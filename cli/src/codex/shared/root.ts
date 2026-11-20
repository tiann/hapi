import { fromCodexServiceTier, toCodexServiceTier } from '@hapi/protocol';
import { catalogConfigurationMatches, isUltrafastAvailable, isUltrafastEnabled, ULTRAFAST_FALLBACK_NOTICE, ULTRAFAST_DISABLED_NOTICE } from '../utils/serviceTier';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SessionBootstrapResult } from '@/agent/sessionFactory';
import type { ApiSessionClient } from '@/api/apiSession';
import { SESSION_KEEP_ALIVE_INTERVAL_MS } from '@/api/keepAlive';
import { logger } from '@/ui/logger';
import { listSlashCommands } from '@/modules/common/slashCommands';
import { normalizeCodexModel } from '@/modules/common/codexModels';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { ImplementCodexPlanRequestSchema, type ImplementCodexPlanResult } from '@hapi/protocol/apiTypes';
import { CodexAppServerClient, isIndeterminateError } from '../codexAppServerClient';
import { buildHapiMcpBridge, type HapiMcpBridge } from '../utils/buildHapiMcpBridge';
import { buildUserInputFromMessage } from '../utils/appServerConfig';
import { resolveCodexPermissionModeConfig } from '../utils/permissionModeConfig';
import { resolveCodexSlashCommand } from '../utils/slashCommands';
import { parseReasoningEffortValue } from '../utils/reasoningEffort';
import { SharedCodexPermissions } from './permissions';
import { SharedCodexAsyncQuestions } from './asyncQuestions';
import { SharedCodexQueue } from './queue';
import { SharedCodexProjection, inputText, userMessageDisplayText } from './projection';
import { getCodexSystemPrompt } from '../utils/systemPrompt';
import { record, string } from './gateway';
import { initializeSharedClient, type SharedLaunchOptions } from './launch';
import { inheritedSandbox, settingsMatch } from './settings';
import { planImplementationMessageId, planProposalForItem, planProposalForTurn } from './plan';

type RuntimeSettings = NonNullable<Parameters<ApiSessionClient['keepAlive']>[2]>;
export type RootHost = {
    directory: string; generation: string; endpoint: string; token?: string;
    attached?: boolean;
    /** Provider captured for the native catalog when its app-server started. */
    catalogProvider?: string;
    startupCatalogConfig?: unknown;
    beforeSubscribe?(threadId: string): Promise<void>;
    validateHistory?(threadId: string, thread: unknown): Promise<void>;
    settingsFor(threadId: string): Record<string, unknown> | undefined;
    create(method: 'thread/start' | 'thread/fork', params: Record<string, unknown>, parent?: SharedCodexRoot, initialOptions?: SharedLaunchOptions): Promise<SharedCodexRoot>;
    end(root: SharedCodexRoot, nativeArchive?: boolean, reason?: 'unavailable' | 'history-changed' | 'archived'): Promise<void>;
};
const SettingsSchema = z.object({
    permissionMode: z.enum(['default', 'read-only', 'autoReview', 'yolo']).optional(),
    model: z.string().min(1).optional(), modelReasoningEffort: z.string().nullable().optional(),
    collaborationMode: z.enum(['default', 'plan']).optional(),
    serviceTier: z.enum(['fast', 'standard', 'ultrafast']).nullable().optional(),
    personality: z.enum(['friendly', 'pragmatic', 'none']).optional()
});

/** One immutable HAPI identity + independent subscription for one root. */
export class SharedCodexRoot {
    readonly client: CodexAppServerClient;
    readonly session: ApiSessionClient;
    bridge!: HapiMcpBridge;
    threadId = '';
    private permissions!: SharedCodexPermissions;
    private asyncQuestions!: SharedCodexAsyncQuestions;
    private queue!: SharedCodexQueue;
    private projection!: SharedCodexProjection;
    private readonly children = new Map<string, SharedCodexProjection>();
    private readonly ancestry = new Map<string, string | null>();
    private heartbeat?: ReturnType<typeof setInterval>;
    private work: Promise<unknown> = Promise.resolve();
    private notifications = Promise.resolve();
    private currentTurn: string | undefined;
    // Ephemeral observations only: dequeue/compaction never prove acceptance.
    private readonly dequeuedInputs = new Set<string>();
    private deliveryTurn?: string;
    private compactingTurn?: string;
    private publishedCompactionIds?: string;
    private latestTurn?: { id: string; status: string; planId?: string };
    private publishedPlanId: string | null | undefined;
    private submittingPlan = false;
    private steeringActive: boolean | undefined;
    private turnRevision = 0;
    private settingsRevision = 0;
    private activated = false;
    private attachedTierObservation?: Promise<void>;
    private attachedTierObservationRequested = false;
    private refreshing?: Promise<void>;
    private interrupted = false;
    private closed = false;
    private stopping = false;
    private closing?: Promise<void>;
    private readonly controls = new Set<Promise<unknown>>();
    private reconnecting = false;
    private settings: RuntimeSettings = {};
    private settingsNative: Record<string, unknown> = {};
    private modelProvider?: string;
    private serviceTierExplicit = false;
    private tierConfirmationPending = false;
    private tierConfirmationResolved = false;
    get hasUltrafastTier(): boolean { return this.settingsNative.serviceTier === 'ultrafast'; }
    private tierAdmissionPending = false;
    beginTierConfirmation(): void { this.tierAdmissionPending = true; this.publishSteering(); }
    get needsTierConfirmation(): boolean { return this.tierAdmissionPending || this.tierConfirmationPending; }
    get hasConfirmedStandardTier(): boolean { return this.settingsNative.serviceTier === 'default'; }
    private settingsNotification?: Record<string, unknown>;
    private readonly settingsListeners = new Set<() => void>();
    private ready!: () => void;
    private readonly bound = new Promise<void>(resolve => { this.ready = resolve; });
    private inputReady!: () => void;
    private inputGateResolved = false;
    private inputGate = new Promise<void>(resolve => { this.inputReady = () => { this.inputGateResolved = true; resolve(); }; });
    private tierOperationCounter = 0;
    private confirmedTierOperation = 0;
    private confirmedTierValue: unknown;
    private pendingTierOperation = 0;
    private pendingLaunchCollaborationMode?: SharedLaunchOptions['collaborationMode'];

    constructor(readonly bootstrap: SessionBootstrapResult, private readonly host: RootHost) {
        this.session = bootstrap.session;
        this.tierConfirmationPending = this.session.getMetadata()?.codexTierConfirmationPending === true;
        this.client = new CodexAppServerClient({ endpoint: host.endpoint, token: host.token, cwd: bootstrap.workingDirectory });
        this.client.setNotificationHandler((method, params) => {
            if (this.host.attached && ['thread/reverted', 'thread/rolledBack'].includes(method)
                && (record(params).threadId === this.threadId || this.children.has(String(record(params).threadId)))) {
                this.invalidateHistory(); return;
            }
            if (method === 'serverRequest/resolved') {
                this.permissions?.resolved(string(record(params).threadId) ?? '', record(params).requestId); return;
            }
            if (method === 'thread/settings/updated' && record(params).threadId === this.threadId) {
                this.acceptSettings(record(record(params).threadSettings), false);
                this.observeAttachedTier();
            }
            if (record(params).threadId === this.threadId) {
                if (method === 'turn/started') {
                    this.turnRevision++; this.currentTurn = string(record(record(params).turn).id); this.interrupted = false;
                    if (this.currentTurn) this.latestTurn = { id: this.currentTurn, status: 'inProgress' };
                    this.publishSteering();
                }
                if (method === 'turn/completed' && (!this.currentTurn || record(record(params).turn).id === this.currentTurn)) {
                    this.turnRevision++; this.currentTurn = undefined; this.interrupted = record(record(params).turn).status === 'interrupted';
                    if (!this.host.attached && record(record(params).turn).status === 'completed') this.session.updateMetadata(metadata => ({ ...metadata,
                        capabilities: { ...metadata.capabilities, conversationHistory: { ...metadata.capabilities?.conversationHistory,
                            forkLatestCompleted: true } } }));
                    this.publishSteering();
                }
                const p = record(params);
                if (method === 'item/completed' && this.latestTurn && this.latestTurn.id === p.turnId) {
                    const planId = planProposalForItem(this.threadId, this.latestTurn.id, p.item);
                    if (planId) { this.turnRevision++; this.latestTurn.planId = planId; }
                }
                if (method === 'turn/completed') {
                    const turn = record(p.turn);
                    const id = string(turn.id);
                    if (id && (!this.latestTurn || this.latestTurn.id === id)) {
                        this.latestTurn = { id, status: string(turn.status) ?? 'unknown',
                            planId: planProposalForTurn(this.threadId, turn) ?? this.latestTurn?.planId };
                    }
                }
                this.publishPlan();
            }
            const receivedAt = Date.now();
            const modelAtReceipt = record(params).threadId === this.threadId ? this.settings.model ?? undefined : undefined;
            this.notifications = this.notifications.then(() => this.notification(method, params, modelAtReceipt, receivedAt)).catch(error => {
                logger.debug('[Codex shared] projection', error);
                this.failAttached();
            });
        });
        this.client.setTransportAbandonedHandler(() => {
            if (this.host.attached) {
                this.stopAccepting();
                void this.host.end(this, false, 'unavailable').catch(error => logger.debug('[Codex attached] disconnect', error));
            } else void this.reconnect();
        });
        this.session.onUserMessage((message, localId) => {
            this.work = this.work.catch(() => {}).then(async () => {
                await this.bound;
                await this.inputGate;
                if (this.closed || this.stopping) return;
                if (this.host.attached) await this.refresh();
                if (this.closed || this.stopping) return;
                const id = localId ?? randomUUID();
                const text = formatMessageWithAttachments(message.content.text, message.content.attachments);
                const resolved = text.trim().startsWith('/') ? await this.queue.command(id, () => this.command(text)) : text;
                if (resolved === null) { this.session.emitMessagesConsumed([id], { clearQueuedThinkingGrace: true }); return; }
                // Compute the batch key now: this.settings may have changed
                // while this message waited behind earlier queued work (e.g. a
                // settings-updating slash command) or while hydration
                // populated them. Capturing it at callback arrival would merge
                // across the configuration change.
                const batchKey = JSON.stringify({
                    ...this.settings,
                    fallbackModel: message.meta?.fallbackModel ?? null,
                    customSystemPrompt: message.meta?.customSystemPrompt ?? null,
                    appendSystemPrompt: message.meta?.appendSystemPrompt ?? null,
                    allowedTools: message.meta?.allowedTools ?? null,
                    disallowedTools: message.meta?.disallowedTools ?? null
                });
                if (this.needsTierConfirmation) await this.inputGate;
                if (this.closed || this.stopping) return;
                await this.queue.enqueue(id, buildUserInputFromMessage(resolved), this.interrupted,
                    text.trim().startsWith('/') || message.meta?.isNativeQueuedMessage ? undefined : batchKey);
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
            const wasActivated = Boolean(this.heartbeat);
            // An emitted socket packet is not a durable hub acknowledgement.
            // Replay final native history with stable IDs after every reconnect.
            // The native turn keeps running across a hub-only reconnect, so the
            // active generation ledger must survive it.
            this.projection?.resetAfterHubReconnect();
            this.steeringActive = undefined;
            this.publishedPlanId = undefined;
            this.publishedCompactionIds = undefined;
            void this.refresh().then(() => this.refreshChildren(false)).then(() => this.queue.replay())
                .then(() => {
                    // Hub restart loses its ephemeral readiness fence. Replay
                    // it only after native revalidation and completed activation.
                    if (wasActivated && this.heartbeat && !this.needsTierConfirmation && !this.closed && !this.stopping && this.client.isInitialized()) this.session.emitSessionReady();
                })
                .catch(error => { logger.debug('[Codex shared] hub resync', error); this.failAttached(); });
        });
    }

    /** The host's approval hooks: a wait for the user is not generation time. */
    private readonly userWaitFor = (threadId: string): ((endedAt: number) => void) | undefined =>
        threadId === this.threadId ? this.projection?.beginUserWait(Date.now()) : undefined;

    /**
     * Seeds a thread this runtime just created (thread/start) to zero
     * cumulative usage so its first round's tok/s is measurable. Never call
     * for resumed or forked threads: their totals arrive through the
     * app-server's attach-time usage replay and already include inherited
     * history.
     */
    seedFreshUsage(): void {
        this.projection.seedFreshUsage();
    }

    async prepare(): Promise<void> {
        // Descendants share this bridge. The projection applies successful
        // root title calls so a child cannot rename the parent session.
        if (!this.host.attached) this.bridge = await buildHapiMcpBridge(this.session, { exportSessionEnv: false, emitTitleSummary: false,
            skillLookup: { workingDirectory: this.bootstrap.workingDirectory, flavor: 'codex' } });
        await initializeSharedClient(this.client);
        this.asyncQuestions = new SharedCodexAsyncQuestions(this.session, (threadId, text, id) => this.submitQuestionAnswer(threadId, text, id),
            this.bootstrap.sessionInfo.agentState?.completedRequests);
        this.permissions = new SharedCodexPermissions(this.session, this.client, this.host.generation, reply => this.asyncQuestions.answer(reply), this.userWaitFor);
        this.client.setServerRequestHandler(request => { void this.receiveRequest(request); });
    }
    private async submitQuestionAnswer(threadId: string, text: string, clientUserMessageId: string): Promise<void> {
        if (this.closed || this.stopping) throw new Error('Codex execution is stopping');
        const operation = (async () => {
            const thread = threadId === this.threadId ? undefined : await this.readThread(threadId);
            if (this.host.attached) {
                if (thread) await this.host.validateHistory?.(threadId, thread);
                else await this.refresh();
                if (this.closed || this.stopping) throw new Error('Codex execution is stopping');
            }
            const turnId = threadId === this.threadId ? this.currentTurn
                : string((Array.isArray(thread?.turns) ? thread.turns.map(record) : []).find(turn => turn.status === 'inProgress')?.id);
            const params = { threadId, clientUserMessageId, input: buildUserInputFromMessage(text) };
            if (this.closed || this.stopping || this.needsTierConfirmation) throw new Error('Service tier confirmation is pending or execution is stopping. Retry this answer after recovery.');
            await this.client.request(turnId ? 'turn/steer' : 'turn/start', { ...params, ...(turnId ? { expectedTurnId: turnId } : {}) });
        })();
        this.controls.add(operation);
        try { await operation; } finally { this.controls.delete(operation); }
    }
    private async projectHistory(projection: SharedCodexProjection, thread: unknown): Promise<void> {
        await this.host.validateHistory?.(projection.threadId, thread);
        this.asyncQuestions.history(projection.threadId, thread);
        await projection.history(thread);
    }
    private async receiveRequest(request: { id: string | number; method: string; params: unknown }): Promise<void> {
        await this.bound;
        if (this.closed || this.stopping) return;
        if (this.host.attached) {
            try { await this.refresh(); } catch { return; }
            if (this.closed || this.stopping) return;
        }
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
        if (this.host.attached) throw new Error('An attached runtime cannot inject native configuration');
        return { ...params, cwd: params.cwd ?? this.bootstrap.workingDirectory,
            developerInstructions: params.developerInstructions ?? getCodexSystemPrompt(), config: {
            ...record(params.config), 'mcp_servers.hapi': this.bridge.mcpServers.hapi,
            'shell_environment_policy.set.HAPI_SESSION_ID': this.session.sessionId
        } };
    }
    private async initializeBinding(threadId: string): Promise<void> {
        this.queue = new SharedCodexQueue({ request: <T = unknown>(method: string, params?: unknown): Promise<T> => {
            if (['turn/steer', 'thread/queue/start'].includes(method) && (this.closed || this.stopping || this.needsTierConfirmation)) {
                return Promise.reject(new Error('Service tier confirmation is pending or execution is stopping; input was not steered.'));
            }
            return this.client.request<T>(method, params);
        } }, threadId, join(this.host.directory, `${this.session.sessionId}.queue.json`),
            (ids, steered) => {
                this.session.emitMessagesConsumed(ids, { steered });
                for (const id of ids) this.dequeuedInputs.delete(id);
                this.publishCompaction();
            }, ids => this.session.emitSteerIndeterminate(ids),
            (id, input) => this.session.syncNativeQueuedMessage(id, input === null ? null : inputText(input)),
            ids => this.session.setSteerDeliveryState(ids, 'queued'), () => {
                if (this.closed || this.stopping || this.needsTierConfirmation) throw new Error('Service tier confirmation is pending or execution is stopping; input was not submitted.');
            });
        await this.queue.load();
        this.projection = new SharedCodexProjection(this.session, threadId, (id, content) => this.queue.committed(id, content),
            undefined, async () => record(await this.client.request('thread/read', { threadId, includeTurns: false })).thread,
            (threadId, item) => this.asyncQuestions.observeItem(threadId, item));
        this.session.updateMetadata(metadata => ({ ...metadata, codexSessionId: threadId, codexProviderScopedCatalog: this.client.supportsProviderScopedModels(), capabilities: {
            ...metadata.capabilities, concurrentClients: true, terminal: !this.host.attached,
            // In-place rewind needs a native + hub commit barrier. Do not
            // advertise a destructive operation we cannot make atomic yet.
            conversationHistory: { forkCurrent: !this.host.attached, forkAtMessage: !this.host.attached, forkLatestCompleted: false, rewindToMessage: false, forkPreview: true }
        } }));
        this.session.updateAgentState(state => ({ ...state, controlledByUser: false, startingMode: undefined, codexPlanProposalId: null, codexCompactionPendingMessageIds: [], requests: {},
            completedRequests: { ...state.completedRequests, ...Object.fromEntries(Object.entries(state.requests ?? {}).map(([id, request]) =>
                [id, { ...request, completedAt: Date.now(), status: 'canceled' as const }])) }
        }));
    }
    get isActivated(): boolean { return this.activated; }
    async bind(threadId: string, response: Record<string, unknown>, subscribe: boolean): Promise<void> {
        if (this.threadId && this.threadId !== threadId) throw new Error('Cannot retarget a shared HAPI session');
        this.threadId = threadId;
        // Keep the queue and projection when retrying a failed native read.
        if (!this.projection) await this.initializeBinding(threadId);
        // The first subscription uses the complete response to initialize history.
        if (subscribe) {
            await this.host.beforeSubscribe?.(threadId);
            response = record(await this.client.request('thread/resume', { threadId }));
        }
        this.modelProvider = string(response.modelProvider) ?? string(record(response.thread).modelProvider);
        this.acceptSettings(this.host.settingsFor(threadId) ?? {}, false); this.acceptSettings(response, true);
        if (this.hasConfirmedStandardTier) {
            this.tierConfirmationPending = false;
            this.tierConfirmationResolved = true;
            if (this.session.getMetadata()?.codexTierConfirmationPending) this.session.updateMetadata(metadata => ({ ...metadata, codexTierConfirmationPending: false }));
        }
        if (!this.host.attached) await this.projectHistory(this.projection, response.thread);
        await this.refresh(); await this.refreshChildren(true);
    }
    async activate(options: SharedLaunchOptions = {}, serviceTierExplicit?: boolean, deferInput = false): Promise<void> {
        this.tierAdmissionPending = false;
        this.tierConfirmationPending = deferInput || this.tierConfirmationPending
            || !this.tierConfirmationResolved && this.session.getMetadata()?.codexTierConfirmationPending === true;
        if (deferInput) this.tierConfirmationResolved = false;
        this.serviceTierExplicit = serviceTierExplicit ?? (options.serviceTier !== undefined || this.session.getMetadata()?.codexServiceTierExplicit === true);
        this.session.updateMetadata(metadata => ({
            ...metadata,
            codexServiceTierExplicit: this.serviceTierExplicit,
            codexTierConfirmationPending: this.tierConfirmationPending,
            codexPendingServiceTier: this.tierConfirmationPending ? metadata.codexPendingServiceTier : undefined
        }));
        // Restored input cannot run before the cold-resume settings are applied.
        if (!this.host.attached && this.tierConfirmationPending) this.pendingLaunchCollaborationMode = options.collaborationMode;
        else if (!this.host.attached) {
            this.pendingLaunchCollaborationMode = options.collaborationMode;
            try { await this.initialSettings(options); }
            catch (error) {
                if (!this.tierConfirmationPending) throw error;
                this.notice('Initial settings confirmation is pending. Select a service tier in settings to recover this conversation.');
            }
        }
        if (this.stopping) throw new Error('Codex execution is stopping');
        this.registerControls();
        this.activated = true;
        this.ready();
        if (!this.tierConfirmationPending) this.inputReady();
        this.heartbeat = setInterval(() => this.alive(), SESSION_KEEP_ALIVE_INTERVAL_MS); this.alive();
        if (!this.tierConfirmationPending) this.session.emitSessionReady();
    }
    private publishSteering(): void {
        this.publishCompaction();
        const active = Boolean(this.currentTurn) && !this.stopping && !this.closed && !this.reconnecting && !this.needsTierConfirmation && this.client.isInitialized();
        if (this.steeringActive === active) return;
        this.steeringActive = active;
        this.session.updateAgentState(state => ({ ...state, steeringActive: active }));
    }
    private publishCompaction(): void {
        const active = this.compactingTurn && this.compactingTurn === this.currentTurn
            && !this.closed && !this.stopping && !this.reconnecting && this.client.isInitialized();
        const ids = active ? [...this.dequeuedInputs].filter(id => this.queue?.state(id) === 'unknown').sort() : [];
        const key = JSON.stringify(ids);
        if (key === this.publishedCompactionIds) return;
        this.publishedCompactionIds = key;
        this.session.updateAgentState(state => ({ ...state, codexCompactionPendingMessageIds: ids }));
    }
    private alive(): void {
        this.publishSteering();
        this.publishPlan();
        if (!this.closed) this.session.keepAlive(Boolean(this.currentTurn), undefined, this.settings);
    }
    private availablePlanId(): string | null {
        if (this.currentTurn || this.latestTurn?.status !== 'completed' || this.settings.collaborationMode !== 'plan'
            || this.stopping || this.closed || this.reconnecting || this.submittingPlan || !this.client.isInitialized()) return null;
        const id = this.latestTurn.planId;
        // An uncertain/accepted submission must never become a fresh Execute button after reconnect.
        return id && !this.queue?.owns(planImplementationMessageId(id)) ? id : null;
    }
    private publishPlan(): void {
        const id = this.availablePlanId();
        if (id === this.publishedPlanId) return;
        this.publishedPlanId = id;
        this.session.updateAgentState(state => ({ ...state, codexPlanProposalId: id }));
    }
    acceptSettings(value: Record<string, unknown>, effective: boolean): void {
        if (typeof value.model !== 'string') return;
        this.settingsRevision++;
        if ('collaborationMode' in value && 'sandboxPolicy' in value) this.settingsNotification = value;
        this.settingsNative = { ...this.settingsNative, ...value };
        this.modelProvider = string(value.modelProvider) ?? this.modelProvider;
        const sandbox = record(value.sandboxPolicy ?? value.sandbox).type;
        this.settings = { ...this.settings, model: value.model,
            modelReasoningEffort: string(value.effort ?? value.reasoningEffort) ?? null,
            ...(sandbox ? { permissionMode: sandbox === 'dangerFullAccess' ? 'yolo' : sandbox === 'readOnly' ? 'read-only'
                : this.settingsNative.approvalsReviewer === 'auto_review' ? 'autoReview' : 'default' } : {}),
            ...('serviceTier' in value && (effective || value.serviceTier !== 'ultrafast')
                ? { serviceTier: fromCodexServiceTier(value.serviceTier) }
                : !effective && this.settings.serviceTier === 'ultrafast' && value.model !== this.settings.model ? { serviceTier: null } : {}),
            ...('collaborationMode' in value ? { collaborationMode: record(value.collaborationMode).mode === 'plan' ? 'plan' as const : 'default' as const } : {})
        };
        for (const listener of this.settingsListeners) listener();
        this.publishPlan();
    }
    private observeAttachedTier(): void {
        if (!this.host.attached || this.closed || this.stopping || !this.hasUltrafastTier || !this.client.supportsEffectiveUltrafastLaunch()) return;
        this.attachedTierObservationRequested = true;
        if (this.attachedTierObservation) return;
        this.attachedTierObservation = (async () => {
            while (this.attachedTierObservationRequested && !this.closed && !this.stopping) {
                this.attachedTierObservationRequested = false;
                const revision = this.settingsRevision;
                try {
                    const snapshot = record(await this.settingsRequest('thread/resume', { threadId: this.threadId, excludeTurns: true }, Date.now() + 10_000));
                    if (!this.closed && !this.stopping && this.settingsRevision === revision) {
                        this.acceptSettings(snapshot, true);
                        this.alive();
                    }
                } catch (error) { logger.debug('[Codex attached] effective tier snapshot unavailable', error); }
            }
        })().finally(() => { this.attachedTierObservation = undefined; });
    }
    private async notification(method: string, params: unknown, modelAtReceipt?: string, receivedAt = Date.now()): Promise<void> {
        // Native broadcasts can arrive while bind() is loading the local
        // ledger, before a projection exists. bind's full read reconciles them.
        if (!this.threadId || !this.projection || this.closed || this.host.attached && this.stopping) return;
        const p = record(params);
        if (method === 'thread/started') {
            const thread = record(p.thread); const id = string(thread.id);
            if (id) this.ancestry.set(id, string(thread.parentThreadId) ?? null);
        }
        const eventThread = string(p.threadId) ?? string(record(p.thread).id);
        if (this.host.attached && ['thread/reverted', 'thread/rolledBack'].includes(method)
            && eventThread && await this.ownsThread(eventThread)) { this.invalidateHistory(); return; }
        if (eventThread && eventThread !== this.threadId) {
            if (!await this.ownsThread(eventThread)) return;
            let projection = this.children.get(eventThread);
            if (!projection) {
                projection = new SharedCodexProjection(this.session, eventThread, async () => {}, this.threadId,
                    async () => record(await this.client.request('thread/read', { threadId: eventThread, includeTurns: false })).thread,
                    (threadId, item) => this.asyncQuestions.observeItem(threadId, item));
                this.children.set(eventThread, projection);
            }
            if (this.host.attached && ['turn/started', 'turn/completed'].includes(method)) {
                await this.projectHistory(projection, await this.readThread(eventThread));
            }
            await projection.notification(method, params); return;
        }
        if (method === 'turn/completed') this.session.sendSessionEvent({ type: 'ready' });
        if (method === 'thread/name/updated' && (typeof p.threadName === 'string' || p.threadName === null)) {
            const name = p.threadName ?? undefined; this.session.updateMetadata(metadata => ({ ...metadata, name }));
        }
        if (method === 'thread/archived') { await this.host.end(this, false, 'archived'); return; }
        if (this.host.attached && ['thread/closed', 'thread/deleted'].includes(method)) {
            this.stopAccepting(); await this.host.end(this, false, 'unavailable'); return;
        }
        // Process these in notification order: queue removal can precede turn/started.
        // Older unknown input must not acquire a later turn's compaction status.
        if (method === 'turn/started') {
            const id = string(record(p.turn).id);
            if (this.deliveryTurn && this.deliveryTurn !== id) this.dequeuedInputs.clear();
            this.deliveryTurn = id;
            this.compactingTurn = undefined;
        }
        if (method === 'turn/completed' && record(p.turn).id === this.deliveryTurn) {
            this.dequeuedInputs.clear(); this.deliveryTurn = undefined; this.compactingTurn = undefined;
        }
        if (p.turnId === this.currentTurn && record(p.item).type === 'contextCompaction') {
            if (method === 'item/started') this.compactingTurn = string(p.turnId);
            if (method === 'item/completed') { this.compactingTurn = undefined; this.dequeuedInputs.clear(); }
        }
        if (method === 'thread/queue/changed') {
            for (const id of await this.queue.reconcile()) this.dequeuedInputs.add(id);
        }
        if (this.host.attached && method === 'turn/started' && !this.stopping) await this.refresh();
        await this.projection.notification(method, params, modelAtReceipt, receivedAt);
        if (this.host.attached && method === 'turn/completed' && !this.stopping) await this.refresh();
        this.publishCompaction(); this.alive();
    }
    private invalidateHistory(): void {
        this.stopAccepting();
        this.session.updateMetadata(metadata => ({ ...metadata, conversationHistoryDiverged: true,
            codexRuntime: { kind: 'attached', bindingId: metadata.codexRuntime?.bindingId ?? this.session.sessionId, state: 'history-changed' } }));
        this.notice('Native history changed outside HAPI. This view is frozen; use hapi attach --new-view for a fresh projection.');
        void this.host.end(this, false, 'history-changed').catch(error => logger.debug('[Codex attached] history change', error));
    }
    private failAttached(): void {
        if (!this.host.attached || this.stopping) return;
        this.stopAccepting();
        void this.host.end(this, false, 'unavailable').catch(error => logger.debug('[Codex attached] validation failed', error));
    }
    private lazyHistory(): boolean {
        if (this.host.attached) return false;
        return !!this.threadId && (process.env.HAPI_CODEX_LAZY_HISTORY_IDS ?? '')
            .split(',').map(id => id.trim()).includes(this.threadId);
    }
    async readThread(threadId = this.threadId, fullHistory = false): Promise<Record<string, unknown>> {
        let thread = record(record(await this.client.request('thread/read', { threadId, includeTurns: false })).thread);
        if (thread.historyMode === 'paginated') {
            // 显式选择快速恢复时只回放最近一轮，原生上下文仍由 Codex 自己恢复。
            if (this.lazyHistory() && !fullHistory && threadId === this.threadId) {
                const page = record(await this.client.request('thread/turns/list', {
                    threadId, sortDirection: 'desc', itemsView: 'full', limit: 1
                }));
                if (!Array.isArray(page.data)) throw new Error('Invalid Codex history');
                thread.turns = [...page.data].reverse();
                return thread;
            }
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
        return this.refreshing ??= this.refreshNow().catch(error => { this.failAttached(); throw error; })
            .finally(() => { this.refreshing = undefined; });
    }
    private async refreshNow(): Promise<void> {
        if (!this.threadId || this.closed || !this.client.isInitialized()) return;
        const revision = this.turnRevision;
        const thread = await this.readThread();
        this.modelProvider = string(thread.modelProvider) ?? this.modelProvider;
        const turns = Array.isArray(thread.turns) ? thread.turns.map(record) : [];
        if (revision === this.turnRevision) {
            this.currentTurn = string(turns.find(turn => turn.status === 'inProgress')?.id);
            this.interrupted = turns.at(-1)?.status === 'interrupted';
            const last = turns.at(-1);
            const id = string(last?.id);
            this.latestTurn = id && last ? { id, status: string(last.status) ?? 'unknown', planId: planProposalForTurn(this.threadId, last) } : undefined;
        }
        const canForkLatest = !this.host.attached && (turns.some(turn => turn.status === 'completed')
            || (this.lazyHistory() && this.session.getMetadata()?.capabilities?.conversationHistory?.forkLatestCompleted === true));
        // Starting a later turn does not invalidate completed-history evidence.
        // Only a stale demotion must defer to newer completion notifications.
        if ((canForkLatest || revision === this.turnRevision)
            && this.session.getMetadata()?.capabilities?.conversationHistory?.forkLatestCompleted !== canForkLatest) {
            this.session.updateMetadata(metadata => !canForkLatest && revision !== this.turnRevision ? metadata : ({
                ...metadata, capabilities: { ...metadata.capabilities,
                    conversationHistory: { ...metadata.capabilities?.conversationHistory, forkLatestCompleted: canForkLatest } }
            }));
        }
        await this.projectHistory(this.projection, thread); await this.queue.reconcile(); this.alive();
    }
    private async refreshChildren(subscribe: boolean): Promise<void> {
        // 历史回放可省略，子代理发现与实时订阅仍需在重连后恢复。
        const replayHistory = !this.lazyHistory();
        let cursor: string | undefined;
        do {
            const page = record(await this.client.request('thread/list', { ancestorThreadId: this.threadId, cursor,
                sourceKinds: ['subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther'] }));
            for (const value of Array.isArray(page.data) ? page.data : []) {
                const thread = record(value); const id = string(thread.id);
                if (id && id !== this.threadId) this.ancestry.set(id, string(thread.parentThreadId) ?? null);
                if (id && id !== this.threadId && await this.ownsThread(id) && !this.children.has(id)) {
                    this.children.set(id, new SharedCodexProjection(this.session, id, async () => {}, this.threadId, undefined,
                        (threadId, item) => this.asyncQuestions.observeItem(threadId, item)));
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
                if (subscribe && loaded.has(id)) {
                    await this.host.beforeSubscribe?.(id);
                    await this.client.request('thread/resume', { threadId: id, excludeTurns: true });
                }
                if (replayHistory) {
                    projection.reset(); await this.projectHistory(projection, await this.readThread(id));
                }
            } catch (error) {
                if (this.host.attached) throw error;
                logger.debug('[Codex shared] child history unavailable', { id, error });
            }
        }
    }
    nativeQueueDeleted(nativeId: string): Promise<void> { return this.queue.deleted(nativeId); }
    async nativeQueueMutation(method: string, params: unknown): Promise<unknown> {
        await this.bound;
        if (method !== 'thread/queue/delete') {
            if (this.needsTierConfirmation) throw new Error('Service tier confirmation is pending. Select a service tier in settings before sending input.');
            await this.inputGate;
            if (this.needsTierConfirmation) throw new Error('Service tier confirmation is pending. Select a service tier in settings before sending input.');
        }
        if (this.closed || this.stopping) throw new Error('Codex execution is stopping');
        return this.queue.nativeMutation(method, record(params));
    }
    replaySettings(): Array<{ method: string; params: unknown }> {
        return this.settingsNotification ? [{ method: 'thread/settings/updated', params: {
            threadId: this.threadId, threadSettings: this.settingsNotification
        } }] : [];
    }
    private async reconnect(): Promise<void> {
        if (this.closed || this.stopping || this.reconnecting || !this.threadId) return;
        this.reconnecting = true;
        this.dequeuedInputs.clear(); this.deliveryTurn = undefined; this.compactingTurn = undefined;
        this.publishSteering(); this.publishPlan(); this.permissions.close();
        try {
            while (!this.closed && !this.stopping) {
                try {
                    await initializeSharedClient(this.client);
                    if (this.stopping) return;
                    this.permissions = new SharedCodexPermissions(this.session, this.client, `${this.host.generation}:${randomUUID()}`, reply => this.asyncQuestions.answer(reply), this.userWaitFor);
                    this.client.setServerRequestHandler(request => { void this.receiveRequest(request); });
                    const settingsRevision = this.settingsRevision;
                    const response = record(await this.client.request('thread/resume', { threadId: this.threadId, excludeTurns: true }));
                    const observedSettings = this.settingsRevision !== settingsRevision;
                    if (!observedSettings) this.acceptSettings(this.host.settingsFor(this.threadId) ?? {}, false);
                    this.acceptSettings(response, true);
                    this.projection.reset(); await this.refresh(); this.queue.replay(); await this.refreshChildren(true);
                    return;
                } catch (error) {
                    this.permissions.close();
                    logger.debug('[Codex shared] reconnect', error); await new Promise(resolve => setTimeout(resolve, 1_000));
                }
            }
        } finally { this.reconnecting = false; this.publishSteering(); this.publishPlan(); }
    }
    private settingsWrites: Promise<unknown> = Promise.resolve();
    applySettings(raw: unknown): Promise<{ applied: RuntimeSettings }> {
        const deadline = Date.now() + 25_000;
        const operationId = ++this.tierOperationCounter;
        const operation = this.settingsWrites.catch(() => {}).then(() => this.applySettingsNow(raw, deadline, operationId));
        this.settingsWrites = operation;
        return operation;
    }
    private async applySettingsNow(raw: unknown, deadline: number, operationId: number): Promise<{ applied: RuntimeSettings }> {
        if (Date.now() >= deadline) throw new Error('Settings update timed out before execution; settings were not changed');
        const config = SettingsSchema.parse(raw);
        if (this.pendingLaunchCollaborationMode && config.collaborationMode === undefined) config.collaborationMode = this.pendingLaunchCollaborationMode;
        const explicitTier = config.serviceTier !== undefined;
        // The existing live-settings API accepts null as a Standard reset.
        if (config.serviceTier === null) config.serviceTier = 'standard';
        let fallbackNotice: string | undefined;
        if (config.serviceTier === 'ultrafast' || config.model && this.hasUltrafastTier && config.serviceTier === undefined) {
            if (this.host.attached) throw new Error('Cannot verify Ultrafast for an externally attached thread. Choose Standard in HAPI or set the tier in the owning Codex client.');
            const discoveryDeadline = Math.min(deadline - 15_000, Date.now() + 10_000);
            for (;;) {
                const model = config.model ?? this.settings.model;
                const provider = this.modelProvider;
                if (!this.client.supportsProviderScopedModels() && !this.host.catalogProvider && config.model && config.serviceTier === undefined) {
                    throw new Error('Catalog provider could not be verified. Switch to Standard before changing models.');
                }
                const available = await isUltrafastAvailable(this.client, model, this.bootstrap.workingDirectory, discoveryDeadline, provider, this.host.catalogProvider, this.host.startupCatalogConfig);
                if ((!config.model && model !== this.settings.model) || provider !== this.modelProvider) continue;
                const enabled = available && await isUltrafastEnabled(this.client, this.threadId, discoveryDeadline);
                if ((!config.model && model !== this.settings.model) || provider !== this.modelProvider) continue;
                if (config.serviceTier === undefined && !this.hasUltrafastTier) break;
                // Pin only after every asynchronous discovery step has settled.
                if (typeof model === 'string') config.model = model;
                if (!available) { config.serviceTier = 'standard'; fallbackNotice = ULTRAFAST_FALLBACK_NOTICE; }
                else if (!enabled) { config.serviceTier = 'standard'; fallbackNotice = ULTRAFAST_DISABLED_NOTICE; }
                break;
            }
        }
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
        if (Date.now() >= deadline - 15_000) throw new Error('Settings discovery timed out; settings were not changed');
        const permission = config.permissionMode && resolveCodexPermissionModeConfig(config.permissionMode);
        const params = { threadId: this.threadId,
            ...(config.model ? { model: config.model } : {}),
            ...(config.personality ? { personality: config.personality } : {}),
            ...(config.modelReasoningEffort !== undefined ? { effort: config.modelReasoningEffort } : {}),
            ...(config.serviceTier !== undefined ? { serviceTier: toCodexServiceTier(config.serviceTier) ?? null } : {}),
            ...(permission ? { approvalPolicy: permission.approvalPolicy, sandboxPolicy: permission.sandboxPolicy,
                approvalsReviewer: config.permissionMode === 'autoReview' ? 'auto_review' : 'user' } : {}),
            ...(config.collaborationMode ? { collaborationMode: { mode: config.collaborationMode, settings: {
                model: config.model ?? this.settings.model, reasoning_effort: config.modelReasoningEffort ?? this.settings.modelReasoningEffort,
                developer_instructions: null
            } } } : {})
        };
        const confirmsTier = config.serviceTier !== undefined || this.hasUltrafastTier;
        await this.writeNativeSettings(params, params, deadline, operationId);
        if (config.collaborationMode) this.pendingLaunchCollaborationMode = undefined;
        if (explicitTier) this.markTierExplicit();
        if (fallbackNotice) this.notice(fallbackNotice);
        if (confirmsTier) this.completeTierConfirmation();
        this.alive(); return { applied: this.settings };
    }
    private markTierExplicit(): void {
        this.serviceTierExplicit = true;
        this.session.updateMetadata(metadata => ({ ...metadata, codexServiceTierExplicit: true, codexPendingServiceTier: undefined }));
    }
    private completeTierConfirmation(operationId = ++this.tierOperationCounter): void {
        if (operationId < this.pendingTierOperation || operationId < this.confirmedTierOperation) return;
        this.confirmedTierOperation = operationId;
        this.confirmedTierValue = this.settingsNative.serviceTier;
        this.tierConfirmationResolved = true;
        const paused = this.tierConfirmationPending;
        if (!paused && this.session.getMetadata()?.codexTierConfirmationPending !== true) return;
        this.tierConfirmationPending = false;
        this.pendingLaunchCollaborationMode = undefined;
        this.session.updateMetadata(metadata => ({ ...metadata, codexTierConfirmationPending: false }));
        this.publishSteering();
        if (paused && this.activated) { this.alive(); this.inputReady(); this.session.emitSessionReady(); }
    }
    /** Resolve native intent without committing settings before input is accepted. */
    private async resolveNativeSettings(params: Record<string, unknown>, operationDeadline = Date.now() + 25_000): Promise<{ params: Record<string, unknown>; fallbackNotice?: string }> {
        params = { ...params };
        if (params.serviceTier === 'fast') params.serviceTier = 'priority';
        const requestedModel = string(record(record(params.collaborationMode).settings).model) ?? string(params.model);
        let fallbackNotice: string | undefined;
        if (params.serviceTier === 'ultrafast' || requestedModel && params.serviceTier === undefined && this.hasUltrafastTier) {
            if (this.host.attached) throw new Error('Cannot verify Ultrafast for an externally attached thread. Choose Standard in HAPI or set the tier in the owning Codex client.');
            const deadline = Math.min(operationDeadline - 15_000, Date.now() + 10_000);
            for (;;) {
                const model = requestedModel ?? this.settings.model;
                const provider = this.modelProvider;
                const available = await isUltrafastAvailable(this.client, model, this.bootstrap.workingDirectory, deadline, provider, this.host.catalogProvider, this.host.startupCatalogConfig);
                const enabled = available && await isUltrafastEnabled(this.client, this.threadId, deadline);
                if ((!requestedModel && model !== this.settings.model) || provider !== this.modelProvider) continue;
                // A model-only request must not reset a newer tier chosen during discovery.
                if (params.serviceTier === undefined && !this.hasUltrafastTier) break;
                params = { ...params, ...(typeof model === 'string' ? { model } : {}) };
                if (!available || !enabled) {
                    params.serviceTier = null;
                    fallbackNotice = !available ? ULTRAFAST_FALLBACK_NOTICE : ULTRAFAST_DISABLED_NOTICE;
                }
                break;
            }
        }
        return { params, fallbackNotice };
    }
    /** Native frontends share the same confirmation and explicit-intent rules. */
    applyNativeSettings(params: Record<string, unknown>): Promise<void> {
        const deadline = Date.now() + 25_000;
        const operationId = ++this.tierOperationCounter;
        const operation = this.settingsWrites.catch(() => {}).then(async () => {
            if (this.pendingLaunchCollaborationMode && params.collaborationMode === undefined) params = { ...params, collaborationMode: {
                mode: this.pendingLaunchCollaborationMode, settings: { model: string(params.model) ?? this.settings.model,
                    reasoning_effort: params.effort ?? this.settings.modelReasoningEffort, developer_instructions: null }
            } };
            const explicitTier = params.serviceTier !== undefined;
            const resolved = await this.resolveNativeSettings(params, deadline);
            const effectiveModel = string(record(record(resolved.params.collaborationMode).settings).model) ?? string(resolved.params.model);
            const confirmsTier = resolved.params.serviceTier !== undefined || this.hasUltrafastTier;
            await this.writeNativeSettings(resolved.params, {
                ...(resolved.params.serviceTier !== undefined ? { serviceTier: resolved.params.serviceTier } : {}),
                ...(resolved.params.collaborationMode ? { collaborationMode: resolved.params.collaborationMode } : {}),
                ...(effectiveModel ? { model: effectiveModel } : {})
            }, deadline, operationId);
            if (resolved.params.collaborationMode) this.pendingLaunchCollaborationMode = undefined;
            if (explicitTier) this.markTierExplicit();
            if (confirmsTier) this.completeTierConfirmation();
            this.alive();
            if (resolved.fallbackNotice) this.notice(resolved.fallbackNotice);
        });
        this.settingsWrites = operation;
        return operation;
    }
    async prepareNativeTurn(params: Record<string, unknown>): Promise<{ params: Record<string, unknown>; fallbackNotice?: string; previousTier: unknown; generation: number }> {
        const resolved = await this.resolveNativeSettings(params);
        return { ...resolved, previousTier: this.settingsNative.serviceTier, generation: ++this.tierOperationCounter };
    }
    async recoverLostNativeTurn(params: Record<string, unknown>, explicitTier: boolean, previousTier: unknown, generation: number, fallbackNotice?: string): Promise<void> {
        this.notice('Native turn delivery is unconfirmed after transport loss. Check the conversation before retrying the message.');
        if (params.serviceTier === undefined || this.closed || this.stopping) return;
        const deadline = Date.now() + 10_000;
        const revision = this.settingsRevision;
        const latestConfirmation = this.confirmedTierOperation;
        if (generation < latestConfirmation) {
            const latestTier = this.confirmedTierValue;
            try {
                const snapshot = record(await this.settingsRequest('thread/resume', { threadId: this.threadId, excludeTurns: true }, deadline));
                if (!this.closed && !this.stopping && this.confirmedTierOperation === latestConfirmation && this.settingsRevision === revision
                    && snapshot.serviceTier !== undefined && snapshot.serviceTier !== latestTier) {
                    this.pauseTierConfirmation(latestConfirmation);
                }
            } catch {
                // An older unknown reply cannot invalidate a newer confirmation by itself.
            }
            return;
        }
        if (generation < this.pendingTierOperation) return;
        const operationId = generation;
        this.pauseTierConfirmation(operationId);
        const expected = { serviceTier: params.serviceTier };
        // An unchanged value cannot establish that the request was accepted.
        if (previousTier === undefined || settingsMatch({ serviceTier: previousTier }, expected)) return;
        const current = () => !this.closed && !this.stopping && this.settingsRevision === revision
            && operationId >= this.confirmedTierOperation && operationId >= this.pendingTierOperation;
        try {
            const snapshot = record(await this.settingsRequest('thread/resume', { threadId: this.threadId, excludeTurns: true }, deadline));
            if (!current() || !settingsMatch(snapshot, expected)) return;
            if (params.serviceTier === 'ultrafast' && !await isUltrafastEnabled(this.client, this.threadId, deadline)) return;
            if (!current()) return;
            this.acceptSettings(snapshot, true);
            if (explicitTier) this.markTierExplicit();
            this.completeTierConfirmation(operationId);
            this.alive();
            if (fallbackNotice) this.notice(fallbackNotice);
        } catch {
            // Preserve the pending state for a deliberate tier selection.
        }
    }
    /** Called only after native turn acceptance; a rejected input leaves intent unchanged. */
    async confirmNativeTurn(params: Record<string, unknown>, explicitTier: boolean, fallbackNotice?: string, operationId = ++this.tierOperationCounter): Promise<void> {
        const verifyUltrafast = params.serviceTier === 'ultrafast' || params.serviceTier === undefined && this.hasUltrafastTier;
        const current = () => operationId >= this.confirmedTierOperation && operationId >= this.pendingTierOperation;
        // A settings lookup can confirm the effective value before the native
        // reply arrives. Only the accepted turn establishes explicit intent.
        if (explicitTier) this.markTierExplicit();
        if (!current()) return;
        const revision = this.settingsRevision;
        const deadline = Date.now() + 25_000;
        const model = string(record(record(params.collaborationMode).settings).model) ?? string(params.model);
        const expected = { ...(model ? { model } : {}), ...(params.serviceTier !== undefined ? { serviceTier: params.serviceTier } : {}) };
        try {
            const snapshot = record(await this.settingsRequest('thread/resume', { threadId: this.threadId, excludeTurns: true }, deadline, true, () => current() && (verifyUltrafast || params.serviceTier !== undefined), operationId));
            if (!current()) return;
            // A notification received during the lookup is newer than its captured snapshot.
            if (this.settingsRevision !== revision) {
                if (verifyUltrafast && this.hasUltrafastTier) {
                    await this.confirmEffectiveUltrafast(deadline, operationId);
                    if (current()) this.completeTierConfirmation(operationId);
                }
                else if (params.serviceTier !== undefined && settingsMatch(this.settingsNative, { serviceTier: params.serviceTier })) {
                    this.completeTierConfirmation(operationId);
                    if (fallbackNotice && this.hasConfirmedStandardTier) this.notice(fallbackNotice);
                }
                return;
            }
            this.acceptSettings(snapshot, true);
            if (verifyUltrafast && !this.hasUltrafastTier && this.settings.serviceTier !== 'fast') {
                await this.writeNativeSettings({ threadId: this.threadId, serviceTier: null }, { serviceTier: null }, deadline, operationId);
                if (current()) this.completeTierConfirmation(operationId);
                this.notice('Codex did not apply Ultrafast; changed to Standard.');
                this.alive(); return;
            }
            if (!settingsMatch(this.settingsNative, expected)) throw new Error('Native turn settings are not confirmed');
            if (verifyUltrafast || params.serviceTier !== undefined) this.completeTierConfirmation(operationId);
            this.alive();
            if (fallbackNotice) this.notice(fallbackNotice);
        } catch {
            if (!current()) return;
            // Input has already been accepted. Never return a send error inviting a duplicate.
            this.notice('Codex accepted the turn, but its settings could not be confirmed. Reconnect before changing the service tier.');
        }
    }
    private pauseTierConfirmation(operationId: number): void {
        if (operationId < this.confirmedTierOperation) return;
        this.tierConfirmationResolved = false;
        this.pendingTierOperation = Math.max(this.pendingTierOperation, operationId);
        if (!this.tierConfirmationPending) {
            this.tierConfirmationPending = true;
            if (this.inputGateResolved) {
                this.inputGateResolved = false;
                this.inputGate = new Promise<void>(resolve => { this.inputReady = () => { this.inputGateResolved = true; resolve(); }; });
            }
            this.session.updateMetadata(metadata => ({ ...metadata, codexTierConfirmationPending: true }));
            this.publishSteering();
            this.notice('Codex settings confirmation is pending. Confirm Standard in settings before sending more input.');
        }
    }
    private async settingsRequest(method: string, params: Record<string, unknown>, deadline: number, uncertain = false, pauseInput: boolean | (() => boolean) = uncertain, operationId = 0): Promise<unknown> {
        const remaining = deadline - Date.now();
        const shouldPause = () => typeof pauseInput === 'function' ? pauseInput() : pauseInput;
        const timedOut = () => {
            if (shouldPause()) this.pauseTierConfirmation(operationId);
            return new Error(uncertain ? shouldPause() ? 'Codex settings confirmation is pending; confirm Standard in settings' : 'Native settings confirmation is pending; reconnect before changing settings' : 'Settings update timed out; settings were not changed');
        };
        if (remaining <= 0) throw timedOut();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([this.client.request(method, params), new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(timedOut()), remaining);
            })]);
        } catch (error) {
            if (shouldPause() && (method !== 'thread/settings/update' || isIndeterminateError(error))) this.pauseTierConfirmation(operationId);
            throw error;
        } finally { clearTimeout(timer); }
    }
    private async writeNativeSettings(params: Record<string, unknown>, expected = params, deadline = Date.now() + 25_000, operationId = ++this.tierOperationCounter): Promise<void> {
        if (this.closed || this.stopping) throw new Error('Codex execution is stopping');
        if (Date.now() >= deadline) throw new Error('Settings update timed out before execution; settings were not changed');
        const verifyUltrafast = expected.serviceTier === 'ultrafast' || expected.serviceTier === undefined && this.hasUltrafastTier;
        const changesTier = expected.serviceTier !== undefined || verifyUltrafast;
        // Native suppresses identical notifications. Verify a current loaded
        // snapshot rather than waiting for an event that will never be emitted.
        const comparable = Object.fromEntries(Object.entries(params).filter(([key, value]) => value !== null || key === 'serviceTier'));
        if (settingsMatch(this.settingsNative, comparable)) {
            const revision = this.settingsRevision;
            const snapshot = record(await this.settingsRequest('thread/resume', { threadId: this.threadId, excludeTurns: true }, deadline));
            if (this.settingsRevision === revision) this.acceptSettings(snapshot, true);
            if (settingsMatch(this.settingsNative, comparable)) {
                if (verifyUltrafast) await this.confirmEffectiveUltrafast(deadline, ++this.tierOperationCounter);
                return;
            }
        }
        const revision = this.settingsRevision;
        let changed!: () => void;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const accepted = new Promise<void>((resolve, reject) => {
            changed = () => { if (this.settingsRevision > revision && settingsMatch(this.settingsNative, expected)) resolve(); };
            this.settingsListeners.add(changed);
            timer = setTimeout(() => { if (changesTier) this.pauseTierConfirmation(operationId); reject(new Error(changesTier ? 'Native settings confirmation is pending; confirm Standard in settings' : 'Native settings confirmation is pending; reconnect before changing settings')); }, Math.min(15_000, Math.max(0, deadline - Date.now())));
        });
        void accepted.catch(() => {});
        try {
            operationId = ++this.tierOperationCounter;
            await this.settingsRequest('thread/settings/update', params, deadline, true, () => changesTier && operationId >= this.confirmedTierOperation, operationId);
            // The RPC only acknowledges queueing the settings operation. The
            // native notification, not our submitted candidate, establishes state.
            await accepted;
        } finally { clearTimeout(timer); this.settingsListeners.delete(changed); }
        if (verifyUltrafast) await this.confirmEffectiveUltrafast(deadline, operationId);
    }
    private async confirmEffectiveUltrafast(deadline: number, operationId: number): Promise<void> {
        // Settings notifications report selection; a loaded thread can still
        // filter Ultrafast using the feature state captured when it started.
        for (let attempt = 0; attempt < 3; attempt++) {
            const revision = this.settingsRevision;
            const snapshot = record(await this.settingsRequest('thread/resume', { threadId: this.threadId, excludeTurns: true }, deadline, true, () => operationId >= this.confirmedTierOperation, operationId));
            if (operationId < this.confirmedTierOperation) throw new Error('Codex settings were superseded by a newer confirmed tier; refresh before retrying');
            if (this.settingsRevision !== revision) continue;
            this.acceptSettings(snapshot, true);
            if (this.hasUltrafastTier) return;
            // A concurrent native client may have deliberately selected Fast.
            if (this.settings.serviceTier === 'fast') return;
            await this.writeNativeSettings({ threadId: this.threadId, serviceTier: null }, { serviceTier: null }, deadline, operationId);
            this.notice('Codex did not apply Ultrafast; changed to Standard.');
            return;
        }
        this.pauseTierConfirmation(operationId);
        throw new Error('Codex settings changed during effective tier confirmation; confirm Standard in settings');
    }
    async confirmUltrafastLaunch(explicitTier = true): Promise<void> {
        // Native launch configuration filters a disabled feature before its
        // response. Unlike live updates, it does not require another discovery
        // RPC after creation that could strand a known, unactivated child.
        if (this.settings.serviceTier === 'ultrafast') { this.completeTierConfirmation(); return; }
        await this.applySettings({ serviceTier: 'standard' });
        if (!explicitTier) {
            this.serviceTierExplicit = false;
            this.session.updateMetadata(metadata => ({ ...metadata, codexServiceTierExplicit: false }));
        }
        this.notice('Codex did not apply Ultrafast; changed to Standard.');
    }
    async confirmStandardLaunch(explicitTier = true): Promise<void> {
        await this.applySettings({ serviceTier: 'standard' });
        if (!explicitTier) {
            this.serviceTierExplicit = false;
            this.session.updateMetadata(metadata => ({ ...metadata, codexServiceTierExplicit: false }));
        }
    }
    async initialSettings(options: SharedLaunchOptions): Promise<void> {
        if (options.collaborationMode) await this.applySettings({ collaborationMode: options.collaborationMode });
    }
    private async implementPlan(planId: string): Promise<ImplementCodexPlanResult> {
        const unavailable = (): ImplementCodexPlanResult => ({ ok: false, code: 'unavailable', error: 'Codex is disconnected or stopping. Reconnect before implementing the plan.' });
        const stale = (): ImplementCodexPlanResult => ({ ok: false, code: 'stale_plan', error: 'This plan is no longer actionable. Refresh the conversation.' });
        const localId = planImplementationMessageId(planId);
        if (this.closed || this.stopping || this.reconnecting || !this.client.isInitialized()) return unavailable();
        try {
            // A reconnect snapshot may have started before this action arrived.
            await this.refreshing;
            await this.refresh();
            const prior = this.queue.state(localId);
            if (prior === 'queued' || prior === 'consumed') return { ok: true };
            if (prior) return { ok: false, code: 'indeterminate', error: 'This implementation was already submitted. Check the queue and conversation before sending again.' };
            const before = await this.queue.list();
            if (this.availablePlanId() !== planId || before.length) return stale();
            const revision = this.turnRevision;
            this.submittingPlan = true; this.publishPlan();
            await this.applySettings({ collaborationMode: 'default' });
            const queued = await this.queue.list();
            if (this.closed || this.stopping || this.reconnecting || !this.client.isInitialized()) return unavailable();
            if (this.turnRevision !== revision || this.currentTurn || this.latestTurn?.planId !== planId
                || this.settings.collaborationMode !== 'default' || queued.length) return stale();
            await this.queue.enqueue(localId, buildUserInputFromMessage('Implement the plan.'));
            return { ok: true };
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return { ok: false, code: isIndeterminateError(error) || this.queue.state(localId) === 'unknown' ? 'indeterminate' : 'failed',
                error: `Plan implementation was not confirmed: ${detail}. Check the mode, queue and conversation before retrying.` };
        } finally { this.submittingPlan = false; this.publishPlan(); }
    }
    private registerControls(): void {
        const rpc = { registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => {
            this.session.rpcHandlerManager.registerHandler(method, async (raw: unknown) => {
                if (this.stopping) throw new Error('Codex execution is stopping; resume when inactive');
                if (this.needsTierConfirmation && ([RPC_METHODS.ClearConversation, RPC_METHODS.ForkConversation, RPC_METHODS.ImplementCodexPlan, RPC_METHODS.SteerQueuedMessage] as string[]).includes(method)) {
                    throw new Error('Confirm the service tier in settings before creating, forking, running a plan, or steering input.');
                }
                if (this.host.attached && ([RPC_METHODS.ClearConversation, RPC_METHODS.ForkConversation, RPC_METHODS.RewindConversation] as string[]).includes(method)) {
                    throw new Error('Create/fork/revert this external thread in its owning desktop; HAPI only attaches');
                }
                if (this.host.attached && method !== RPC_METHODS.KillSession) {
                    await this.refresh();
                    if (this.stopping) throw new Error('Codex execution is stopping');
                }
                const pending = handler(raw); this.controls.add(pending);
                try { return await pending; } finally { this.controls.delete(pending); }
            });
        } };
        rpc.registerHandler(RPC_METHODS.ListCodexModels, async raw => {
            const entries = []; let cursor: string | undefined;
            do {
                const response = await this.client.listModels({ includeHidden: record(raw).includeHidden === true, cursor, ...(this.client.supportsProviderScopedModels() && this.modelProvider ? { modelProvider: this.modelProvider } : {}) });
                entries.push(...response.data ?? []); cursor = response.nextCursor ?? undefined;
            } while (cursor);
            let canVerifyUltrafast = false;
            if (!this.host.attached && this.host.startupCatalogConfig != null && this.client.supportsEffectiveUltrafastLaunch()) {
                try {
                    const config = await this.client.readConfig({ cwd: this.bootstrap.workingDirectory, includeLayers: true });
                    canVerifyUltrafast = catalogConfigurationMatches(this.host.startupCatalogConfig, config);
                } catch { /* Keep the model list and withhold unverified Ultrafast. */ }
            }
            const models = entries.map(entry => normalizeCodexModel(entry, canVerifyUltrafast)).filter(model => model !== null);
            return { success: true, models };
        });
        rpc.registerHandler(RPC_METHODS.Switch, async () => { throw new Error('control_mode_not_applicable'); });
        rpc.registerHandler(RPC_METHODS.HandoffLocal, async () => { throw new Error('control_mode_not_applicable'); });
        rpc.registerHandler(RPC_METHODS.Abort, async () => {
            const turnId = this.currentTurn;
            if (turnId) await this.client.request('turn/interrupt', { threadId: this.threadId, turnId });
        });
        rpc.registerHandler(RPC_METHODS.KillSession, async () => { await this.host.end(this); return { success: true }; });
        // #1911 C2 / AC6: Codex owns KillSession here and never calls
        // registerKillSessionHandler — still must EXIT on hub-archived metadata
        // (KillSession unreachable / map-miss). Latch covers bootstrap write
        // before bind/activate registers controls; B2 refuses tree-kill of the
        // shared wrapper so this subscribe is load-bearing.
        const exitFromHubArchive = () => {
            void this.host.end(this).catch(error => logger.debug('[CODEX] hub-archived end failed:', error));
        };
        if (this.session.hubArchived) {
            exitFromHubArchive();
        }
        this.session.on('hub-archived', exitFromHubArchive);
        rpc.registerHandler(RPC_METHODS.SetSessionConfig, raw => this.applySettings(raw));
        rpc.registerHandler(RPC_METHODS.ImplementCodexPlan, raw => {
            const { planId } = ImplementCodexPlanRequestSchema.parse(raw);
            const work = this.work.catch(() => {}).then(() => this.implementPlan(planId));
            this.work = work;
            return work;
        });
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
            const { messageLocalId, latestCompleted, lastTurnId } = z.object({ messageLocalId: z.string().optional(), latestCompleted: z.boolean().optional(),
                lastTurnId: z.string().optional() })
                .refine(value => !(value.messageLocalId && value.latestCompleted))
                .refine(value => !(value.messageLocalId && value.lastTurnId)).parse(raw);
            if (latestCompleted || lastTurnId) {
                const thread = await this.readThread(this.threadId, true);
                const turns = (Array.isArray(thread.turns) ? thread.turns : []).map(record);
                // An explicit inclusive native cutoff remains fixed even if the source advances.
                // Shared children hydrate directly from native fork history, never a moving Hub tail.
                const cutoff = lastTurnId ? this.verifyPinnedTurn(turns, lastTurnId) : latestCompletedForkCutoff(turns);
                const child = await this.host.create('thread/fork', { ...this.freshParams(), threadId: this.threadId,
                    lastTurnId: cutoff }, this, { collaborationMode: this.settings.collaborationMode });
                try {
                    const expected = turns.slice(0, turns.findIndex(turn => turn.id === cutoff) + 1).map(turn => string(turn.id));
                    const inherited = await child.readThread(child.threadId, true);
                    const actual = (Array.isArray(inherited.turns) ? inherited.turns : []).map(value => string(record(value).id));
                    if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
                        throw new Error('Native fork history does not match the completed-turn cutoff');
                    }
                    return { nativeSessionId: child.threadId, sessionId: child.session.sessionId, completedTurnId: cutoff };
                } catch (error) {
                    await this.host.end(child).catch(cleanup => logger.debug('[Codex shared] invalid fork cleanup failed', cleanup));
                    throw error;
                }
            }
            if (this.currentTurn && !messageLocalId) throw new Error('Session is busy');
            const beforeTurnId = messageLocalId ? this.projection.turnFor(messageLocalId) : undefined;
            if (messageLocalId && !beforeTurnId) throw new Error('No native history point for this message');
            if (messageLocalId) {
                const thread = await this.assertBoundary(messageLocalId, beforeTurnId!);
                const turns = (Array.isArray(thread.turns) ? thread.turns : []).map(record);
                const index = turns.findIndex(turn => turn.id === beforeTurnId);
                if (index < 0 || turns.slice(0, index + 1).some(turn =>
                    !['completed', 'interrupted', 'failed'].includes(string(turn.status) ?? ''))) {
                    throw new Error('Historical fork requires a completed turn and history prefix');
                }
            }
            const child = await this.host.create('thread/fork', { ...this.freshParams(), threadId: this.threadId,
                ...(beforeTurnId ? { beforeTurnId } : {}) }, this, { collaborationMode: this.settings.collaborationMode });
            return { nativeSessionId: child.threadId, sessionId: child.session.sessionId };
        });
        rpc.registerHandler(RPC_METHODS.RewindConversation, async () => {
            throw new Error('In-place rewind is not supported for concurrent Codex clients; fork at the message instead');
        });
        rpc.registerHandler(RPC_METHODS.PreviewForkBoundary, async raw => {
            const { mode, messageLocalId } = z.object({ mode: z.enum(['current', 'message', 'latestCompleted']),
                messageLocalId: z.string().optional() })
                .refine(value => (value.mode === 'message') === Boolean(value.messageLocalId)).parse(raw);
            if (mode === 'latestCompleted' || (mode === 'current' && this.currentTurn)) {
                const thread = await this.readThread(this.threadId, true);
                const turns = (Array.isArray(thread.turns) ? thread.turns : []).map(record);
                // A plain current fork cannot run mid-turn: the honest answer is
                // the last completed turn, which is also what a pinned fork uses.
                const cutoff = latestCompletedForkCutoff(turns);
                const index = turns.findIndex(turn => turn.id === cutoff);
                return { nativeTurnId: cutoff, ...this.firstExcludedUserLocalId(turns, index + 1) };
            }
            if (mode === 'current') {
                const thread = await this.readThread(this.threadId, true);
                const turns = (Array.isArray(thread.turns) ? thread.turns : []).map(record);
                if (!turns.length) return {};
                // Confirm pins this turn and re-verifies its prefix, so offer
                // the pin only when the confirm would accept it; a non-terminal
                // prefix would otherwise preview a 200 that confirm always
                // rejects. Without a valid pin both sides fall back to the
                // unpinned whole-history cut the preview already showed.
                const pinned = string(turns.at(-1)?.id);
                if (!pinned) return {};
                try {
                    this.verifyPinnedTurn(turns, pinned);
                } catch {
                    return {};
                }
                return { nativeTurnId: pinned };
            }
            const beforeTurnId = this.projection.turnFor(messageLocalId!);
            if (!beforeTurnId) throw new Error('No native history point for this message');
            // Mirror ForkConversation's admission rule on the assertBoundary
            // snapshot: a historical cut may not run through an unfinished
            // turn, so the preview refuses exactly what the confirm would.
            const boundaryThread = await this.assertBoundary(messageLocalId!, beforeTurnId);
            const boundaryTurns = (Array.isArray(boundaryThread.turns) ? boundaryThread.turns : []).map(record);
            const index = boundaryTurns.findIndex(turn => turn.id === beforeTurnId);
            if (index < 0) throw new Error('No native history point for this message');
            if (boundaryTurns.slice(0, index + 1).some(turn =>
                !['completed', 'interrupted', 'failed'].includes(string(turn.status) ?? ''))) {
                throw new Error('Historical fork requires a completed turn and history prefix');
            }
            const previous = index > 0 ? string(boundaryTurns[index - 1]?.id) : undefined;
            return { ...(previous ? { nativeTurnId: previous } : {}), cutBeforeLocalId: messageLocalId };
        });
    }
    /** Re-validate a preview-pinned turn before forking through it. */
    private verifyPinnedTurn(turns: Record<string, unknown>[], pinnedTurnId: string): string {
        const index = turns.findIndex(turn => turn.id === pinnedTurnId);
        if (index < 0) throw new Error('The pinned fork turn is no longer part of the native history');
        if (turns.slice(0, index + 1).some(turn => !['completed', 'interrupted', 'failed'].includes(string(turn.status) ?? ''))) {
            throw new Error('The pinned fork turn no longer has a completed native history prefix');
        }
        return pinnedTurnId;
    }
    /** First hub localId at/after `startIndex`, the excluded side of the cut. */
    private firstExcludedUserLocalId(turns: Record<string, unknown>[], startIndex: number): { cutBeforeLocalId?: string } {
        for (const turn of turns.slice(Math.max(startIndex, 0))) {
            const items = Array.isArray(turn.items) ? turn.items.map(record) : [];
            const first = items.find(item => item.type === 'userMessage');
            // Empty-text user messages never reach the hub transcript
            // (projection.ts), so naming one as the cut would make the hub
            // resolve a boundary row that does not exist.
            if (!first || !userMessageDisplayText(first)) continue;
            const id = string(first.clientId ?? first.clientUserMessageId) ?? (first.id ? `codex:${this.threadId}:user:${string(first.id)}` : undefined);
            // A batch submission's native client id is a synthetic
            // hapi-batch-* alias while the hub rows are keyed by the original
            // member ids, so resolve the same accepted boundary assertBoundary
            // does. An unproven batch version cannot name a hub row: fall back
            // to the caller's missing-cut behavior instead of the alias.
            const boundaryId = id ? this.queue.originalBoundaryId(id, first.content) : undefined;
            if (boundaryId) return { cutBeforeLocalId: boundaryId };
            return {};
        }
        return {};
    }
    private async assertBoundary(localId: string, turnId: string): Promise<Record<string, unknown>> {
        const thread = await this.readThread(this.threadId, true);
        const turn = (Array.isArray(thread.turns) ? thread.turns.map(record) : []).find(turn => turn.id === turnId);
        const first = (Array.isArray(turn?.items) ? turn.items.map(record) : []).find(item => item.type === 'userMessage');
        const firstId = string(first?.clientId ?? first?.clientUserMessageId) ?? (first?.id ? `codex:${this.threadId}:user:${first.id}` : undefined);
        const boundaryId = firstId ? this.queue.originalBoundaryId(firstId, first?.content) : undefined;
        if (boundaryId !== localId) throw new Error('Cannot cut inside a steered native turn. Select its first message.');
        return thread;
    }
    freshParams(): Record<string, unknown> {
        const sandbox = inheritedSandbox(this.settingsNative);
        return { ...sandbox, cwd: this.settingsNative.cwd ?? this.bootstrap.workingDirectory, model: this.settingsNative.model, modelProvider: this.settingsNative.modelProvider,
            approvalPolicy: this.settingsNative.approvalPolicy, serviceTier: this.serviceTierExplicit ? this.settingsNative.serviceTier : undefined,
            approvalsReviewer: this.settingsNative.approvalsReviewer, personality: this.settingsNative.personality,
            developerInstructions: getCodexSystemPrompt(),
            config: { ...record(sandbox.config), model_reasoning_effort: this.settings.modelReasoningEffort ?? undefined } };
    }
    private notice(message: string): void { this.session.sendSessionEvent({ type: 'message', message }); }
    private async newConversation(): Promise<SharedCodexRoot> {
        if (this.host.attached) throw new Error('Create new conversations in the owning desktop, then attach them explicitly');
        return this.host.create('thread/start', this.freshParams(), undefined, { collaborationMode: this.settings.collaborationMode });
    }
    private async command(text: string): Promise<string | null> {
        const command = text.trim();
        if (command === '/clear' || command === '/new') {
            const child = await this.newConversation(); this.notice(`New conversation: /sessions/${child.session.sessionId}`); return null;
        }
        if (command === '/compact') { await this.client.request('thread/compact/start', { threadId: this.threadId }); return null; }
        if (command === '/exit') { this.notice(this.host.attached ? 'Use hapi detach to disconnect HAPI without stopping the external thread.'
            : '/exit closes a native terminal, not this Web view. Use End session to archive this conversation.'); return null; }
        if (!command.startsWith('/')) return text;
        const slash = resolveCodexSlashCommand(text, { commands: await listSlashCommands('codex', this.bootstrap.workingDirectory),
            permissionMode: this.settings.permissionMode === 'yolo' || this.settings.permissionMode === 'read-only' || this.settings.permissionMode === 'autoReview' ? this.settings.permissionMode : 'default',
            collaborationMode: this.settings.collaborationMode ?? 'default', model: this.settings.model ?? undefined,
            modelReasoningEffort: parseReasoningEffortValue(this.settings.modelReasoningEffort), serviceTier: this.settings.serviceTier });
        if (slash.kind === 'passthrough') return text;
        if (slash.kind === 'goal') {
            const params = { threadId: this.threadId };
            const goal = slash.action === 'set'
                ? record(record(await this.client.request('thread/goal/get', params)).goal) : null;
            if (goal?.status === 'complete') {
                await this.client.request('thread/goal/clear', params);
            }
            const response = slash.action === 'show' ? await this.client.request('thread/goal/get', params)
                : slash.action === 'clear' ? await this.client.request('thread/goal/clear', params)
                : await this.client.request('thread/goal/set', { ...params, ...(slash.action === 'set'
                    ? { objective: slash.objective, ...(goal?.status === 'complete' ? { status: 'active' } : {}) }
                    : { status: slash.action === 'pause' ? 'paused' : 'active' }) });
            this.notice(JSON.stringify(response)); return null;
        }
        if (slash.updates?.proactiveMultiAgent !== undefined) throw new Error('This Codex version uses Ultra reasoning effort instead of a multi-agent toggle');
        if (slash.updates?.model === null) throw new Error('Choose an explicit model in a shared thread');
        const applied = slash.updates ? await this.applySettings(slash.updates) : undefined;
        const tierFellBack = slash.updates?.serviceTier === 'ultrafast' && applied?.applied.serviceTier !== 'ultrafast';
        if (slash.message && !tierFellBack) this.notice(slash.message);
        return slash.kind === 'replace' ? slash.text : null;
    }
    stopAccepting(): void {
        this.stopping = true; this.ready(); this.inputReady();
        this.publishSteering();
        this.publishPlan();
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
            this.permissions?.close(); this.asyncQuestions?.close();
            await this.client.disconnect();
            if (this.host.attached) { await this.work.catch(() => {}); await Promise.allSettled([...this.controls]); }
            await this.notifications; await this.queue?.flush(); this.bridge?.server.stop();
            if (archived) this.session.updateMetadata(metadata => ({ ...metadata, lifecycleState: 'archived', lifecycleStateSince: Date.now() }));
            // Inactive is resumable; uploads referenced by pending input must survive.
            this.session.sendSessionDeath(undefined, { preserveUploads: !archived });
            await this.session.flush(); this.session.close();
        })();
    }
}

/** Resolve an inclusive immutable prefix from authoritative native history. */
export function latestCompletedForkCutoff(turns: Record<string, unknown>[]): string {
    const ids = turns.map(turn => string(turn.id));
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('Native turn history is ambiguous');
    let completed: string | undefined;
    for (const turn of turns) {
        if (turn.status === 'inProgress' || turn.status === 'in_progress') break;
        if (!['completed', 'interrupted', 'failed'].includes(string(turn.status) ?? '')) throw new Error('Native history prefix is not complete');
        if (turn.status === 'completed') completed = string(turn.id);
    }
    if (!completed) throw new Error('No completed turn is available to fork');
    return completed;
}
