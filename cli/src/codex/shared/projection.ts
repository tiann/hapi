import { createHash, randomUUID } from 'node:crypto';
import type { ApiSessionClient } from '@/api/apiSession';
import { normalizeSessionDisplayTitle } from '@/agent/sessionDisplayRename';
import { registerGeneratedImageFromPath } from '@/modules/common/generatedImages';
import { AppServerEventConverter } from '../utils/appServerEventConverter';
import { record, string } from './gateway';
import { codexPlanProposalId } from './plan';
import { childIdentity, ChildTurnContexts, type ChildExecution } from './childMetadata';

export function inputText(input: unknown): string {
    if (!Array.isArray(input)) return '';
    return input.map(part => {
        const value = record(part);
        return string(value.text) ?? (value.type === 'mention' ? `@"${value.path}"` : value.type === 'skill' ? `$${value.name}`
            : value.type === 'localImage' ? `[Image: ${value.path}]` : value.type === 'image' ? '[Image]' : '');
    }).filter(Boolean).join('\n');
}

function requestedTitle(item: Record<string, unknown>): string | undefined {
    if (item.type !== 'mcpToolCall' || item.server !== 'hapi' || item.tool !== 'change_title') return;
    return normalizeSessionDisplayTitle(string(record(item.arguments).title)) ?? undefined;
}

function successfulTitle(item: Record<string, unknown>, pending?: string): string | undefined {
    if (item.type !== 'mcpToolCall' || (item.status !== undefined && item.status !== 'completed')
        || item.error != null || item.result == null) return;
    const result = record(item.result);
    if ('Err' in result || result.isError === true || record(result.Ok).isError === true) return;
    return requestedTitle(item) ?? pending;
}

function metadataHasDisplayTitle(metadata: { name?: string; summary?: { text: string } } | null | undefined): boolean {
    return Boolean(metadata?.name?.trim() || metadata?.summary?.text?.trim());
}

function nativeTurnTimes(turn: unknown): Record<string, number> {
    const value = record(turn);
    return {
        ...(typeof value.startedAt === 'number' && Number.isFinite(value.startedAt) ? { startedAt: value.startedAt * 1000 } : {}),
        ...(typeof value.completedAt === 'number' && Number.isFinite(value.completedAt) ? { completedAt: value.completedAt * 1000 } : {})
    };
}

/** Canonical V2 stream only. Stable message IDs also deduplicate snapshot replay at the hub. */
export class SharedCodexProjection {
    private converter = new AppServerEventConverter();
    private readonly emitted = new Set<string>();
    private readonly turns = new Map<string, string>();
    private readonly turnModels = new Map<string, string>();
    // Unlike transcript emission, title side effects survive reset/replay.
    private readonly pendingTitles = new Map<string, string>();
    private readonly completedTitles = new Set<string>();
    private titleRevision = 0;
    private readonly childContexts: ChildTurnContexts;
    private evidenceRetries = 0;
    private nextEvidenceAt = 0;
    private readingEvidence = false;
    private childTurnId?: string;
    private readonly knownChildTurns = new Set<string>();
    private readonly liveChildTurns = new Set<string>();
    private readonly rerouted = new Map<string, string>();
    private readonly metadataRun = randomUUID();
    private executionRevision = 0;
    private lastExecution?: string;
    private metadata(body: Record<string, unknown>): void {
        const fingerprint = JSON.stringify(body);
        if (body.agentExecution && this.lastExecution === fingerprint) return;
        if (body.agentExecution) this.lastExecution = fingerprint;
        this.send({ type: 'agent-run-update', agentId: this.threadId, cardId: `codex-agent:${this.threadId}`,
            metadataOnly: true, input: body }, body.agentExecution ? `execution:${this.metadataRun}:${++this.executionRevision}` : `metadata:${createHash('sha256').update(fingerprint).digest('hex')}`);
    }
    childThread(thread: unknown): void {
        if (!this.parentThreadId) return;
        const t = record(thread);
        if (t.id !== this.threadId) return;
        this.childContexts.setPath(t.path);
        const identity = childIdentity(t);
        if (Object.keys(identity).length) this.metadata({ agentIdentity: identity });
    }
    async refreshEvidence(): Promise<void> {
        if (!this.childTurnId || !this.evidenceRetries || this.readingEvidence || Date.now() < this.nextEvidenceAt) return;
        this.nextEvidenceAt = Date.now() + 2_000;
        this.evidenceRetries--; this.readingEvidence = true;
        try { await this.childExecution(this.childTurnId); } finally { this.readingEvidence = false; }
    }
    private async childExecution(turnId: string): Promise<void> {
        const context = await this.childContexts.read(turnId, this.liveChildTurns.has(turnId) ? this.threadId : undefined);
        const model = this.rerouted.get(turnId);
        if (context?.model && context.reasoningEffort && turnId === this.childTurnId) this.evidenceRetries = 0;
        if (context || model) {
            const execution: ChildExecution = { turnId, model: model ?? context?.model ?? null,
                reasoningEffort: context?.reasoningEffort ?? null, source: model ? 'codex-model-rerouted' : 'codex-turn-context' };
            this.metadata({ agentExecution: execution });
        }
    }
    constructor(private readonly session: ApiSessionClient, readonly threadId: string,
        private readonly committed: (id: string) => Promise<void>, private readonly parentThreadId?: string) {
        this.childContexts = new ChildTurnContexts(threadId);
        if (!parentThreadId) for (const [id, turn] of Object.entries(session.getMetadata()?.conversationHistoryTurns ?? {})) this.turns.set(id, turn);
    }

    turnFor(id: string): string | undefined { return this.turns.get(id); }
    reset(): void { this.converter = new AppServerEventConverter(); this.emitted.clear(); this.lastExecution = undefined; }
    private send(body: Record<string, unknown>, key: string): void {
        if (this.emitted.has(key)) return;
        this.emitted.add(key);
        const id = `codex:${this.threadId}:${key}`;
        this.session.sendAgentMessage(this.parentThreadId && !String(body.type).startsWith('agent-run-') ? {
            type: 'agent-run-trace', agentId: this.threadId, cardId: `codex-agent:${this.threadId}`, message: { ...body, id }, id,
            scope: { role: 'child', threadId: this.threadId, parentThreadId: this.parentThreadId }, scope_role: 'child'
        } : { ...body, id }, id);
    }

    private applyDisplayRename(title: string, revision: number): void {
        this.session.updateMetadata(metadata => {
            if (revision !== this.titleRevision) return metadata;
            const normalized = normalizeSessionDisplayTitle(title);
            if (!normalized || metadata.name?.trim() === normalized) return metadata;
            return { ...metadata, name: normalized };
        });
    }

    async notification(method: string, params: unknown, modelAtReceipt?: string): Promise<void> {
        const p = record(params);
        const item = record(p.item);
        // Only real child-scoped notifications attest own turns. history/project also
        // replays inherited items and must never turn those into live provenance.
        if (this.parentThreadId && p.threadId === this.threadId
            && (method === 'turn/started' || method === 'turn/completed' || method === 'model/rerouted')) {
            const turnId = string(p.turnId) ?? string(record(p.turn).id);
            if (turnId) this.liveChildTurns.add(turnId);
        }
        if (!this.parentThreadId && p.threadId === this.threadId && string(item.id)) {
            const key = `${string(p.turnId) ?? 'thread'}:${item.id}`;
            if (!this.completedTitles.has(key)) {
                const title = requestedTitle(item);
                if (method === 'item/started' && title) this.pendingTitles.set(key, title);
                if (method === 'item/completed') {
                    const completedTitle = successfulTitle(item, this.pendingTitles.get(key));
                    this.pendingTitles.delete(key);
                    if (completedTitle) {
                        this.completedTitles.add(key);
                        const revision = ++this.titleRevision;
                        this.applyDisplayRename(completedTitle, revision);
                    }
                }
            }
        }
        await this.project(method, params, modelAtReceipt);
    }

    private async project(method: string, params: unknown, modelAtReceipt?: string): Promise<void> {
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
        if (this.parentThreadId) {
            if (method === 'thread/started') this.childThread(p.thread);
            if (method === 'model/rerouted' && turnId && string(p.toModel)) this.rerouted.set(turnId, string(p.toModel)!);
            if (method === 'turn/started' && turnId && (!this.knownChildTurns.has(turnId) || this.childTurnId === turnId)) {
                this.knownChildTurns.add(turnId); this.childTurnId = turnId; this.evidenceRetries = 15; this.nextEvidenceAt = 0;
            }
            if (method === 'turn/completed' && turnId) this.knownChildTurns.add(turnId);
            if (method === 'turn/completed' && turnId && (!this.childTurnId || this.childTurnId === turnId)) { this.childTurnId = turnId; this.evidenceRetries = 15; this.nextEvidenceAt = 0; }
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
        if (this.parentThreadId && ((method === 'turn/started' || method === 'turn/completed') && this.childTurnId === turnId)) {
            this.send({ type: 'agent-run-update', agentId: this.threadId, cardId: `codex-agent:${this.threadId}`,
                turnId, ...nativeTurnTimes(p.turn), activityKind: method === 'turn/started' ? 'turn_started' : 'turn_completed',
                input: { agentExecution: { turnId, model: null, reasoningEffort: null } },
                status: method === 'turn/started' ? 'running' : record(p.turn).status === 'completed' ? 'completed' : record(p.turn).status === 'interrupted' ? 'interrupted' : record(p.turn).status === 'failed' ? 'failed' : 'unknown'
            }, `lifecycle:${turnId}:${method}`);
        }
        if (this.parentThreadId && (turnId ?? this.childTurnId)) await this.childExecution((turnId ?? this.childTurnId)!);
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
            } else if (event.type === 'proposed_plan' && turnId && itemId) {
                const planId = codexPlanProposalId(this.threadId, turnId, itemId);
                this.send({ type: 'tool-call', name: 'ExitPlanMode', callId: planId, input: { plan: event.plan } }, key);
                // A proposal is durable content, not a native approval request.
                this.send({ type: 'tool-call-result', callId: planId, output: null }, `${key}:result`);
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
        if (item.type === 'subAgentActivity' && string(item.agentThreadId) && string(item.agentPath)) {
            const agentId = string(item.agentThreadId)!;
            const path = string(item.agentPath)!;
            this.send({ type: 'agent-run-update', agentId, cardId: `codex-agent:${agentId}`, metadataOnly: true,
                input: { agentIdentity: { agentPath: path, taskName: path.split('/').filter(Boolean).at(-1) } }
            }, `agent-path:${agentId}:${path}`);
        }
        if (item.type === 'collabAgentToolCall') {
            const states = record(item.agentsStates);
            for (const [agentId, state] of Object.entries(states)) {
                const status = string(record(state).status);
                this.send({ type: 'agent-run-update', agentId, cardId: `codex-agent:${agentId}`,
                    ...(status ? { status: status === 'completed' ? 'completed' : status === 'errored' ? 'failed' : status } : { metadataOnly: true }),
                    summary: record(state).message, input: item, scope: { role: 'child', threadId: agentId, parentThreadId: this.threadId }, scope_role: 'child', thread_id: agentId
                }, `agent:${agentId}:${itemId}:${method}:${JSON.stringify(state)}`);
            }
        }
    }

    async history(thread: unknown): Promise<void> {
        this.childThread(thread);
        const turns = record(thread).turns;
        if (!Array.isArray(turns)) return;
        if (this.parentThreadId) {
            const last = record(turns.at(-1));
            const turnOrder = turns.map(value => string(record(value).id)).filter((id): id is string => Boolean(id));
            const id = string(last.id);
            // A full native history establishes order even when timestamps are null or have equal seconds.
            // If the snapshot lacks a turn already observed live, it is stale.
            if (id && (!this.childTurnId || turnOrder.includes(this.childTurnId))) {
                for (const turn of turnOrder) this.knownChildTurns.add(turn);
                this.childTurnId = id; this.evidenceRetries = 15; this.nextEvidenceAt = 0;
                this.send({ type: 'agent-run-update', agentId: this.threadId, cardId: `codex-agent:${this.threadId}`,
                    turnId: id, turnOrder, ...nativeTurnTimes(last), activityKind: 'turn_snapshot',
                    input: { agentExecution: { turnId: id, model: null, reasoningEffort: null } },
                    status: last.status === 'inProgress' ? 'running' : last.status === 'completed' ? 'completed' : last.status === 'interrupted' ? 'interrupted' : last.status === 'failed' ? 'failed' : 'unknown'
                }, `snapshot:${id}:${last.status}:${createHash('sha256').update(JSON.stringify(turnOrder)).digest('hex')}:${last.startedAt ?? 'unknown'}:${last.completedAt ?? 'unknown'}`);
                await this.childExecution(id);
            }
        }
        const titleRevision = this.titleRevision;
        let latestTitle: string | undefined;
        for (const value of turns) {
            const turn = record(value);
            if (!Array.isArray(turn.items)) continue;

            for (const item of turn.items) {
                const params = { threadId: this.threadId, turnId: turn.id, item };
                const titleKey = `${string(turn.id) ?? 'thread'}:${record(item).id}`;
                const pendingTitle = requestedTitle(record(item));
                if (!this.parentThreadId && string(record(item).id) && pendingTitle && !this.completedTitles.has(titleKey)) {
                    this.pendingTitles.set(titleKey, pendingTitle);
                }
                await this.project('item/started', params);
                // Active snapshots can contain partial assistant text. Do not
                // settle it under the final stable id and suppress completion.
                if (turn.status !== 'inProgress' || record(item).status === 'completed' || record(item).type === 'userMessage') {
                    if (!this.parentThreadId) {
                        const title = successfulTitle(record(item));
                        if (title && string(record(item).id)) {
                            latestTitle = title;
                            this.completedTitles.add(titleKey);
                        }
                        this.pendingTitles.delete(titleKey);
                    }
                    await this.project('item/completed', params);
                }
            }
        }
        // Repair sessions created while remote title projection was missing.
        // Recheck inside the metadata lock: live updates may still be queued,
        // and a replay must never replace an existing or newer display title.
        if (latestTitle && titleRevision === this.titleRevision && !metadataHasDisplayTitle(this.session.getMetadata())) {
            const title = latestTitle;
            this.session.updateMetadata(metadata => {
                if (titleRevision !== this.titleRevision || metadataHasDisplayTitle(metadata)) {
                    return metadata;
                }
                const normalized = normalizeSessionDisplayTitle(title);
                if (!normalized) return metadata;
                return { ...metadata, name: normalized };
            });
        }
    }
}
