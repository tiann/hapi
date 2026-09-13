import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SessionBootstrapResult } from '@/agent/sessionFactory';
import type { ApiSessionClient } from '@/api/apiSession';
import { logger } from '@/ui/logger';
import { listSlashCommands } from '@/modules/common/slashCommands';
import { normalizeCodexModel } from '@/modules/common/codexModels';
import { formatUserMessageForAgent } from '@/utils/attachmentFormatter';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { CodexAppServerClient } from '../codexAppServerClient';
import { buildHapiMcpBridge, type HapiMcpBridge } from '../utils/buildHapiMcpBridge';
import { buildUserInputFromMessage } from '../utils/appServerConfig';
import { resolveCodexPermissionModeConfig } from '../utils/permissionModeConfig';
import { resolveCodexSlashCommand } from '../utils/slashCommands';
import { parseReasoningEffortValue } from '../utils/reasoningEffort';
import { SharedCodexPermissions } from './permissions';
import { SharedCodexQueue } from './queue';
import { SharedCodexProjection, inputText } from './projection';
import { getCodexSystemPrompt } from '../utils/systemPrompt';
import { record, string } from './gateway';
import { initializeSharedClient, type SharedLaunchOptions } from './launch';
import { inheritedSandbox, settingsMatch } from './settings';

type RuntimeSettings = NonNullable<Parameters<ApiSessionClient['keepAlive']>[2]>;
export type RootHost = {
    directory: string; generation: string; endpoint: string; token?: string;
    settingsFor(threadId: string): Record<string, unknown> | undefined;
    create(method: 'thread/start' | 'thread/fork', params: Record<string, unknown>, parent?: SharedCodexRoot): Promise<SharedCodexRoot>;
    end(root: SharedCodexRoot, nativeArchive?: boolean): Promise<void>;
};
const SettingsSchema = z.object({
    permissionMode: z.enum(['default', 'read-only', 'safe-yolo', 'yolo']).optional(),
    model: z.string().min(1).optional(), modelReasoningEffort: z.string().nullable().optional(),
    collaborationMode: z.enum(['default', 'plan']).optional(),
    serviceTier: z.enum(['fast', 'standard']).nullable().optional(),
    personality: z.enum(['friendly', 'pragmatic', 'none']).optional()
});

/** One immutable HAPI identity + independent subscription for one root. */
export class SharedCodexRoot {
    readonly client: CodexAppServerClient;
    readonly session: ApiSessionClient;
    bridge!: HapiMcpBridge;
    threadId = '';
    private permissions!: SharedCodexPermissions;
    private queue!: SharedCodexQueue;
    private projection!: SharedCodexProjection;
    private readonly children = new Map<string, SharedCodexProjection>();
    private readonly ancestry = new Map<string, string | null>();
    private heartbeat?: ReturnType<typeof setInterval>;
    private work: Promise<unknown> = Promise.resolve();
    private notifications = Promise.resolve();
    private currentTurn: string | undefined;
    private steeringActive: boolean | undefined;
    private turnRevision = 0;
    private settingsRevision = 0;
    private refreshing?: Promise<void>;
    private interrupted = false;
    private closed = false;
    private stopping = false;
    private closing?: Promise<void>;
    private readonly controls = new Set<Promise<unknown>>();
    private reconnecting = false;
    private settings: RuntimeSettings = {};
    private settingsNative: Record<string, unknown> = {};
    private settingsNotification?: Record<string, unknown>;
    private readonly settingsListeners = new Set<() => void>();
    private ready!: () => void;
    private readonly bound = new Promise<void>(resolve => { this.ready = resolve; });

    constructor(readonly bootstrap: SessionBootstrapResult, private readonly host: RootHost) {
        this.session = bootstrap.session;
        this.client = new CodexAppServerClient({ endpoint: host.endpoint, token: host.token, cwd: bootstrap.workingDirectory });
        this.client.setNotificationHandler((method, params) => {
            if (method === 'serverRequest/resolved') {
                this.permissions?.resolved(string(record(params).threadId) ?? '', record(params).requestId); return;
            }
            if (method === 'thread/settings/updated' && record(params).threadId === this.threadId) this.acceptSettings(record(record(params).threadSettings));
            if (record(params).threadId === this.threadId) {
                if (method === 'turn/started') {
                    this.turnRevision++; this.currentTurn = string(record(record(params).turn).id); this.interrupted = false;
                    this.publishSteering();
                }
                if (method === 'turn/completed' && (!this.currentTurn || record(record(params).turn).id === this.currentTurn)) {
                    this.turnRevision++; this.currentTurn = undefined; this.interrupted = record(record(params).turn).status === 'interrupted';
                    this.publishSteering();
                }
            }
            const modelAtReceipt = record(params).threadId === this.threadId ? this.settings.model ?? undefined : undefined;
            this.notifications = this.notifications.then(() => this.notification(method, params, modelAtReceipt)).catch(error => logger.debug('[Codex shared] projection', error));
        });
        this.client.setTransportAbandonedHandler(() => { void this.reconnect(); });
        this.session.onUserMessage((message, localId) => {
            this.work = this.work.catch(() => {}).then(async () => {
                await this.bound;
                if (this.closed || this.stopping) return;
                const id = localId ?? randomUUID();
                // Peer deliveries: annotate From:/Name: and skip slash resolvers so
                // control syntax in peer text stays inert (#1203 / #1618).
                const isPeerDelivery = message.meta?.sentFrom === 'peer';
                const text = formatUserMessageForAgent(
                    message.content.text,
                    message.content.attachments,
                    message.meta
                );
                const resolved = !isPeerDelivery && text.trim().startsWith('/')
                    ? await this.queue.command(id, () => this.command(text))
                    : text;
                if (resolved === null) { this.session.emitMessagesConsumed([id], { clearQueuedThinkingGrace: true }); return; }
                await this.queue.enqueue(id, buildUserInputFromMessage(resolved), this.interrupted);
            }).catch(error => this.notice(`Message not confirmed: ${error instanceof Error ? error.message : error}. Inspect the queue before retrying.`));
        });
        this.session.onCancelQueuedMessage(async id => { await this.bound; return this.stopping ? 'indeterminate' : this.queue.cancel(id); });
        // Absence from history is NOT proof an uncertain mutation failed.
        this.session.onRetryQueuedMessage(async id => {
            await this.bound;
            if (this.stopping) return false;
            await this.refresh();
            return ['rejected', 'canceled', 'released'].includes(this.queue.state(id) ?? '');
        });
        this.session.onReconnect(() => {
            if (!this.threadId || this.closed || this.stopping) return;
            // An emitted socket packet is not a durable hub acknowledgement.
            // Replay final native history with stable IDs after every reconnect.
            this.projection?.reset();
            this.steeringActive = undefined;
            void this.refresh().then(() => this.refreshChildren(false)).then(() => this.queue.replay())
                .catch(error => logger.debug('[Codex shared] hub resync', error));
        });
    }

    async prepare(): Promise<void> {
        this.bridge = await buildHapiMcpBridge(this.session, { exportSessionEnv: false, emitTitleSummary: false,
            skillLookup: { workingDirectory: this.bootstrap.workingDirectory, flavor: 'codex' } });
        await initializeSharedClient(this.client);
        this.permissions = new SharedCodexPermissions(this.session, this.client, this.host.generation);
        this.client.setServerRequestHandler(request => { void this.receiveRequest(request); });
    }
    private async receiveRequest(request: { id: string | number; method: string; params: unknown }): Promise<void> {
        await this.bound;
        if (this.closed || this.stopping) return;
        const threadId = string(record(request.params).threadId);
        // App-server automatically subscribes every initialized connection to
        // newly created threads, including siblings. Never answer their calls.
        if (threadId && await this.ownsThread(threadId)) this.permissions.receive(request);
    }
    private async ownsThread(threadId: string): Promise<boolean> {
        const visited = new Set<string>();
        let candidate: string | null = threadId;
        while (candidate && !visited.has(candidate)) {
            if (candidate === this.threadId) return true;
            visited.add(candidate);
            if (!this.ancestry.has(candidate)) {
                try {
                    const thread = record(record(await this.client.request('thread/read', { threadId: candidate, includeTurns: false })).thread);
                    this.ancestry.set(candidate, string(thread.parentThreadId) ?? null);
                } catch { return false; }
            }
            candidate = this.ancestry.get(candidate) ?? null;
        }
        return false;
    }
    config(params: Record<string, unknown>): Record<string, unknown> {
        return { ...params, cwd: params.cwd ?? this.bootstrap.workingDirectory,
            developerInstructions: params.developerInstructions ?? getCodexSystemPrompt(), config: {
            ...record(params.config), 'mcp_servers.hapi': this.bridge.mcpServers.hapi,
            'shell_environment_policy.set.HAPI_SESSION_ID': this.session.sessionId
        } };
    }
    async bind(threadId: string, response: Record<string, unknown>, subscribe: boolean): Promise<void> {
        if (this.threadId && this.threadId !== threadId) throw new Error('Cannot retarget a shared HAPI session');
        this.threadId = threadId;
        this.queue = new SharedCodexQueue(this.client, threadId, join(this.host.directory, `${this.session.sessionId}.queue.json`),
            (ids, steered) => this.session.emitMessagesConsumed(ids, { steered }), ids => this.session.emitSteerIndeterminate(ids),
            (id, input) => this.session.syncNativeQueuedMessage(id, input === null ? null : inputText(input)),
            ids => this.session.setSteerDeliveryState(ids, 'queued'));
        await this.queue.load();
        this.projection = new SharedCodexProjection(this.session, threadId, id => this.queue.committed(id));
        this.session.updateMetadata(metadata => ({ ...metadata, codexSessionId: threadId, capabilities: {
            ...metadata.capabilities, concurrentClients: true, terminal: true,
            // In-place rewind needs a native + hub commit barrier. Do not
            // advertise a destructive operation we cannot make atomic yet.
            conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: false }
        } }));
        this.session.updateAgentState(state => ({ ...state, controlledByUser: false, startingMode: undefined, requests: {},
            completedRequests: { ...state.completedRequests, ...Object.fromEntries(Object.entries(state.requests ?? {}).map(([id, request]) =>
                [id, { ...request, completedAt: Date.now(), status: 'canceled' as const }])) }
        }));
        if (subscribe) response = record(await this.client.request('thread/resume', { threadId }));
        this.acceptSettings(response); this.acceptSettings(this.host.settingsFor(threadId) ?? {});
        await this.projection.history(response.thread); await this.refresh(); await this.refreshChildren(true);
    }
    async activate(options: SharedLaunchOptions = {}): Promise<void> {
        // Restored input cannot run before the cold-resume settings are applied.
        await this.initialSettings(options);
        if (this.stopping) throw new Error('Codex execution is stopping');
        this.registerControls(); this.ready();
        this.heartbeat = setInterval(() => this.alive(), 2_000); this.alive(); this.session.emitSessionReady();
    }
    private publishSteering(): void {
        const active = Boolean(this.currentTurn) && !this.stopping && !this.closed && !this.reconnecting && this.client.isInitialized();
        if (this.steeringActive === active) return;
        this.steeringActive = active;
        this.session.updateAgentState(state => ({ ...state, steeringActive: active }));
    }
    private alive(): void {
        this.publishSteering();
        if (!this.closed) this.session.keepAlive(Boolean(this.currentTurn), undefined, this.settings);
    }
    acceptSettings(value: Record<string, unknown>): void {
        if (typeof value.model !== 'string') return;
        this.settingsRevision++;
        if ('collaborationMode' in value && 'sandboxPolicy' in value) this.settingsNotification = value;
        this.settingsNative = { ...this.settingsNative, ...value };
        const sandbox = record(value.sandboxPolicy ?? value.sandbox).type;
        this.settings = { ...this.settings, model: value.model,
            modelReasoningEffort: string(value.effort ?? value.reasoningEffort) ?? null,
            ...(sandbox ? { permissionMode: sandbox === 'dangerFullAccess' ? 'yolo' : sandbox === 'readOnly' ? 'read-only' : 'default' } : {}),
            ...('serviceTier' in value ? { serviceTier: value.serviceTier === 'priority' ? 'fast' : 'standard' } : {}),
            ...('collaborationMode' in value ? { collaborationMode: record(value.collaborationMode).mode === 'plan' ? 'plan' as const : 'default' as const } : {})
        };
        for (const listener of this.settingsListeners) listener();
    }
    private async notification(method: string, params: unknown, modelAtReceipt?: string): Promise<void> {
        if (!this.threadId || this.closed) return;
        const p = record(params);
        if (method === 'thread/started') {
            const thread = record(p.thread); const id = string(thread.id);
            if (id) this.ancestry.set(id, string(thread.parentThreadId) ?? null);
        }
        const eventThread = string(p.threadId) ?? string(record(p.thread).id);
        if (eventThread && eventThread !== this.threadId) {
            if (!await this.ownsThread(eventThread)) return;
            let projection = this.children.get(eventThread);
            if (!projection) {
                projection = new SharedCodexProjection(this.session, eventThread, async () => {}, this.threadId);
                this.children.set(eventThread, projection);
            }
            await projection.notification(method, params); return;
        }
        if (method === 'turn/completed') this.session.sendSessionEvent({ type: 'ready' });
        if (method === 'thread/name/updated' && (typeof p.threadName === 'string' || p.threadName === null)) {
            const name = p.threadName ?? undefined; this.session.updateMetadata(metadata => ({ ...metadata, name }));
        }
        if (method === 'thread/archived') { await this.host.end(this, false); return; }
        if (method === 'thread/queue/changed') await this.queue.reconcile();
        await this.projection.notification(method, params, modelAtReceipt); this.alive();
    }
    async readThread(threadId = this.threadId): Promise<Record<string, unknown>> {
        let thread = record(record(await this.client.request('thread/read', { threadId, includeTurns: false })).thread);
        if (thread.historyMode === 'paginated') {
            const turns: unknown[] = []; let cursor: string | undefined;
            do {
                const page = record(await this.client.request('thread/turns/list', { threadId, cursor, sortDirection: 'asc', itemsView: 'full' }));
                if (!Array.isArray(page.data)) throw new Error('Invalid Codex history');
                turns.push(...page.data); cursor = string(page.nextCursor);
            } while (cursor);
            thread.turns = turns;
        } else thread = record(record(await this.client.request('thread/read', { threadId, includeTurns: true })).thread);
        return thread;
    }
    refresh(): Promise<void> {
        return this.refreshing ??= this.refreshNow().finally(() => { this.refreshing = undefined; });
    }
    private async refreshNow(): Promise<void> {
        if (!this.threadId || this.closed || !this.client.isInitialized()) return;
        const revision = this.turnRevision;
        const thread = await this.readThread();
        const turns = Array.isArray(thread.turns) ? thread.turns.map(record) : [];
        if (revision === this.turnRevision) {
            this.currentTurn = string(turns.find(turn => turn.status === 'inProgress')?.id);
            this.interrupted = turns.at(-1)?.status === 'interrupted';
        }
        await this.projection.history(thread); await this.queue.reconcile(); this.alive();
    }
    private async refreshChildren(subscribe: boolean): Promise<void> {
        let cursor: string | undefined;
        do {
            const page = record(await this.client.request('thread/list', { ancestorThreadId: this.threadId, cursor,
                sourceKinds: ['subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther'] }));
            for (const value of Array.isArray(page.data) ? page.data : []) {
                const thread = record(value); const id = string(thread.id);
                if (id && id !== this.threadId) this.ancestry.set(id, string(thread.parentThreadId) ?? null);
                if (id && id !== this.threadId && await this.ownsThread(id) && !this.children.has(id)) {
                    this.children.set(id, new SharedCodexProjection(this.session, id, async () => {}, this.threadId));
                }
            }
            cursor = string(page.nextCursor);
        } while (cursor);
        const loaded = new Set<string>(); cursor = undefined;
        if (subscribe && this.children.size) do {
            const page = record(await this.client.request('thread/loaded/list', { cursor }));
            for (const id of Array.isArray(page.data) ? page.data : []) if (typeof id === 'string') loaded.add(id);
            cursor = string(page.nextCursor);
        } while (cursor);
        for (const [id, projection] of this.children) {
            // Replaying a completed/unloaded child must not start its engine.
            try {
                if (subscribe && loaded.has(id)) await this.client.request('thread/resume', { threadId: id });
                projection.reset(); await projection.history(await this.readThread(id));
            } catch (error) { logger.debug('[Codex shared] child history unavailable', { id, error }); }
        }
    }
    nativeQueueDeleted(nativeId: string): Promise<void> { return this.queue.deleted(nativeId); }
    replaySettings(): Array<{ method: string; params: unknown }> {
        return this.settingsNotification ? [{ method: 'thread/settings/updated', params: {
            threadId: this.threadId, threadSettings: this.settingsNotification
        } }] : [];
    }
    private async reconnect(): Promise<void> {
        if (this.closed || this.stopping || this.reconnecting || !this.threadId) return;
        this.reconnecting = true; this.publishSteering(); this.permissions.close();
        try {
            while (!this.closed && !this.stopping) {
                try {
                    await initializeSharedClient(this.client);
                    if (this.stopping) return;
                    this.permissions = new SharedCodexPermissions(this.session, this.client, `${this.host.generation}:${randomUUID()}`);
                    this.client.setServerRequestHandler(request => { void this.receiveRequest(request); });
                    const settingsRevision = this.settingsRevision;
                    const response = record(await this.client.request('thread/resume', { threadId: this.threadId }));
                    const observedSettings = this.settingsRevision !== settingsRevision;
                    this.acceptSettings(response);
                    if (!observedSettings) this.acceptSettings(this.host.settingsFor(this.threadId) ?? {});
                    this.projection.reset(); await this.refresh(); this.queue.replay(); await this.refreshChildren(true);
                    return;
                } catch (error) {
                    this.permissions.close();
                    logger.debug('[Codex shared] reconnect', error); await new Promise(resolve => setTimeout(resolve, 1_000));
                }
            }
        } finally { this.reconnecting = false; this.publishSteering(); }
    }
    async applySettings(raw: unknown): Promise<{ applied: RuntimeSettings }> {
        const config = SettingsSchema.parse(raw);
        if (config.permissionMode === 'safe-yolo') throw new Error('safe-yolo is not a native shared permission mode; choose default, read-only, or yolo');
        if (Object.keys(config).length === 0) return { applied: this.settings };
        if (typeof config.modelReasoningEffort === 'string') config.modelReasoningEffort = parseReasoningEffortValue(config.modelReasoningEffort);
        if (config.modelReasoningEffort === null) {
            // Native public null means "leave effort alone", not reset. Resolve
            // the selected model's real default instead of publishing a false reset.
            let cursor: string | undefined;
            do {
                const page = await this.client.listModels({ cursor, includeHidden: true });
                const model = page.data?.find(model => (model.model ?? model.id) === (config.model ?? this.settingsNative.model));
                if (model?.defaultReasoningEffort) { config.modelReasoningEffort = model.defaultReasoningEffort; break; }
                cursor = page.nextCursor ?? undefined;
            } while (cursor);
            if (config.modelReasoningEffort === null) throw new Error('Codex did not report a default reasoning effort; choose an explicit effort');
        }
        const revision = this.settingsRevision;
        const permission = config.permissionMode && resolveCodexPermissionModeConfig(config.permissionMode);
        const params = { threadId: this.threadId,
            ...(config.model ? { model: config.model } : {}),
            ...(config.personality ? { personality: config.personality } : {}),
            ...(config.modelReasoningEffort !== undefined ? { effort: config.modelReasoningEffort } : {}),
            ...(config.serviceTier !== undefined ? { serviceTier: config.serviceTier === 'fast' ? 'priority' : null } : {}),
            ...(permission ? { approvalPolicy: permission.approvalPolicy, sandboxPolicy: permission.sandboxPolicy } : {}),
            ...(config.collaborationMode ? { collaborationMode: { mode: config.collaborationMode, settings: {
                model: config.model ?? this.settings.model, reasoning_effort: config.modelReasoningEffort ?? this.settings.modelReasoningEffort,
                developer_instructions: null
            } } } : {})
        };
        let changed!: () => void;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const accepted = new Promise<void>((resolve, reject) => {
            changed = () => { if (this.settingsRevision > revision && settingsMatch(this.settingsNative, params)) resolve(); };
            this.settingsListeners.add(changed);
            timer = setTimeout(() => reject(new Error('Native settings update is not confirmed; reconnect before retrying')), 15_000);
        });
        void accepted.catch(() => {});
        try {
            await this.client.request('thread/settings/update', params);
            // The RPC only acknowledges queueing the settings operation. The
            // native notification, not our submitted candidate, establishes state.
            await accepted; this.alive(); return { applied: this.settings };
        } finally { clearTimeout(timer); this.settingsListeners.delete(changed); }
    }
    async initialSettings(options: SharedLaunchOptions): Promise<void> {
        if (options.collaborationMode) await this.applySettings({ collaborationMode: options.collaborationMode });
    }
    private registerControls(): void {
        const rpc = { registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => {
            this.session.rpcHandlerManager.registerHandler(method, async (raw: unknown) => {
                if (this.stopping) throw new Error('Codex execution is stopping; resume when inactive');
                const pending = handler(raw); this.controls.add(pending);
                try { return await pending; } finally { this.controls.delete(pending); }
            });
        } };
        rpc.registerHandler(RPC_METHODS.ListCodexModels, async raw => {
            const models = []; let cursor: string | undefined;
            do {
                const response = await this.client.listModels({ includeHidden: record(raw).includeHidden === true, cursor });
                models.push(...(response.data ?? []).map(normalizeCodexModel).filter(model => model !== null)); cursor = response.nextCursor ?? undefined;
            } while (cursor);
            return { success: true, models };
        });
        rpc.registerHandler(RPC_METHODS.Switch, async () => { throw new Error('control_mode_not_applicable'); });
        rpc.registerHandler(RPC_METHODS.HandoffLocal, async () => { throw new Error('control_mode_not_applicable'); });
        rpc.registerHandler(RPC_METHODS.Abort, async () => {
            const turnId = this.currentTurn;
            if (turnId) await this.client.request('turn/interrupt', { threadId: this.threadId, turnId });
        });
        rpc.registerHandler(RPC_METHODS.KillSession, async () => { await this.host.end(this); return { success: true }; });
        rpc.registerHandler(RPC_METHODS.SetSessionConfig, raw => this.applySettings(raw));
        rpc.registerHandler(RPC_METHODS.SteerQueuedMessage, async raw => {
            const { localId } = z.object({ localId: z.string().min(1) }).parse(raw);
            const expectedTurnId = this.currentTurn;
            if (!expectedTurnId) return { steered: false, error: 'No active turn' };
            return this.queue.steer(localId, expectedTurnId);
        });
        rpc.registerHandler(RPC_METHODS.ClearConversation, async () => {
            const child = await this.newConversation(); return { sessionId: child.session.sessionId };
        });
        rpc.registerHandler(RPC_METHODS.ForkConversation, async raw => {
            const { messageLocalId } = z.object({ messageLocalId: z.string().optional() }).parse(raw);
            if (this.currentTurn) throw new Error('Session is busy');
            const beforeTurnId = messageLocalId ? this.projection.turnFor(messageLocalId) : undefined;
            if (messageLocalId && !beforeTurnId) throw new Error('No native history point for this message');
            if (messageLocalId) await this.assertBoundary(messageLocalId, beforeTurnId!);
            const child = await this.host.create('thread/fork', { ...this.freshParams(), threadId: this.threadId,
                ...(beforeTurnId ? { beforeTurnId } : {}) }, this);
            await child.initialSettings({ collaborationMode: this.settings.collaborationMode });
            return { nativeSessionId: child.threadId, sessionId: child.session.sessionId };
        });
        rpc.registerHandler(RPC_METHODS.RewindConversation, async () => {
            throw new Error('In-place rewind is not supported for concurrent Codex clients; fork at the message instead');
        });
    }
    private async assertBoundary(localId: string, turnId: string): Promise<Record<string, unknown>> {
        const thread = await this.readThread();
        const turn = (Array.isArray(thread.turns) ? thread.turns.map(record) : []).find(turn => turn.id === turnId);
        const first = (Array.isArray(turn?.items) ? turn.items.map(record) : []).find(item => item.type === 'userMessage');
        const firstId = string(first?.clientId ?? first?.clientUserMessageId) ?? (first?.id ? `codex:${this.threadId}:user:${first.id}` : undefined);
        if (firstId !== localId) throw new Error('Cannot cut inside a steered native turn. Select its first message.');
        return thread;
    }
    freshParams(): Record<string, unknown> {
        const sandbox = inheritedSandbox(this.settingsNative);
        return { ...sandbox, cwd: this.settingsNative.cwd ?? this.bootstrap.workingDirectory, model: this.settingsNative.model, modelProvider: this.settingsNative.modelProvider,
            approvalPolicy: this.settingsNative.approvalPolicy, serviceTier: this.settingsNative.serviceTier,
            approvalsReviewer: this.settingsNative.approvalsReviewer, personality: this.settingsNative.personality,
            developerInstructions: getCodexSystemPrompt(),
            config: { ...record(sandbox.config), model_reasoning_effort: this.settings.modelReasoningEffort ?? undefined } };
    }
    private notice(message: string): void { this.session.sendSessionEvent({ type: 'message', message }); }
    private async newConversation(): Promise<SharedCodexRoot> {
        const child = await this.host.create('thread/start', this.freshParams());
        await child.initialSettings({ collaborationMode: this.settings.collaborationMode }); return child;
    }
    private async command(text: string): Promise<string | null> {
        const command = text.trim();
        if (command === '/clear' || command === '/new') {
            const child = await this.newConversation(); this.notice(`New conversation: /sessions/${child.session.sessionId}`); return null;
        }
        if (command === '/compact') { await this.client.request('thread/compact/start', { threadId: this.threadId }); return null; }
        if (command === '/exit') { this.notice('/exit closes a native terminal, not this Web view. Use End session to archive this conversation.'); return null; }
        if (!command.startsWith('/')) return text;
        const slash = resolveCodexSlashCommand(text, { commands: await listSlashCommands('codex', this.bootstrap.workingDirectory),
            permissionMode: this.settings.permissionMode === 'yolo' ? 'yolo' : this.settings.permissionMode === 'read-only' ? 'read-only' : 'default',
            collaborationMode: this.settings.collaborationMode ?? 'default', model: this.settings.model ?? undefined,
            modelReasoningEffort: parseReasoningEffortValue(this.settings.modelReasoningEffort), serviceTier: this.settings.serviceTier });
        if (slash.kind === 'passthrough') return text;
        if (slash.kind === 'goal') {
            const params = { threadId: this.threadId };
            const response = slash.action === 'show' ? await this.client.request('thread/goal/get', params)
                : slash.action === 'clear' ? await this.client.request('thread/goal/clear', params)
                : await this.client.request('thread/goal/set', { ...params, ...(slash.action === 'set' ? { objective: slash.objective } : { status: slash.action === 'pause' ? 'paused' : 'active' }) });
            this.notice(JSON.stringify(response)); return null;
        }
        if (slash.updates?.proactiveMultiAgent !== undefined) throw new Error('This Codex version uses Ultra reasoning effort instead of a multi-agent toggle');
        if (slash.updates?.model === null) throw new Error('Choose an explicit model in a shared thread');
        if (slash.updates) await this.applySettings(slash.updates);
        if (slash.message) this.notice(slash.message);
        return slash.kind === 'replace' ? slash.text : null;
    }
    stopAccepting(): void {
        this.stopping = true; this.ready();
        this.publishSteering();
        this.session.onReconnect(null); this.client.setTransportAbandonedHandler(null);
    }
    async suspend(): Promise<void> {
        this.stopAccepting();
        await this.work.catch(() => {}); await Promise.allSettled([...this.controls]);
        await this.queue?.suspend();
        // Capture any dequeue/turn that won the race with native deletion.
        if (this.threadId && this.client.isInitialized()) await this.refresh();
    }
    close(archived: boolean): Promise<void> {
        return this.closing ??= (async () => {
            this.stopAccepting(); this.closed = true; clearInterval(this.heartbeat);
            this.permissions?.close();
            await this.client.disconnect(); await this.notifications; await this.queue?.flush(); this.bridge?.server.stop();
            if (archived) this.session.updateMetadata(metadata => ({ ...metadata, lifecycleState: 'archived', lifecycleStateSince: Date.now() }));
            // Inactive is resumable; uploads referenced by pending input must survive.
            this.session.sendSessionDeath(undefined, { preserveUploads: !archived });
            await this.session.flush(); this.session.close();
        })();
    }
}
