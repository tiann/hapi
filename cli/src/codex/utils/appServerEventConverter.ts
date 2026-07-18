import { logger } from '@/ui/logger';

type ConvertedEvent = {
    type: string;
    [key: string]: unknown;
};

type FunctionCallMeta = {
    name: string;
    namespace?: string;
    input: Record<string, unknown> | null;
};

const BENIGN_NOTIFICATION_METHODS = new Set([
    'thread/status/changed',
    'thread/goal/updated',
    'thread/goal/cleared',
    'serverRequest/resolved',
    'item/commandExecution/terminalInteraction',
    'skills/changed'
]);

const BENIGN_ITEM_TYPES = new Set([
    'usermessage'
]);

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const strings = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    return strings.length > 0 ? strings : null;
}

function extractItemId(params: Record<string, unknown>): string | null {
    const direct = asString(params.itemId ?? params.item_id ?? params.id);
    if (direct) return direct;

    const item = asRecord(params.item);
    if (item) {
        return asString(item.id ?? item.itemId ?? item.item_id);
    }

    return null;
}

function extractItem(params: Record<string, unknown>): Record<string, unknown> | null {
    const item = asRecord(params.item);
    return item ?? params;
}

function normalizeItemType(value: unknown): string | null {
    const raw = asString(value);
    if (!raw) return null;
    return raw.toLowerCase().replace(/[\s_-]/g, '');
}

function parseJsonValue(value: unknown): unknown {
    if (typeof value !== 'string') {
        return value;
    }

    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return value;
    }

    try {
        return JSON.parse(trimmed);
    } catch (error) {
        logger.debug('[AppServerEventConverter] Failed to parse JSON value:', error);
        return value;
    }
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
    return asRecord(parseJsonValue(value));
}

function extractFunctionCallId(params: Record<string, unknown>, item: Record<string, unknown>): string | null {
    return asString(
        item.call_id ??
        item.callId ??
        item.tool_call_id ??
        item.toolCallId ??
        params.call_id ??
        params.callId ??
        params.tool_call_id ??
        params.toolCallId
    ) ?? extractItemId(params);
}

function normalizeFunctionName(value: string): string {
    return value.includes('.') ? value.slice(value.lastIndexOf('.') + 1) : value;
}

function isCodexSubagentFunction(name: string, namespace: string | undefined): boolean {
    const normalizedName = normalizeFunctionName(name);
    if (normalizedName !== 'spawn_agent' && normalizedName !== 'wait_agent' && normalizedName !== 'close_agent') {
        return false;
    }
    return !namespace || namespace === 'multi_agent_v1' || name.startsWith('multi_agent_v1.');
}

function normalizeCollabAgentToolName(value: unknown): 'spawn_agent' | 'wait_agent' | 'close_agent' | null {
    const raw = asString(value);
    if (!raw) return null;

    const normalized = raw.toLowerCase().replace(/[\s_-]/g, '');
    if (normalized === 'spawnagent') return 'spawn_agent';
    if (normalized === 'wait' || normalized === 'waitagent') return 'wait_agent';
    if (normalized === 'closeagent') return 'close_agent';
    return null;
}

function maybeSet(target: Record<string, unknown>, key: string, value: unknown): void {
    if (value !== null && value !== undefined) {
        target[key] = value;
    }
}

function extractCommand(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        const parts = value.filter((part): part is string => typeof part === 'string');
        return parts.length > 0 ? parts.join(' ') : null;
    }
    return null;
}

function extractChanges(value: unknown): Record<string, unknown> | null {
    const record = asRecord(value);
    if (record) return record;

    if (Array.isArray(value)) {
        const changes: Record<string, unknown> = {};
        for (const entry of value) {
            const entryRecord = asRecord(entry);
            if (!entryRecord) continue;
            const path = asString(entryRecord.path ?? entryRecord.file ?? entryRecord.filePath ?? entryRecord.file_path);
            if (path) {
                changes[path] = entryRecord;
            }
        }
        return Object.keys(changes).length > 0 ? changes : null;
    }

    return null;
}

function contextCompactedEvent(source: Record<string, unknown>, threadSource: Record<string, unknown> = source): ConvertedEvent {
    const event: ConvertedEvent = { type: 'context_compacted' };
    const threadId = asString(threadSource.threadId ?? threadSource.thread_id ?? threadSource.id);
    const turnId = asString(source.turnId ?? source.turn_id);
    const previousTokens = asNumber(
        source.previousTokens ??
        source.previous_tokens ??
        source.previousTokenCount ??
        source.previous_token_count
    );
    const tokens = asNumber(source.tokens ?? source.tokenCount ?? source.token_count);

    if (threadId) event.thread_id = threadId;
    if (turnId) event.turn_id = turnId;
    if (previousTokens !== null) event.previousTokens = previousTokens;
    if (tokens !== null) event.tokens = tokens;

    return event;
}

function extractTextFromContent(value: unknown): string | null {
    if (typeof value === 'string' && value.length > 0) {
        return value;
    }

    if (!Array.isArray(value)) {
        return null;
    }

    const chunks: string[] = [];
    for (const entry of value) {
        const record = asRecord(entry);
        if (!record) continue;
        const text = asString(record.text ?? record.message ?? record.content);
        if (text) {
            chunks.push(text);
        }
    }

    if (chunks.length === 0) {
        return null;
    }

    return chunks.join('');
}

function extractItemText(item: Record<string, unknown>): string | null {
    return asString(item.text ?? item.message) ?? extractTextFromContent(item.content);
}

function extractReasoningText(item: Record<string, unknown>): string | null {
    const direct = extractItemText(item);
    if (direct) {
        return direct;
    }

    const summary = item.summary_text ?? item.summaryText;
    if (Array.isArray(summary)) {
        const chunks = summary.filter((part): part is string => typeof part === 'string' && part.length > 0);
        if (chunks.length > 0) {
            return chunks.join('\n');
        }
    }

    return null;
}

function mergeItemMeta(meta: Record<string, unknown> | undefined, item: Record<string, unknown>): Record<string, unknown> {
    return meta ? { ...meta, ...item } : item;
}

function extractCollabAgentIds(item: Record<string, unknown>): string[] {
    const ids = new Set<string>();
    for (const id of asStringArray(item.receiverThreadIds ?? item.receiver_thread_ids ?? item.receivers) ?? []) {
        ids.add(id);
    }

    const states = asRecord(item.agentsStates ?? item.agents_states ?? item.agentStates);
    if (states) {
        for (const id of Object.keys(states)) {
            if (id.length > 0) {
                ids.add(id);
            }
        }
    }

    return Array.from(ids);
}

export class AppServerEventConverter {
    private readonly agentMessageBuffers = new Map<string, string>();
    private readonly reasoningBuffers = new Map<string, string>();
    private readonly commandOutputBuffers = new Map<string, string>();
    private readonly commandMeta = new Map<string, Record<string, unknown>>();
    private readonly functionCallMeta = new Map<string, FunctionCallMeta>();
    private readonly collabAgentToolMeta = new Map<string, Record<string, unknown>>();
    private readonly fileChangeMeta = new Map<string, Record<string, unknown>>();
    private readonly completedAgentMessageItems = new Set<string>();
    private readonly completedReasoningItems = new Set<string>();
    private readonly reasoningSectionBreakKeys = new Set<string>();
    private readonly lastAgentMessageDeltaByItemId = new Map<string, string>();
    private readonly lastReasoningDeltaByItemId = new Map<string, string>();
    private readonly lastCommandOutputDeltaByItemId = new Map<string, string>();

    private handleWrappedCodexEvent(paramsRecord: Record<string, unknown>): ConvertedEvent[] | null {
        const msg = asRecord(paramsRecord.msg);
        if (!msg) {
            return [];
        }

        const msgType = asString(msg.type);
        if (!msgType) {
            return [];
        }

        if (msgType === 'item_started' || msgType === 'item_completed') {
            const itemMethod = msgType === 'item_started' ? 'item/started' : 'item/completed';
            const item = asRecord(msg.item) ?? {};
            const params: Record<string, unknown> = {
                item,
                itemId: asString(msg.item_id ?? msg.itemId ?? item.id),
                threadId: asString(msg.thread_id ?? msg.threadId),
                turnId: asString(msg.turn_id ?? msg.turnId)
            };
            return this.handleNotification(itemMethod, params);
        }

        if (
            msgType === 'task_started' ||
            msgType === 'task_complete' ||
            msgType === 'turn_aborted' ||
            msgType === 'task_failed'
        ) {
            const turnId = asString(msg.turn_id ?? msg.turnId);
            if ((msgType === 'task_complete' || msgType === 'turn_aborted' || msgType === 'task_failed') && !turnId) {
                logger.debug('[AppServerEventConverter] Ignoring wrapped terminal event without turn_id', { msgType });
                return [];
            }

            const event: ConvertedEvent = { type: msgType };
            if (turnId) {
                event.turn_id = turnId;
            }
            if (msgType === 'task_failed') {
                event.error = 'Codex task failed';
            }
            return [event];
        }

        if (msgType === 'agent_message_delta' || msgType === 'agent_message_content_delta') {
            const itemId = asString(msg.item_id ?? msg.itemId ?? msg.id) ?? 'agent-message';
            const delta = asString(msg.delta ?? msg.text ?? msg.message);
            if (!delta) return [];
            return this.handleNotification('item/agentMessage/delta', { itemId, delta });
        }

        if (msgType === 'reasoning_content_delta') {
            const itemId = asString(msg.item_id ?? msg.itemId ?? msg.id) ?? 'reasoning';
            const delta = asString(msg.delta ?? msg.text ?? msg.message);
            if (!delta) return [];
            return this.handleNotification('item/reasoning/summaryTextDelta', { itemId, delta });
        }

        if (msgType === 'agent_reasoning_section_break') {
            const itemId = asString(msg.item_id ?? msg.itemId ?? msg.id) ?? 'reasoning';
            const summaryIndex = asNumber(msg.summary_index ?? msg.summaryIndex);
            return this.handleNotification('item/reasoning/summaryPartAdded', {
                itemId,
                ...(summaryIndex !== null ? { summaryIndex } : {})
            });
        }

        if (msgType === 'agent_reasoning_delta' || msgType === 'agent_reasoning' || msgType === 'agent_message') {
            return [];
        }

        if (msgType === 'context_compacted') {
            return [contextCompactedEvent(msg)];
        }

        if (msgType === 'exec_command_output_delta') {
            const itemId = asString(msg.call_id ?? msg.callId ?? msg.item_id ?? msg.itemId ?? msg.id);
            const delta = asString(msg.delta ?? msg.output ?? msg.stdout ?? msg.text);
            if (!itemId || !delta) return [];
            return this.handleNotification('item/commandExecution/outputDelta', { itemId, delta });
        }

        if (msgType === 'error') {
            const errorRecord = asRecord(msg.error);
            const willRetry = asBoolean(msg.will_retry ?? msg.willRetry ?? errorRecord?.will_retry ?? errorRecord?.willRetry) ?? false;
            if (willRetry) {
                return [];
            }
            const hasError = asString(msg.message ?? msg.reason ?? errorRecord?.message);
            return hasError ? [{ type: 'task_failed', error: 'Codex task failed' }] : [];
        }

        if (
            msgType === 'mcp_startup_update' ||
            msgType === 'mcp_startup_complete' ||
            msgType === 'plan_update' ||
            msgType === 'skills_update_available' ||
            msgType === 'stream_error' ||
            msgType === 'warning' ||
            msgType === 'terminal_interaction' ||
            msgType === 'user_message'
        ) {
            return [];
        }

        return [msg as ConvertedEvent];
    }

    handleNotification(method: string, params: unknown): ConvertedEvent[] {
        const events: ConvertedEvent[] = [];
        const paramsRecord = asRecord(params) ?? {};

        if (method.startsWith('codex/event/')) {
            return this.handleWrappedCodexEvent(paramsRecord) ?? events;
        }

        if (BENIGN_NOTIFICATION_METHODS.has(method)) {
            return events;
        }

        if (method === 'thread/compacted') {
            const thread = asRecord(paramsRecord.thread) ?? paramsRecord;
            const event = contextCompactedEvent(paramsRecord, thread);
            events.push(event);
            return events;
        }

        if (method === 'account/rateLimits/updated' || method === 'turn/plan/updated') {
            return events;
        }

        if (method === 'thread/started' || method === 'thread/resumed') {
            const thread = asRecord(paramsRecord.thread) ?? paramsRecord;
            const threadId = asString(thread.threadId ?? thread.thread_id ?? thread.id);
            if (threadId) {
                events.push({ type: 'thread_started', thread_id: threadId });
            }
            return events;
        }

        if (method === 'turn/started') {
            const turn = asRecord(paramsRecord.turn) ?? paramsRecord;
            const turnId = asString(turn.turnId ?? turn.turn_id ?? turn.id);
            events.push({ type: 'task_started', ...(turnId ? { turn_id: turnId } : {}) });
            return events;
        }

        if (method === 'turn/completed') {
            const turn = asRecord(paramsRecord.turn) ?? paramsRecord;
            const statusRaw = asString(paramsRecord.status ?? turn.status);
            const status = statusRaw?.toLowerCase();
            const turnId = asString(turn.turnId ?? turn.turn_id ?? turn.id);

            if (status === 'interrupted' || status === 'cancelled' || status === 'canceled') {
                events.push({ type: 'turn_aborted', ...(turnId ? { turn_id: turnId } : {}) });
                return events;
            }

            if (status === 'failed' || status === 'error') {
                events.push({ type: 'task_failed', ...(turnId ? { turn_id: turnId } : {}), error: 'Codex task failed' });
                return events;
            }

            events.push({ type: 'task_complete', ...(turnId ? { turn_id: turnId } : {}) });
            return events;
        }

        if (method === 'turn/diff/updated') {
            const diff = asString(paramsRecord.diff ?? paramsRecord.unified_diff ?? paramsRecord.unifiedDiff);
            if (diff) {
                events.push({ type: 'turn_diff', unified_diff: diff });
            }
            return events;
        }

        if (method === 'thread/tokenUsage/updated') {
            const info = asRecord(paramsRecord.tokenUsage ?? paramsRecord.token_usage ?? paramsRecord) ?? {};
            events.push({ type: 'token_count', info });
            return events;
        }

        if (method === 'error') {
            const willRetry = asBoolean(paramsRecord.will_retry ?? paramsRecord.willRetry) ?? false;
            if (willRetry) return events;
            const message = asString(paramsRecord.message) ?? asString(asRecord(paramsRecord.error)?.message);
            if (message) {
                events.push({ type: 'task_failed', error: 'Codex task failed' });
            }
            return events;
        }

        if (method === 'item/agentMessage/delta') {
            const itemId = extractItemId(paramsRecord);
            const delta = asString(paramsRecord.delta ?? paramsRecord.text ?? paramsRecord.message);
            if (itemId && delta) {
                const lastDelta = this.lastAgentMessageDeltaByItemId.get(itemId);
                if (lastDelta === delta) {
                    return events;
                }
                this.lastAgentMessageDeltaByItemId.set(itemId, delta);
                const prev = this.agentMessageBuffers.get(itemId) ?? '';
                this.agentMessageBuffers.set(itemId, prev + delta);
            }
            return events;
        }

        if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
            const itemId = extractItemId(paramsRecord) ?? 'reasoning';
            const delta = asString(paramsRecord.delta ?? paramsRecord.text ?? paramsRecord.message);
            if (delta) {
                const lastDelta = this.lastReasoningDeltaByItemId.get(itemId);
                if (lastDelta === delta) {
                    return events;
                }
                this.lastReasoningDeltaByItemId.set(itemId, delta);
                const prev = this.reasoningBuffers.get(itemId) ?? '';
                this.reasoningBuffers.set(itemId, prev + delta);
                events.push({ type: 'agent_reasoning_delta', delta });
            }
            return events;
        }

        if (method === 'item/reasoning/summaryPartAdded') {
            const itemId = extractItemId(paramsRecord) ?? 'reasoning';
            const summaryIndex = asNumber(paramsRecord.summaryIndex ?? paramsRecord.summary_index);
            if (summaryIndex !== null) {
                const key = `${itemId}:${summaryIndex}`;
                if (this.reasoningSectionBreakKeys.has(key)) {
                    return events;
                }
                this.reasoningSectionBreakKeys.add(key);
            }
            events.push({ type: 'agent_reasoning_section_break' });
            return events;
        }

        if (method === 'item/commandExecution/outputDelta') {
            const itemId = extractItemId(paramsRecord);
            const delta = asString(paramsRecord.delta ?? paramsRecord.text ?? paramsRecord.output ?? paramsRecord.stdout);
            if (itemId && delta) {
                const lastDelta = this.lastCommandOutputDeltaByItemId.get(itemId);
                if (lastDelta === delta) {
                    return events;
                }
                this.lastCommandOutputDeltaByItemId.set(itemId, delta);
                const prev = this.commandOutputBuffers.get(itemId) ?? '';
                this.commandOutputBuffers.set(itemId, prev + delta);
            }
            return events;
        }

        if (method === 'item/started' || method === 'item/completed') {
            const item = extractItem(paramsRecord);
            if (!item) return events;

            const itemType = normalizeItemType(item.type ?? item.itemType ?? item.kind);
            const itemId = extractItemId(paramsRecord) ?? asString(item.id ?? item.itemId ?? item.item_id);

            if (!itemType || !itemId) {
                return events;
            }

            if (itemType === 'agentmessage') {
                if (method === 'item/completed') {
                    if (this.completedAgentMessageItems.has(itemId)) {
                        return events;
                    }
                    const text = extractItemText(item) ?? this.agentMessageBuffers.get(itemId);
                    if (text) {
                        events.push({ type: 'agent_message', message: text });
                        this.completedAgentMessageItems.add(itemId);
                        this.agentMessageBuffers.delete(itemId);
                    }
                    this.lastAgentMessageDeltaByItemId.delete(itemId);
                }
                return events;
            }

            if (itemType === 'reasoning') {
                if (method === 'item/completed') {
                    if (this.completedReasoningItems.has(itemId)) {
                        return events;
                    }
                    const text = extractReasoningText(item) ?? this.reasoningBuffers.get(itemId);
                    if (text) {
                        events.push({ type: 'agent_reasoning', text });
                        this.completedReasoningItems.add(itemId);
                        this.reasoningBuffers.delete(itemId);
                    }
                    this.lastReasoningDeltaByItemId.delete(itemId);
                }
                return events;
            }

            if (itemType === 'commandexecution') {
                if (method === 'item/started') {
                    const command = extractCommand(item.command ?? item.cmd ?? item.args);
                    const cwd = asString(item.cwd ?? item.workingDirectory ?? item.working_directory);
                    const autoApproved = asBoolean(item.autoApproved ?? item.auto_approved);
                    const meta: Record<string, unknown> = {};
                    if (command) meta.command = command;
                    if (cwd) meta.cwd = cwd;
                    if (autoApproved !== null) meta.auto_approved = autoApproved;
                    this.commandMeta.set(itemId, meta);

                    events.push({
                        type: 'exec_command_begin',
                        call_id: itemId,
                        ...meta
                    });
                }

                if (method === 'item/completed') {
                    const meta = this.commandMeta.get(itemId) ?? {};
                    const output = asString(item.output ?? item.result ?? item.stdout) ?? this.commandOutputBuffers.get(itemId);
                    const stderr = asString(item.stderr);
                    const error = asString(item.error);
                    const exitCode = asNumber(item.exitCode ?? item.exit_code ?? item.exitcode);
                    const status = asString(item.status);

                    events.push({
                        type: 'exec_command_end',
                        call_id: itemId,
                        ...meta,
                        ...(output ? { output } : {}),
                        ...(stderr ? { stderr } : {}),
                        ...(error ? { error } : {}),
                        ...(exitCode !== null ? { exit_code: exitCode } : {}),
                        ...(status ? { status } : {})
                    });

                    this.commandMeta.delete(itemId);
                    this.commandOutputBuffers.delete(itemId);
                    this.lastCommandOutputDeltaByItemId.delete(itemId);
                }

                return events;
            }

            if (itemType === 'collabagenttoolcall') {
                if (method === 'item/started') {
                    this.collabAgentToolMeta.set(itemId, item);
                    return events;
                }

                const collabItem = mergeItemMeta(this.collabAgentToolMeta.get(itemId), item);
                this.collabAgentToolMeta.delete(itemId);

                const toolName = normalizeCollabAgentToolName(collabItem.tool ?? collabItem.name ?? collabItem.toolName);
                if (!toolName) {
                    return events;
                }

                const callId = asString(collabItem.call_id ?? collabItem.callId ?? collabItem.id) ?? itemId;
                const agentIds = extractCollabAgentIds(collabItem);
                const agentsStates = asRecord(collabItem.agentsStates ?? collabItem.agents_states ?? collabItem.agentStates);

                if (toolName === 'spawn_agent') {
                    for (const agentId of agentIds) {
                        const event: ConvertedEvent = {
                            type: 'codex_subagent_spawned',
                            call_id: callId,
                            agent_id: agentId
                        };
                        maybeSet(event, 'nickname', asString(collabItem.nickname ?? collabItem.name));
                        maybeSet(event, 'agent_type', asString(collabItem.agent_type ?? collabItem.agentType ?? collabItem.model));
                        maybeSet(event, 'message', asString(collabItem.prompt ?? collabItem.message ?? collabItem.description));
                        events.push(event);
                    }
                    return events;
                }

                if (toolName === 'wait_agent') {
                    const event: ConvertedEvent = {
                        type: 'codex_subagent_waited',
                        call_id: callId
                    };
                    const targets = agentIds.length > 0 ? agentIds : null;
                    if (targets) {
                        event.targets = targets;
                    }
                    if (agentsStates) {
                        event.status = agentsStates;
                    }
                    events.push(event);
                    return events;
                }

                if (toolName === 'close_agent') {
                    const target = agentIds[0] ?? null;
                    if (!target) {
                        return events;
                    }
                    events.push({
                        type: 'codex_subagent_closed',
                        call_id: callId,
                        target,
                        ...(agentsStates?.[target] !== undefined ? { previous_status: agentsStates[target] } : {})
                    });
                    return events;
                }
            }

            if (itemType === 'functioncall') {
                const name = asString(item.name ?? item.tool_name ?? item.toolName);
                const callId = extractFunctionCallId(paramsRecord, item);
                if (name && callId) {
                    const namespace = asString(item.namespace ?? item.tool_namespace ?? item.toolNamespace) ?? undefined;
                    this.functionCallMeta.set(callId, {
                        name,
                        namespace,
                        input: parseJsonRecord(item.arguments ?? item.input ?? item.args)
                    });
                }
                return events;
            }

            if (itemType === 'functioncalloutput') {
                const callId = extractFunctionCallId(paramsRecord, item);
                if (!callId) {
                    return events;
                }

                const meta = this.functionCallMeta.get(callId);
                const name = meta?.name ?? asString(item.name ?? item.tool_name ?? item.toolName);
                const namespace = meta?.namespace ?? asString(item.namespace ?? item.tool_namespace ?? item.toolNamespace) ?? undefined;
                this.functionCallMeta.delete(callId);

                if (!name || !isCodexSubagentFunction(name, namespace)) {
                    return events;
                }

                const input = meta?.input ?? {};
                const output = parseJsonRecord(item.output ?? item.result ?? item.content) ?? {};
                const normalizedName = normalizeFunctionName(name);

                if (normalizedName === 'spawn_agent') {
                    const agentId = asString(output.agent_id ?? output.agentId ?? output.id ?? input.agent_id ?? input.agentId);
                    if (!agentId) {
                        return events;
                    }

                    const event: ConvertedEvent = {
                        type: 'codex_subagent_spawned',
                        call_id: callId,
                        agent_id: agentId
                    };
                    maybeSet(event, 'nickname', asString(output.nickname ?? output.name ?? input.nickname));
                    maybeSet(event, 'agent_type', asString(input.agent_type ?? input.agentType ?? output.agent_type ?? output.agentType));
                    maybeSet(event, 'message', asString(input.message ?? input.prompt ?? input.description));
                    events.push(event);
                    return events;
                }

                if (normalizedName === 'wait_agent') {
                    const event: ConvertedEvent = {
                        type: 'codex_subagent_waited',
                        call_id: callId
                    };
                    maybeSet(event, 'target', asString(input.target ?? input.agent_id ?? input.agentId));
                    const targets = asStringArray(input.targets ?? input.agent_ids ?? input.agentIds);
                    if (targets) {
                        event.targets = targets;
                    }
                    const status = parseJsonRecord(output.status ?? item.status);
                    if (status) {
                        event.status = status;
                    }
                    events.push(event);
                    return events;
                }

                if (normalizedName === 'close_agent') {
                    const target = asString(input.target ?? input.agent_id ?? input.agentId);
                    if (!target) {
                        return events;
                    }
                    events.push({
                        type: 'codex_subagent_closed',
                        call_id: callId,
                        target,
                        ...(output.previous_status !== undefined ? { previous_status: output.previous_status } : {}),
                        ...(output.previousStatus !== undefined ? { previous_status: output.previousStatus } : {})
                    });
                    return events;
                }
            }

            if (itemType === 'contextcompaction') {
                const threadId = asString(paramsRecord.threadId ?? paramsRecord.thread_id);
                const turnId = asString(paramsRecord.turnId ?? paramsRecord.turn_id);
                if (method === 'item/started') {
                    events.push({
                        type: 'task_started',
                        ...(threadId ? { thread_id: threadId } : {}),
                        ...(turnId ? { turn_id: turnId } : {})
                    });
                } else if (method === 'item/completed') {
                    events.push({
                        type: 'context_compacted',
                        ...(threadId ? { thread_id: threadId } : {}),
                        ...(turnId ? { turn_id: turnId } : {})
                    });
                }
                return events;
            }

            if (itemType === 'filechange') {
                if (method === 'item/started') {
                    const changes = extractChanges(item.changes ?? item.change ?? item.diff);
                    const autoApproved = asBoolean(item.autoApproved ?? item.auto_approved);
                    const meta: Record<string, unknown> = {};
                    if (changes) meta.changes = changes;
                    if (autoApproved !== null) meta.auto_approved = autoApproved;
                    this.fileChangeMeta.set(itemId, meta);

                    events.push({
                        type: 'patch_apply_begin',
                        call_id: itemId,
                        ...meta
                    });
                }

                if (method === 'item/completed') {
                    const meta = this.fileChangeMeta.get(itemId) ?? {};
                    const stdout = asString(item.stdout ?? item.output);
                    const stderr = asString(item.stderr);
                    const success = asBoolean(item.success ?? item.ok ?? item.applied ?? item.status === 'completed');

                    events.push({
                        type: 'patch_apply_end',
                        call_id: itemId,
                        ...meta,
                        ...(stdout ? { stdout } : {}),
                        ...(stderr ? { stderr } : {}),
                        success: success ?? false
                    });

                    this.fileChangeMeta.delete(itemId);
                }

                return events;
            }

            if (BENIGN_ITEM_TYPES.has(itemType)) {
                return events;
            }
        }

        let paramsBytes = 0;
        try {
            paramsBytes = Buffer.byteLength(JSON.stringify(params) ?? '', 'utf8');
        } catch {
            paramsBytes = -1;
        }
        logger.debug('[AppServerEventConverter] Unhandled notification', { method, paramsBytes });
        return events;
    }

    reset(): void {
        this.agentMessageBuffers.clear();
        this.reasoningBuffers.clear();
        this.commandOutputBuffers.clear();
        this.commandMeta.clear();
        this.functionCallMeta.clear();
        this.collabAgentToolMeta.clear();
        this.fileChangeMeta.clear();
        this.completedAgentMessageItems.clear();
        this.completedReasoningItems.clear();
        this.reasoningSectionBreakKeys.clear();
        this.lastAgentMessageDeltaByItemId.clear();
        this.lastReasoningDeltaByItemId.clear();
        this.lastCommandOutputDeltaByItemId.clear();
    }
}
