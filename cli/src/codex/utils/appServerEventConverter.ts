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

function decodeBase64Chunk(value: unknown): string | null {
    const raw = asString(value);
    if (!raw) return null;

    try {
        return Buffer.from(raw, 'base64').toString('utf8');
    } catch {
        return null;
    }
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

function mergeDeltaText(previous: string, incoming: string): string {
    if (!previous) return incoming;
    if (!incoming) return previous;

    // Some transports emit cumulative snapshots instead of append-only deltas.
    // If incoming already includes previous, treat it as full replacement.
    if (incoming.startsWith(previous)) {
        return incoming;
    }

    // Duplicate replay of the same chunk; keep existing buffer.
    if (previous.endsWith(incoming)) {
        return previous;
    }

    // Overlap-safe append: append only non-overlapping suffix.
    const maxOverlap = Math.min(previous.length, incoming.length);
    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
        if (previous.slice(previous.length - overlap) === incoming.slice(0, overlap)) {
            return previous + incoming.slice(overlap);
        }
    }

    return previous + incoming;
}

export class AppServerEventConverter {
    private readonly agentMessageBuffers = new Map<string, string>();
    private readonly reasoningBuffers = new Map<string, string>();
    private readonly commandOutputBuffers = new Map<string, string>();
    private readonly commandMeta = new Map<string, Record<string, unknown>>();
    private readonly fileChangeMeta = new Map<string, Record<string, unknown>>();
    private readonly completedItemKeys = new Set<string>();

    handleNotification(method: string, params: unknown): ConvertedEvent[] {
        const events: ConvertedEvent[] = [];
        const paramsRecord = asRecord(params) ?? {};

        if (method === 'account/rateLimits/updated') {
            return events;
        }

        if (method === 'item/reasoning/summaryTextDelta') {
            return events;
        }

        if (method.startsWith('codex/event/')) {
            const msg = asRecord(paramsRecord.msg) ?? {};
            const msgType = asString(msg.type) ?? method.slice('codex/event/'.length);

            if (!msgType) {
                return events;
            }

            if (msgType === 'agent_message_delta' || msgType === 'agent_reasoning_delta') {
                return events;
            }

            if (msgType === 'agent_message_content_delta') {
                const itemId = asString(msg.item_id ?? msg.itemId);
                const delta = asString(msg.delta);
                if (itemId && delta) {
                    return this.handleNotification('item/agentMessage/delta', { itemId, delta });
                }
                return events;
            }

            if (msgType === 'reasoning_content_delta') {
                const itemId = asString(msg.item_id ?? msg.itemId);
                const delta = asString(msg.delta);
                if (delta) {
                    return this.handleNotification('item/reasoning/textDelta', { itemId, delta });
                }
                return events;
            }

            if (msgType === 'agent_reasoning_section_break') {
                return this.handleNotification('item/reasoning/summaryPartAdded', {});
            }

            if (msgType === 'item_started' || msgType === 'item_completed') {
                return this.handleNotification(
                    msgType === 'item_started' ? 'item/started' : 'item/completed',
                    msg
                );
            }

            if (msgType === 'task_started' || msgType === 'task_complete') {
                const turnId = asString(msg.turn_id ?? msg.turnId ?? paramsRecord.id);
                return this.handleNotification(
                    msgType === 'task_started' ? 'turn/started' : 'turn/completed',
                    {
                        turn: turnId ? { id: turnId } : {},
                        ...(msgType === 'task_complete' ? { status: 'completed' } : {})
                    }
                );
            }

            if (msgType === 'turn_diff') {
                return this.handleNotification('turn/diff/updated', {
                    diff: msg.unified_diff ?? msg.unifiedDiff
                });
            }

            if (msgType === 'plan_update') {
                return this.handleNotification('turn/plan/updated', {
                    plan: msg.plan
                });
            }

            if (msgType === 'exec_command_output_delta') {
                const itemId = asString(msg.call_id ?? msg.callId);
                const delta = decodeBase64Chunk(msg.chunk) ?? asString(msg.chunk);
                if (itemId && delta) {
                    return this.handleNotification('item/commandExecution/outputDelta', { itemId, delta });
                }
                return events;
            }

            if (msgType === 'exec_command_begin') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (!callId) return events;

                const command = extractCommand(msg.command);
                const cwd = asString(msg.cwd);
                const event: ConvertedEvent = {
                    type: 'exec_command_begin',
                    call_id: callId
                };
                if (command) event.command = command;
                if (cwd) event.cwd = cwd;
                if (msg.source !== undefined) event.source = msg.source;
                if (msg.parsed_cmd !== undefined) event.parsed_cmd = msg.parsed_cmd;
                if (msg.process_id !== undefined) event.process_id = msg.process_id;
                if (msg.turn_id !== undefined) event.turn_id = msg.turn_id;
                return [event];
            }

            if (msgType === 'exec_command_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (!callId) return events;

                const command = extractCommand(msg.command);
                const cwd = asString(msg.cwd);
                const output =
                    asString(msg.formatted_output)
                    ?? asString(msg.aggregated_output)
                    ?? asString(msg.stdout)
                    ?? asString(msg.output)
                    ?? this.commandOutputBuffers.get(callId);
                const stderr = asString(msg.stderr);
                const error = asString(msg.error);
                const exitCode = asNumber(msg.exit_code ?? msg.exitCode);

                const event: ConvertedEvent = {
                    type: 'exec_command_end',
                    call_id: callId
                };
                if (command) event.command = command;
                if (cwd) event.cwd = cwd;
                if (output) event.output = output;
                if (stderr) event.stderr = stderr;
                if (error) event.error = error;
                if (exitCode !== null) event.exit_code = exitCode;
                if (msg.source !== undefined) event.source = msg.source;
                if (msg.parsed_cmd !== undefined) event.parsed_cmd = msg.parsed_cmd;
                if (msg.process_id !== undefined) event.process_id = msg.process_id;
                if (msg.turn_id !== undefined) event.turn_id = msg.turn_id;
                this.commandOutputBuffers.delete(callId);
                return [event];
            }

            if (msgType === 'token_count') {
                events.push({
                    type: 'token_count',
                    info: asRecord(msg.info) ?? null,
                    ...(msg.rate_limits !== undefined ? { rate_limits: msg.rate_limits } : {})
                });
                return events;
            }

            if (msgType === 'patch_apply_begin' || msgType === 'patch_apply_end'
                || msgType === 'mcp_startup_update' || msgType === 'mcp_startup_complete'
                || msgType === 'mcp_tool_call_begin' || msgType === 'mcp_tool_call_end'
                || msgType === 'web_search_begin' || msgType === 'web_search_end'
                || msgType === 'context_compacted') {
                events.push({
                    type: msgType,
                    ...msg
                });
                return events;
            }
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
            const errorMessage = asString(paramsRecord.error ?? paramsRecord.message ?? paramsRecord.reason);

            if (status === 'interrupted' || status === 'cancelled' || status === 'canceled') {
                events.push({ type: 'turn_aborted', ...(turnId ? { turn_id: turnId } : {}) });
                return events;
            }

            if (status === 'failed' || status === 'error') {
                events.push({ type: 'task_failed', ...(turnId ? { turn_id: turnId } : {}), ...(errorMessage ? { error: errorMessage } : {}) });
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

        if (method === 'turn/plan/updated') {
            const plan = Array.isArray(paramsRecord.plan) ? paramsRecord.plan : [];
            events.push({
                type: 'turn_plan_updated',
                entries: plan
            });
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
                events.push({ type: 'task_failed', error: message });
            }
            return events;
        }

        if (method === 'item/agentMessage/delta') {
            const itemId = extractItemId(paramsRecord);
            const delta = asString(paramsRecord.delta ?? paramsRecord.text ?? paramsRecord.message);
            if (itemId && delta) {
                const prev = this.agentMessageBuffers.get(itemId) ?? '';
                this.agentMessageBuffers.set(itemId, mergeDeltaText(prev, delta));
            }
            return events;
        }

        if (method === 'item/reasoning/textDelta') {
            const itemId = extractItemId(paramsRecord) ?? 'reasoning';
            const delta = asString(paramsRecord.delta ?? paramsRecord.text ?? paramsRecord.message);
            if (delta) {
                const prev = this.reasoningBuffers.get(itemId) ?? '';
                this.reasoningBuffers.set(itemId, mergeDeltaText(prev, delta));
                events.push({ type: 'agent_reasoning_delta', delta });
            }
            return events;
        }

        if (method === 'item/reasoning/summaryPartAdded') {
            events.push({ type: 'agent_reasoning_section_break' });
            return events;
        }

        if (method === 'item/commandExecution/outputDelta') {
            const itemId = extractItemId(paramsRecord);
            const delta = asString(paramsRecord.delta ?? paramsRecord.text ?? paramsRecord.output ?? paramsRecord.stdout);
            if (itemId && delta) {
                const prev = this.commandOutputBuffers.get(itemId) ?? '';
                this.commandOutputBuffers.set(itemId, mergeDeltaText(prev, delta));
            }
            return events;
        }

        if (method === 'item/fileChange/outputDelta') {
            const itemId = extractItemId(paramsRecord);
            const delta = asString(paramsRecord.delta ?? paramsRecord.text ?? paramsRecord.output ?? paramsRecord.stdout);
            if (itemId && delta) {
                const meta = this.fileChangeMeta.get(itemId) ?? {};
                const previousOutput = asString(meta.stdout) ?? '';
                this.fileChangeMeta.set(itemId, {
                    ...meta,
                    stdout: mergeDeltaText(previousOutput, delta)
                });
            }
            return events;
        }

        if (method === 'item/plan/delta') {
            const delta = asString(paramsRecord.delta ?? paramsRecord.text);
            if (delta) {
                events.push({ type: 'plan_delta', delta });
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

            const completionKey = `${itemType}:${itemId}`;
            if (method === 'item/started') {
                this.completedItemKeys.delete(completionKey);
            } else if (this.completedItemKeys.has(completionKey)) {
                return events;
            }

            if (itemType === 'usermessage' || itemType === 'mcptoolcall' || itemType === 'websearch') {
                if (method === 'item/completed') {
                    this.completedItemKeys.add(completionKey);
                }
                return events;
            }

            if (itemType === 'agentmessage') {
                if (method === 'item/completed') {
                    const text = asString(item.text ?? item.message ?? item.content) ?? this.agentMessageBuffers.get(itemId);
                    if (text) {
                        events.push({ type: 'agent_message', message: text });
                    }
                    this.agentMessageBuffers.delete(itemId);
                    this.completedItemKeys.add(completionKey);
                }
                return events;
            }

            if (itemType === 'reasoning') {
                if (method === 'item/completed') {
                    const text = asString(item.text ?? item.message ?? item.content) ?? this.reasoningBuffers.get(itemId);
                    if (text) {
                        events.push({ type: 'agent_reasoning', text });
                    }
                    this.reasoningBuffers.delete(itemId);
                    this.completedItemKeys.add(completionKey);
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
                    this.completedItemKeys.add(completionKey);
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
                    this.completedItemKeys.add(completionKey);
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
        this.completedItemKeys.clear();
    }
}
