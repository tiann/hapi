import { logger } from '@/ui/logger';
import { convertAgentMessage } from '@/agent/messageConverter';
import { createNativeSessionTitleMetadataSync } from '@/agent/nativeSessionTitle';
import { PiTransport } from './piTransport';
import { convertPiEvent, convertPiTurnUsage } from './piEventConverter';
import { PiMessageAccumulator } from './piMessageAccumulator';
import { PiExtensionUiHandler } from './extensionUiHandler';
import { parsePiModels, parsePiCommands, parsePiContextUsage, PiAgentEndEventSchema, PiAgentSettledEventSchema, PiExtensionUiRequestSchema, PiLifecycleEventSchema, PiResponseEventSchema, PiSessionInfoChangedEventSchema, PiStateDataSchema, PiSetModelDataSchema } from './schemas';
import type { PiContextUsage, PiResponseEvent, PiRpcCommand, PiThinkingLevel, PiTurnEndEvent } from './types';
import type { PiSession } from './session';
import type { PiConversationHistory } from './conversationHistory';

// --- Response parsers: re-exported from schemas.ts ---
export { parsePiModels, parsePiCommands, parsePiContextUsage } from './schemas';

// --- Pending RPC resolver ---
// Instance-scoped: created once by wireTransportEvents, stored on PiSession.
export class PiRpcTimeoutError extends Error {
    readonly command: string;
    readonly requestId: number;
    readonly timeoutMs: number;

    constructor(command: string, requestId: number, timeoutMs: number) {
        super(`Pi RPC ${command} (id=${requestId}) timed out after ${timeoutMs}ms`);
        this.name = 'PiRpcTimeoutError';
        this.command = command;
        this.requestId = requestId;
        this.timeoutMs = timeoutMs;
    }
}

export class PiRpcResolver {
    private idCounter = 0;
    private terminalError: Error | null = null;
    private readonly pending = new Map<number, {
        resolve: (data: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();

    sendAndWait(transport: PiTransport, command: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
        if (this.terminalError) return Promise.reject(this.terminalError);
        const id = ++this.idCounter;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new PiRpcTimeoutError(String(command.type), id, timeoutMs));
            }, timeoutMs);

            this.pending.set(id, {
                timer,
                resolve: (data) => { clearTimeout(timer); this.pending.delete(id); resolve(data); },
                reject: (error) => { clearTimeout(timer); this.pending.delete(id); reject(error); },
            });

            transport.send({ ...command, id: String(id) } as unknown as PiRpcCommand);
        });
    }

    rejectAll(error: Error): void {
        this.terminalError ??= error;
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            this.pending.delete(id);
            pending.reject(error);
        }
    }

    resolveResponse(raw: unknown): void {
        const parsed = PiResponseEventSchema.safeParse(raw);
        if (!parsed.success) return;
        const response = parsed.data;
        const rawId = response.id;
        if (rawId !== undefined) {
            const numericId = Number(rawId);
            if (!Number.isNaN(numericId)) {
                const resolver = this.pending.get(numericId);
                if (resolver) {
                    if (response.success) {
                        resolver.resolve(response.data);
                    } else {
                        resolver.reject(new Error(response.error ?? 'Unknown error'));
                    }
                }
            }
        }
    }
}

export function sendPiRpcAndWait(session: PiSession, transport: PiTransport, command: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
    if (!session.rpcResolver) throw new Error('Pi RPC resolver not initialized');
    return session.rpcResolver.sendAndWait(transport, command, timeoutMs);
}

function resolvePendingRpc(resolver: PiRpcResolver, response: PiResponseEvent): void {
    resolver.resolveResponse(response);
}

// Mirror the web picker's provider-qualified selection into metadata so the hub
// and web can disambiguate duplicate modelId values across providers. The web
// /sessions/:id/model path already writes piSelectedModel via persistPiSelectedModel;
// these runtime paths (get_state, startup set_model, successful set_model response)
// previously only keepAlive'd the bare modelId, so a Pi session on Pi's default model
// or started with --model could render/filter against the wrong provider.
function persistSelectedPiModel(session: PiSession): void {
    const modelId = session.currentModel;
    const provider = session.currentProvider;
    if (!modelId || !provider) return;
    session.updateMetadata((meta) => ({
        ...meta,
        piSelectedModel: { provider, modelId },
    }));
}

// --- Response handler ---

function applyGetState(
    data: {
        model?: { id?: string; modelId?: string; provider?: string };
        sessionId?: string;
        sessionName?: string;
        thinkingLevel?: string;
        steeringMode?: 'all' | 'one-at-a-time';
        isStreaming?: boolean;
    },
    session: PiSession,
    syncNativeTitle: (title: unknown) => void,
    applyStreamingState = true,
): void {

    if (data.model) {
        // Pi returns model.id (not modelId). Fallback to modelId for forward compat.
        const newModel = data.model.id ?? data.model.modelId ?? session.currentModel;
        if (data.model.provider && data.model.provider.length > 0) {
            session.currentProvider = data.model.provider;
        }
        // Do NOT overwrite currentModel with the unconfirmed startup model here.
        // The requested startup model is applied (and committed) only after
        // get_available_models confirms it exists and Pi accepts set_model;
        // reporting Pi's actual current model until then keeps the hub in sync
        // if the requested model is unavailable or rejected.
        session.currentModel = newModel ?? session.currentModel;
        if (session.initialModel) {
            logger.debug(`[pi] Startup model requested: ${session.initialModel} (will apply once available models arrive); Pi default model: ${newModel ?? 'unknown'}`);
        } else if (newModel) {
            logger.debug(`[pi] Initial model: ${newModel} (provider=${session.currentProvider ?? 'unknown'})`);
        }
        // Pi reported its actual model+provider; persist the provider-qualified
        // selection so the web can disambiguate (a startup --model overrides this
        // once get_available_models confirms and applies it below).
        persistSelectedPiModel(session);
    }

    if (data.sessionId) {
        session.updateMetadata((meta) => ({ ...meta, piSessionId: data.sessionId }));
        logger.debug(`[pi] Session ID persisted to metadata: ${data.sessionId}`);
    }

    syncNativeTitle(data.sessionName);

    if (data.thinkingLevel) {
        session.currentThinkingLevel = data.thinkingLevel as PiThinkingLevel;
        logger.debug(`[pi] Initial thinking level: ${data.thinkingLevel}`);
    }

    if (data.steeringMode) {
        session.currentSteeringMode = data.steeringMode;
    }

    if (data.isStreaming !== undefined && applyStreamingState) {
        // get_state is Pi's authoritative current-session snapshot. Synchronize
        // only its explicit boolean, never infer state from unknown event types.
        session.updateThinkingState(data.isStreaming);
    }

}

function handleResponse(
    response: PiResponseEvent,
    session: PiSession,
    pendingLocalIds: string[],
    transport?: PiTransport,
    onStartupFailure?: (error: Error) => void,
    conversationHistory?: PiConversationHistory,
    onReady?: () => void,
    shouldApplyGetStateStreaming?: (isStreaming: boolean) => boolean,
    syncNativeTitle?: (title: unknown) => void,
): { rejectedPromptLocalId?: string } {
    const { command, success } = response;
    const resolver = session.rpcResolver!;

    if (!success) {
        const error = response.error ?? 'Unknown Pi error';
        logger.debug(`[pi] RPC error for ${command}: ${error}`);
        resolvePendingRpc(resolver, response);
        // get_session_stats is a best-effort compatibility probe. Older Pi
        // versions may reject it, so fall back silently instead of surfacing an
        // error event to the user on every completed turn. compact/set_model
        // are owned by the awaited slash-command/config handlers, which report
        // their own formatted failure message.
        if (!['get_session_stats', 'steer', 'compact', 'set_model'].includes(command)) {
            session.sendSessionEvent({ type: 'message', message: error });
        }
        if (command === 'prompt' && pendingLocalIds.length > 0) {
            const oldestLocalId = pendingLocalIds.shift()!;
            session.emitMessagesConsumed([oldestLocalId], { clearQueuedThinkingGrace: true });
            conversationHistory?.rejectPendingEntry(oldestLocalId);
            return { rejectedPromptLocalId: oldestLocalId };
        }
        // A failed initial get_state means Pi did not load its native session.
        // Do not leave the HAPI wrapper alive until the hub's ready timeout: the
        // caller tears down the process so the archived row can be restored.
        // A fresh Pi session keeps the historic non-fatal fallback behavior;
        // only a requested native resume must fail closed.
        if (command === 'get_state' && session.expectedNativeSessionId && !session.isNativeReady) {
            onStartupFailure?.(new Error(`Pi get_state failed: ${error}`));
        }
        // A failed model discovery must not strand a startup effort that waits
        // on the startup-model gate (see runPi startup effort).
        if (command === 'get_available_models') {
            session.resolveStartupModelSettled?.();
        }
        return {};
    }

    switch (command) {
        case 'get_state': {
            const parsed = PiStateDataSchema.safeParse(response.data);
            // Pi has finished startup init (this is the response that persists
            // metadata.piSessionId). It is also the only native-ready signal
            // that the hub trusts for Pi resume; session-alive only proves the
            // HAPI wrapper connected. Validate a requested native session before
            // mutating model/metadata state: an invalid resume must not publish a
            // colliding piSessionId that auto-dedup could merge.
            if (!parsed.success) {
                resolvePendingRpc(resolver, response);
                if (session.expectedNativeSessionId) {
                    onStartupFailure?.(new Error('Pi get_state returned malformed state data'));
                }
                break;
            }
            const state = parsed.data;
            if (!session.isHistoryTransactionActive && !session.matchesExpectedNativeSessionId(state.sessionId)) {
                const actual = state.sessionId ? state.sessionId : '(missing)';
                const error = `Pi loaded unexpected native session ${actual} instead of ${session.expectedNativeSessionId}`;
                logger.debug(`[pi] ${error}`);
                session.sendSessionEvent({ type: 'message', message: error });
                onStartupFailure?.(new Error(error));
                break;
            }
            // Emit ready before publishing Pi metadata. On native resume, this
            // ensures the hub can never merge based on a piSessionId before the
            // get_state identity check has completed.
            // History transactions deliberately switch Pi through temporary
            // clone/fork identities. Resolve their awaited get_state request,
            // but never publish the temporary identity/model to the source row.
            if (!session.isHistoryTransactionActive) {
                session.markNativeReady();
                const applyStreamingState = state.isStreaming === undefined
                    || shouldApplyGetStateStreaming?.(state.isStreaming) !== false;
                if (!applyStreamingState) {
                    logger.debug('[pi] Ignoring get_state isStreaming=false during an active prompt lifecycle');
                }
                applyGetState(state, session, syncNativeTitle ?? (() => {}), applyStreamingState);
                onReady?.();
            }
            resolvePendingRpc(resolver, response);
            break;
        }
        case 'set_model': {
            const parsed = PiSetModelDataSchema.safeParse(response.data);
            if (parsed.success) {
                const data = parsed.data;
                const modelId = data.id ?? data.modelId;
                if (modelId) {
                    session.currentModel = modelId;
                }
                if (data.provider && data.provider.length > 0) {
                    session.currentProvider = data.provider;
                }
                persistSelectedPiModel(session);
                logger.debug(`[pi] Model changed to: ${modelId ?? session.currentModel}`);
            }
            // set_model is awaited by SetSessionConfig (Fix #9); without this
            // the awaited RPC would time out and /sessions/:id/model return 409.
            resolvePendingRpc(resolver, response);
            break;
        }
        case 'set_thinking_level': {
            // Awaited by SetSessionConfig (Fix #9 symmetry with set_model).
            // currentThinkingLevel is maintained by the SetSessionConfig
            // handler, so this branch only resolves the pending RPC — without
            // it the awaited call times out and /sessions/:id/effort returns 409.
            resolvePendingRpc(resolver, response);
            break;
        }
        case 'get_available_models': {
            const models = parsePiModels(response.data);
            if (models.length > 0) {
                session.cachedPiModels = models;
                logger.debug(`[pi] Available models: ${models.map((m) => m.modelId).join(', ')}`);
                session.updateMetadata((meta) => ({
                    ...meta,
                    piAvailableModels: models,
                }));

                // Apply the requested startup model only after confirming it exists
                // in Pi's available models and Pi accepts set_model. Commit
                // currentModel/currentProvider only on success so the hub does not
                // persist a model Pi rejected or never had. Fire-and-forget the
                // await so resolving the get_available_models RPC itself is not
                // blocked (it may be awaited by ListPiModels).
                if (session.initialModel && transport) {
                    const match = models.find((m) => m.modelId === session.initialModel)
                        ?? models.find((m) => `${m.provider}/${m.modelId}` === session.initialModel);
                    if (match) {
                        void (async () => {
                            try {
                                await session.runRuntimeMutation(async () => {
                                    await sendPiRpcAndWait(session, transport, {
                                        type: 'set_model',
                                        provider: match.provider,
                                        modelId: match.modelId,
                                    });
                                    session.currentModel = match.modelId;
                                    session.currentProvider = match.provider;
                                    persistSelectedPiModel(session);
                                }, { poisonOnError: (error) => error instanceof PiRpcTimeoutError });
                                logger.debug(`[pi] Startup model applied: ${match.provider}/${match.modelId}`);
                            } catch (error) {
                                if (error instanceof PiRpcTimeoutError) {
                                    onStartupFailure?.(new Error(`Pi startup model outcome is indeterminate: ${error.message}`));
                                    session.resolveStartupModelSettled?.();
                                    return;
                                }
                                const detail = error instanceof Error ? error.message : String(error);
                                logger.debug(`[pi] Startup model set_model rejected, keeping Pi default: ${detail}`);
                                session.sendSessionEvent({
                                    type: 'message',
                                    message: `⚠️ Startup model switch failed: ${detail}`,
                                });
                            }
                            session.resolveStartupModelSettled?.();
                        })();
                    } else {
                        logger.debug(`[pi] Startup model not found in available models: ${session.initialModel}`);
                        session.resolveStartupModelSettled?.();
                    }
                } else {
                    session.resolveStartupModelSettled?.();
                }
            } else {
                // Empty discovery — settle the startup-model gate so a waiting
                // startup effort does not strand (nothing to match against).
                session.resolveStartupModelSettled?.();
            }
            resolvePendingRpc(resolver, response);
            break;
        }
        case 'get_commands': {
            const commands = parsePiCommands(response.data);
            if (commands.length > 0) {
                session.cachedPiCommands = commands;
                logger.debug(`[pi] Available commands: ${commands.map((c) => c.name).join(', ')}`);
            }
            resolvePendingRpc(resolver, response);
            break;
        }
        case 'new_session':
            logger.debug('[pi] Pi session initialized');
            break;
        case 'abort':
            logger.debug('[pi] Abort confirmed');
            resolvePendingRpc(resolver, response);
            break;
        case 'prompt':
            logger.debug('[pi] Prompt accepted');
            break;
        case 'steer':
            logger.debug('[pi] Steer accepted');
            resolvePendingRpc(resolver, response);
            break;
        default:
            logger.debug(`[pi] Response for ${command}`);
            resolvePendingRpc(resolver, response);
            break;
    }

    return {};
}

const PI_CONTEXT_USAGE_RPC_TIMEOUT_MS = 1_000;

async function publishPiTurnUsage(
    event: PiTurnEndEvent,
    transport: PiTransport,
    session: PiSession,
    isLatestRequest: () => boolean,
): Promise<void> {
    let contextUsage: PiContextUsage | null | undefined;
    try {
        const stats = await sendPiRpcAndWait(
            session,
            transport,
            { type: 'get_session_stats' },
            PI_CONTEXT_USAGE_RPC_TIMEOUT_MS,
        );
        contextUsage = parsePiContextUsage(stats);
    } catch (error) {
        // Unsupported/failed stats RPC: convertPiTurnUsage falls back to the
        // positive per-turn totalTokens value. The fallback is intentionally
        // local to Pi so providers with different usage semantics are untouched.
        logger.debug(`[pi] get_session_stats unavailable, using turn usage fallback: ${error instanceof Error ? error.message : String(error)}`);
        contextUsage = undefined;
    }

    // RPC responses can arrive after a newer turn has already completed.
    // Publishing only the newest request prevents stale context values from
    // overwriting a later turn's usage state.
    if (!isLatestRequest()) return;

    const usageMessage = convertPiTurnUsage(event, contextUsage);
    if (!usageMessage) return;

    const converted = convertAgentMessage(usageMessage, session.currentModel);
    if (converted) session.sendAgentMessage(converted);
}

// --- Wire transport events to session ---

export type PiTransportEventController = {
    flush: () => void;
    cancelPendingExtensionUi: (reason: string, options?: { sendResponse?: boolean }) => void;
    terminatePendingRpc: (error: Error) => void;
    beginPromptLifecycle: (promptId: string) => void;
    abortPromptLifecycle: () => void;
};

type PiTransportEventOptions = {
    onStartupFailure?: (error: Error) => void;
    onReady?: () => void;
    /** Observes each Pi agent_start/turn_start without releasing the prompt queue. */
    onAgentLifecycleStarted?: () => void;
    onAgentSettled?: () => void;
    onPromptRejected?: (localId?: string) => void;
    /** Return false to keep this prompt generation open for a late lifecycle. */
    onPromptLifecycleMissing?: (localId?: string) => void | boolean;
    conversationHistory?: PiConversationHistory;
};

const PI_LEGACY_SETTLE_GRACE_MS = 500;
const PI_PROMPT_LIFECYCLE_GRACE_MS = 1_000;
const PI_COMPACTION_RETRY_START_GRACE_MS = 1_000;

class PiLifecycleTimeline {
    private compacting = false;
    private activeRetryKey: string | null = null;
    private summaryRetryActive = false;

    emit(event: unknown, session: PiSession): void {
        const parsed = PiLifecycleEventSchema.safeParse(event);
        if (!parsed.success) return;
        const lifecycle = parsed.data;
        let message: string | null = null;

        switch (lifecycle.type) {
            case 'compaction_start':
                if (this.compacting) return;
                this.compacting = true;
                message = '📦 Compaction started';
                break;
            case 'compaction_end':
                if (!this.compacting) return;
                this.compacting = false;
                message = lifecycle.aborted
                    ? '📦 Compaction canceled'
                    : lifecycle.errorMessage
                        ? `📦 Compaction failed: ${lifecycle.errorMessage}`
                        : lifecycle.willRetry
                            ? '📦 Compaction will retry'
                            : '📦 Compaction completed';
                break;
            case 'auto_retry_start': {
                const key = `${lifecycle.attempt}:${lifecycle.errorMessage}`;
                if (this.activeRetryKey === key) return;
                this.activeRetryKey = key;
                message = `↻ Retrying after error (attempt ${lifecycle.attempt}/${lifecycle.maxAttempts}): ${lifecycle.errorMessage}`;
                break;
            }
            case 'auto_retry_end':
                if (this.activeRetryKey === null) return;
                this.activeRetryKey = null;
                message = lifecycle.success
                    ? `↻ Retry succeeded (attempt ${lifecycle.attempt})`
                    : `↻ Retry failed (attempt ${lifecycle.attempt})${lifecycle.finalError ? `: ${lifecycle.finalError}` : ''}`;
                break;
            case 'summarization_retry_scheduled':
                if (this.summaryRetryActive) return;
                this.summaryRetryActive = true;
                message = `📝 Summary retry scheduled (attempt ${lifecycle.attempt}/${lifecycle.maxAttempts}): ${lifecycle.errorMessage}`;
                break;
            case 'summarization_retry_attempt_start':
                if (!this.summaryRetryActive) return;
                message = `📝 Summary retry started (${lifecycle.source})`;
                break;
            case 'summarization_retry_finished':
                if (!this.summaryRetryActive) return;
                this.summaryRetryActive = false;
                message = '📝 Summary retry completed';
                break;
        }

        if (message) session.sendSessionEvent({ type: 'message', message });
    }
}

export function wireTransportEvents(
    transport: PiTransport,
    session: PiSession,
    pendingLocalIds: string[],
    options: PiTransportEventOptions = {},
): PiTransportEventController {
    session.rpcResolver = new PiRpcResolver();
    const assistantMessageAccumulator = new PiMessageAccumulator();
    const extensionUi = new PiExtensionUiHandler({
        session: session.client,
        sendResponse: (response) => transport.send(response),
    });
    // Shared dedup state for native Pi titles (get_state startup/resume and
    // live session_info_changed renames) so repeated identical names do not
    // trigger redundant updateMetadata calls.
    const syncNativeTitle = createNativeSessionTitleMetadataSync(session.client);
    const lifecycleTimeline = new PiLifecycleTimeline();
    let latestContextUsageRequest = 0;
    let deliveredSettlement = false;
    let legacySettleTimer: ReturnType<typeof setTimeout> | null = null;
    let promptLifecycleTimer: ReturnType<typeof setTimeout> | null = null;
    let compactionRetryTimer: ReturnType<typeof setTimeout> | null = null;
    const maintenanceActive = new Set<'compaction' | 'compactionRetry' | 'autoRetry' | 'summary'>();
    let agentEndObserved = false;
    let agentLifecycleSeen = false;
    let lifecycleGeneration = 0;
    let activePromptId: string | null = null;
    let activePromptResponseAccepted = false;
    let activeAgentSettledSeen = false;
    let promptLifecycleAborted = false;
    // turn_start consumes the FIFO entry before the prompt response is known.
    // Retain that exact local ID so a later matching response failure can reject
    // the history registration even after pendingLocalIds has been drained.
    let activePromptLocalId: string | undefined;

    const clearLegacySettleFallback = (): void => {
        if (legacySettleTimer) clearTimeout(legacySettleTimer);
        legacySettleTimer = null;
    };
    const clearPromptLifecycleFallback = (): void => {
        if (promptLifecycleTimer) clearTimeout(promptLifecycleTimer);
        promptLifecycleTimer = null;
    };
    const clearCompactionRetryPending = (): void => {
        maintenanceActive.delete('compactionRetry');
        if (compactionRetryTimer) clearTimeout(compactionRetryTimer);
        compactionRetryTimer = null;
    };
    const beginPromptLifecycle = (promptId: string): void => {
        lifecycleGeneration += 1;
        activePromptId = promptId;
        promptLifecycleAborted = false;
        activePromptResponseAccepted = false;
        activeAgentSettledSeen = false;
        activePromptLocalId = undefined;
        deliveredSettlement = false;
        agentEndObserved = false;
        agentLifecycleSeen = false;
        maintenanceActive.clear();
        clearCompactionRetryPending();
        clearLegacySettleFallback();
        clearPromptLifecycleFallback();
    };
    const abortPromptLifecycle = (): void => {
        lifecycleGeneration += 1;
        activePromptId = null;
        promptLifecycleAborted = true;
        activePromptResponseAccepted = false;
        activeAgentSettledSeen = false;
        activePromptLocalId = undefined;
        deliveredSettlement = false;
        agentEndObserved = false;
        agentLifecycleSeen = false;
        maintenanceActive.clear();
        clearCompactionRetryPending();
        clearLegacySettleFallback();
        clearPromptLifecycleFallback();
    };
    const rejectPromptLifecycle = (): void => {
        // A rejected prompt is terminal for this generation. Invalidate all
        // delayed settlement work before notifying runPi so it can immediately
        // resume FIFO pumping without a stale grace timer changing its state.
        lifecycleGeneration += 1;
        activePromptId = null;
        promptLifecycleAborted = true;
        activePromptResponseAccepted = false;
        activeAgentSettledSeen = false;
        activePromptLocalId = undefined;
        deliveredSettlement = true;
        agentEndObserved = false;
        agentLifecycleSeen = false;
        maintenanceActive.clear();
        clearCompactionRetryPending();
        latestContextUsageRequest += 1;
        clearLegacySettleFallback();
        clearPromptLifecycleFallback();
        flushAccumulator();
        session.updateThinkingState(false);
    };
    const deliverSettlement = (): void => {
        if (deliveredSettlement || (activePromptId !== null && !activePromptResponseAccepted)) return;
        deliveredSettlement = true;
        clearCompactionRetryPending();
        clearLegacySettleFallback();
        clearPromptLifecycleFallback();
        session.updateThinkingState(false);
        if (options.conversationHistory) {
            // The settled notification fires after an async history sync. A new
            // lifecycle (e.g. an autonomous wake-up) can begin in the meantime;
            // generation-scope the callback so a stale settlement cannot mark
            // that newer lifecycle's abort boundary as settled.
            const settlementGeneration = lifecycleGeneration;
            void options.conversationHistory.syncEntries()
                .catch(() => {})
                .finally(() => {
                    if (settlementGeneration === lifecycleGeneration) {
                        options.onAgentSettled?.();
                    }
                });
        } else {
            options.onAgentSettled?.();
        }
    };
    const scheduleLegacySettleFallback = (): void => {
        if ((activePromptId !== null && !activePromptResponseAccepted) || !agentEndObserved || maintenanceActive.size > 0 || deliveredSettlement || legacySettleTimer) return;
        legacySettleTimer = setTimeout(() => {
            legacySettleTimer = null;
            deliverSettlement();
        }, PI_LEGACY_SETTLE_GRACE_MS);
        legacySettleTimer.unref?.();
    };
    const schedulePromptLifecycleFallback = (): void => {
        const generation = lifecycleGeneration;
        clearPromptLifecycleFallback();
        promptLifecycleTimer = setTimeout(() => {
            promptLifecycleTimer = null;
            void (async () => {
                if (generation !== lifecycleGeneration || deliveredSettlement || agentLifecycleSeen) return;
                // Some Pi integrations omit entry_appended even for successful
                // command-only prompts. Read the append log before runPi retires
                // the pending localId, otherwise the next user entry can inherit
                // this prompt's native history association.
                if (options.conversationHistory) {
                    try {
                        await options.conversationHistory.syncEntries();
                    } catch (error) {
                        if (generation !== lifecycleGeneration || deliveredSettlement || agentLifecycleSeen) return;
                        const detail = error instanceof Error ? error.message : String(error);
                        // Continuing would discard the only FIFO association for
                        // an unread native user entry. Fail the wrapper closed
                        // instead of allowing all later fork/rewind points to
                        // shift onto the wrong HAPI messages.
                        options.onStartupFailure?.(new Error(`Pi command-only history sync failed: ${detail}`));
                        return;
                    }
                }
                if (generation !== lifecycleGeneration || deliveredSettlement || agentLifecycleSeen) return;
                const handled = options.onPromptLifecycleMissing?.(pendingLocalIds[0]);
                // The callback may synchronously pump the next queued prompt,
                // whose beginPromptLifecycle() advances the generation and
                // resets state. Never stamp the old timer's settlement onto it.
                if (handled === false || generation !== lifecycleGeneration) return;
                deliveredSettlement = true;
                session.updateThinkingState(false);
            })();
        }, PI_PROMPT_LIFECYCLE_GRACE_MS);
        promptLifecycleTimer.unref?.();
    };

    const sendMessages = (messages: ReturnType<PiMessageAccumulator['handleEvent']>): void => {
        for (const message of messages) {
            const converted = convertAgentMessage(message, session.currentModel);
            if (converted) session.sendAgentMessage(converted);
        }
    };
    const flushAccumulator = (): void => sendMessages(assistantMessageAccumulator.flush());

    transport.onEvent((event) => {
        // Legacy Pi emitted auto_compaction_*; normalize it before every
        // lifecycle consumer so both the maintenance gate and timeline see the
        // same current event names. PiTransport performs this for subprocess
        // traffic too; retaining it here keeps direct/test transports aligned.
        const parsedLifecycle = PiLifecycleEventSchema.safeParse(event);
        if (parsedLifecycle.success) {
            event = parsedLifecycle.data;
        }
        if (event.type !== 'keep_alive') {
            logger.debug(`[pi][event] ${event.type}`);
        }
        if (event.type === 'response') {
            const parsed = PiResponseEventSchema.safeParse(event);
            if (parsed.success) {
                const isCurrentPrompt = parsed.data.command === 'prompt'
                    && !deliveredSettlement
                    && !activePromptResponseAccepted
                    && (activePromptId === null ? !promptLifecycleAborted : parsed.data.id === activePromptId);
                if (parsed.data.command === 'prompt' && !isCurrentPrompt) {
                    logger.debug(`[pi] Ignoring stale prompt response id=${parsed.data.id ?? 'missing'}`);
                    return;
                }
                const responseOutcome = handleResponse(
                    parsed.data,
                    session,
                    pendingLocalIds,
                    transport,
                    options.onStartupFailure,
                    options.conversationHistory,
                    options.onReady,
                    (isStreaming) => {
                        if (isStreaming) return true;
                        const promptLifecycleActive = !deliveredSettlement
                            && !promptLifecycleAborted
                            && (activePromptId !== null || agentLifecycleSeen);
                        return !promptLifecycleActive;
                    },
                    syncNativeTitle,
                );
                if (isCurrentPrompt && !parsed.data.success) {
                    const rejectedLocalId = responseOutcome.rejectedPromptLocalId ?? activePromptLocalId;
                    // A Pi 0.83 turn_start can consume the HAPI FIFO before Pi
                    // replies that prompt failed. handleResponse only has the
                    // still-pending list, so finish the exact consumed history
                    // entry here when the FIFO was already shifted.
                    if (responseOutcome.rejectedPromptLocalId === undefined && rejectedLocalId) {
                        options.conversationHistory?.rejectPendingEntry(rejectedLocalId);
                    }
                    rejectPromptLifecycle();
                    options.onPromptRejected?.(rejectedLocalId);
                    return;
                }
                if (isCurrentPrompt && parsed.data.success) {
                    activePromptResponseAccepted = true;
                    if (activeAgentSettledSeen) {
                        deliverSettlement();
                    } else if (agentLifecycleSeen) {
                        scheduleLegacySettleFallback();
                    } else {
                        schedulePromptLifecycleFallback();
                    }
                }
            } else {
                logger.debug('[pi] Ignoring malformed RPC response');
            }
            return;
        }

        if (event.type === 'entry_appended') {
            options.conversationHistory?.observeEntry((event as { entry?: unknown }).entry);
        }

        if (event.type === 'extension_ui_request') {
            const parsed = PiExtensionUiRequestSchema.safeParse(event);
            if (parsed.success) {
                extensionUi.handle(parsed.data);
            } else {
                logger.debug('[pi] Ignoring malformed extension_ui_request');
            }
            return;
        }

        if (event.type === 'session_info_changed') {
            // Pi emits this for `/name` and the set_session_name RPC. Mirror the
            // native rename into HAPI metadata so the web title stays in sync
            // without any HAPI-injected change_title flow (issue #1440).
            const parsed = PiSessionInfoChangedEventSchema.safeParse(event);
            if (parsed.success) {
                syncNativeTitle(parsed.data.name);
            } else {
                logger.debug('[pi] Ignoring malformed session_info_changed');
            }
            return;
        }

        if (event.type === 'agent_start' || event.type === 'turn_start') {
            if (deliveredSettlement) {
                // Pi can start an agent lifecycle on its own — subagent
                // completion wake-ups, scheduled work — with no HAPI prompt in
                // flight. The previous prompt lifecycle already delivered its
                // settlement, so every settlement path below is gated shut and
                // this turn's agent_settled/agent_end would be swallowed,
                // leaving thinking=true (and the FIFO pump blocked) forever.
                // Open a fresh settlement cycle for the autonomous lifecycle.
                // Prompt-driven lifecycles are unaffected: beginPromptLifecycle
                // has already reset deliveredSettlement to false by the time
                // their agent_start arrives.
                // Advance the generation so a previous settlement's async
                // history-sync callback (still in flight) turns stale and
                // cannot mark this new lifecycle's abort boundary as settled.
                lifecycleGeneration += 1;
                deliveredSettlement = false;
                agentEndObserved = false;
                activeAgentSettledSeen = false;
            }
            clearCompactionRetryPending();
            agentLifecycleSeen = true;
            clearLegacySettleFallback();
            clearPromptLifecycleFallback();
            options.onAgentLifecycleStarted?.();
        }
        if (event.type === 'compaction_start') {
            clearCompactionRetryPending();
            maintenanceActive.add('compaction');
            clearLegacySettleFallback();
        } else if (event.type === 'auto_retry_start') {
            maintenanceActive.add('autoRetry');
            clearLegacySettleFallback();
        } else if (event.type === 'summarization_retry_scheduled') {
            maintenanceActive.add('summary');
            clearLegacySettleFallback();
        } else if (event.type === 'compaction_end') {
            maintenanceActive.delete('compaction');
            if ('willRetry' in event && event.willRetry === true) {
                maintenanceActive.add('compactionRetry');
                clearLegacySettleFallback();
                if (compactionRetryTimer) clearTimeout(compactionRetryTimer);
                compactionRetryTimer = setTimeout(() => {
                    compactionRetryTimer = null;
                    if (!maintenanceActive.delete('compactionRetry')) return;
                    scheduleLegacySettleFallback();
                }, PI_COMPACTION_RETRY_START_GRACE_MS);
                compactionRetryTimer.unref?.();
            }
        } else if (event.type === 'auto_retry_end') {
            maintenanceActive.delete('autoRetry');
        } else if (event.type === 'summarization_retry_finished') {
            maintenanceActive.delete('summary');
        }
        lifecycleTimeline.emit(event, session);
        sendMessages(assistantMessageAccumulator.handleEvent(event));

        if (event.type !== 'message_start' && event.type !== 'message_update' && event.type !== 'message_end') {
            const messages = convertPiEvent(event);
            for (const message of messages) {
                const converted = convertAgentMessage(message, session.currentModel);
                if (converted) session.sendAgentMessage(converted);
            }
        }

        if (event.type === 'agent_start') {
            session.updateThinkingState(true);
        } else if (event.type === 'turn_start') {
            session.updateThinkingState(true);
            if (pendingLocalIds.length > 0) {
                const oldestLocalId = pendingLocalIds.shift()!;
                activePromptLocalId = oldestLocalId;
                session.emitMessagesConsumed([oldestLocalId]);
            }
            // Some Pi integrations omit entry_appended forwarding. Incremental
            // get_entries is the durable fallback and still pairs only FIFO.
            if (options.conversationHistory) {
                void options.conversationHistory.syncEntries().catch(() => {});
            }
        } else if (event.type === 'turn_end') {
            // Pi emits turn_end for each LLM/tool-loop iteration. The enclosing
            // user prompt remains active until agent_end, so keep both streaming
            // state and the local FIFO blocked here.
            const requestVersion = ++latestContextUsageRequest;
            void publishPiTurnUsage(
                event as PiTurnEndEvent,
                transport,
                session,
                () => requestVersion === latestContextUsageRequest,
            );
        } else if (event.type === 'agent_end') {
            const parsed = PiAgentEndEventSchema.safeParse(event);
            // Pi can end one attempt before its built-in auto-retry starts. That
            // is not a user-prompt settlement, so keep the HAPI FIFO blocked.
            if (parsed.success && parsed.data.willRetry === true) return;
            agentEndObserved = true;
            scheduleLegacySettleFallback();
        } else if (event.type === 'agent_settled') {
            // A command-only generation has no Pi agent lifecycle; a delayed
            // settled event from an earlier prompt must not settle this one.
            if (agentLifecycleSeen && PiAgentSettledEventSchema.safeParse(event).success) {
                activeAgentSettledSeen = true;
                deliverSettlement();
            }
        }

        if (agentEndObserved && maintenanceActive.size === 0 && (event.type === 'compaction_end' || event.type === 'auto_retry_end' || event.type === 'summarization_retry_finished')) {
            scheduleLegacySettleFallback();
        }
    });

    return {
        flush: flushAccumulator,
        cancelPendingExtensionUi: (reason, options) => extensionUi.cancelAll(reason, options),
        terminatePendingRpc: (error) => session.rpcResolver?.rejectAll(error),
        beginPromptLifecycle,
        abortPromptLifecycle,
    };
}
