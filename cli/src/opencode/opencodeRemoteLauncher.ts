import React from 'react';
import { randomUUID } from 'node:crypto';
import { registerAcpSessionTitleSync } from '@/agent/acpSessionTitle';
import { logger } from '@/ui/logger';
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import type { AcpStderrError } from '@/agent/backends/acp/AcpStdioTransport';
import { isAcpIndeterminateError } from '@/agent/backends/acp/AcpStdioTransport';
import { isAcpStallStderrError } from '@/agent/backends/acp/acpStderrErrors';
import { convertAgentMessage } from '@/agent/messageConverter';
import type { AgentMessage, McpServerStdio, PromptContent } from '@/agent/types';
import { RemoteLauncherBase, type RemoteLauncherDisplayContext, type RemoteLauncherExitReason } from '@/modules/common/remote/RemoteLauncherBase';
import { OpencodeDisplay } from '@/ui/ink/OpencodeDisplay';
import type { OpencodeSession } from './session';
import type { OpencodeMode, PermissionMode } from './types';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { allocateFreePort, createOpencodeBackend } from './utils/opencodeBackend';
import { captureCompactionMarkerSnapshot, fetchCompactionResult, splitProviderModel, triggerOpencodeCompact } from './utils/opencodeCompactBridge';
import { formatOpencodePromptError } from './utils/opencodeErrorText';
import {
    formatOpencodeRetryStatus,
    subscribeToOpencodeEvents,
    type OpencodeEventSubscription,
    type OpencodeRetryStatus
} from './utils/opencodeEventStream';
import { OpencodePermissionHandler } from './utils/permissionHandler';
import { getOpencodeNativeToolInstruction, PLAN_MODE_INSTRUCTION } from './utils/systemPrompt';
import { resolveThoughtLevelEffort } from './thoughtLevelEffort';
import { fetchOpencodeUserMessages } from './utils/opencodeInputReceipt';

type OpencodeRemoteLauncherOptions = {
    onModelRollback?: (model: string | null) => void;
    onReasoningEffortRollback?: (effort: string | null) => void;
    // Called with `true` once the ACP backend + internal HTTP baseUrl are
    // ready (so /compact can actually run) and with `false` whenever this
    // session leaves remote mode. runOpencode.ts uses this to decide whether
    // a `/compact` message should be queued or immediately answered with a
    // "not yet supported" reply — see its `slash.kind === 'compact'` branch.
    onCompactAvailabilityChange?: (available: boolean) => void;
    // Consumes (delete-and-return) whether the queued item with this localId
    // was cancelled via runOpencode.ts's `onCancelQueuedMessage` fallback
    // branch (see the comment on `cancelledDequeuedLocalIds` there for what
    // that actually covers — in practice a narrow ack-vs-hub-DB-write race,
    // not "cancel while the REST call is running"). Checked once the REST
    // call (and summary lookup) settles, so a cancelled request's result
    // doesn't surface for an action the user no longer expects a reply from.
    isLocalIdCancelled?: (localId: string) => boolean;
    // Called only after /clear reaches its FIFO position *and* this
    // launcher has disconnected its OpenCode backend. The caller then performs
    // the source lifecycle cleanup before requesting the fresh process.
    onClearRequested?: () => Promise<void>;
    onClearCleanupComplete?: () => Promise<void>;
    onClearCleanupFailed?: () => Promise<void>;
};

export type AbortStatusDecision = {
    message: string;
    shouldClearThinking: boolean;
};

type CompactOperationPhase = 'idle' | 'snapshot' | 'summarize' | 'post-summarize' | 'verification';

/**
 * One steer operation the launcher still tracks. Deliberately distinct from
 * the queue reservation (what a cancelled row does) and from backend
 * ownership (whether the ACP backend is counting a request):
 *
 * - `settled` resolves only once completion *and* every restore/consumed
 *   bookkeeping finished. It is what the foreground prompt's drain awaits.
 * - `transportPending` is true only while the backend may still be counting
 *   this steer's request: from `beginSoftSteerPrompt` returning (the backend
 *   counts it before `dispatched` resolves) until the real `completed` promise
 *   settles, or until a *definite* failure proved the request is done. Only a
 *   pending request can be *stranded* by a cancellation (one the agent killed
 *   that never answers), so only a pending one may be detached. It must be
 *   cleared as soon as the request settles — while this operation keeps owning
 *   the row's restore bookkeeping, which must continue to gate the drain.
 * - `release()` ends the launcher's wait without touching the ACP callbacks,
 *   so an accepted steer can still commit and acknowledge itself later.
 */
type OpencodeSteerOperation = {
    settled: Promise<void>;
    transportPending: boolean;
    release: () => void;
};

/**
 * Pure decision logic for handleAbort()'s final step: which status message
 * to show, and whether `thinking` should be cleared. Extracted out of the
 * method itself (which calls this with freshly re-read state, not a
 * snapshot from before its awaits — see the call site) so it's unit
 * testable without needing to observe `MessageBuffer`/Ink rendering, which
 * this file's test harness (`opencodeRemoteLauncher.test.ts`) has no
 * infrastructure for.
 *
 * A compact operation left deliberately running after a plain Stop (see
 * `compactResultSuppressed`'s field doc comment on the class) is the one
 * case where nothing has actually stopped yet — Stop alone cannot leave
 * this remote session, only switch-to-local/exit can, so the message says
 * so explicitly rather than leaving the user wondering why the UI still
 * looks busy.
 */
export function selectAbortStatusMessage(opts: {
    hasCompactInFlight: boolean;
    leavingRemote: boolean;
    compactAborted: boolean;
}): AbortStatusDecision {
    const compactStillWaiting = opts.hasCompactInFlight && !opts.leavingRemote && !opts.compactAborted;
    if (compactStillWaiting) {
        return {
            message: 'Stop requested — waiting for the in-progress compaction to finish on the server. Switch to local or exit to leave immediately.',
            shouldClearThinking: false
        };
    }
    return { message: 'Turn aborted', shouldClearThinking: true };
}

class OpencodeRemoteLauncher extends RemoteLauncherBase {
    private readonly session: OpencodeSession;
    private backend: ReturnType<typeof createOpencodeBackend> | null = null;
    /** Loopback base URL of the OpenCode ACP subprocess's internal HTTP API, set once the backend is spawned with an explicit --port/--hostname. */
    private baseUrl: string | null = null;
    private permissionHandler: OpencodePermissionHandler | null = null;
    private happyServer: { stop: () => void } | null = null;
    // Becomes true when the FIFO loop reaches /clear. Its callback is deferred
    // until cleanup() completes so a failed OpenCode disconnect cannot create a
    // replacement while the source backend may still be live.
    private clearRequested = false;
    private abortController = new AbortController();
    // Set by the dequeue loop as soon as a batch is identified as a
    // `operation:'compact'` one — deliberately *before* that batch's inline
    // model/effort switch runs, not only once runCompactOperation()'s
    // triggerOpencodeCompact() REST call actually starts (a hostile-review
    // sweep found that creating it any later left a window during that
    // switch — a real async ACP round-trip — where an abort had nothing to
    // act on yet). Null whenever no compact batch is in flight. Unlike
    // `abortController` above (which governs the dequeue loop's
    // wait-for-next-message signal), `handleAbort()` needs this to actually
    // interrupt the compact's HTTP call(s) — without it, Stop/switch-to-local
    // has no way to unblock a dequeued /compact whose REST call is
    // deliberately unbounded (see triggerOpencodeCompact's doc comment) and
    // the launcher stays wedged until it eventually settles on its own.
    private compactAbortController: AbortController | null = null;
    // A plain Stop must keep waiting only while the summarize POST is
    // actually in flight. That POST can outlive a client-side abort while
    // continuing to mutate the shared OpenCode session, so advancing to a
    // prompt would violate FIFO. The pre-POST marker snapshot and post-POST
    // result verification are read-only GETs; Stop aborts those immediately.
    // `compactOperationPhase` makes that distinction explicit for
    // handleAbort(), while this flag suppresses every eventual compact result.
    private compactResultSuppressed = false;
    private compactOperationPhase: CompactOperationPhase = 'idle';
    private displayPermissionMode: PermissionMode | null = null;
    private instructionsSent = false;
    private currentBackendModel: string | null = null;
    private defaultBackendModel: string | null = null;
    private currentBackendEffort: string | null = null;
    private defaultBackendEffort: string | null = null;
    private setModelSupported: boolean | undefined = undefined;
    private setEffortSupported: boolean | undefined = undefined;
    private activeAcpSessionId: string | null = null;
    /** Subscription to the agent's own server event stream; null until the ACP session id is known, closed in cleanup(). */
    private eventStream: OpencodeEventSubscription | null = null;
    private stallErrorReportedForPrompt = false;
    /** True while a normal (non-compact/clear) prompt turn is in flight — the only steerable state. */
    private promptInFlight = false;
    /** Mode hash of the prompt turn currently in flight; steers must match it. */
    private activePromptModeHash: string | null = null;
    /** Bumped synchronously by abort/cleanup/teardown; invalidates in-flight steer handlers. */
    private steerEpoch = 0;
    /**
     * Identity of the normal prompt turn currently running, advanced once per
     * prompt. `steerEpoch` churns several times per turn (onLeavingRemote,
     * abort, cleanup), so it cannot identify which turn dispatched a soft
     * request; this can, and cancellation paths use it to settle exactly their
     * own turn's requests.
     */
    private steerTurnEpoch = 0;
    /**
     * Steer operations that still own queue/bookkeeping state. Registered the
     * moment a reservation is taken — *before* the durable-state await — and
     * retained until the ACP completion plus every restore/consumed ACK has
     * settled. The foreground prompt's `finally` drains this before advancing,
     * so a prompt that finishes mid-persistence cannot start the next turn
     * while a steer is still restoring rows.
     */
    private pendingSteerOperations = new Set<OpencodeSteerOperation>();
    private pendingSteerAcceptances = new Set<OpencodeSteerOperation>();
    private nativeSteerReceiptGeneration = 0;
    /**
     * Soft requests the ACP backend is still counting, keyed by identity so a
     * late completion callback can only release *its own* entry and never
     * corrupt a newer turn's ownership.
     *
     * `AcpSdkBackend.abortSoftSteers()` deactivates the shared foreground
     * message handler, which would swallow the cancelled turn's trailing
     * tool_result/text — so it may only be called while this set holds a
     * request for that backend. An ordinary Stop with no steer must behave
     * exactly as before steering existed.
     */
    private backendSoftSteerOwnership = new Set<{ backend: AcpSdkBackend; turnEpoch: number }>();

    constructor(
        session: OpencodeSession,
        private readonly options: OpencodeRemoteLauncherOptions = {}
    ) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(OpencodeDisplay, context);
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;
        // Published up front so a session that never reaches a normal prompt
        // advertises "not steerable" rather than a stale value.
        this.setSteeringActive(false);

        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client, {
            enableChangeTitle: false,
            skillLookup: { workingDirectory: session.path, flavor: 'opencode' }
        });
        this.happyServer = happyServer;

        // Pre-select a loopback port for the ACP subprocess's internal HTTP
        // API and pass it explicitly via --port/--hostname. opencode does not
        // announce the bound port anywhere (stdout/stderr/ACP responses) when
        // launched with --port 0, so HAPI must choose it up front to be able
        // to reach that HTTP API later (e.g. for /compact — see
        // opencodeCompactBridge.ts).
        const hostname = '127.0.0.1';
        const port = await allocateFreePort(hostname);
        const baseUrl = `http://${hostname}:${port}`;
        this.baseUrl = baseUrl;

        const backend = createOpencodeBackend({
            cwd: session.path,
            port,
            hostname
        });
        this.backend = backend;
        registerAcpSessionTitleSync(backend, session.client);

        backend.onStderrError((error) => {
            this.handleAcpStderrError(error);
        });

        await backend.initialize();

        const resumeSessionId = session.sessionId;
        const mcpServerList = toAcpMcpServers(mcpServers);
        let acpSessionId: string;
        if (resumeSessionId) {
            try {
                acpSessionId = await backend.loadSession({
                    sessionId: resumeSessionId,
                    cwd: session.path,
                    mcpServers: mcpServerList
                });
            } catch (error) {
                logger.warn('[opencode-remote] resume failed, starting new session', error);
                session.sendSessionEvent({
                    type: 'message',
                    message: 'OpenCode resume failed; starting a new session.'
                });
                acpSessionId = await backend.newSession({
                    cwd: session.path,
                    mcpServers: mcpServerList
                });
            }
        } else {
            acpSessionId = await backend.newSession({
                cwd: session.path,
                mcpServers: mcpServerList
            });
        }
        session.onSessionFound(acpSessionId);
        this.activeAcpSessionId = acpSessionId;

        // Upstream retries are announced only on the agent's own event
        // stream — not as ACP notifications and not on stderr. Measured
        // against a provider stubbed to answer 429: 40 minutes, 85 retries,
        // zero ACP updates, zero stderr bytes, and a prompt that never
        // settled. Without this the user watches a session that looks like
        // it is thinking and never learns it is rate limited.
        //
        // Attached here rather than at spawn time because the stream is
        // filtered by ACP session id, which only exists once new/loadSession
        // has answered. Failing to subscribe degrades that visibility and
        // nothing else, so it is deliberately neither awaited nor
        // error-checked; the subscription reports its own failures at debug
        // level and keeps the session running.
        this.eventStream = subscribeToOpencodeEvents({
            baseUrl,
            // Required. Omitting it yields heartbeats and no session events
            // at all, with no error to notice — see the subscription's doc.
            directory: session.path,
            sessionId: acpSessionId,
            onRetry: (retry) => this.surfaceUpstreamRetry(retry)
        });

        // Seed currentBackendModel from the ACP session metadata so the first
        // batch — whose model the hub mirrors from the just-discovered session —
        // does not trigger a redundant setModel on the very first turn.
        const initialMetadata = backend.getSessionModelsMetadata?.(acpSessionId);
        this.currentBackendModel = initialMetadata?.currentModelId ?? null;
        this.defaultBackendModel = this.currentBackendModel;
        const thoughtLevelOption = backend.getThoughtLevelConfigOption?.(acpSessionId);
        this.currentBackendEffort = thoughtLevelOption?.currentValue ?? null;
        this.defaultBackendEffort = this.currentBackendEffort;

        // The CLI may have been launched with an explicit --model that differs
        // from the ACP session's own default. Apply it eagerly right here so
        // the new model's thought_level config options are captured (via
        // setModel's set_config_option round-trip) *before* the web UI's first
        // effort-options poll — otherwise a variant-capable startup model looks
        // unsupported until after the first turn. On failure just warn: the
        // first batch's existing inline switch path retries the same model.
        const requestedStartupModel = this.session.getModel?.();
        if (
            !this.shouldExit
            && typeof requestedStartupModel === 'string'
            && requestedStartupModel.length > 0
            && requestedStartupModel !== this.defaultBackendModel
            && typeof backend.setModel === 'function'
        ) {
            try {
                await backend.setModel(acpSessionId, requestedStartupModel, { flavor: 'opencode' });
                this.currentBackendModel = requestedStartupModel;
                // The lookup above ran before the switch — re-query so the
                // seeded effort reflects the eagerly applied model.
                const refreshedThoughtLevel = backend.getThoughtLevelConfigOption?.(acpSessionId);
                this.currentBackendEffort = refreshedThoughtLevel?.currentValue ?? null;
                this.defaultBackendEffort = this.currentBackendEffort;
            } catch (error) {
                logger.warn('[opencode-remote] Eager startup model application failed; first batch will retry inline', error);
            }
        }

        // Let the caller (runOpencode.ts) know native /compact can actually
        // run now that the ACP backend + internal HTTP baseUrl exist. The
        // dequeue loop below (not an externally-invoked trigger) is what
        // executes it, in its actual FIFO queue position.
        //
        // A 9th PR-review round found a race here: a terminal
        // switch-to-local/exit can land *during* the newSession/loadSession
        // await above (setupTerminal() wires up onExit/onSwitchToLocal
        // before runMainLoop() even starts, so this is reachable well
        // before setupAbortHandlers() below registers the RPC
        // 'abort'/'switch' handlers). RemoteLauncherBase.requestExit()
        // already fired onLeavingRemote() (availability(false)) and set
        // `this.shouldExit = true` synchronously for that switch/exit,
        // before awaiting its handler — but this line used to run
        // regardless once initialization finished, resurrecting
        // availability(true) even though the session is already on its way
        // out. runOpencode.ts's compactSupported/compactTeardownInProgress
        // gate treats compactSupported flipping true as reason enough to
        // ignore compactTeardownInProgress entirely (see that gate's doc
        // comment), so this stray true could let a /compact arriving right
        // after slip into the queue mid-teardown. Checking `shouldExit`
        // here — the same flag requestExit() already set — keeps
        // availability from ever un-flipping once a switch/exit is
        // underway.
        if (!this.shouldExit) {
            this.options.onCompactAvailabilityChange?.(true);
        }

        // Expose the cached models metadata via per-session RPC so the hub can
        // forward it to the web UI's model selector without round-tripping ACP.
        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListOpencodeModels, async () => {
            const metadata = backend.getSessionModelsMetadata?.(acpSessionId);
            if (!metadata) {
                return { success: false, error: 'OpenCode model metadata is not available' };
            }
            return {
                success: true,
                availableModels: metadata.availableModels,
                currentModelId: metadata.currentModelId
            };
        });

        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListOpencodeReasoningEffortOptions, async () => {
            const effortOption = backend.getThoughtLevelConfigOption?.(acpSessionId);
            const currentModelId = backend.getSessionModelsMetadata?.(acpSessionId)?.currentModelId ?? null;
            const requestedModel = this.session.getModel?.();
            const targetModelId = requestedModel === null
                ? this.defaultBackendModel
                : requestedModel ?? currentModelId;
            if (!effortOption) {
                return {
                    success: false,
                    error: 'OpenCode reasoning effort options are not available',
                    currentModelId,
                    targetModelId
                };
            }
            return {
                success: true,
                options: effortOption.options,
                currentValue: effortOption.currentValue ?? null,
                // Lets the web client detect "options still belong to the
                // previous model" while a requested switch has not been
                // applied by the backend yet.
                currentModelId,
                targetModelId
            };
        });

        this.permissionHandler = new OpencodePermissionHandler(
            session.client,
            backend,
            () => session.getPermissionMode() as PermissionMode | undefined
        );
        this.applyDisplayMode(session.getPermissionMode() as PermissionMode);

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            // Explicit `false`: plain Stop stays in this remote session, so
            // an in-flight compact must not be aborted client-side — see
            // handleAbort's `leavingRemote` doc comment.
            onAbort: () => this.handleAbort(false),
            onSwitch: () => this.handleSwitchRequest()
        });

        this.installSteerHandler(session, acpSessionId);

        const sendReady = () => {
            session.sendSessionEvent({ type: 'ready' });
        };

        while (!this.shouldExit) {
            const waitSignal = this.abortController.signal;
            const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);
            if (!batch) {
                if (waitSignal.aborted && !this.shouldExit) {
                    continue;
                }
                break;
            }

            // /clear is deliberately a queue operation rather than a direct
            // slash side effect: every prompt and /compact ahead of it has
            // completed before this point. In particular, do not route this
            // through handleAbort(true): that method exists to interrupt an
            // in-flight compact, while clear can only run after one finishes.
            if (batch.mode.operation === 'clear') {
                await this.options.onClearRequested?.();
                this.clearRequested = true;
                await this.requestExit('exit', async () => {})
                break;
            }

            // Created here — before the model/effort switch below — rather
            // than inside runCompactOperation(), so it already exists for
            // handleAbort() to act on during that switch. backend.setModel()/
            // setConfigOption() are real async ACP round-trips that yield to
            // the event loop; a hostile-review whole-feature sweep found
            // that an abort landing in that window used to hit a still-null
            // compactAbortController (a no-op) and then get silently
            // forgotten once runCompactOperation() created a *fresh*
            // controller afterward — the compact's unbounded REST call would
            // then run to completion with no way to interrupt it, despite
            // the user having already pressed Stop/switch/exit.

            // No foreground turn is live here (the previous one settled and its
            // drain completed), so this is the one safe place to force-settle a
            // soft request a cancellation left counted: the inter-turn
            // model/effort switch below awaits response-complete and would
            // otherwise block on it forever.
            this.settleBackendSoftSteers(backend, null, 'dequeue');

            const isCompactBatch = batch.mode.operation === 'compact';
            const compactAbortController = isCompactBatch ? new AbortController() : null;
            if (compactAbortController) {
                this.compactAbortController = compactAbortController;
                this.compactOperationPhase = 'idle';
                // Reset here (as early as the controller itself — see its
                // sibling field's doc comment for why that timing matters)
                // rather than inside runCompactOperation(), so a plain Stop
                // landing during the model/effort switch below already has
                // something to suppress.
                this.compactResultSuppressed = false;
            }

            // Inline model change via ACP RPC (session/set_model — see ACP SDK
            // schema `x-method: session/set_model`). Mirrors the Gemini pattern
            // from PR #543: if the running OpenCode build does not implement the
            // RPC, we learn that from the first method-not-found response and stop
            // attempting it for the rest of this session.
            //
            // `batch.mode.model` semantics: a string is a specific model id;
            // `null` means "reset to whatever model the backend launched with"
            // (emitted by `/model default`); `undefined` means "no change".
            const requestedModel = batch.mode.model === null
                ? this.defaultBackendModel
                : batch.mode.model;
            // The very first batch seeds currentBackendModel — the OpenCode CLI was
            // launched with that model via --model and there is nothing to switch yet.
            if (requestedModel && this.currentBackendModel === null) {
                this.currentBackendModel = requestedModel;
            } else if (requestedModel && requestedModel !== this.currentBackendModel) {
                if (!backend.setModel || this.setModelSupported === false) {
                    this.rollbackModel(batch, this.currentBackendModel);
                } else {
                    logger.debug(`[opencode-remote] Switching model inline: ${this.currentBackendModel} -> ${requestedModel}`);
                    try {
                        await backend.setModel(acpSessionId, requestedModel, { flavor: 'opencode' });
                        this.currentBackendModel = requestedModel;
                        this.setModelSupported = true;
                        // set_config_option("model") also switches the backend's
                        // effort currentValue — refresh both cached efforts so
                        // a subsequent request equal to the stale value still
                        // performs the round-trip instead of being skipped,
                        // and an unset effort falls back to the *new* model's
                        // default rather than reapplying the old model's.
                        const refreshedInlineEffort = backend.getThoughtLevelConfigOption?.(acpSessionId);
                        this.currentBackendEffort = refreshedInlineEffort?.currentValue ?? null;
                        this.defaultBackendEffort = this.currentBackendEffort;
                        // Reflect the resolved model back into the batch so
                        // downstream display logic sees the concrete id rather
                        // than a `null` placeholder.
                        batch.mode.model = requestedModel;
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        const methodNotFound = /method not found/i.test(message);
                        if (methodNotFound && this.setModelSupported === undefined) {
                            this.setModelSupported = false;
                            logger.warn('[opencode-remote] OpenCode build does not support session/set_model; inline switching disabled for this session');
                            session.sendSessionEvent({
                                type: 'message',
                                message: 'This OpenCode build does not support inline model switching. Restart the session to apply a different model.'
                            });
                        } else {
                            logger.warn('[opencode-remote] Inline model switch failed', error);
                            session.sendSessionEvent({
                                type: 'message',
                                message: `Failed to switch model to ${requestedModel}. Continuing with ${this.currentBackendModel ?? '(default)'}.`
                            });
                        }
                        this.rollbackModel(batch, this.currentBackendModel);
                    }
                }
            }

            const requestedEffort = batch.mode.modelReasoningEffort ?? this.defaultBackendEffort;
            if (requestedEffort && requestedEffort !== this.currentBackendEffort) {
                const thoughtLevelOption = backend.getThoughtLevelConfigOption?.(acpSessionId);
                if (!backend.setConfigOption || !thoughtLevelOption || this.setEffortSupported === false) {
                    this.rollbackReasoningEffort(batch, this.currentBackendEffort);
                } else {
                    const resolvedEffort = resolveThoughtLevelEffort(
                        requestedEffort,
                        thoughtLevelOption,
                        this.currentBackendEffort ?? this.defaultBackendEffort
                    );
                    if (!resolvedEffort || resolvedEffort === this.currentBackendEffort) {
                        if (requestedEffort !== resolvedEffort) {
                            logger.warn(
                                `[opencode-remote] Unsupported reasoning effort "${requestedEffort}"; continuing with ${resolvedEffort ?? this.currentBackendEffort ?? '(default)'}`
                            );
                            this.rollbackReasoningEffort(batch, resolvedEffort ?? this.currentBackendEffort);
                        }
                    } else {
                        logger.debug(`[opencode-remote] Switching effort inline: ${this.currentBackendEffort ?? '(default)'} -> ${resolvedEffort}`);
                        try {
                            await backend.setConfigOption(acpSessionId, thoughtLevelOption.id, resolvedEffort);
                            this.currentBackendEffort = resolvedEffort;
                            this.setEffortSupported = true;
                            if (requestedEffort !== resolvedEffort) {
                                this.rollbackReasoningEffort(batch, resolvedEffort);
                            }
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error);
                            const methodNotFound = /method not found/i.test(message);
                            if (methodNotFound && this.setEffortSupported === undefined) {
                                this.setEffortSupported = false;
                                logger.warn('[opencode-remote] OpenCode build does not support session/set_config_option; inline effort switching disabled for this session');
                                session.sendSessionEvent({
                                    type: 'message',
                                    message: 'This OpenCode build does not support inline reasoning effort switching.'
                                });
                            } else {
                                logger.warn('[opencode-remote] Inline effort switch failed', error);
                                session.sendSessionEvent({
                                    type: 'message',
                                    message: `Failed to switch reasoning effort to ${resolvedEffort}. Continuing with ${this.currentBackendEffort ?? '(default)'}.`
                                });
                            }
                            this.rollbackReasoningEffort(batch, this.currentBackendEffort);
                        }
                    }
                }
            }

            this.applyDisplayMode(batch.mode.permissionMode);
            messageBuffer.addMessage(batch.message, 'user');

            // /compact reaches here through the exact same dequeue loop as
            // any prompt — it was pushed via messageQueue.pushIsolated(...)
            // in runOpencode.ts, so it occupies its real FIFO position
            // relative to prompts queued before or after it (fixes a prior
            // design where /compact ran via an externally-invoked trigger
            // and could execute ahead of an already-queued prompt). The
            // model/effort switch above already ran for this batch just like
            // any other, so compaction runs under whatever model this batch
            // resolved to.
            if (isCompactBatch && compactAbortController) {
                // A compact batch is always a single isolated item (pushed
                // via pushIsolated), so its own localId is exactly
                // batch.items[0]?.localId.
                const compactLocalId = batch.items[0]?.localId;

                // A 7th PR-review round found that a plain Stop landing
                // *during the model/effort switch above* — before this
                // compact's REST request has ever actually been sent — was
                // silently ignored here. Plain Stop's handleAbort(false) only
                // sets `compactResultSuppressed = true`; it deliberately
                // leaves compactAbortController.signal alone (see that
                // field's doc comment — Round 6 needs the real HTTP request
                // to keep running so the dequeue loop can wait for genuine
                // server-side completion). But that logic assumed a request
                // was already in flight to wait for. Here, mid-switch, none
                // has been sent yet — so this branch used to call
                // runCompactOperation() unconditionally once the switch
                // resolved anyway, starting a brand new REST request the
                // instant a cancelled compact's turn came up and blocking
                // the dequeue loop for however long that takes.
                //
                // The fix is narrow on purpose: skip starting the operation
                // only when a plain Stop landed (compactResultSuppressed)
                // AND the controller was never actually aborted. If the
                // controller WAS aborted, that means switch/exit's
                // handleAbort(true) ran instead — and Round 5's test
                // (below) established that runCompactOperation() must still
                // be called in that case, threading the pre-aborted signal
                // through so the fetch call rejects immediately without any
                // network I/O, rather than being skipped here.
                //
                // An 8th PR-review round found this same reasoning also
                // applies to isLocalIdCancelled, which round 7 had
                // deliberately left out of this check (see runOpencode.ts's
                // preparingLocalIds/cancelledBeforeEnqueue doc comment for
                // the full mechanism): the localId-keyed cancel Set it reads
                // can *only* ever be populated during the brief network
                // round trip between the CLI emitting the /compact item's
                // "invoked" ack and the hub recording it — never while a
                // compact REST call is actually running. So if
                // isLocalIdCancelled(compactLocalId) is already true here,
                // that unconditionally means this compact was cancelled
                // before its REST request was ever sent, exactly like the
                // compactResultSuppressed case above — there's no
                // in-flight server-side work to preserve by starting the
                // operation anyway. (isLocalIdCancelled is a delete-and-
                // return, one-shot callback, so checking it here consumes
                // the same entry runCompactOperation()'s own isCancelled()
                // would otherwise have consumed — it isn't checked twice.)
                const compactCancelledByLocalId = compactLocalId
                    ? (this.options.isLocalIdCancelled?.(compactLocalId) ?? false)
                    : false;
                const cancelledBeforeStart =
                    (this.compactResultSuppressed && !compactAbortController.signal.aborted)
                    || compactCancelledByLocalId;
                if (cancelledBeforeStart) {
                    if (this.compactAbortController === compactAbortController) {
                        this.compactAbortController = null;
                        this.compactOperationPhase = 'idle';
                    }
                    // A 10th PR-review round found this skip path never
                    // calls session.onThinkingChange(true) (that's the
                    // whole point of skipping) but also never told the hub
                    // this queued item is done, leaving the web UI spinner
                    // stuck: markMessageQueued's 15s "queued thinking"
                    // grace (hub/src/sync/sessionCache.ts) keeps thinking
                    // pinned true regardless of keepalives until either the
                    // grace expires or a messages-consumed ack with
                    // `clearQueuedThinkingGrace` arrives. Same situation,
                    // same fix, as the synchronous slash.kind === 'handled'
                    // path in runOpencode.ts (e.g. /model — see its
                    // `clearQueuedThinkingGrace` comment there): ack with
                    // the grace-clearing flag, then push an immediate
                    // thinking=false keepalive so the spinner clears
                    // without waiting on the grace. (This is on top of, not
                    // instead of, the queue's own unflagged
                    // onBatchConsumed ack — a second ack for an
                    // already-invoked localId is a no-op on the hub's
                    // first-write-wins queued-message protocol, and
                    // clearQueuedThinkingGrace itself is keyed by session,
                    // not by localId, so it's idempotent too.)
                    if (compactLocalId) {
                        session.client.emitMessagesConsumed([compactLocalId], { clearQueuedThinkingGrace: true });
                    }
                    // Plain Stop before summarize already emitted this
                    // keepalive in handleAbort(); localId cancellation did not.
                    if (!this.compactResultSuppressed) {
                        session.onThinkingChange(false);
                    }
                    if (session.queue.size() === 0 && !this.shouldExit) {
                        sendReady();
                    }
                    continue;
                }

                session.onThinkingChange(true);
                try {
                    await this.runCompactOperation(acpSessionId, compactAbortController, compactLocalId);
                } finally {
                    session.onThinkingChange(false);
                    if (session.queue.size() === 0 && !this.shouldExit) {
                        sendReady();
                    }
                }
                continue;
            }

            // Inject title instructions on first prompt
            let messageText = batch.message;
            if (batch.mode.permissionMode === 'plan') {
                messageText = `${PLAN_MODE_INSTRUCTION}\n\n${messageText}`;
            }
            if (!this.instructionsSent) {
                messageText = `${getOpencodeNativeToolInstruction()}\n\n${messageText}`;
                this.instructionsSent = true;
            }

            const promptContent: PromptContent[] = [{
                type: 'text',
                text: messageText,
            }];

            this.stallErrorReportedForPrompt = false;
            session.onThinkingChange(true);
            // Only a normal prompt is steerable: /compact and /clear leave this
            // false, so a steer arriving during either is rejected rather than
            // injected into a turn the agent is not running.
            this.promptInFlight = true;
            this.activePromptModeHash = batch.hash;
            this.steerTurnEpoch += 1;
            // Advertise steerability so the web's queued-message Steer button
            // is reachable at all; only a normal active prompt may set it.
            this.setSteeringActive(true);
            // Captured before the prompt await: handleAbort replaces
            // this.abortController, so the drain below must race the turn's
            // own signal to stay abort-aware.
            const promptTurnSignal = this.abortController.signal;

            try {
                await backend.prompt(acpSessionId, promptContent, (message: AgentMessage) => {
                    this.handleAgentMessage(message);
                });
                void backend.refreshSessionInfo(acpSessionId, session.path);
            } catch (error) {
                logger.warn('[opencode-remote] prompt failed', error);
                this.reportPromptFailure(error);
            } finally {
                // Close the steer gate synchronously, before the first await:
                // any steer still parked on its durable-state await must see
                // the turn as gone and restore its row instead of injecting
                // into a turn that has already returned.
                this.promptInFlight = false;
                this.activePromptModeHash = null;
                // Publish "not steerable" together with the gate, *before* the
                // drain: a steer whose completion is still pending would keep
                // the web's Steer button visible for the whole drain, and every
                // click in that window is a guaranteed rejection.
                this.setSteeringActive(false);
                // Drain before ready / thinking=false / the next batch, so a
                // steer that settled (or is still restoring) cannot cross the
                // turn boundary into the next prompt or a /compact.
                await this.drainSteerOperations(promptTurnSignal);
                session.onThinkingChange(false);
                await this.permissionHandler?.cancelAll('Prompt finished');
                if (session.queue.size() === 0 && !this.shouldExit) {
                    sendReady();
                }
            }
        }
    }

    /**
     * Registers the per-message Queue/Steer handler. A steer delivers one
     * waiting-queue row into the *active* OpenCode turn as a concurrent ACP
     * `session/prompt` (soft inject) — no cancel, no mode/model/effort
     * mutation, and no plan-instruction re-application (that already rode the
     * active prompt).
     */
    private installSteerHandler(
        session: OpencodeSession,
        acpSessionId: string
    ): void {
        session.client.rpcHandlerManager.registerHandler(
            RPC_METHODS.SteerQueuedMessage,
            async (payload: unknown) => {
                const localId = typeof (payload as { localId?: unknown } | null)?.localId === 'string'
                    ? (payload as { localId: string }).localId
                    : '';
                if (!localId) {
                    return { steered: false, error: 'Missing localId' };
                }
                const backend = this.backend;
                // isPromptRequestInFlight(), not processingMessage: after ACP
                // answers the foreground session/prompt, prompt() keeps
                // draining updates for seconds while the backend still reports
                // a processing message. A steer accepted in that window would
                // start a brand-new turn instead of injecting mid-turn.
                if (!this.promptInFlight
                    || !this.activeAcpSessionId
                    || !backend
                    || this.shouldExit
                    || !backend.isPromptRequestInFlight()) {
                    return { steered: false, error: 'No active steerable turn' };
                }
                const steerEpoch = this.steerEpoch;
                const targetPromptGeneration = backend.getPromptGeneration();

                // takeByLocalId is atomic: a duplicate Steer for the same row
                // finds no queue entry (the live one is held as a reservation)
                // and is rejected.
                const taken = session.queue.takeByLocalId(localId);
                if (!taken) {
                    return { steered: false, error: 'Message not in queue' };
                }

                // Registered before the first await below, and released only
                // after every restore/consumed ACK has settled. Without this
                // a prompt finishing during the durable-state await would
                // drain an empty set and advance to the next batch while this
                // row is still being restored.
                const { operation, release: releaseOperation } = this.beginSteerOperation();
                const receiptGeneration = this.nativeSteerReceiptGeneration;

                const isControlItem = Boolean(taken.item.isolate) || taken.item.mode.operation !== undefined;
                if (isControlItem) {
                    session.queue.restoreReservation(taken);
                    releaseOperation();
                    return { steered: false, error: 'Control commands cannot be steered' };
                }
                if (this.activePromptModeHash !== taken.item.modeHash) {
                    session.queue.restoreReservation(taken);
                    releaseOperation();
                    return { steered: false, error: 'Queued message mode differs from the active turn' };
                }
                if (!session.queue.beginReservationDispatch(taken)) {
                    releaseOperation();
                    return { steered: false, error: 'Steer cancelled' };
                }

                const dispatchStatePersisted = await session.client.setSteerDeliveryState([localId], 'dispatching');
                if (!dispatchStatePersisted) {
                    // Never send without a durable dispatching state: a crash
                    // after this point must not look like a delivered row.
                    session.queue.markReservationIndeterminate(taken);
                    session.client.emitSteerIndeterminate([localId]);
                    releaseOperation();
                    return { steered: false, error: 'Steer state is indeterminate' };
                }

                const restoreQueuedReservation = async (): Promise<boolean> => {
                    if (!taken.originIndeterminate) {
                        const persisted = await session.client.setSteerDeliveryState([localId], 'queued');
                        if (!persisted) {
                            session.queue.markReservationIndeterminate(taken);
                            session.client.emitSteerIndeterminate([localId]);
                            return false;
                        }
                    }
                    if (taken.state !== 'dispatching' || !session.queue.restoreReservation(taken)) {
                        session.client.emitSteerIndeterminate([localId]);
                        return false;
                    }
                    return true;
                };

                if (taken.state !== 'dispatching') {
                    session.client.emitSteerIndeterminate([localId]);
                    releaseOperation();
                    return { steered: false, error: 'Steer cancelled' };
                }
                // Snapshot before dispatch: an older identical prompt must not
                // count as acceptance. Overlapping unproven steers cannot be
                // correlated by text, so they retain completion-based ACKs.
                const nativeBefore = this.pendingSteerAcceptances.size === 1
                    ? await fetchOpencodeUserMessages({ baseUrl: this.baseUrl, sessionId: acpSessionId })
                    : null;
                // Recheck everything the durable/native-history awaits could
                // have invalidated before sending to the backend.
                if (!this.promptInFlight
                    || this.shouldExit
                    || this.steerEpoch !== steerEpoch
                    || this.backend !== backend
                    || this.activeAcpSessionId !== acpSessionId
                    || !backend.isPromptRequestInFlight()
                    || backend.getPromptGeneration() !== targetPromptGeneration) {
                    await restoreQueuedReservation();
                    releaseOperation();
                    return { steered: false, error: 'Active turn changed' };
                }

                let steer: { dispatched: Promise<void>; completed: Promise<void> };
                let softSteerOwnership: { backend: AcpSdkBackend; turnEpoch: number } | null = null;
                try {
                    steer = backend.beginSoftSteerPrompt(acpSessionId, [{
                        type: 'text',
                        text: taken.item.message
                    }]);
                    // The backend counts this request from here, before
                    // `dispatched` resolves, so ownership starts now — and a
                    // cancellation can strand it from here on.
                    softSteerOwnership = { backend, turnEpoch: this.steerTurnEpoch };
                    this.backendSoftSteerOwnership.add(softSteerOwnership);
                    operation.transportPending = true;
                    // Attach the transport-ownership cleanup immediately,
                    // before awaiting dispatch. `AcpSdkBackend`'s `completed`
                    // runs finishPromptRequest in its finally, so the backend
                    // stops counting this request the moment that promise
                    // settles — for *every* outcome, definite or ambiguous.
                    // Leaving the record behind would let a cancellation detach
                    // the operation mid-restore (the FIFO inversion) and
                    // force-settle a counter already back down, deactivating the
                    // foreground handler for nothing.
                    //
                    // This is purely backend logical-request bookkeeping: an
                    // ambiguous outcome is still an unproven *delivery*, which
                    // the reservation policy below handles independently (held
                    // indeterminate, never auto-replayed). The handler swallows
                    // the rejection, so this adds no unhandled rejection.
                    void steer.completed.then(() => {
                        this.settleSteerTransport(operation, softSteerOwnership);
                    }, () => {
                        this.settleSteerTransport(operation, softSteerOwnership);
                    });
                } catch (error) {
                    if (isAcpIndeterminateError(error)) {
                        if (session.queue.markReservationIndeterminate(taken)) {
                            session.client.emitSteerIndeterminate([localId]);
                        }
                        logger.debug('[opencode-remote] soft-steer dispatch outcome unknown', error);
                        releaseOperation();
                        return { steered: false, error: 'Steer outcome is being reconciled' };
                    }
                    logger.debug('[opencode-remote] soft-steer failed to start', error);
                    await restoreQueuedReservation();
                    releaseOperation();
                    return { steered: false, error: 'Failed to soft-steer into active turn' };
                }

                try {
                    // Ack the hub once ACP accepted the inject on stdin, not
                    // when the concurrent prompt finishes — that response can
                    // exceed the hub's RPC timeout while the inject is already
                    // under way. Completion still gates the next prompt.
                    await steer.dispatched;
                } catch (error) {
                    if (isAcpIndeterminateError(error)) {
                        if (session.queue.markReservationIndeterminate(taken)) {
                            session.client.emitSteerIndeterminate([localId]);
                        }
                        logger.debug('[opencode-remote] soft-steer dispatch outcome unknown', error);
                        releaseOperation();
                        return { steered: false, error: 'Steer outcome is being reconciled' };
                    }
                    // A definite dispatch rejection means the request is
                    // finished, not stranded: clear its ownership before the
                    // restore so a cancellation during it cannot treat this
                    // operation as an unanswered runtime request.
                    this.settleSteerTransport(operation, softSteerOwnership);
                    await restoreQueuedReservation();
                    releaseOperation();
                    logger.debug('[opencode-remote] soft-steer failed to start', error);
                    return { steered: false, error: 'Failed to soft-steer into active turn' };
                }

                let accepted = false;
                const acknowledgeAcceptance = () => {
                    if (accepted) return;
                    accepted = true;
                    this.pendingSteerAcceptances.delete(operation);
                    session.queue.commitReservation(taken);
                    session.client.emitMessagesConsumed([localId], { steered: true });
                    this.messageBuffer.addMessage(taken.item.message, 'user');
                };
                // OpenCode persists the user input before the concurrent
                // session/prompt response (which waits for the model's entire
                // turn). A new native id with the exact input proves acceptance
                // now, allowing every UI to move the row into chat promptly.
                // Never infer acceptance from stdin dispatch or elapsed time.
                const nativeReceipt = (async () => {
                    if (!nativeBefore) return;
                    const previousIds = new Set(nativeBefore.map(message => message.id));
                    const deadline = Date.now() + 3_000;
                    while (!accepted && Date.now() < deadline
                        && this.steerEpoch === steerEpoch
                        && this.backend === backend
                        && this.activeAcpSessionId === acpSessionId
                        && this.nativeSteerReceiptGeneration === receiptGeneration
                        && this.pendingSteerAcceptances.has(operation)) {
                        const nativeMessages = await fetchOpencodeUserMessages({
                            baseUrl: this.baseUrl,
                            sessionId: acpSessionId,
                            signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))
                        });
                        if (this.steerEpoch !== steerEpoch
                            || this.backend !== backend
                            || this.activeAcpSessionId !== acpSessionId
                            || this.nativeSteerReceiptGeneration !== receiptGeneration) return;
                        if (!nativeMessages) return;
                        const matches = nativeMessages.filter(message =>
                            !previousIds.has(message.id) && message.text === taken.item.message
                        );
                        if (matches.length === 1) {
                            acknowledgeAcceptance();
                            return;
                        }
                        if (matches.length > 1) return;
                        await new Promise<void>(resolve => setTimeout(resolve, 100));
                    }
                })();
                // Completion still gates the next normal prompt and settles
                // backend ownership. A failure after proven native acceptance
                // must never restore/replay that input. If no receipt is
                // available, retain the rejection/indeterminate contract.
                void steer.completed.then(acknowledgeAcceptance, async (error) => {
                    await nativeReceipt;
                    if (accepted) return;
                    if (isAcpIndeterminateError(error)) {
                        if (session.queue.markReservationIndeterminate(taken)) {
                            session.client.emitSteerIndeterminate([localId]);
                        }
                        logger.debug('[opencode-remote] soft-steer outcome unknown after dispatch; row held for explicit resolution', error);
                        return;
                    }
                    return restoreQueuedReservation().then((restored) => {
                        if (restored) {
                            logger.debug('[opencode-remote] soft-steer rejected by ACP; row restored', error);
                        }
                    });
                }).finally(() => {
                    releaseOperation();
                });
                await nativeReceipt;
                return { steered: true };
            }
        );
    }

    /**
     * Single source of the steer gate's lifecycle: bump the epoch so any steer
     * parked on an await is invalid, close the normal-prompt gate, and stop
     * advertising steerability. Every terminal or cancelling path (abort,
     * switch/exit, teardown, and the stderr stall cancel) must run this
     * *synchronously*, before its first await — otherwise a steer can still
     * inject into a runtime that is being cancelled or already torn down.
     *
     * `detachStrandedSteers` additionally releases tracked operations whose
     * ACP request may still be unanswered — a cancellation can strand those
     * forever, and they must not block the next turn's drain. Everything else
     * keeps gating the drain: an operation still on its durable write, or on
     * the restore that follows a settled request, always finishes within the
     * socket timeouts. Releasing those early would let the next prompt start
     * (and `ready` fire) while the row is still held, and the row would then
     * be restored *after* the next prompt, inverting FIFO. Their ACP callbacks
     * stay attached either way, so a steer that was in fact accepted can still
     * commit and acknowledge itself.
     */
    private closeSteerGate(options?: { detachStrandedSteers?: boolean }): void {
        this.steerEpoch++;
        this.promptInFlight = false;
        this.activePromptModeHash = null;
        this.setSteeringActive(false);
        if (options?.detachStrandedSteers === true) {
            for (const operation of Array.from(this.pendingSteerOperations)) {
                if (operation.transportPending) {
                    operation.release();
                }
            }
        }
    }

    /**
     * Publishes whether a queued message could be steered right now. The web
     * only surfaces the queued Steer button for a session advertising this,
     * so it must track the normal prompt turn exactly — true while one runs,
     * false in its `finally`, on abort, on teardown, and the instant remote
     * mode starts leaving.
     */
    private setSteeringActive(active: boolean): void {
        this.session.client.updateAgentState?.((state) => ({ ...state, steeringActive: active }));
    }

    /**
     * Registers a steer operation that the foreground prompt must wait for.
     * Released once its bookkeeping finished, or detached by a cancellation
     * that can strand its ACP request — either way the ACP callbacks attached
     * to that request stay alive.
     */
    private beginSteerOperation(): {
        operation: OpencodeSteerOperation;
        release: () => void;
    } {
        let settle!: () => void;
        const operation: OpencodeSteerOperation = {
            settled: new Promise<void>((resolve) => { settle = resolve; }),
            transportPending: false,
            release: () => {}
        };
        this.pendingSteerOperations.add(operation);
        this.pendingSteerAcceptances.add(operation);
        this.nativeSteerReceiptGeneration++;
        let released = false;
        operation.release = () => {
            if (released) return;
            released = true;
            this.pendingSteerOperations.delete(operation);
            this.pendingSteerAcceptances.delete(operation);
            settle();
        };
        return { operation, release: operation.release };
    }

    /**
     * Marks a steer operation's ACP request as settled: the backend no longer
     * counts it, so it is neither stranded-by-a-cancellation material nor a
     * reason to force-settle counters.
     *
     * Identity-scoped on both sides — a late callback (an aborted turn's
     * request settling long after) can only clear its own record and flag, and
     * can never mark a newer turn's request as settled.
     */
    private settleSteerTransport(
        operation: OpencodeSteerOperation,
        ownership: { backend: AcpSdkBackend; turnEpoch: number } | null
    ): void {
        operation.transportPending = false;
        if (ownership) {
            this.backendSoftSteerOwnership.delete(ownership);
        }
    }

    /**
     * Force-settles this backend's soft-steer counters — and only when it
     * actually owns an outstanding soft request.
     *
     * `AcpSdkBackend.abortSoftSteers()` deactivates the shared foreground
     * message handler, so calling it on a plain Stop with no steer would
     * swallow the cancelled turn's trailing tool_result/text. `turnEpoch`
     * scopes the decision to the turn being cancelled; `null` means "any
     * leftover", which is only safe where no foreground turn is live (the
     * dequeue loop, after the previous turn settled).
     */
    private settleBackendSoftSteers(
        backend: AcpSdkBackend,
        turnEpoch: number | null,
        reason: string
    ): void {
        let owned = false;
        for (const entry of Array.from(this.backendSoftSteerOwnership)) {
            if (entry.backend !== backend) continue;
            if (turnEpoch !== null && entry.turnEpoch !== turnEpoch) continue;
            this.backendSoftSteerOwnership.delete(entry);
            owned = true;
        }
        if (!owned) {
            return;
        }
        logger.debug(`[opencode-remote] settling stranded soft-steer request (${reason})`);
        backend.abortSoftSteers();
    }

    /**
     * Waits for every tracked steer operation to finish its bookkeeping.
     * Abort-aware through the *original* turn signal: handleAbort replaces
     * this.abortController, so reading the field here would miss the abort.
     */
    private async drainSteerOperations(turnSignal: AbortSignal): Promise<void> {
        if (this.pendingSteerOperations.size === 0) return;
        if (turnSignal.aborted) {
            // The turn was aborted; its steer work must not gate the next one.
            return;
        }
        const pending = Array.from(this.pendingSteerOperations, (operation) => operation.settled);
        let releaseWait!: () => void;
        const abortListener = () => releaseWait();
        turnSignal.addEventListener('abort', abortListener, { once: true });
        try {
            await Promise.race([
                Promise.allSettled(pending),
                new Promise<void>((resolve) => { releaseWait = resolve; })
            ]);
        } finally {
            turnSignal.removeEventListener('abort', abortListener);
        }
    }

    /**
     * /compact must stop being offered the instant remote mode starts
     * leaving — not merely by the time it's actually torn down, and
     * critically not only on the *next* local-mode entry (the previous
     * mechanism, in loop.ts's `runLocal:` callback). That gap between "a
     * switch/exit was requested" and "the next runLocal() call reset this"
     * is exactly the window a PR-review round found: a /compact slash
     * command arriving in it still queues normally (runOpencode.ts's
     * `compactSupported` flag hadn't flipped yet), and since local mode
     * immediately hands back to remote when it finds a non-empty queue, that
     * queued compact can end up running anyway — despite the user having
     * already asked to leave remote mode. See onLeavingRemote()'s doc
     * comment on RemoteLauncherBase for exactly when this fires.
     */
    protected onLeavingRemote(): void {
        // Synchronous, before anything here could await: a steer parked on a
        // durable-state await must not be able to inject into a backend that is
        // already on its way out.
        this.closeSteerGate();
        this.options.onCompactAvailabilityChange?.(false);
    }

    protected async cleanup(): Promise<void> {
        // Before anything that can fail: a steer still parked on a
        // durable-state await must not be able to send into the backend that is
        // about to be torn down (or a replacement one).
        this.closeSteerGate({ detachStrandedSteers: true });
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.SteerQueuedMessage, async () => ({
            steered: false,
            error: 'Session ending'
        }));
        // Before anything that can fail: a stream left open would keep
        // reconnecting to a subprocess that is on its way out.
        this.eventStream?.close();
        this.eventStream = null;
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);
        const failures: unknown[] = [];
        if (this.permissionHandler) {
            try {
                await this.permissionHandler.cancelAll('Session ended');
            } catch (error) {
                failures.push(error);
            } finally {
                this.permissionHandler = null;
            }
        }
        if (this.backend) {
            try {
                await this.backend.disconnect();
            } catch (error) {
                failures.push(error);
            } finally {
                this.backend = null;
            }
        }
        if (this.happyServer) {
            try {
                this.happyServer.stop();
            } catch (error) {
                failures.push(error);
            } finally {
                this.happyServer = null;
            }
        }
        if (failures.length > 0) {
            if (this.clearRequested) await this.options.onClearCleanupFailed?.();
            throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'OpenCode cleanup failed');
        }
        if (this.clearRequested) await this.options.onClearCleanupComplete?.();

        // Signal the runner only after the native backend is gone. If an
        // awaited teardown above fails, RemoteLauncherBase propagates that
        // failure and this callback never runs; runOpencode then archives the
        // source as an error rather than spawning a potentially concurrent
        // replacement.
    }

    private handleAcpStderrError(error: AcpStderrError): void {
        logger.debug('[opencode-remote] stderr error', error);
        const isStall = isAcpStallStderrError(error)
            && this.backend?.isPromptRequestInFlight() === true;
        if (isStall && this.stallErrorReportedForPrompt) {
            return;
        }
        if (isStall) {
            this.stallErrorReportedForPrompt = true;
        }
        this.surfaceAgentError(error.message);
        if (isStall) {
            void this.clearStalledPrompt();
        }
    }

    /**
     * Reports an upstream retry as progress, not as a failure: the agent is
     * still working and will try again on its own.
     *
     * Sent as the `api_error` system message Claude sessions already use for
     * the same situation, rather than as a new message type, so the web
     * timeline folds consecutive retries into a single block instead of
     * stacking one warning per attempt (`foldApiErrorEvents` in
     * web/src/chat/reducerEvents.ts). `maxRetries` is 0 because OpenCode
     * announces no ceiling — it retries until the provider lets it through
     * (its own issue tracker has the missing circuit breaker open) — and the
     * presentation already has a branch for exactly that. The provider's own
     * text rides in `error` so the reader learns *why* the session is
     * waiting, which is the entire point; without it the timeline says only
     * "Retrying...".
     *
     * `thinking` is deliberately untouched. During a retry the session
     * really is busy, and the hub composes the flag it shows from what this
     * session reports plus its own queue grace
     * (`hub/src/sync/sessionCache.ts`) — this side reports what is true and
     * does not reach across that seam.
     */
    private surfaceUpstreamRetry(retry: OpencodeRetryStatus): void {
        const text = formatOpencodeRetryStatus(retry);
        this.session.client.sendClaudeSessionMessage({
            type: 'system',
            uuid: randomUUID(),
            subtype: 'api_error',
            retryAttempt: retry.attempt,
            maxRetries: 0,
            error: { message: text }
        });
        this.messageBuffer.addMessage(text, 'status');
    }

    /**
     * Reports a rejected `session/prompt` to the user in the provider's own
     * words.
     *
     * Nothing had to be detected to make this possible: `AcpStdioTransport`
     * already rejects the pending request with the JSON-RPC `error.message`
     * verbatim, and this catch used to log it and hand the user a fixed
     * "check logs for details" line instead. A remote user is by definition
     * not at the machine holding those logs.
     *
     * This reports unconditionally, and that is a decision rather than an
     * omission. On a hard error OpenCode also dumps the same JSON-RPC error
     * onto stderr, which the shared ACP reader reports a line at a time, so
     * the user sees three raw fragments and then this one sentence. An
     * earlier revision tried to suppress the sentence as a duplicate; do
     * not add that back:
     *
     * - The fragments are a JSON dump split at newlines. This sentence is
     *   the only line of the four a person can read. It follows them as a
     *   summary, which is not the same thing as a repeat.
     * - Suppressing on containment deleted it in every measured hard error,
     *   because a fragment embeds it as a substring; suppressing on exact
     *   equivalence never fired at all, because the fragment and this
     *   sentence are differently worded. There was no observed case where
     *   the check both fired and was right.
     * - Doing it at all needs a per-turn ledger of what has been shown, and
     *   the stderr path has no turn boundary of its own to reset it on: a
     *   /compact batch never reaches this loop's per-prompt reset, so the
     *   ledger leaked across batches and silently muted the stderr channel
     *   for the rest of such a session. That channel discarded nothing
     *   before this branch existed and should keep discarding nothing.
     */
    private reportPromptFailure(error: unknown): void {
        this.surfaceAgentError(formatOpencodePromptError(error));
    }

    private surfaceAgentError(message: string): void {
        this.session.sendAgentMessage({ type: 'error', message });
        this.messageBuffer.addMessage(message, 'status');
    }

    private async clearStalledPrompt(): Promise<void> {
        const backend = this.backend;
        const sessionId = this.activeAcpSessionId;
        if (!backend || !sessionId) {
            return;
        }

        // Synchronous, before the cancel: this cancels the running runtime turn,
        // so a cancelled runtime must never accept a new mid-turn steer, and a
        // concurrent ACP request the cancel killed must not block the next
        // turn's drain. Only already-transmitted requests are detached — a
        // reservation still waiting on its durable write keeps gating the
        // drain, so its row cannot be restored after the next prompt.
        this.closeSteerGate({ detachStrandedSteers: true });

        this.session.onThinkingChange(false);
        try {
            await backend.cancelPrompt(sessionId);
        } catch (error) {
            logger.debug('[opencode-remote] cancelPrompt after stderr failed', error);
        } finally {
            // Same reasoning as handleAbort, and deliberately conditional: with
            // no soft request of this turn in flight, abortSoftSteers() would
            // deactivate the foreground handler and swallow the tail output
            // OpenCode still emits while processing the cancel.
            this.settleBackendSoftSteers(backend, this.steerTurnEpoch, 'stall-cancel');
        }
    }

    private rollbackReasoningEffort(batch: { mode: OpencodeMode }, effort: string | null): void {
        batch.mode.modelReasoningEffort = effort;
        this.session.setModelReasoningEffort(effort);
        this.session.pushKeepAlive();
        this.options.onReasoningEffortRollback?.(effort);
    }

    private rollbackModel(batch: { mode: OpencodeMode }, model: string | null): void {
        batch.mode.model = model ?? undefined;
        this.session.setModel(model);
        this.session.pushKeepAlive();
        this.options.onModelRollback?.(model);
    }

    /**
     * Executes the /compact operation for a queued `operation:'compact'`
     * batch. Reached only through the main dequeue loop (so it never runs
     * concurrently with a prompt turn — see the loop's doc comment), which
     * is also why this needs no timeout/mutex of its own despite the REST
     * call it makes potentially taking several minutes.
     *
     * `localId` is used to detect a cancel that runOpencode.ts's
     * `isLocalIdCancelled` reports for this item (see its declaration there
     * for the real — and narrow — race window that covers) — checked at each
     * point below right before a result would be shown, same as the
     * pre-redesign behavior where this was a single `wasCancelled()` check
     * after one combined async trigger(). "Compaction started" itself is
     * never suppressed (it wasn't before either).
     *
     * Separately, `compactAbortController`/`compactResultSuppressed` cover a
     * different case: Stop/switch-to-local firing *while the REST call is
     * actually in flight*, which `isLocalIdCancelled` cannot — that
     * mechanism only ever observes a cancel for this item's *queue message*,
     * and by this point the item has already been dequeued. `isCancelled()`
     * below checks all three, so any kind of cancellation suppresses the
     * eventual result the same way. A plain Stop aborts only the read-only
     * snapshot/verification GET phases; while the summarize POST itself is
     * in flight it leaves the signal alone and waits for real server-side
     * completion, preserving the shared-session FIFO invariant. Switch/exit
     * aborts every phase because teardown disconnects the session.
     *
     * `compactAbortController` is created by the caller (the dequeue loop),
     * not here, and passed in — deliberately, before the loop's model/effort
     * switch for this batch runs, not after. A hostile-review whole-feature
     * sweep found that creating it in here (i.e. only once this function was
     * actually entered) left a window during that switch — a real async ACP
     * round-trip — where an abort had nothing to act on yet (`this
     * .compactAbortController` was still null) and was silently lost by the
     * time this function created a *fresh* controller afterward.
     */
    private async runCompactOperation(
        acpSessionId: string,
        compactAbortController: AbortController,
        localId?: string
    ): Promise<void> {
        const session = this.session;
        session.sendSessionEvent({ type: 'message', message: '📦 Compaction started' });

        try {
            const isCancelled = (): boolean =>
                (localId ? (this.options.isLocalIdCancelled?.(localId) ?? false) : false)
                || compactAbortController.signal.aborted
                || this.compactResultSuppressed;

            const backend = this.backend;
            const baseUrl = this.baseUrl;
            if (!baseUrl || !backend) {
                if (!isCancelled()) {
                    session.sendSessionEvent({
                        type: 'message',
                        message: '📦 Compaction failed: OpenCode internal HTTP API base URL is not available.'
                    });
                }
                return;
            }

            const metadata = backend.getSessionModelsMetadata?.(acpSessionId);
            const split = splitProviderModel(metadata?.currentModelId ?? this.currentBackendModel);
            if (!split) {
                if (!isCancelled()) {
                    session.sendSessionEvent({
                        type: 'message',
                        message: '📦 Compaction failed: OpenCode model metadata is not available; cannot determine provider/model for compaction.'
                    });
                }
                return;
            }

            if (isCancelled()) {
                logger.debug('[opencode-remote] /compact skipped before marker snapshot: cancelled or aborted');
                return;
            }

            // The pre-POST marker snapshot is a read-only GET. A plain Stop
            // aborts it because no summarize request has started yet.
            this.compactOperationPhase = 'snapshot';
            const markerSnapshot = await captureCompactionMarkerSnapshot({
                baseUrl,
                sessionId: acpSessionId,
                signal: compactAbortController.signal
            });
            if (isCancelled()) {
                logger.debug('[opencode-remote] /compact skipped after marker snapshot: cancelled or aborted');
                return;
            }

            // Suppressed: OpenCode keeps streaming session/update notifications
            // (agent_thought_chunk etc.) over the ACP transport while this raw
            // HTTP call runs — with no prompt() turn in flight to own them, they
            // would otherwise leak into the previous turn's still-installed
            // onUpdate and render as a duplicate assistant message alongside the
            // explicit summary we show below (from fetchCompactionResult).
            // See AcpSdkBackend.suppressUpdatesDuring's doc comment.
            //
            // The summarize POST can keep mutating the shared session after a
            // client abort, so a plain Stop deliberately waits only in this
            // phase. It has no deadline because real compaction can take minutes.
            this.compactOperationPhase = 'summarize';
            const requestResult = await backend.suppressUpdatesDuring(async () => {
                try {
                    return await triggerOpencodeCompact({
                        baseUrl,
                        sessionId: acpSessionId,
                        providerId: split.providerId,
                        modelId: split.modelId,
                        signal: compactAbortController.signal
                    });
                } finally {
                    // suppressUpdatesDuring may still quiet-drain after the
                    // POST settles. It is no longer server-side compaction.
                    this.compactOperationPhase = 'post-summarize';
                }
            });
            if (!requestResult.ok) {
                if (!isCancelled()) {
                    session.sendSessionEvent({ type: 'message', message: `📦 Compaction failed: ${requestResult.error}` });
                } else {
                    logger.debug('[opencode-remote] /compact failure suppressed: cancelled or aborted before it resolved');
                }
                return;
            }
            if (isCancelled()) {
                logger.debug('[opencode-remote] /compact verification skipped: cancelled or aborted after summarize');
                return;
            }

            // The persisted-result lookup is also read-only: once summarize
            // returned, a plain Stop can abort it without concurrent session work.
            this.compactOperationPhase = 'verification';
            const result = await fetchCompactionResult({
                baseUrl,
                sessionId: acpSessionId,
                markerIdsBefore: markerSnapshot?.markerIds ?? null,
                signal: compactAbortController.signal
            });

            if (isCancelled()) {
                logger.debug('[opencode-remote] /compact result suppressed: cancelled or aborted before it resolved');
                return;
            }

            switch (result.status) {
                case 'success': {
                    session.sendSessionEvent({ type: 'message', message: '📦 Compaction completed' });
                    const converted = convertAgentMessage({ type: 'reasoning', text: result.text, id: randomUUID() });
                    if (converted) {
                        session.sendAgentMessage(converted);
                    }
                    return;
                }
                case 'failed':
                    session.sendSessionEvent({ type: 'message', message: `📦 Compaction failed: ${result.reason}` });
                    return;
                case 'unverified':
                    session.sendSessionEvent({ type: 'message', message: '📦 Compaction result could not be verified.' });
                    return;
            }
        } finally {
            // Defensive: only clear if this is still the controller we set —
            // mirrors the same "don't clobber a newer value" guard as
            // AcpSdkBackend.suppressUpdatesDuring's restore. In practice this
            // is always still the same instance, since compact runs
            // serialized through the single dequeue loop (never concurrently
            // with another runCompactOperation call).
            if (this.compactAbortController === compactAbortController) {
                this.compactAbortController = null;
                this.compactOperationPhase = 'idle';
            }
        }
    }

    private handleAgentMessage(message: AgentMessage): void {
        const converted = convertAgentMessage(message, this.currentBackendModel);
        if (converted) {
            this.session.sendAgentMessage(converted);
        }

        switch (message.type) {
            case 'text':
                this.messageBuffer.addMessage(message.text, 'assistant');
                break;
            case 'reasoning':
                if (message.live) {
                    break;
                }
                this.messageBuffer.addMessage(`[Thinking] ${message.text.substring(0, 100)}...`, 'system');
                break;
            case 'tool_call':
                this.messageBuffer.addMessage(`Tool call: ${message.name}`, 'tool');
                break;
            case 'tool_result':
                this.messageBuffer.addMessage('Tool result received', 'result');
                break;
            case 'usage':
                break;
            case 'plan':
                this.messageBuffer.addMessage('Plan updated', 'status');
                break;
            case 'error':
                this.messageBuffer.addMessage(message.message, 'status');
                break;
            case 'generated_image':
                this.messageBuffer.addMessage(`Generated image: ${message.fileName}`, 'assistant');
                break;
            case 'turn_complete':
                this.messageBuffer.addMessage('Turn complete', 'status');
                break;
            default: {
                const _exhaustive: never = message;
                return _exhaustive;
            }
        }
    }

    private applyDisplayMode(permissionMode: PermissionMode | undefined): void {
        if (permissionMode && permissionMode !== this.displayPermissionMode) {
            this.displayPermissionMode = permissionMode;
            this.messageBuffer.addMessage(`[MODE:${permissionMode}]`, 'system');
        }
    }

    /**
     * `leavingRemote` distinguishes plain Stop (`false`, the default — stays
     * in the same remote session) from switch-to-local/exit (`true` — the
     * session is being torn down). A 6th PR-review round rejected an earlier
     * fix (always aborting `compactAbortController` here) because it broke
     * this feature's core invariant: compact and a prompt must never touch
     * the same OpenCode session concurrently (see
     * `compactResultSuppressed`'s field doc comment for the full
     * reasoning). Plain Stop aborts only read-only marker/result GETs. It
     * leaves an in-flight summarize POST running so the dequeue loop waits
     * for its real server-side completion; only that phase can still mutate
     * the shared session. Switch/exit aborts every phase because cleanup()
     * disconnects the ACP subprocess right after.
     */
    private async handleAbort(leavingRemote = false): Promise<void> {
        // Synchronous, before any await: a steer parked on its durable-state
        // await must observe the turn as invalid immediately, so it restores
        // its row instead of injecting into a cancelled turn or a new one.
        this.closeSteerGate({ detachStrandedSteers: true });
        // A hostile-review sweep found that a plain Stop during an in-flight
        // compact — which deliberately leaves the operation running for real
        // (see compactResultSuppressed's doc comment) — still unconditionally
        // flipped `thinking` off and reported "Turn aborted" below, telling
        // the user the turn had stopped while the dequeue loop was actually
        // still blocked inside runCompactOperation() for however long the
        // real server-side compaction takes (potentially minutes). Track
        // that specific case so the messaging stays honest: nothing has
        // actually stopped yet from the user's perspective, and the dequeue
        // loop's own `finally` (once runCompactOperation() genuinely
        // returns) remains the sole source of truth for when this turn is
        // done.
        const compactAbortController = this.compactAbortController;
        if (compactAbortController) {
            this.compactResultSuppressed = true;
            // Only summarize can still mutate the shared OpenCode session.
            // Plain Stop aborts snapshot/verification reads, but deliberately
            // waits for an in-flight POST to complete server-side.
            if (
                leavingRemote
                || this.compactOperationPhase === 'snapshot'
                || this.compactOperationPhase === 'post-summarize'
                || this.compactOperationPhase === 'verification'
            ) {
                compactAbortController.abort();
            }
        }
        const backend = this.backend;
        if (backend && this.session.sessionId) {
            try {
                await backend.cancelPrompt(this.session.sessionId);
            } finally {
                // A soft steer this turn dispatched can still be pending after
                // an Abort and its ACP request may never answer, which would
                // hold both the next turn's message handler and the inter-turn
                // model/effort switches that wait for response-complete. Only
                // settle counters this backend genuinely owns, so an ordinary
                // Stop with no steer keeps the cancelled turn's trailing
                // tool_result/text (abortSoftSteers deactivates the shared
                // foreground handler).
                this.settleBackendSoftSteers(backend, this.steerTurnEpoch, 'abort');
            }
        }
        await this.permissionHandler?.cancelAll('User aborted');
        // A steer that was already dispatched may still complete after the
        // abort; preserve its reservation so the completion callback can
        // still commit it (or mark it indeterminate) instead of losing the
        // input.
        this.session.queue.reset({ preserveDispatchingReservations: true });
        this.abortController.abort();
        this.abortController = new AbortController();
        // Re-read here (not the snapshot taken above, before the awaits) in
        // case a concurrent leavingRemote=true call for the same compact
        // interleaved with this one and already aborted it — RPC dispatch
        // doesn't serialize handleAbort() calls against each other, so a
        // Stop immediately followed by a switch-to-local can genuinely
        // overlap. Without this, the (now-stale) plain-Stop continuation
        // could append its "still waiting" message after the switch's
        // "Turn aborted" already ran, showing the two in a confusing order.
        const activeCompactAbortController = this.compactAbortController;
        const decision = selectAbortStatusMessage({
            hasCompactInFlight: activeCompactAbortController !== null && this.compactOperationPhase === 'summarize',
            leavingRemote,
            compactAborted: activeCompactAbortController?.signal.aborted ?? false
        });
        if (decision.shouldClearThinking) {
            this.session.onThinkingChange(false);
        }
        this.messageBuffer.addMessage(decision.message, 'status');
    }

    private async handleExitFromUi(): Promise<void> {
        await this.requestExit('exit', () => this.handleAbort(true));
    }

    private async handleSwitchFromUi(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort(true));
    }

    private async handleSwitchRequest(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort(true));
    }
}

function toAcpMcpServers(config: Record<string, { command: string; args: string[] }>): McpServerStdio[] {
    return Object.entries(config).map(([name, entry]) => ({
        name,
        command: entry.command,
        args: entry.args,
        env: []
    }));
}

export async function opencodeRemoteLauncher(
    session: OpencodeSession,
    options: OpencodeRemoteLauncherOptions = {}
): Promise<'switch' | 'exit'> {
    const launcher = new OpencodeRemoteLauncher(session, options);
    return launcher.launch();
}
