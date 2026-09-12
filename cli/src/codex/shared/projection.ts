import { createHash } from 'node:crypto';
import type { ApiSessionClient } from '@/api/apiSession';
import { registerGeneratedImageFromPath } from '@/modules/common/generatedImages';
import { AppServerEventConverter } from '../utils/appServerEventConverter';
import { record, string } from './gateway';

export function inputText(input: unknown): string {
    if (!Array.isArray(input)) return '';
    return input.map(part => {
        const value = record(part);
        return string(value.text) ?? (value.type === 'mention' ? `@"${value.path}"` : value.type === 'skill' ? `$${value.name}`
            : value.type === 'localImage' ? `[Image: ${value.path}]` : value.type === 'image' ? '[Image]' : '');
    }).filter(Boolean).join('\n');
}

/** Canonical V2 stream only. Stable message IDs also deduplicate snapshot replay at the hub. */
export class SharedCodexProjection {
    private converter = new AppServerEventConverter();
    private readonly emitted = new Set<string>();
    private readonly turns = new Map<string, string>();
    private readonly turnModels = new Map<string, string>();
    constructor(private readonly session: ApiSessionClient, readonly threadId: string,
        private readonly committed: (id: string) => Promise<void>, private readonly parentThreadId?: string) {
        if (!parentThreadId) for (const [id, turn] of Object.entries(session.getMetadata()?.conversationHistoryTurns ?? {})) this.turns.set(id, turn);
    }

    turnFor(id: string): string | undefined { return this.turns.get(id); }
    reset(): void { this.converter = new AppServerEventConverter(); this.emitted.clear(); }
    private send(body: Record<string, unknown>, key: string): void {
        if (this.emitted.has(key)) return;
        this.emitted.add(key);
        const id = `codex:${this.threadId}:${key}`;
        this.session.sendAgentMessage(this.parentThreadId && !String(body.type).startsWith('agent-run-') ? {
            type: 'agent-run-trace', agentId: this.threadId, cardId: `codex-agent:${this.threadId}`, message: { ...body, id }, id,
            scope: { role: 'child', threadId: this.threadId, parentThreadId: this.parentThreadId }, scope_role: 'child'
        } : { ...body, id }, id);
    }

    async notification(method: string, params: unknown, modelAtReceipt?: string): Promise<void> {
        if (method.startsWith('codex/event/')) return;
        const p = record(params);
        const item = record(p.item);
        const turnId = string(p.turnId) ?? string(record(p.turn).id);
        // Settings may already describe the next turn by the time queued
        // notifications are projected. Never attribute usage to that model.
        if (turnId && method === 'turn/started' && modelAtReceipt && !this.turnModels.has(turnId)) {
            this.turnModels.set(turnId, modelAtReceipt);
        }
        if (turnId && method === 'model/rerouted' && string(p.toModel)) {
            this.turnModels.set(turnId, string(p.toModel)!);
        }
        const itemId = string(item.id) ?? string(p.itemId);
        if (!this.parentThreadId && (method === 'item/started' || method === 'item/completed') && item.type === 'userMessage') {
            const id = string(item.clientId ?? item.clientUserMessageId) ?? (itemId ? `codex:${this.threadId}:user:${itemId}` : undefined);
            if (id) {
                const firstInTurn = turnId ? [...this.turns].find(([, value]) => value === turnId)?.[0] : undefined;
                if (turnId) this.turns.set(id, turnId);
                await this.committed(id);
                const text = inputText(item.content);
                if (text) this.session.sendUserMessage(text, undefined, id);
                this.session.updateMetadata(metadata => ({ ...metadata, conversationHistoryTurns: Object.fromEntries(this.turns),
                    ...(turnId && (!firstInTurn || firstInTurn === id) ? { conversationHistoryPoints: { ...metadata.conversationHistoryPoints, [id]: true } } : {})
                }));
            }
        }
        if (this.parentThreadId && (method === 'turn/started' || method === 'turn/completed')) {
            this.send({ type: 'agent-run-update', agentId: this.threadId, cardId: `codex-agent:${this.threadId}`,
                status: method === 'turn/started' ? 'running' : record(p.turn).status === 'completed' ? 'completed' : 'failed'
            }, `lifecycle:${turnId}:${method}`);
        }
        const events = this.converter.handleNotification(method, params);
        for (const event of events) {
            const callId = string(event.call_id);
            const key = `${turnId ?? 'thread'}:${itemId ?? callId ?? createHash('sha256').update(JSON.stringify(event)).digest('hex')}:${event.type}`;
            if (event.type === 'agent_message') this.send({ type: 'message', message: event.message }, key);
            else if (event.type === 'agent_reasoning') this.send({ type: 'reasoning', message: event.text }, key);
            else if (event.type === 'exec_command_begin' && callId) {
                this.send({ type: 'tool-call', name: 'CodexBash', callId, input: event }, key);
            } else if (event.type === 'exec_command_end' && callId) {
                this.send({ type: 'tool-call-result', callId, output: { ...event, stdout: event.output } }, key);
            } else if (event.type === 'patch_apply_begin' && callId) {
                this.send({ type: 'tool-call', name: 'CodexPatch', callId, input: { changes: event.changes, auto_approved: event.auto_approved } }, key);
            } else if (event.type === 'patch_apply_end' && callId) {
                this.send({ type: 'tool-call-result', callId, output: { stdout: event.stdout, stderr: event.stderr, success: event.success } }, key);
            } else if (event.type === 'mcp_tool_call_begin' && callId) {
                const invocation = record(event.invocation);
                this.send({ type: 'tool-call', name: `mcp__${invocation.server}__${invocation.tool}`, callId, input: invocation.arguments ?? {} }, key);
            } else if (event.type === 'mcp_tool_call_end' && callId) {
                const result = record(event.result);
                this.send({ type: 'tool-call-result', callId, output: result.Ok ?? result.Err ?? event.result, is_error: 'Err' in result }, key);
            } else if (event.type === 'codex_tool_call_begin' && callId) {
                this.send({ type: 'tool-call', name: event.name, callId, input: event.input ?? event.arguments }, key);
            } else if (event.type === 'codex_tool_call_end' && callId) {
                this.send({ type: 'tool-call-result', callId, output: event.output, is_error: event.is_error }, key);
            } else if (event.type === 'token_count' || event.type === 'context_compacted' || event.type.startsWith('thread_goal_')) {
                const model = event.type === 'token_count' && turnId ? this.turnModels.get(turnId) : undefined;
                this.send({ ...event, ...(model ? { model } : {}), flavor: 'codex', scope: { role: 'parent', threadId: this.threadId }, scope_role: 'parent', thread_id: this.threadId }, key);
            } else if (event.type === 'plan_update') {
                this.send({ type: 'tool-call', name: 'update_plan', callId: 'codex-plan-state', input: { plan: event.plan, source: 'codex' } }, key);
                this.send({ type: 'tool-call-result', callId: 'codex-plan-state', output: { plan: event.plan, source: 'codex', status: 'updated' } }, `${key}:result`);
            } else if (event.type === 'generated_image' && typeof event.saved_path === 'string') {
                const image = await registerGeneratedImageFromPath({ path: event.saved_path, id: createHash('sha256').update(`${this.threadId}:${key}`).digest('hex'), fileName: string(event.file_name) });
                if (image) this.send({ type: 'generated-image', imageId: image.id, fileName: image.fileName, mimeType: image.mimeType }, key);
            } else if (event.type === 'task_failed') {
                this.send({ type: 'message', message: `Codex error: ${event.error ?? event.message ?? 'Turn failed'}` }, key);
            }
        }
        if (item.type === 'collabAgentToolCall') {
            const states = record(item.agentsStates);
            for (const [agentId, state] of Object.entries(states)) {
                const status = string(record(state).status) ?? 'running';
                this.send({ type: 'agent-run-update', agentId, cardId: `codex-agent:${agentId}`,
                    status: status === 'completed' ? 'completed' : status === 'errored' ? 'failed' : 'running',
                    summary: record(state).message, input: item, scope: { role: 'child', threadId: agentId, parentThreadId: this.threadId }, scope_role: 'child', thread_id: agentId
                }, `agent:${agentId}:${itemId}:${method}:${JSON.stringify(state)}`);
            }
        }
    }

    async history(thread: unknown): Promise<void> {
        const turns = record(thread).turns;
        if (!Array.isArray(turns)) return;
        for (const value of turns) {
            const turn = record(value);
            if (!Array.isArray(turn.items)) continue;
            for (const item of turn.items) {
                const params = { threadId: this.threadId, turnId: turn.id, item };
                await this.notification('item/started', params);
                // Active snapshots can contain partial assistant text. Do not
                // settle it under the final stable id and suppress completion.
                if (turn.status !== 'inProgress' || record(item).status === 'completed' || record(item).type === 'userMessage') {
                    await this.notification('item/completed', params);
                }
            }
        }
    }
}
