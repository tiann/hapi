import { logger } from '@/ui/logger';

type ConvertedEvent = {
    type: string;
    [key: string]: unknown;
};

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

function normalizePlanStatus(value: unknown): 'pending' | 'in_progress' | 'completed' {
    const raw = typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]/g, '_') : '';
    if (raw === 'completed' || raw === 'complete' || raw === 'done') return 'completed';
    if (raw === 'in_progress' || raw === 'inprogress' || raw === 'active' || raw === 'running') return 'in_progress';
    return 'pending';
}

function extractPlanEntries(value: unknown): Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }> {
    const record = asRecord(value);
    const entries = Array.isArray(value)
        ? value
        : Array.isArray(record?.plan)
            ? record.plan
            : Array.isArray(record?.items)
                ? record.items
                : Array.isArray(record?.steps)
                    ? record.steps
                    : [];

    const plan: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }> = [];
    for (const entry of entries) {
        if (typeof entry === 'string') {
            plan.push({ step: entry, status: 'pending' });
            continue;
        }
        const item = asRecord(entry);
        if (!item) continue;
        const step = asString(item.step ?? item.content ?? item.text ?? item.title ?? item.description);
        if (!step) continue;
        plan.push({
            step,
            status: normalizePlanStatus(item.status ?? item.state)
        });
    }
    return plan;
}

function extractPlanUpdate(params: Record<string, unknown>): ConvertedEvent[] {
    const plan = extractPlanEntries(
        params.plan ?? params.update ?? params.items ?? params.steps ?? params
    );
    return plan.length > 0 ? [{ type: 'plan_update', plan }] : [];
}

function extractEventScope(params: Record<string, unknown>): Record<string, unknown> {
    const thread = asRecord(params.thread);
    const turn = asRecord(params.turn);
    const tokenUsage = asRecord(params.tokenUsage ?? params.token_usage ?? params.info);
    const tokenUsageThread = asRecord(tokenUsage?.thread);
    const tokenUsageTurn = asRecord(tokenUsage?.turn);
    const item = asRecord(params.item);
    const itemThread = asRecord(item?.thread);
    const itemTurn = asRecord(item?.turn);
    const threadId = asString(
        params.threadId
        ?? params.thread_id
        ?? thread?.threadId
        ?? thread?.thread_id
        ?? thread?.id
        ?? tokenUsage?.threadId
        ?? tokenUsage?.thread_id
        ?? tokenUsageThread?.threadId
        ?? tokenUsageThread?.thread_id
        ?? tokenUsageThread?.id
        ?? item?.threadId
        ?? item?.thread_id
        ?? itemThread?.threadId
        ?? itemThread?.thread_id
        ?? itemThread?.id
    );
    const turnId = asString(
        params.turnId
        ?? params.turn_id
        ?? turn?.turnId
        ?? turn?.turn_id
        ?? turn?.id
        ?? tokenUsage?.turnId
        ?? tokenUsage?.turn_id
        ?? tokenUsageTurn?.turnId
        ?? tokenUsageTurn?.turn_id
        ?? tokenUsageTurn?.id
        ?? item?.turnId
        ?? item?.turn_id
        ?? itemTurn?.turnId
        ?? itemTurn?.turn_id
        ?? itemTurn?.id
    );

    return {
        ...(threadId ? { thread_id: threadId } : {}),
        ...(turnId ? { turn_id: turnId } : {})
    };
}

function addEventScope(events: ConvertedEvent[], scope: Record<string, unknown>): ConvertedEvent[] {
    if (Object.keys(scope).length === 0) {
        return events;
    }

    return events.map((event) => ({
        ...scope,
        ...event
    }));
}

function normalizeCollabAgentToolName(value: unknown): string | null {
    const raw = asString(value);
    if (!raw) return null;

    const normalized = raw.trim().toLowerCase().replace(/[\s_-]/g, '');
    if (normalized === 'spawnagent' || normalized === 'spawn') return 'spawn_agent';
    if (normalized === 'sendinput' || normalized === 'sendmessage') return 'send_input';
    if (normalized === 'resumeagent' || normalized === 'resume') return 'resume_agent';
    if (normalized === 'waitagent' || normalized === 'wait') return 'wait_agent';
    if (normalized === 'closeagent' || normalized === 'close') return 'close_agent';
    return null;
}

function extractStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        : [];
}

function buildCollabAgentInput(item: Record<string, unknown>, toolName: string): Record<string, unknown> {
    const targets = extractStringArray(item.receiverThreadIds ?? item.receiver_thread_ids ?? item.targets);
    const input: Record<string, unknown> = {};

    const prompt = asString(item.prompt ?? item.message);
    if (prompt) {
        input.message = prompt;
    }

    const agentType = asString(item.agentType ?? item.agent_type);
    if (agentType) {
        input.agent_type = agentType;
    }

    const forkContext = asBoolean(item.forkContext ?? item.fork_context);
    if (forkContext !== null) {
        input.fork_context = forkContext;
    }

    const model = asString(item.model);
    if (model) {
        input.model = model;
    }

    const reasoningEffort = asString(item.reasoningEffort ?? item.reasoning_effort);
    if (reasoningEffort) {
        input.reasoning_effort = reasoningEffort;
    }

    const senderThreadId = asString(item.senderThreadId ?? item.sender_thread_id);
    if (senderThreadId) {
        input.sender_thread_id = senderThreadId;
    }

    if (targets.length > 0) {
        input.targets = targets;
        if (toolName === 'close_agent' || toolName === 'send_input' || toolName === 'resume_agent') {
            input.target = targets[0];
        }
    }

    return input;
}

function statusObjectFromAgentState(value: unknown): unknown {
    const record = asRecord(value);
    if (!record) return value;

    const message = asString(record.message);
    const status = asString(record.status ?? record.state);
    if (status === 'completed' && message) return { completed: message };
    if ((status === 'failed' || status === 'error') && message) return { failed: message };
    if ((status === 'canceled' || status === 'cancelled') && message) return { canceled: message };
    return value;
}

function buildCollabAgentOutput(item: Record<string, unknown>, toolName: string): Record<string, unknown> {
    const targets = extractStringArray(item.receiverThreadIds ?? item.receiver_thread_ids ?? item.targets);
    const agentsStates = asRecord(item.agentsStates ?? item.agents_states) ?? {};
    const status = asString(item.status);
    const error = asString(item.error ?? item.message);
    const errorFields = error ? { error, message: error } : {};

    if (toolName === 'spawn_agent') {
        const agentId = targets[0] ?? null;
        return {
            ...(agentId ? { agent_id: agentId, agentId } : {}),
            ...(status ? { status } : {}),
            ...errorFields,
            agentsStates
        };
    }

    if (toolName === 'wait_agent') {
        const normalizedStatus: Record<string, unknown> = {};
        for (const [agentId, agentStatus] of Object.entries(agentsStates)) {
            normalizedStatus[agentId] = statusObjectFromAgentState(agentStatus);
        }
        return {
            status: normalizedStatus,
            ...errorFields,
            timed_out: status === 'timedOut' || status === 'timed_out'
        };
    }

    if (toolName === 'close_agent') {
        const firstStatus = targets[0] ? agentsStates[targets[0]] : Object.values(agentsStates)[0];
        return {
            previous_status: statusObjectFromAgentState(firstStatus),
            ...errorFields,
            ...(targets[0] ? { agent_id: targets[0] } : {})
        };
    }

    return {
        ...(targets.length > 0 ? { targets } : {}),
        ...(status ? { status } : {}),
        ...errorFields,
        agentsStates
    };
}

export class AppServerEventConverter {
    private readonly agentMessageBuffers = new Map<string, string>();
    private readonly reasoningBuffers = new Map<string, string>();
    private readonly commandOutputBuffers = new Map<string, string>();
    private readonly commandMeta = new Map<string, Record<string, unknown>>();
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

        const msgScope = extractEventScope(msg);

        if (msgType === 'item_started' || msgType === 'item_completed') {
            const itemMethod = msgType === 'item_started' ? 'item/started' : 'item/completed';
            const item = asRecord(msg.item) ?? {};
            const threadId = asString(msg.thread_id ?? msg.threadId ?? msgScope.thread_id);
            const turnId = asString(msg.turn_id ?? msg.turnId ?? msgScope.turn_id);
            const params: Record<string, unknown> = {
                ...msgScope,
                item,
                itemId: asString(msg.item_id ?? msg.itemId ?? item.id),
                ...(threadId ? { threadId } : {}),
                ...(turnId ? { turnId } : {})
            };
            return this.handleNotification(itemMethod, params);
        }

        if (
            msgType === 'task_started' ||
            msgType === 'task_complete' ||
            msgType === 'turn_aborted' ||
            msgType === 'task_failed'
        ) {
            const turnId = asString(msg.turn_id ?? msg.turnId ?? msgScope.turn_id);
            if ((msgType === 'task_complete' || msgType === 'turn_aborted' || msgType === 'task_failed') && !turnId) {
                logger.debug('[AppServerEventConverter] Ignoring wrapped terminal event without turn_id', { msgType });
                return [];
            }

            const event: ConvertedEvent = { ...msgScope, type: msgType };
            if (turnId) {
                event.turn_id = turnId;
            }
            const threadId = asString(msg.thread_id ?? msg.threadId ?? msgScope.thread_id);
            if (threadId) {
                event.thread_id = threadId;
            }
            if (msgType === 'task_failed') {
                const error = asString(msg.error ?? msg.message ?? asRecord(msg.error)?.message);
                if (error) {
                    event.error = error;
                }
            }
            return [event];
        }

        if (msgType === 'agent_message_delta' || msgType === 'agent_message_content_delta') {
            const itemId = asString(msg.item_id ?? msg.itemId ?? msg.id) ?? 'agent-message';
            const delta = asString(msg.delta ?? msg.text ?? msg.message);
            if (!delta) return [];
            return this.handleNotification('item/agentMessage/delta', { itemId, delta, ...msgScope });
        }

        if (msgType === 'reasoning_content_delta') {
            const itemId = asString(msg.item_id ?? msg.itemId ?? msg.id) ?? 'reasoning';
            const delta = asString(msg.delta ?? msg.text ?? msg.message);
            if (!delta) return [];
            return this.handleNotification('item/reasoning/summaryTextDelta', { itemId, delta, ...msgScope });
        }

        if (msgType === 'agent_reasoning_section_break') {
            const itemId = asString(msg.item_id ?? msg.itemId ?? msg.id) ?? 'reasoning';
            const summaryIndex = asNumber(msg.summary_index ?? msg.summaryIndex);
            return this.handleNotification('item/reasoning/summaryPartAdded', {
                itemId,
                ...msgScope,
                ...(summaryIndex !== null ? { summaryIndex } : {})
            });
        }

        if (msgType === 'agent_reasoning_delta' || msgType === 'agent_reasoning' || msgType === 'agent_message') {
            return [];
        }

        if (msgType === 'exec_command_output_delta') {
            const itemId = asString(msg.call_id ?? msg.callId ?? msg.item_id ?? msg.itemId ?? msg.id);
            const delta = asString(msg.delta ?? msg.output ?? msg.stdout ?? msg.text);
            if (!itemId || !delta) return [];
            return this.handleNotification('item/commandExecution/outputDelta', { itemId, delta, ...msgScope });
        }

        if (msgType === 'error') {
            const errorRecord = asRecord(msg.error);
            const willRetry = asBoolean(msg.will_retry ?? msg.willRetry ?? errorRecord?.will_retry ?? errorRecord?.willRetry) ?? false;
            if (willRetry) {
                return [];
            }
            const error = asString(msg.message ?? msg.reason ?? errorRecord?.message);
            return error ? addEventScope([{ type: 'task_failed', error }], msgScope) : [];
        }

        if (msgType === 'plan_update') {
            return addEventScope(extractPlanUpdate(msg), msgScope);
        }

        if (msgType === 'context_compacted') {
            const threadId = asString(msg.thread_id ?? msg.threadId ?? msgScope.thread_id);
            if (!threadId) {
                return [];
            }
            const turnId = asString(msg.turn_id ?? msg.turnId ?? msgScope.turn_id);
            return [
                {
                    type: 'thread_compacted',
                    thread_id: threadId,
                    ...(turnId ? { turn_id: turnId } : {})
                },
                ...addEventScope([{ type: 'context_compacted' }], msgScope)
            ];
        }

        if (
            msgType === 'mcp_startup_update' ||
            msgType === 'mcp_startup_complete' ||
            msgType === 'skills_update_available' ||
            msgType === 'stream_error' ||
            msgType === 'warning' ||
            msgType === 'terminal_interaction' ||
            msgType === 'user_message'
        ) {
            return [];
        }

        return addEventScope([msg as ConvertedEvent], msgScope);
    }

    handleNotification(method: string, params: unknown): ConvertedEvent[] {
        const events: ConvertedEvent[] = [];
        const paramsRecord = asRecord(params) ?? {};
        const eventScope = extractEventScope(paramsRecord);
        const scoped = (event: ConvertedEvent): ConvertedEvent => ({
            ...eventScope,
            ...event
        });

        if (method.startsWith('codex/event/')) {
            return this.handleWrappedCodexEvent(paramsRecord) ?? events;
        }

        if (method === 'turn/plan/updated') {
            return addEventScope(extractPlanUpdate(paramsRecord), eventScope);
        }

        if (method === 'account/rateLimits/updated') {
            return events;
        }

        if (method === 'thread/compacted') {
            const threadId = asString(paramsRecord.threadId ?? paramsRecord.thread_id ?? eventScope.thread_id);
            if (!threadId) {
                return events;
            }
            const turnId = asString(paramsRecord.turnId ?? paramsRecord.turn_id ?? eventScope.turn_id);
            events.push({
                type: 'thread_compacted',
                thread_id: threadId,
                ...(turnId ? { turn_id: turnId } : {})
            });
            events.push(scoped({ type: 'context_compacted' }));
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

        if (method === 'thread/status/changed') {
            const thread = asRecord(paramsRecord.thread) ?? paramsRecord;
            const threadId = asString(thread.threadId ?? thread.thread_id ?? thread.id);
            const status = asRecord(paramsRecord.status ?? thread.status);
            const statusType = asString(status?.type ?? paramsRecord.statusType ?? paramsRecord.status_type);
            if (statusType === 'systemError') {
                const error = asString(status?.message ?? status?.error ?? paramsRecord.message ?? paramsRecord.error)
                    ?? 'Codex thread entered systemError';
                events.push(scoped({
                    type: 'task_failed',
                    ...(threadId ? { thread_id: threadId } : {}),
                    terminal_source: 'thread_status',
                    error
                }));
            }
            return events;
        }

        if (method === 'turn/started') {
            const turn = asRecord(paramsRecord.turn) ?? paramsRecord;
            const turnId = asString(turn.turnId ?? turn.turn_id ?? turn.id);
            events.push(scoped({ type: 'task_started', ...(turnId ? { turn_id: turnId } : {}) }));
            return events;
        }

        if (method === 'turn/completed') {
            const turn = asRecord(paramsRecord.turn) ?? paramsRecord;
            const statusRaw = asString(paramsRecord.status ?? turn.status);
            const status = statusRaw?.toLowerCase();
            const turnId = asString(turn.turnId ?? turn.turn_id ?? turn.id);
            const errorMessage = asString(paramsRecord.error ?? paramsRecord.message ?? paramsRecord.reason);

            if (status === 'interrupted' || status === 'cancelled' || status === 'canceled') {
                events.push(scoped({ type: 'turn_aborted', ...(turnId ? { turn_id: turnId } : {}) }));
                return events;
            }

            if (status === 'failed' || status === 'error') {
                events.push(scoped({ type: 'task_failed', ...(turnId ? { turn_id: turnId } : {}), ...(errorMessage ? { error: errorMessage } : {}) }));
                return events;
            }

            events.push(scoped({ type: 'task_complete', ...(turnId ? { turn_id: turnId } : {}) }));
            return events;
        }

        if (method === 'turn/diff/updated') {
            const diff = asString(paramsRecord.diff ?? paramsRecord.unified_diff ?? paramsRecord.unifiedDiff);
            if (diff) {
                events.push(scoped({ type: 'turn_diff', unified_diff: diff }));
            }
            return events;
        }

        if (method === 'thread/tokenUsage/updated') {
            const info = asRecord(paramsRecord.tokenUsage ?? paramsRecord.token_usage ?? paramsRecord) ?? {};
            events.push(scoped({ type: 'token_count', info }));
            return events;
        }

        if (method === 'error') {
            const willRetry = asBoolean(paramsRecord.will_retry ?? paramsRecord.willRetry) ?? false;
            if (willRetry) return events;
            const message = asString(paramsRecord.message) ?? asString(asRecord(paramsRecord.error)?.message);
            if (message) {
                events.push(scoped({ type: 'task_failed', error: message }));
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
                events.push(scoped({ type: 'agent_reasoning_delta', delta }));
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
            events.push(scoped({ type: 'agent_reasoning_section_break' }));
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
                        events.push(scoped({ type: 'agent_message', message: text }));
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
                        events.push(scoped({ type: 'agent_reasoning', text }));
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

                    events.push(scoped({
                        type: 'exec_command_begin',
                        call_id: itemId,
                        ...meta
                    }));
                }

                if (method === 'item/completed') {
                    const meta = this.commandMeta.get(itemId) ?? {};
                    const output = asString(item.output ?? item.result ?? item.stdout) ?? this.commandOutputBuffers.get(itemId);
                    const stderr = asString(item.stderr);
                    const error = asString(item.error);
                    const exitCode = asNumber(item.exitCode ?? item.exit_code ?? item.exitcode);
                    const status = asString(item.status);

                    events.push(scoped({
                        type: 'exec_command_end',
                        call_id: itemId,
                        ...meta,
                        ...(output ? { output } : {}),
                        ...(stderr ? { stderr } : {}),
                        ...(error ? { error } : {}),
                        ...(exitCode !== null ? { exit_code: exitCode } : {}),
                        ...(status ? { status } : {})
                    }));

                    this.commandMeta.delete(itemId);
                    this.commandOutputBuffers.delete(itemId);
                    this.lastCommandOutputDeltaByItemId.delete(itemId);
                }

                return events;
            }

            if (itemType === 'mcptoolcall') {
                const server = asString(item.server ?? item.serverName ?? item.server_name);
                const tool = asString(item.tool ?? item.toolName ?? item.tool_name ?? item.name);
                const input = item.arguments ?? item.input ?? {};

                if (method === 'item/started') {
                    events.push(scoped({
                        type: 'mcp_tool_call_begin',
                        call_id: itemId,
                        server,
                        tool,
                        invocation: {
                            server,
                            tool,
                            arguments: input
                        }
                    }));
                }

                if (method === 'item/completed') {
                    const error = item.error;
                    events.push(scoped({
                        type: 'mcp_tool_call_end',
                        call_id: itemId,
                        server,
                        tool,
                        result: error ? { Err: error } : item.result
                    }));
                }

                return events;
            }

            if (itemType === 'collabagenttoolcall') {
                const toolName = normalizeCollabAgentToolName(item.tool ?? item.name);
                if (!toolName) return events;

                if (method === 'item/started') {
                    events.push(scoped({
                        type: 'codex_tool_call_begin',
                        call_id: itemId,
                        name: toolName,
                        input: buildCollabAgentInput(item, toolName)
                    }));
                }

                if (method === 'item/completed') {
                    const status = asString(item.status);
                    events.push(scoped({
                        type: 'codex_tool_call_end',
                        call_id: itemId,
                        name: toolName,
                        output: buildCollabAgentOutput(item, toolName),
                        is_error: status === 'failed' || status === 'error'
                    }));
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

                    events.push(scoped({
                        type: 'patch_apply_begin',
                        call_id: itemId,
                        ...meta
                    }));
                }

                if (method === 'item/completed') {
                    const meta = this.fileChangeMeta.get(itemId) ?? {};
                    const stdout = asString(item.stdout ?? item.output);
                    const stderr = asString(item.stderr);
                    const success = asBoolean(item.success ?? item.ok ?? item.applied ?? item.status === 'completed');

                    events.push(scoped({
                        type: 'patch_apply_end',
                        call_id: itemId,
                        ...meta,
                        ...(stdout ? { stdout } : {}),
                        ...(stderr ? { stderr } : {}),
                        success: success ?? false
                    }));

                    this.fileChangeMeta.delete(itemId);
                }

                return events;
            }
        }

        logger.debug('[AppServerEventConverter] Unhandled notification', { method, params });
        return events;
    }

    reset(): void {
        this.agentMessageBuffers.clear();
        this.reasoningBuffers.clear();
        this.commandOutputBuffers.clear();
        this.commandMeta.clear();
        this.fileChangeMeta.clear();
        this.completedAgentMessageItems.clear();
        this.completedReasoningItems.clear();
        this.reasoningSectionBreakKeys.clear();
        this.lastAgentMessageDeltaByItemId.clear();
        this.lastReasoningDeltaByItemId.clear();
        this.lastCommandOutputDeltaByItemId.clear();
    }
}
