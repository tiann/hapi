import React from 'react';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createAcpSessionTitleSync, registerAcpSessionTitleSync } from '@/agent/acpSessionTitle';
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
import type { QueueReservation } from '@/utils/MessageQueue2';
import { admitOpencodeV2Steer, cancelOpencodeV2Steer, opencodeV2InputId, readOpencodeV2Input, steerOpencodeV2Inbox, type OpencodeSteerCancelHandler, type OpencodeSteerCancelResult } from './utils/opencodeV2Steer';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { captureOpencodeRoundSnapshot, fetchOpencodeRoundSummary, type OpencodeRoundSnapshot } from './utils/opencodeRoundSummary';
import {
    allocateFreePort,
    createOpencodeBackend,
    detectOpencodeFlavorVersion,
    discoverOpencodeV2RestPort,
    findOpencodeServePid,
    listChildPids,
    listLoopbackListeners,
    type OpencodeFlavorVersion
} from './utils/opencodeBackend';
import {
    captureCompactionIdsV2,
    captureCompactionMarkerSnapshot,
    fetchCompactionResult,
    pollCompactionResultV2,
    type CompactionResult,
    readOpencodeV2ServerPassword,
    splitProviderModel,
    triggerOpencodeCompact,
    triggerOpencodeCompactV2
} from './utils/opencodeCompactBridge';
import { OpencodeNativeTranscript } from './utils/opencodeNativeTranscript';
import { opencodeCompactionEventId } from './utils/opencodeCompactionProjector';
import { formatOpencodePromptError } from './utils/opencodeErrorText';
import {
    formatOpencodeRetryStatus,
    subscribeToOpencodeEvents,
    type OpencodeEventSubscription,
    type OpencodeRetryStatus
} from './utils/opencodeEventStream';
import { OpencodePermissionHandler } from './utils/permissionHandler';
import { presentQuestionToolCall } from './utils/opencodeQuestion';
import { getOpencodeNativeToolInstruction, PLAN_MODE_INSTRUCTION } from './utils/systemPrompt';
import { resolveThoughtLevelEffort } from './thoughtLevelEffort';
import { OpencodeConversationHistory } from './conversationHistory';
import { OpenCodeRewind, OpenCodeRewindSupersededError, OpenCodeRuntimeBlockedError, OpenCodeRuntimeGate, readOpenCodeRewindIntent, sameOperation } from './rewind';
import { OpenCodeRewindSchema } from '@hapi/protocol/schemas';
import { configuration } from '@/configuration';
import { join } from 'node:path';
import { getProcessStartMarker } from '@/utils/process';
import { fetchOpencodeUserMessages } from './utils/opencodeInputReceipt';

type OpencodeRemoteLauncherOptions = {
    onSteerCancelHandlerChange?: (handler: OpencodeSteerCancelHandler | null) => void;
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
type RoundSummaryPhase = 'idle' | 'snapshot' | 'prompt' | 'settle';

const ROUND_SUMMARY_SETTLE_TIMEOUT_MS = 1_000;

async function settleRoundSummary<T>(promise: Promise<T>, controller: AbortController): Promise<T | null> {
    return await new Promise<T | null>((resolve) => {
        let settled = false;
        const settle = (value: T | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            controller.signal.removeEventListener('abort', onAbort);
            resolve(value);
        };
        const onAbort = () => settle(null);
        const timeout = setTimeout(() => {
            controller.abort();
            settle(null);
        }, ROUND_SUMMARY_SETTLE_TIMEOUT_MS);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        void promise.then((summary) => settle(summary), () => settle(null));
    });
}

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
 * - `detach()` also makes an unanswered delivery explicitly resolvable. A
 *   late callback may consume it only while it still owns that reservation.
 */
type OpencodeV2SteerEntry = {
    inputId: string;
    sessionId: string;
    delivered: () => void;
    enqueued: (properties: Record<string, unknown>) => void;
    cancel: (purpose: 'stop' | 'explicit' | 'teardown', resetFinished?: Promise<void>) => Promise<OpencodeSteerCancelResult>;
    abandon: () => void;
};

type OpencodeSteerOperation = {
    settled: Promise<void>;
    transportPending: boolean;
    detach: () => void;
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
    // Created before the compact batch's async model/effort switch so aborts
    // during that switch reach the same controller as the later HTTP calls.
    // Null when no compact batch is in flight. Unlike abortController, which
    // interrupts queue waiting, this controller interrupts compact HTTP work.
    private compactAbortController: AbortController | null = null;
    private roundSummaryAbortController: AbortController | null = null;
    /** Distinguishes an active prompt from read-only post-prompt work for Stop semantics. */
    private roundSummaryPhase: RoundSummaryPhase = 'idle';
    /** Validated ID boundary returned by the previous post-prompt fetch; explicit history mutations clear it. */
    private nextRoundSnapshot: OpencodeRoundSnapshot | null = null;
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
    private nativeTranscript: OpencodeNativeTranscript | null = null;
    private stallErrorReportedForPrompt = false;
    private nativeHistoryUnverified = false;
    /** Cancels the detached capability probe when remote mode is left. */
    private readonly historyProbeAbortController = new AbortController();
    private readonly conversationHistory = new OpencodeConversationHistory(() => ({
        baseUrl: this.v2RestInfo?.baseUrl ?? this.baseUrl,
        headers: this.v2RestInfo ? {
            authorization: 'Basic ' + Buffer.from(`opencode:${this.v2RestInfo.password}`).toString('base64')
        } : undefined,
        sessionId: this.activeAcpSessionId
    }));
    /** True while a normal (non-compact/clear) prompt turn is in flight — the only steerable state. */
    private promptInFlight = false;
    /** Mode hash of the prompt turn currently in flight; steers must match it. */
    private activePromptModeHash: string | null = null;
    private activePromptText: string | null = null;
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
    // Detached requests outlive operation/counter bookkeeping. Quarantine all
    // native inputs present at a cancellation or uncertain outcome until each
    // returns successfully: only its own response fences its input writes.
    // Rejections retain quarantine; a later foreground is not a writer fence.
    private nativeInputWriters = new Set<{ uncertain: boolean }>();
    private nativeSteerReceiptCorrelationLost = false;
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
    /** opencode major version detected once per session; v2 changes spawn args and baseUrl discovery. */
    private majorVersion: OpencodeFlavorVersion | null = null;
    /** v2-only REST access discovered after spawn; null unless both port and OPENCODE_PASSWORD were found. */
    private v2RestInfo: { baseUrl: string; password: string } | null = null;
    private readonly workerId: string;
    private readonly runtimeGate: OpenCodeRuntimeGate;
    private nativeProcess: { pid: number; startMarker: string } | undefined;
    private rewind: OpenCodeRewind | null = null;
    private rewindInFlight = false;
    private rewindReconnect: (() => void) | null = null;
    private rewindConnectionStart: (() => void) | null = null;
    private entryFence: symbol | undefined;
    private entryEpoch = 0;
    /** The in-memory checkpoint is newer than Hub's: a publication was withheld by the entry fence. */
    private historyPublicationDeferred = false;
    private detachEntryHandoff: (() => void) | undefined;
    private drainReconnect: (() => void) | undefined;
    private rewindReconnectPending = false;
    private entryRetryTimer: NodeJS.Timeout | undefined;
    private entryRetryAttempt = 0;
    private rewindStopped = false;
    private readonly rewindEntryAbortController = new AbortController();
    private rewindSupersededId: string | undefined;
    private v2Steers = new Map<string, OpencodeV2SteerEntry>();
    private v2AbortInProgress: Promise<void> | null = null;
    private v2ResetInProgress: Promise<void> | null = null;

    constructor(
        session: OpencodeSession,
        private readonly options: OpencodeRemoteLauncherOptions = {}
    ) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.runtimeGate = session.runtimeGate ?? new OpenCodeRuntimeGate();
        this.workerId = this.runtimeGate.workerId;
        this.entryFence = this.runtimeGate.takeInitialEntryFence() ?? this.runtimeGate.acquireEntryFence();
        this.detachEntryHandoff = this.runtimeGate.onEntryHandoff(() => {
            if (this.rewindStopped) return;
            this.entryFence = this.runtimeGate.adoptInitialEntryFence(this.entryFence);
            this.entryEpoch++;
            this.rewindReconnectPending = true;
            this.entryRetryAttempt = 0;
            this.drainReconnect?.();
        });
        this.rewindConnectionStart = () => {
            if (this.rewindStopped) return;
            this.entryEpoch++;
            this.entryFence ??= this.runtimeGate.acquireEntryFence();
        };
        this.rewindReconnect = () => {
            if (this.rewindStopped) return;
            this.rewindConnectionStart?.();
            this.rewindReconnectPending = true;
            this.entryRetryAttempt = 0;
            this.drainReconnect?.();
        };
        session.client.on('connection-start', this.rewindConnectionStart);
        session.client.on('connected', this.rewindReconnect);
    }

    private noteSupersededRewind(error: unknown): void {
        if (!this.rewindStopped && error instanceof OpenCodeRewindSupersededError
            && error.operationId !== this.rewindSupersededId) {
            this.entryFence ??= this.runtimeGate.acquireEntryFence();
            this.rewindSupersededId = error.operationId;
            this.rewindReconnectPending = true;
        }
    }

    /** A dropped GET, a stale snapshot or a withheld flush can all clear on
     *  their own while the socket stays connected, so admission stays fenced
     *  but the entry is retried with backoff. Journal/identity mismatches and
     *  superseded operations are decisions, not outages: only a fresh
     *  connection event re-drives those. */
    private entryFailureRetriable(error: unknown): boolean {
        if (this.rewindStopped || this.rewindEntryAbortController.signal.aborted) return false;
        if (error instanceof OpenCodeRewindSupersededError) return false;
        const permanent = ['OpenCode entry journal native identity mismatch', 'OpenCode entry native identity mismatch',
            'OpenCode entry has an unresolved journal', 'OpenCode rewind requires remote reconciliation',
            'OpenCode entry is not reconciled', 'OpenCode entry journal remains unresolved'];
        return !(error instanceof Error && permanent.includes(error.message));
    }

    private clearEntryRetryTimer(): void {
        if (!this.entryRetryTimer) return;
        clearTimeout(this.entryRetryTimer);
        this.entryRetryTimer = undefined;
    }

    private scheduleEntryRetry(): void {
        this.clearEntryRetryTimer();
        const delay = Math.min(500 * 2 ** this.entryRetryAttempt, 15_000);
        this.entryRetryAttempt++;
        const timer = setTimeout(() => {
            this.entryRetryTimer = undefined;
            if (this.rewindStopped || this.rewindInFlight || this.rewindReconnectPending) return;
            this.rewindReconnectPending = true;
            this.drainReconnect?.();
        }, delay);
        // A pending retry must never hold the process open during teardown.
        timer.unref?.();
        this.entryRetryTimer = timer;
    }

    private detachRewindEntry(): void {
        this.detachEntryHandoff?.();
        this.detachEntryHandoff = undefined;
        this.clearEntryRetryTimer();
        if (this.rewindConnectionStart) this.session.client.off('connection-start', this.rewindConnectionStart);
        if (this.rewindReconnect) this.session.client.off('connected', this.rewindReconnect);
        this.rewindConnectionStart = null;
        this.rewindReconnect = null;
        if (this.entryFence) this.runtimeGate.handoffEntryFence(this.entryFence);
        this.entryFence = undefined;
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

        const titleSync = createAcpSessionTitleSync(session.client);
        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client, {
            onChangeTitle: () => titleSync.markManualTitle(),
            skillLookup: { workingDirectory: session.path, flavor: 'opencode' }
        });
        this.happyServer = happyServer;

        // opencode v2 dropped the `acp --cwd/--port/--hostname` flags and
        // binds its internal HTTP API to a random loopback port it exposes
        // nowhere (verified 2026-10-15), so the spawn strategy and the
        // baseUrl discovery differ per major version. Detected once per
        // session; any detection failure falls back to the v1 path.
        this.majorVersion = await detectOpencodeFlavorVersion();
        const isV2 = this.majorVersion === 'v2';
        if (!isV2) {
            // v1 keeps upstream's non-history behavior; the fork/rewind
            // machinery must never advertise or mutate history there.
            this.conversationHistory.declareUnsupported();
        }
        const workerStartMarker = getProcessStartMarker(process.pid);

        // v1: pre-select a loopback port for the ACP subprocess's internal
        // HTTP API and pass it explicitly via --port/--hostname. opencode
        // does not announce the bound port anywhere (stdout/stderr/ACP
        // responses) when launched with --port 0, so HAPI must choose it up
        // front to be able to reach that HTTP API later (e.g. for /compact —
        // see opencodeCompactBridge.ts).
        const hostname = '127.0.0.1';
        let beforeSnapshot: Set<number> | null = null;
        let v1Port: number | null = null;
        if (isV2) {
            beforeSnapshot = await listLoopbackListeners();
            this.baseUrl = null;
        } else {
            v1Port = await allocateFreePort(hostname);
            this.baseUrl = `http://${hostname}:${v1Port}`;
        }

        const backend = isV2
            ? createOpencodeBackend({
                cwd: session.path,
                majorVersion: 'v2' as OpencodeFlavorVersion
            })
            : createOpencodeBackend({
                cwd: session.path,
                port: v1Port!,
                hostname
            });
        this.backend = backend;
        registerAcpSessionTitleSync(backend, session.client, titleSync);

        backend.onStderrError((error) => {
            this.handleAcpStderrError(error);
        });

        await backend.initialize();

        // Read the REST value itself before using cached metadata to select a
        // native resume or publish a session binding. A failed read remains
        // an owned entry fence until a later connection event retries it.
        const initialSnapshot = await session.client.readRewindMetadata();

        // Forks can trust restored metadata only after the previous launcher's
        // writes reached the hub. Ordinary ACP resumes can run without forks.
        let historyMetadataDurable = true;
        if (typeof session.client.flushMetadata === 'function'
            && !(typeof session.client.isPending === 'function' && session.client.isPending())) {
            try {
                historyMetadataDurable = await session.client.flushMetadata();
            } catch {
                historyMetadataDurable = false;
            }
        }

        const resumeSessionId = session.sessionId;
        // A fork child's transcript already lives on the hub; silently
        // falling back to a blank native session would show inherited
        // messages the model cannot actually see (same fence as grok).
        const currentMetadata = initialSnapshot?.metadata ?? session.client.getMetadata();
        const strictForkResume = !initialSnapshot || currentMetadata?.forkedFrom != null || currentMetadata?.opencodeRewind != null;
        // Fork provenance persists; strict history availability is needed only
        // until the hub commits the child's first validated readiness.
        const strictHistoryVerification = currentMetadata?.opencodeForkPending === true;
        if (strictHistoryVerification && !historyMetadataDurable) {
            throw new Error('OpenCode history metadata did not become durable before remote entry');
        }
        // A resume that fell back to a blank native session invalidates every
        // persisted history locator: old local ids would resolve to unrelated
        // native turns. History stays disabled for such sessions.
        let startedFreshAfterResumeFailure = false;
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
                if (strictForkResume) {
                    throw error;
                }
                logger.warn('[opencode-remote] resume failed, starting new session', error);
                startedFreshAfterResumeFailure = true;
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

        // Fire the validated session-ready fence only now (after the actual
        // load/new below): loop.ts seeds onSessionFound with the resume id
        // before ACP initialize, so the hub's exact-binding wait must not
        // succeed until this point (same fence as Pi).
        if (strictForkResume && resumeSessionId && acpSessionId !== resumeSessionId) {
            // OpenCode replaced the forked native id — binding readiness to a
            // different session would report a successful fork for context
            // the child never loaded.
            throw new Error('OpenCode fork loaded a different native session');
        }
        let nativeBindingPublished = false;
        if (initialSnapshot && !initialSnapshot.metadata.opencodeRewind
            && (!initialSnapshot.metadata.opencodeSessionId || initialSnapshot.metadata.opencodeSessionId === acpSessionId)) {
            session.onSessionFound(acpSessionId);
            nativeBindingPublished = true;
        } else {
            session.sessionId = acpSessionId;
        }
        this.activeAcpSessionId = acpSessionId;

        // v2: the internal HTTP API port is bound randomly after spawn and
        // exposed nowhere, so discover it now that the ACP session is up
        // (the server is listening by then). Both the port and the
        // OPENCODE_PASSWORD (injected into the serve --stdio child env by
        // the acp parent) must be found; otherwise /compact stays disabled
        // exactly like the pre-v2 "not yet supported" fallback.
        if (isV2) {
            const acpPid = backend.getProcessPid?.() ?? null;
            // v2's random port is owned by the `serve --stdio` process, not
            // the acp parent — and the tree can own OTHER listeners too
            // (configured MCP servers bind their own ports). Identify the
            // serve process by its command line and scope the port scan to
            // it, so an unrelated descendant listener cannot win the
            // lowest-port race; without a match, fall back to the tree-wide
            // scan.
            const descendants = acpPid !== null ? await listChildPids(acpPid) : [];
            const servePid = acpPid !== null
                ? await findOpencodeServePid({ rootPids: [acpPid, ...descendants] })
                : null;
            const marker = servePid !== null ? getProcessStartMarker(servePid) : null;
            if (servePid !== null && marker) this.nativeProcess = { pid: servePid, startMarker: marker };
            const ownerPids = servePid !== null
                ? [servePid]
                : acpPid !== null
                    ? [acpPid, ...descendants]
                    : undefined;
            const discoveredPort = await discoverOpencodeV2RestPort({
                beforeSnapshot: beforeSnapshot ?? new Set(),
                ownerPids
            });
            const password = acpPid !== null ? await readOpencodeV2ServerPassword(acpPid) : null;
            if (discoveredPort !== null && password) {
                this.v2RestInfo = { baseUrl: `http://127.0.0.1:${discoveredPort}`, password };
            } else {
                logger.warn('[opencode-remote] opencode v2 internal HTTP API discovery failed; /compact disabled for this session');
                session.sendSessionEvent({
                    type: 'message',
                    message: 'OpenCode v2 internal API discovery failed; upstream retry status and /compact are unavailable this session.'
                });
            }
        }

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
        // v2 keeps baseUrl null until discovery succeeds above; skipping the
        // subscription then only degrades upstream-retry visibility.
        const restBaseUrl = this.v2RestInfo?.baseUrl ?? this.baseUrl;
        if (restBaseUrl) {
        const nativeHeaders = this.v2RestInfo ? {
            authorization: 'Basic ' + Buffer.from(`opencode:${this.v2RestInfo.password}`).toString('base64')
        } : undefined;
        this.nativeTranscript = new OpencodeNativeTranscript({
            baseUrl: restBaseUrl, sessionId: acpSessionId, directory: session.path,
            mode: this.majorVersion ?? 'v1', headers: nativeHeaders,
            // A fork child's native history holds the source's compactions and
            // the hub's transcript copy already carries their cards; outcomes
            // this runtime never observed live would be republished duplicates.
            suppressInheritedCompactions: currentMetadata?.forkedFrom != null,
            onSummary: (id, summary, trigger) => {
                // Only the verified manual bridge owns remote manual outcomes,
                // including cancellation. Hub history restores published cards.
                if (trigger !== 'auto') return;
                session.client.sendAgentMessage({ type: 'compact-summary', summary }, opencodeCompactionEventId(acpSessionId, id));
            },
            onStart: (id, trigger) => {
                if (trigger !== 'auto') return;
                const localId = `${opencodeCompactionEventId(acpSessionId, id)}:started`;
                session.client.sendSessionEvent({ type: 'message', message: '📦 Compaction started' }, localId, { localId });
            },
            onFailure: (id, trigger) => {
                if (trigger === 'auto') session.client.sendAgentMessage({ type: 'error', message: 'OpenCode compaction failed or was interrupted.' }, `${opencodeCompactionEventId(acpSessionId, id)}:failed`);
            },
            onReadFailure: () => session.sendSessionEvent({ type: 'message', message: 'OpenCode native transcript is temporarily unavailable. Retrying on reconnect or at the end of the turn.' }),
            onText: (part) => {
                if (this.majorVersion !== 'v1' || part.role !== 'assistant') return;
                const converted = convertAgentMessage(part.type === 'reasoning'
                    ? { type: 'reasoning', id: part.id, text: part.text, live: !part.complete }
                    : { type: 'text', id: part.id, text: part.text, streamSnapshot: true, live: !part.complete });
                if (converted) session.sendAgentMessage(converted);
                if (part.complete) this.messageBuffer.addMessage(
                    part.type === 'reasoning' ? `[Thinking] ${part.text.substring(0, 100)}...` : part.text,
                    part.type === 'reasoning' ? 'system' : 'assistant'
                );
            }
        });
        await this.nativeTranscript.refresh();
        this.eventStream = subscribeToOpencodeEvents({
            baseUrl: restBaseUrl,
            // Required. Omitting it yields heartbeats and no session events
            // at all, with no error to notice — see the subscription's doc.
            directory: session.path,
            sessionId: acpSessionId,
            // opencode v2's internal server is Basic-auth protected; without
            // the header the subscription is rejected before any event.
            headers: this.v2RestInfo ? {
                authorization: 'Basic ' + Buffer.from(`opencode:${this.v2RestInfo.password}`).toString('base64')
            } : undefined,
            mode: this.majorVersion ?? 'v1',
            onRetry: (retry) => this.surfaceUpstreamRetry(retry),
            onConnected: () => { void this.nativeTranscript?.refresh(); },
            onEvent: (type, properties, eventId) => {
                this.nativeTranscript?.event(type, properties, eventId);
                this.handleV2SteerEvent(type, properties);
            }
        });
        }

        this.conversationHistory.setPublishCapabilities(async () => {
            const conversationHistory = this.conversationHistory.getCapabilitiesForMetadata()?.conversationHistory;
            try {
                session.client.updateMetadata((metadata) => {
                    const capabilities = { ...metadata?.capabilities };
                    delete capabilities.conversationHistory;
                    if (metadata.opencodeRewind && !this.runtimeGate.hasReconciled(metadata.opencodeRewind.operationId)) {
                        return { ...metadata, capabilities };
                    }
                    if (conversationHistory) {
                        capabilities.conversationHistory = conversationHistory;
                    }
                    const diverged = Boolean(metadata.conversationHistoryDiverged || this.conversationHistory.isDiverged());
                    if (diverged || this.runtimeGate.isBlocked()) delete capabilities.conversationHistory;
                    const publishSnapshot = !this.conversationHistory.isDisabled() && !this.runtimeGate.isBlocked();
                    // An uninitialized in-memory checkpoint (the entry read
                    // failed before the first restore) must not publish an
                    // empty state over the saved one; the startup retry
                    // restores and verifies the persisted history instead.
                    const uninitializedCheckpoint = this.conversationHistory.getCheckpoint() === undefined
                        && metadata.opencodeHistoryCheckpoint != null;
                    const publishHistory = publishSnapshot && !uninitializedCheckpoint;
                    this.historyPublicationDeferred = !diverged && !this.conversationHistory.isDisabled() && !publishSnapshot
                        && JSON.stringify(this.conversationHistory.getCheckpoint()) !== JSON.stringify(metadata.opencodeHistoryCheckpoint);
                    return {
                        ...metadata,
                        path: metadata?.path ?? session.path,
                        host: metadata?.host ?? 'unknown',
                        capabilities,
                        conversationHistoryPoints: diverged ? undefined : publishHistory ? this.conversationHistory.getHistoryPoints() : metadata.conversationHistoryPoints,
                        conversationHistoryIndexes: diverged ? undefined : publishHistory ? this.conversationHistory.getHistoryIndexes() : metadata.conversationHistoryIndexes,
                        opencodeHistoryCheckpoint: diverged ? undefined : publishHistory ? this.conversationHistory.getCheckpoint() : metadata.opencodeHistoryCheckpoint,
                        conversationHistoryDiverged: metadata?.conversationHistoryDiverged || diverged || undefined
                    };
                });
                if (typeof session.client.flushMetadata === 'function'
                    && !(typeof session.client.isPending === 'function' && session.client.isPending())
                    && !await session.client.flushMetadata()) {
                    throw new Error('OpenCode history checkpoint could not be persisted');
                }
            } catch (error) {
                logger.warn('[opencode-remote] History metadata persistence failed', error);
                throw error;
            }
        });
        // A persisted divergence flag must survive later launches too — the
        // hub rejects history actions for diverged sessions, so republished
        // capabilities would only surface controls that cannot succeed.
        let historyDiverged = startedFreshAfterResumeFailure
            || currentMetadata?.conversationHistoryDiverged === true;
        let lastRewindSnapshot: Awaited<ReturnType<typeof session.client.readRewindMetadata>> = null;
        if (historyDiverged) {
            // Drop stale locators and hide history affordances: the native
            // session no longer corresponds to the persisted HAPI transcript.
            // The CLI refuses forks too (defense in depth alongside the hub's
            // conversationHistoryDiverged gate).
            void this.conversationHistory.disableFork().catch(() => {});
            try {
                session.client.updateMetadata((metadata) => {
                    if (metadata.opencodeRewind && !this.runtimeGate.hasReconciled(metadata.opencodeRewind.operationId)) return metadata;
                    const capabilities = { ...metadata?.capabilities };
                    delete capabilities.conversationHistory;
                    return {
                        ...metadata,
                        capabilities,
                        conversationHistoryPoints: undefined,
                        conversationHistoryIndexes: undefined,
                        opencodeHistoryCheckpoint: undefined,
                        conversationHistoryDiverged: true
                    };
                });
            } catch {
                // best-effort; transient hub disconnects must not crash the loop
            }
        } else {
            if (isV2 && this.v2RestInfo && typeof session.client.reportOpenCodeRewind === 'function') {
                this.rewind = new OpenCodeRewind({ directory: join(configuration.happyHomeDir, 'opencode-rewind'),
                    hapiSessionId: session.client.sessionId, workerId: this.workerId, gate: this.runtimeGate,
                    nativeSessionId: acpSessionId, baseUrl: this.v2RestInfo.baseUrl,
                    headers: { authorization: 'Basic ' + Buffer.from(`opencode:${this.v2RestInfo.password}`).toString('base64') },
                    nativeProcess: this.nativeProcess,
                    consumeCommitted: async () => {
                        const snapshot = await session.client.readRewindMetadata();
                        if (!snapshot || this.rewindStopped) throw new Error('Cannot refresh OpenCode rewind metadata');
                        const metadata = snapshot.metadata;
                        this.conversationHistory.clearPromptIndexes();
                        this.conversationHistory.restoreCheckpoint(metadata?.opencodeHistoryCheckpoint);
                        this.conversationHistory.restorePromptIndexes(metadata?.conversationHistoryIndexes);
                        const loaded = await backend.suppressUpdatesDuring(() => backend.loadSession({
                            sessionId: acpSessionId, cwd: session.path, mcpServers: mcpServerList
                        }));
                        if (this.rewindStopped) throw new Error('OpenCode rewind launcher is stopping');
                        if (loaded !== acpSessionId) throw new Error('Rewind native reload changed identity');
                        try {
                            await this.conversationHistory.reconcileHistory();
                        } catch (error) {
                            // Hub truncation has already committed: a diverged
                            // read must disable forks, not fail consumption and
                            // overwrite the finalized journal with 'unknown'.
                            await this.conversationHistory.disableFork();
                            logger.warn('[opencode-rewind] Consumption reconciliation diverged; forks disabled', error);
                        }
                        if (this.rewindStopped) throw new Error('OpenCode rewind launcher is stopping');
                        this.instructionsSent = (this.conversationHistory.getCheckpoint()?.userMessageIds.length ?? 0) > 0;
                        if (!workerStartMarker) throw new Error('OpenCode worker generation is unavailable');
                        session.client.updateMetadata(meta => meta.opencodeRewind?.operationId !== snapshot.metadata.opencodeRewind?.operationId
                            ? meta : ({ ...meta, opencodeWorkerId: this.workerId,
                                opencodeWorkerProcess: { workerId: this.workerId, pid: process.pid, startMarker: workerStartMarker } }));
                        if (!await session.client.flushMetadata()) throw new Error('Rewind runtime consumption is not durable');
                    },
                    report: report => session.client.reportOpenCodeRewind(report),
                    getAuthoritativeOperation: async () => {
                        const snapshot = await session.client.readRewindMetadata();
                        if (!snapshot) throw new Error('Cannot refresh OpenCode rewind metadata');
                        lastRewindSnapshot = snapshot;
                        return snapshot.metadata.opencodeRewind;
                    },
                    flush: async () => {
                        await this.conversationHistory.reconcileHistory();
                        return await session.client.flush() && await session.client.flushMetadata();
                    },
                    isIdle: () => !session.thinking && session.queue.size() === 0 && !backend.isPromptRequestInFlight?.()
                        && !this.hasUnresolvedNativeInput(),
                    sourceCheckpoint: () => this.conversationHistory.getCheckpoint(),
                    sourceIndexes: () => this.conversationHistory.getHistoryIndexes(),
                    previousWorkerCannotRun: previous => {
                        const marker = getProcessStartMarker(previous.pid);
                        if (marker !== null) return marker !== previous.startMarker;
                        try { process.kill(previous.pid, 0); return false; }
                        catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
                    },
                    requestsFromPreviousWorkerCannotRun: () => {
                        const previous = this.rewind?.readIntent()?.nativeProcess;
                        if (!previous) return false;
                        const marker = getProcessStartMarker(previous.pid);
                        if (marker !== null) return marker !== previous.startMarker;
                        try { process.kill(previous.pid, 0); return false; }
                        catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
                    }
                });

            }
        }
        // Entry ownership is independent of the rewind blocker. Every release
        // requires a fresh REST snapshot and a validated local journal.
        const reconcileEntry = async () => {
            const token = this.entryFence;
            const epoch = this.entryEpoch;
            if (!token || this.rewindStopped) return;
            const ownsEntry = () => !this.rewindStopped && token === this.entryFence && epoch === this.entryEpoch;
            const snapshot = await session.client.readRewindMetadata();
            if (!ownsEntry()) return;
            if (!snapshot) throw new Error('OpenCode entry metadata unavailable');
            const operation = snapshot.metadata.opencodeRewind;
            const readIntent = () => readOpenCodeRewindIntent(join(configuration.happyHomeDir, 'opencode-rewind'), session.client.sessionId);
            let intent = readIntent();
            if (intent && intent.operation.nativeSessionId !== acpSessionId) throw new Error('OpenCode entry journal native identity mismatch');
            if (snapshot.metadata.opencodeSessionId && snapshot.metadata.opencodeSessionId !== acpSessionId) {
                if (!startedFreshAfterResumeFailure || operation || intent) throw new Error('OpenCode entry native identity mismatch');
                // Withdraw the old worker's reservation capability durably
                // before replacing a failed resume's native binding. If an
                // operation won the race, leave its metadata untouched.
                session.client.updateMetadata(meta => {
                    if (meta.opencodeRewind) return meta;
                    const capabilities = { ...meta.capabilities };
                    delete capabilities.conversationHistory;
                    return { ...meta, capabilities, opencodeWorkerId: undefined, opencodeWorkerProcess: undefined };
                });
                if (!await session.client.flushMetadata()) throw new Error('OpenCode stale readiness withdrawal failed');
                const withdrawn = await session.client.readRewindMetadata();
                if (!ownsEntry()) return;
                if (!withdrawn || withdrawn.metadata.opencodeRewind
                    || withdrawn.metadata.capabilities?.conversationHistory?.rewindToMessage) {
                    throw new Error('OpenCode stale readiness withdrawal unconfirmed');
                }
            }
            if (operation) {
                if (!this.rewind) throw new Error('OpenCode rewind requires remote reconciliation');
                do {
                    await this.runtimeGate.waitUntilIdle(this.rewindEntryAbortController.signal);
                    if (!ownsEntry()) return;
                } while (this.runtimeGate.isRuntimeActive());
                if (!this.runtimeGate.hasReconciled(operation.operationId) || !['rejected', 'committed'].includes(operation.phase)) {
                    this.runtimeGate.block();
                    await this.rewind.recover(operation);
                }
            } else if (intent && intent.phase !== 'finalized') {
                throw new Error('OpenCode entry has an unresolved journal');
            }
            const confirmed = await session.client.readRewindMetadata();
            if (!ownsEntry()) return;
            if (!confirmed) throw new Error('OpenCode entry confirmation unavailable');
            const latest = confirmed.metadata.opencodeRewind;
            if (latest && (!operation || latest.operationId !== operation.operationId)) {
                throw new OpenCodeRewindSupersededError(latest.operationId);
            }
            if ((confirmed.metadata.opencodeSessionId && confirmed.metadata.opencodeSessionId !== acpSessionId
                    && !(startedFreshAfterResumeFailure && !latest && !intent))
                || (latest && confirmed.metadata.opencodeSessionId !== acpSessionId)
                || (latest && (!['committed', 'rejected'].includes(latest.phase) || !this.runtimeGate.hasReconciled(latest.operationId)))) {
                throw new Error('OpenCode entry is not reconciled');
            }
            intent = readIntent();
            if (intent && (intent.phase !== 'finalized' || intent.operation.nativeSessionId !== acpSessionId)) {
                throw new Error('OpenCode entry journal remains unresolved');
            }
            if (!nativeBindingPublished) {
                session.onSessionFound(acpSessionId);
                if (!await session.client.flushMetadata()) throw new Error('OpenCode native binding is not durable');
                nativeBindingPublished = true;
                // A durable write just reached the hub: the startup flush miss
                // is superseded, so fork support no longer rests on it.
                historyMetadataDurable = true;
            }
            if (!ownsEntry()) return;
            if (confirmed.metadata.conversationHistoryDiverged && !historyDiverged) {
                historyDiverged = true;
                await this.conversationHistory.disableFork();
            }
            // A prompt admitted before the fence may have completed after the
            // snapshots above were read. Its verified checkpoint is newer than
            // Hub's and is published once the fence opens; restoring the stale
            // snapshot would make that growth look unobserved. An uninitialized
            // checkpoint is not an advance: the retry must still restore and
            // verify the persisted history.
            if (!historyDiverged && !this.runtimeGate.isRuntimeActive()
                && (!this.historyPublicationDeferred || this.conversationHistory.getCheckpoint() === undefined)) {
                this.conversationHistory.clearPromptIndexes();
                this.conversationHistory.restoreCheckpoint(confirmed.metadata.opencodeHistoryCheckpoint);
                this.conversationHistory.restorePromptIndexes(confirmed.metadata.conversationHistoryIndexes);
                if (restBaseUrl && historyMetadataDurable) {
                    try { await this.conversationHistory.reconcileHistory(); }
                    catch (error) {
                        await this.conversationHistory.disableFork();
                        if (strictHistoryVerification) throw error;
                    }
                } else if (strictHistoryVerification) {
                    throw new Error('OpenCode fork history is unavailable');
                }
            }
            let final: Awaited<ReturnType<typeof session.client.readRewindMetadata>>;
            do {
                // A no-op may overlap an unrelated ordinary turn, but Stop's
                // later queue reset must settle before admission can reopen.
                await this.runtimeGate.waitUntilCancellationsIdle(this.rewindEntryAbortController.signal);
                if (!ownsEntry()) return;
                final = await session.client.readRewindMetadata();
                if (!ownsEntry()) return;
            } while (this.runtimeGate.hasCancellationActivity());
            if (final?.metadata.conversationHistoryDiverged) historyDiverged = true;
            if (!final || final.metadata.opencodeSessionId !== acpSessionId
                || JSON.stringify(final.metadata.opencodeRewind) !== JSON.stringify(latest)
                || (!historyDiverged && (JSON.stringify(final.metadata.opencodeHistoryCheckpoint) !== JSON.stringify(confirmed.metadata.opencodeHistoryCheckpoint)
                    || JSON.stringify(final.metadata.conversationHistoryIndexes) !== JSON.stringify(confirmed.metadata.conversationHistoryIndexes)))) {
                if (final?.metadata.opencodeRewind && final.metadata.opencodeRewind.operationId !== latest?.operationId) {
                    throw new OpenCodeRewindSupersededError(final.metadata.opencodeRewind.operationId);
                }
                throw new Error('OpenCode entry changed during verification');
            }
            if (ownsEntry()) {
                this.entryFence = undefined;
                this.runtimeGate.releaseEntryFence(token);
            }
        };
        this.drainReconnect = () => {
            if (this.rewindStopped || this.rewindInFlight || !this.rewindReconnectPending) return;
            // A fresh drain supersedes whatever backoff a failed attempt scheduled.
            this.clearEntryRetryTimer();
            this.rewindReconnectPending = false;
            this.rewindInFlight = true;
            void reconcileEntry().then(async () => {
                if (this.rewindStopped) return;
                this.entryRetryAttempt = 0;
                this.conversationHistory.setRewindReady(!this.runtimeGate.isBlocked());
                if (!this.runtimeGate.isBlocked() && this.rewind && this.nativeProcess && workerStartMarker) {
                    session.client.updateMetadata(metadata => metadata.opencodeRewind && !this.runtimeGate.hasReconciled(metadata.opencodeRewind.operationId)
                        ? metadata : ({ ...metadata, opencodeWorkerId: this.workerId,
                            opencodeWorkerProcess: { workerId: this.workerId, pid: process.pid, startMarker: workerStartMarker } }));
                    // Re-verify metadata durability on the recovery path: the
                    // one-shot startup read must not decide fork support forever.
                    if (await session.client.flushMetadata()) historyMetadataDurable = true;
                }
                if (this.rewindStopped) return;
                await this.conversationHistory.publish();
                await registerRewindHandler();
            }).catch(error => {
                this.noteSupersededRewind(error);
                if (this.entryFailureRetriable(error)) this.scheduleEntryRetry();
                logger.warn('[opencode-rewind] Reconnect recovery remains blocked', error);
            }).finally(() => { this.rewindInFlight = false; this.drainReconnect?.(); });
        };
        let rewindHandlerRegistered = false;
        const registerRewindHandler = async () => {
            if (rewindHandlerRegistered || this.rewindStopped) return;
            if (!this.rewind || !this.nativeProcess || !workerStartMarker || this.conversationHistory.isDisabled()) return;
            if (!this.runtimeGate.isBlocked()) session.client.updateMetadata(metadata => metadata.opencodeRewind && !this.runtimeGate.hasReconciled(metadata.opencodeRewind.operationId)
                ? metadata : ({ ...metadata, opencodeWorkerId: this.workerId,
                    opencodeWorkerProcess: { workerId: this.workerId, pid: process.pid, startMarker: workerStartMarker } }));
            if (!await session.client.flushMetadata()) return;
            session.client.rpcHandlerManager.registerHandler(RPC_METHODS.RewindConversation, async (payload: unknown) => {
                const input = payload as { messageLocalId?: string; opencodeRewind?: unknown };
                const operation = OpenCodeRewindSchema.parse(input?.opencodeRewind);
                if (input.messageLocalId !== operation.requestedLocalId) throw new Error('Rewind boundary mismatch');
                if (this.rewindInFlight) throw new Error('OpenCode rewind is busy');
                this.rewindInFlight = true;
                try {
                    const result = await this.rewind!.execute(operation);
                    if (result.success) {
                        // The controller's post-consumption authority read
                        // returned this exact parsed snapshot immediately
                        // before its verified terminal release.
                        const snapshot = lastRewindSnapshot;
                        const current = snapshot?.metadata.opencodeRewind;
                        if (!snapshot || !current || !sameOperation(current, operation) || current.phase !== 'committed') {
                            this.runtimeGate.block();
                            throw new Error('Committed OpenCode rewind metadata is unavailable');
                        }
                        this.conversationHistory.clearPromptIndexes();
                        this.conversationHistory.restoreCheckpoint(snapshot.metadata.opencodeHistoryCheckpoint);
                        this.conversationHistory.restorePromptIndexes(snapshot.metadata.conversationHistoryIndexes);
                    }
                    this.conversationHistory.setRewindReady(!this.runtimeGate.isBlocked());
                    await this.conversationHistory.publish();
                    return result;
                } catch (error) {
                    this.noteSupersededRewind(error);
                    throw error;
                } finally { this.rewindInFlight = false; this.drainReconnect?.(); }
            });
            rewindHandlerRegistered = true;
            this.conversationHistory.setRewindReady(!this.runtimeGate.isBlocked());
            this.drainReconnect?.();
        };
        this.rewindInFlight = true;
        try {
            // A failed optional publication is not proof of absence. The strict
            // snapshot below still decides whether admission is safe.
            await session.client.flushMetadata().catch(() => false);
            if (initialSnapshot) await reconcileEntry();
            // A null startup read on a live socket is a transient miss (the GET
            // swallowed a timeout/503 or saw a stale version), not a waiting
            // socket: retry it through the same serialized backoff. A socket
            // still connecting keeps the existing connected-event path.
            else if (!this.rewindStopped && typeof session.client.isActive === 'function' && session.client.isActive()) this.scheduleEntryRetry();
        } catch (error) {
            this.noteSupersededRewind(error);
            if (this.entryFailureRetriable(error)) this.scheduleEntryRetry();
            logger.warn('[opencode-rewind] Initial entry remains blocked', error);
            if (strictHistoryVerification) throw error;
        } finally {
            this.rewindInFlight = false;
            this.drainReconnect();
        }
        if (!historyDiverged) {
            if (!historyMetadataDurable) {
                // An entry fence held by a pending retry is not a verdict: the
                // recovery path re-verifies durability before forks are lost.
                if (!this.entryFence) await this.conversationHistory.disableFork().catch((error) => logger.warn('[opencode-remote] Forks disabled while metadata is unavailable', error));
            } else {
                try {
                    await this.conversationHistory.publish();
                } catch (error) {
                    await this.conversationHistory.disableFork().catch((writeError) => logger.warn('[opencode-remote] Forks disabled while history is unavailable', writeError));
                    if (strictHistoryVerification) throw error;
                }
            }
        }
        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ForkConversation, async (payload: unknown) => {
            const release = this.runtimeGate.enterRuntime();
            try {
            const messageLocalId = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
                && typeof (payload as Record<string, unknown>).messageLocalId === 'string'
                ? (payload as Record<string, unknown>).messageLocalId as string
                : undefined;
            const result = await this.conversationHistory.fork(messageLocalId);
            return { ...result, opencodeHistoryCheckpoint: await this.conversationHistory.checkpointForkedSession(result.nativeSessionId) };
            } finally { release(); }
        });
        await registerRewindHandler();
        if (isV2 && !historyDiverged) {
            void this.conversationHistory.probeCapabilities(this.historyProbeAbortController.signal).catch(() => {});
        }
        if ((resumeSessionId || strictForkResume) && typeof session.client.emitSessionReady === 'function') {
            session.client.emitSessionReady();
        }

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
            && !this.runtimeGate.isBlocked()
            && typeof requestedStartupModel === 'string'
            && requestedStartupModel.length > 0
            && requestedStartupModel !== this.defaultBackendModel
            && typeof backend.setModel === 'function'
        ) {
            const release = this.runtimeGate.enterRuntime();
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
            } finally { release(); }
        }

        // Let the caller (runOpencode.ts) know native /compact can actually
        // run now that the ACP backend + internal HTTP baseUrl exist. The
        // dequeue loop below (not an externally-invoked trigger) is what
        // executes it, in its actual FIFO queue position.
        //
        // Terminal switch/exit handlers are active during newSession/loadSession.
        // requestExit() synchronously withdraws availability and sets shouldExit;
        // finishing initialization must not advertise compact again mid-teardown.
        if (!this.shouldExit && (this.v2RestInfo !== null || this.baseUrl !== null)) {
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
        // Archive and SIGTERM end the process through the runner lifecycle. A
        // question form the user never answered would otherwise leave OpenCode
        // waiting and the request pending in the session state.
        session.setKillHandler(() => this.permissionHandler?.cancelAll('Session terminated'));
        this.applyDisplayMode(session.getPermissionMode() as PermissionMode);

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            // Explicit `false`: plain Stop stays in this remote session, so
            // an in-flight compact must not be aborted client-side — see
            // handleAbort's `leavingRemote` doc comment.
            onAbort: () => this.handleAbort(false),
            onSwitch: () => this.handleSwitchRequest()
        });

        this.installSteerHandler(session, acpSessionId);
        if (isV2 && this.v2RestInfo) {
            this.options.onSteerCancelHandlerChange?.(localId => this.v2Steers.get(localId)?.cancel('explicit'));
        }

        const sendReady = () => {
            session.sendSessionEvent({ type: 'ready' });
        };

        while (!this.shouldExit) {
            const waitSignal = this.abortController.signal;
            await this.runtimeGate.waitUntilOpen(waitSignal);
            if (waitSignal.aborted) continue;
            let batch;
            try {
                batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);
            } catch (error) {
                // beforeDequeue acquired no ownership and removed/ACKed no row.
                // A socket entry can fence the gate while this await is parked.
                if (error instanceof OpenCodeRuntimeBlockedError) continue;
                throw error;
            }
            if (!batch) {
                if (waitSignal.aborted && !this.shouldExit) {
                    continue;
                }
                break;
            }

            // Hold the fork busy guard across the whole dequeued batch —
            // collectBatch() already acked the rows, so the hub can briefly see an
            // empty queue + thinking=false while model/effort setup or native
            // mutations are still in flight (same fence as grok).
            this.conversationHistory.setBusy(true);
            const releaseRuntime = session.takeDequeuedRuntimeRelease?.() ?? this.runtimeGate.enterRuntime();
            try {

                this.settleBackendSoftSteers(backend, null, 'dequeue');

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

                // Install the controller before async model/effort changes so
                // handleAbort() can cancel this batch even before HTTP work starts.
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
                let steeringModel = batch.mode.model;
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
                        steeringModel = batch.mode.model;
                    } else {
                        logger.debug(`[opencode-remote] Switching model inline: ${this.currentBackendModel} -> ${requestedModel}`);
                        try {
                            await backend.setModel(acpSessionId, requestedModel, { flavor: 'opencode' });
                            this.currentBackendModel = requestedModel;
                            this.setModelSupported = true;
                            // set_config_option("model") also switches the backend's
                            // effort currentValue, so refresh both effort caches.
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
                        steeringModel = batch.mode.model;
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

                    // Stop during model/effort setup must not start new HTTP work.
                    // Switch/exit instead passes its aborted signal through the
                    // operation so fetch rejects without issuing a request.
                    // Local-id cancellation is recorded during the invoked ACK,
                    // before HTTP work starts. Consume its one-shot entry here;
                    // there is no running server mutation to wait for in that case.
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
                        // Clear the hub's queued-thinking grace even though this
                        // operation never entered thinking=true. The queue's normal
                        // unflagged consumed ACK does not clear that grace; repeating
                        // the ACK with the session-level flag is idempotent.
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

                    this.nextRoundSnapshot = null;
                    session.onThinkingChange(true);
                    let nativeHistoryMayHaveChanged = false;
                    try {
                        await this.runCompactOperation(
                            acpSessionId,
                            compactAbortController,
                            compactLocalId,
                            () => {
                                nativeHistoryMayHaveChanged = true;
                                this.nativeHistoryUnverified = true;
                            }
                        );
                        if (!nativeHistoryMayHaveChanged) continue;
                        // Compaction starts a new identity epoch. Discard old
                        // positions, then persist the new baseline before any
                        // fork or handoff can trust the compacted history.
                        this.conversationHistory.clearPromptIndexes();
                        try {
                            await this.conversationHistory.reconcileHistory(undefined, { allowUnobservedAppend: true });
                            await this.conversationHistory.publish();
                            this.nativeHistoryUnverified = false;
                        } catch {
                            if (!this.conversationHistory.isDiverged()) {
                                await this.conversationHistory.invalidateHistory().catch((error) => logger.warn('[opencode-remote] History divergence persistence deferred', error));
                            }
                        }
                    } finally {
                        this.nativeHistoryUnverified = false;
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

                this.stallErrorReportedForPrompt = false;
                const roundSummaryAbortController = new AbortController();
                this.roundSummaryAbortController = roundSummaryAbortController;
                this.roundSummaryPhase = 'snapshot';
                const roundApi = this.v2RestInfo
                    ? { baseUrl: this.v2RestInfo.baseUrl, api: { version: 'v2' as const, password: this.v2RestInfo.password } }
                    : this.baseUrl ? { baseUrl: this.baseUrl } : null;
                const roundSnapshot = this.nextRoundSnapshot ?? (roundApi
                    ? await captureOpencodeRoundSnapshot({
                        ...roundApi,
                        sessionId: acpSessionId,
                        signal: roundSummaryAbortController.signal
                    }).catch((error) => {
                        logger.debug('[opencode-remote] round snapshot unavailable', error);
                        return null;
                    })
                    : null);
                this.nextRoundSnapshot = null;
                if (
                    this.roundSummaryAbortController !== roundSummaryAbortController
                    || roundSummaryAbortController.signal.aborted
                    || this.shouldExit
                ) {
                    if (this.roundSummaryAbortController === roundSummaryAbortController) {
                        this.roundSummaryAbortController = null;
                        this.roundSummaryPhase = 'idle';
                    }
                    session.onThinkingChange(false);
                    if (session.queue.size() === 0 && !this.shouldExit) {
                        sendReady();
                    }
                    continue;
                }

                // The one-time flag is consumed only at dispatch below, so a Stop
                // during the history read cannot drop the instructions for good.
                const attachInstructions = !this.instructionsSent;
                if (attachInstructions) {
                    messageText = `${getOpencodeNativeToolInstruction()}\n\n${messageText}`;
                }

                const promptContent: PromptContent[] = [{
                    type: 'text',
                    text: messageText,
                }];

                const promptStartedAt = performance.now();
                let promptDurationMs = 0;
                // A pre-dispatch bail-out (aborted wait, unavailable history count)
                // must not request a round summary for a prompt that never ran.
                let promptDispatched = false;
                this.roundSummaryPhase = 'prompt';
                session.onThinkingChange(true);
                // Only a normal prompt is steerable: /compact and /clear leave this
                // false, so a steer arriving during either is rejected rather than
                // injected into a turn the agent is not running.
                this.promptInFlight = true;
                this.permissionHandler?.beginTurn();
                this.activePromptModeHash = session.queue.modeHasher({ ...batch.mode, model: steeringModel });
                this.activePromptText = messageText;
                this.steerTurnEpoch += 1;
                // Advertise steerability so the web's queued-message Steer button
                // is reachable at all; only a normal active prompt may set it.
                this.setSteeringActive(true);
                const nativeInput = { uncertain: false };
                try {
                    // Native automatic compaction can append both a user-role
                    // compaction marker and a synthetic continuation. Re-read the
                    // native count before each prompt instead of assuming that the
                    // previous HAPI batch added exactly one user message. A failed
                    // read must omit this point, never reuse a stale position. A
                    // second snapshot below verifies the completed native history.
                    const nativeUserCount = await this.conversationHistory.getNativeUserMessageCount(waitSignal);
                    if (waitSignal.aborted || this.shouldExit) {
                        continue;
                    }
                    if (nativeUserCount === null) {
                        logger.warn('[opencode-remote] Native history unavailable; skipping fork point');
                    }
                    logger.debug(`[opencode-remote] history point: localId=${batch.items[0]?.localId} index=${nativeUserCount} items=${batch.items.length}`);
                    // Publish a locator only after completion and verification;
                    // failed/cancelled requests may leave partial native history.
                    this.nativeHistoryUnverified = true;
                    this.nativeInputWriters.add(nativeInput);
                    promptDispatched = true;
                    if (attachInstructions) this.instructionsSent = true;
                    try {
                        await backend.prompt(acpSessionId, promptContent, (message: AgentMessage) => {
                            this.handleAgentMessage(message);
                        });
                    } finally {
                        promptDurationMs = performance.now() - promptStartedAt;
                        this.roundSummaryPhase = 'settle';
                    }
                    this.completeNativeInput(nativeInput);
                    // The foreground response does not fence concurrent inbox or
                    // soft-steer writes. Close admission before awaiting their
                    // receipts/restores, then snapshot the combined native turn.
                    this.promptInFlight = false;
                    this.activePromptModeHash = null;
                    this.setSteeringActive(false);
                    await this.drainSteerOperations();
                    if (this.hasUnresolvedNativeInput()) throw new Error('OpenCode input outcome is unresolved');
                    await this.nativeTranscript?.refresh();
                    // A merged batch is one native prompt, so only its first item
                    // is a native fork boundary (same merge semantics as grok).
                    try {
                        await this.conversationHistory.reconcileHistory(undefined, { allowUnobservedAppend: true });
                        if (nativeUserCount !== null) {
                            if (!this.conversationHistory.getCheckpoint()?.userMessageIds[nativeUserCount]) {
                                throw new Error('OpenCode did not persist the accepted prompt');
                            }
                            this.conversationHistory.rememberPromptIndex(batch.items[0]?.localId, nativeUserCount);
                        }
                        await this.conversationHistory.publish();
                        this.nativeHistoryUnverified = false;
                    } catch {
                        // Never expose newly accepted rows without a verified
                        // native identity checkpoint for a future handoff.
                        if (!this.conversationHistory.isDiverged()) {
                            await this.conversationHistory.invalidateHistory().catch((error) => logger.warn('[opencode-remote] History divergence persistence deferred', error));
                        }
                    }
                    void backend.refreshSessionInfo(acpSessionId, session.path);
                } catch (error) {
                    if (this.nativeHistoryUnverified && !this.conversationHistory.isDiverged()) {
                        await this.conversationHistory.invalidateHistory().catch((writeError) => logger.warn('[opencode-remote] History divergence persistence deferred', writeError));
                    }
                    this.invalidateNativeReceiptCorrelation();
                    logger.warn('[opencode-remote] prompt failed', error);
                    this.reportPromptFailure(error);
                } finally {
                    this.promptInFlight = false;
                    this.activePromptModeHash = null;
                    this.setSteeringActive(false);
                    await this.drainSteerOperations();
                    this.nativeHistoryUnverified = false;
                    if (
                        this.roundSummaryAbortController === roundSummaryAbortController
                        && !roundSummaryAbortController.signal.aborted
                        && !this.shouldExit
                        && promptDispatched
                        && roundApi
                        && roundSnapshot
                    ) {
                        const result = await settleRoundSummary(
                            fetchOpencodeRoundSummary({
                                ...roundApi,
                                sessionId: acpSessionId,
                                promptText: messageText,
                                snapshot: roundSnapshot,
                                durationMs: promptDurationMs,
                                signal: roundSummaryAbortController.signal
                            }),
                            roundSummaryAbortController
                        );
                        if (result) {
                            this.nextRoundSnapshot = result.snapshot;
                            if (result.summary) this.handleAgentMessage({ type: 'round_summary', summary: result.summary });
                        }
                    }
                    if (this.roundSummaryAbortController === roundSummaryAbortController) {
                        this.roundSummaryAbortController = null;
                    }
                    try {
                        session.onThinkingChange(false);
                        await this.permissionHandler?.cancelAll('Prompt finished');
                        if (session.queue.size() === 0 && !this.shouldExit) {
                            sendReady();
                        }
                    } finally {
                        this.roundSummaryPhase = 'idle';
                    }
                }
            } finally {
                this.conversationHistory.setBusy(false);
                releaseRuntime();
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
                if (this.majorVersion === 'v2' && !this.v2RestInfo) {
                    return { steered: false, error: 'OpenCode v2 internal API unavailable' };
                }
                const backend = this.backend;
                // isPromptRequestInFlight(), not processingMessage: after ACP
                // answers the foreground session/prompt, prompt() keeps
                // draining updates for seconds while the backend still reports
                // a processing message. A steer accepted in that window would
                // start a brand-new turn instead of injecting mid-turn.
                if (this.runtimeGate.isBlocked()
                    || !this.promptInFlight
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
                const markUncertainNativeDelivery = () => {
                    this.invalidateNativeReceiptCorrelation();
                    if (session.queue.markReservationIndeterminate(taken)) {
                        session.client.emitSteerIndeterminate([localId]);
                    }
                };
                const { operation, release: releaseOperation } = this.beginSteerOperation(markUncertainNativeDelivery);
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

                const restoreQueuedReservation = async (shouldRestore: () => boolean = () => true): Promise<boolean> => {
                    // Includes pre-admission and stall restores, whose native
                    // entry may not yet exist or predate the active Stop.
                    while (this.v2ResetInProgress) await this.v2ResetInProgress;
                    if (!shouldRestore()) return false;
                    if (!taken.originIndeterminate) {
                        const persisted = await session.client.setSteerDeliveryState([localId], 'queued');
                        if (!persisted) {
                            session.queue.markReservationIndeterminate(taken);
                            session.client.emitSteerIndeterminate([localId]);
                            return false;
                        }
                    }
                    while (this.v2ResetInProgress) await this.v2ResetInProgress;
                    if (!shouldRestore()) return false;
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
                // The foreground input itself may still be awaiting native
                // persistence. If its text matches, a new id cannot prove
                // which request was accepted; wait for completion instead.
                const nativeBefore = this.majorVersion !== 'v2' && !this.nativeSteerReceiptCorrelationLost
                    && this.pendingSteerAcceptances.size === 1
                    && taken.item.message !== this.activePromptText
                    // Native slash commands can persist an expanded body
                    // different from the foreground text sent over ACP.
                    && !this.activePromptText?.trimStart().startsWith('/')
                    ? await fetchOpencodeUserMessages({ baseUrl: this.baseUrl, sessionId: acpSessionId })
                    : null;
                // Recheck everything the durable/native-history awaits could
                // have invalidated before sending to the backend.
                if (this.runtimeGate.isBlocked()
                    || !this.promptInFlight
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

                if (this.majorVersion === 'v2') {
                    return this.dispatchV2Steer(session, acpSessionId, localId, taken, releaseOperation, restoreQueuedReservation);
                }

                let steer: ReturnType<AcpSdkBackend['beginSoftSteerPrompt']>;
                let softSteerOwnership: { backend: AcpSdkBackend; turnEpoch: number } | null = null;
                const nativeInput = { uncertain: false };
                this.nativeInputWriters.add(nativeInput);
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
                        this.completeNativeInput(nativeInput);
                        this.settleSteerTransport(operation, softSteerOwnership);
                    }, () => {
                        this.invalidateNativeReceiptCorrelation();
                        this.settleSteerTransport(operation, softSteerOwnership);
                    });
                } catch (error) {
                    if (isAcpIndeterminateError(error)) {
                        markUncertainNativeDelivery();
                        logger.debug('[opencode-remote] soft-steer dispatch outcome unknown', error);
                        releaseOperation();
                        return { steered: false, error: 'Steer outcome is being reconciled' };
                    }
                    this.completeNativeInput(nativeInput);
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
                        markUncertainNativeDelivery();
                        logger.debug('[opencode-remote] soft-steer dispatch outcome unknown', error);
                        releaseOperation();
                        return { steered: false, error: 'Steer outcome is being reconciled' };
                    }
                    // A definite dispatch rejection means the request is
                    // finished, not stranded: clear its ownership before the
                    // restore so a cancellation during it cannot treat this
                    // operation as an unanswered runtime request.
                    this.settleSteerTransport(operation, softSteerOwnership);
                    this.completeNativeInput(nativeInput);
                    await restoreQueuedReservation();
                    releaseOperation();
                    logger.debug('[opencode-remote] soft-steer failed to start', error);
                    return { steered: false, error: 'Failed to soft-steer into active turn' };
                }

                let accepted = false;
                const acknowledgeAcceptance = () => {
                    if (accepted) return;
                    // Explicit resolution can release an abandoned request's
                    // reservation before its late native completion arrives.
                    if (!session.queue.commitReservation(taken)) return;
                    accepted = true;
                    this.pendingSteerAcceptances.delete(operation);
                    session.client.emitMessagesConsumed([localId], { steered: true });
                    this.messageBuffer.addMessage(taken.item.message, 'user');
                };
                // OpenCode persists the user input before the concurrent
                // session/prompt response (which waits for the model's entire
                // turn). A new native id can confirm a previously unseen input.
                // Compaction can replay an earlier user row without a marker,
                // so repeated text must wait for its own successful response.
                // Never infer acceptance from stdin dispatch or elapsed time.
                const nativeReceipt = (async () => {
                    if (!nativeBefore || nativeBefore.some(message => message.text === taken.item.message)) return;
                    const previousIds = new Set(nativeBefore.map(message => message.id));
                    while (!accepted && operation.transportPending
                        && !this.nativeSteerReceiptCorrelationLost
                        && this.steerEpoch === steerEpoch
                        && this.backend === backend
                        && this.activeAcpSessionId === acpSessionId
                        && this.nativeSteerReceiptGeneration === receiptGeneration
                        && this.pendingSteerAcceptances.has(operation)) {
                        const nativeMessages = await fetchOpencodeUserMessages({
                            baseUrl: this.baseUrl,
                            sessionId: acpSessionId
                        });
                        if (this.nativeSteerReceiptCorrelationLost
                            || this.steerEpoch !== steerEpoch
                            || this.backend !== backend
                            || this.activeAcpSessionId !== acpSessionId
                            || this.nativeSteerReceiptGeneration !== receiptGeneration) return;
                        const matches = nativeMessages?.filter(message =>
                            !previousIds.has(message.id) && message.text === taken.item.message
                        ) ?? [];
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
                // available, hold a completion failure indeterminate.
                void steer.completed.then(acknowledgeAcceptance, async (error) => {
                    await nativeReceipt;
                    if (accepted) return;
                    // ACP provider errors may arrive after native input acceptance.
                    // Without a receipt, dispatch completion cannot prove rejection.
                    markUncertainNativeDelivery();
                    logger.debug('[opencode-remote] soft-steer outcome unknown after dispatch; row held for explicit resolution', error);
                }).finally(() => {
                    releaseOperation();
                });
                // Native persistence is independent of the transport ACK. Keep
                // reconciling while this request owns the active turn, without
                // holding the hub RPC open or inferring acceptance from dispatch.
                return { steered: true };
            }
        );
    }

    private handleV2SteerEvent(type: string, properties: Record<string, unknown>): void {
        if (this.majorVersion !== 'v2' || typeof properties.inboxID !== 'string') return;
        for (const entry of this.v2Steers.values()) {
            if (properties.sessionID !== entry.sessionId || properties.inboxID !== entry.inputId) continue;
            if (type === 'session.inbox.delivered') entry.delivered();
            if (type === 'session.inbox.enqueued') entry.enqueued(properties);
            // delivery.changed is only a mode change. Neither it nor an
            // enqueued fact can acknowledge model-visible input delivery.
        }
    }

    private async dispatchV2Steer(
        session: OpencodeSession,
        sessionId: string,
        localId: string,
        taken: QueueReservation<OpencodeMode>,
        release: () => void,
        restore: (shouldRestore?: () => boolean) => Promise<boolean>
    ): Promise<{ steered: boolean; error?: string }> {
        const rest = this.v2RestInfo!;
        const opts = { ...rest, sessionId, text: taken.item.message, inputId: opencodeV2InputId({
            hapiSessionId: session.client.sessionId, sessionId, localId, text: taken.item.message
        }) };
        let accepted = false;
        let admissionKnown = false;
        let cancelRequested = false;
        let abandoned = false;
        let purpose: 'stop' | 'explicit' | 'teardown' = 'stop';
        let cancellation: Promise<OpencodeSteerCancelResult> | null = null;
        const currentPurpose = () => purpose;
        let resolveDelivered!: () => void;
        const delivered = new Promise<void>(resolve => { resolveDelivered = resolve; });
        const remove = () => { if (this.v2Steers.get(localId) === entry) this.v2Steers.delete(localId); };
        const unknown = () => {
            if (accepted) return;
            if (session.queue.markReservationIndeterminate(taken)) session.client.emitSteerIndeterminate([localId]);
            release();
        };
        const consume = () => {
            if (accepted) return true;
            if (abandoned || !session.queue.commitReservation(taken)) return false;
            accepted = true;
            session.client.emitMessagesConsumed([localId], { steered: true });
            this.messageBuffer.addMessage(taken.item.message, 'user');
            resolveDelivered();
            release();
            remove();
            return true;
        };
        const entry: OpencodeV2SteerEntry = {
            inputId: opts.inputId, sessionId, delivered: consume,
            enqueued: properties => {
                const item = properties.item;
                if (item && typeof item === 'object' && 'type' in item && item.type === 'user'
                    && 'payload' in item && item.payload && typeof item.payload === 'object'
                    && 'text' in item.payload && item.payload.text === opts.text) admissionKnown = true;
            },
            abandon: () => { abandoned = true; unknown(); },
            cancel: (nextPurpose, resetFinished = Promise.resolve()) => {
                cancelRequested = true;
                if (nextPurpose === 'explicit' || purpose !== 'explicit' && nextPurpose === 'teardown') purpose = nextPurpose;
                const activeCancellation: Promise<OpencodeSteerCancelResult> = cancellation ?? (async (): Promise<OpencodeSteerCancelResult> => {
                    const admission = await Promise.race([admitted, delivered.then(() => 'delivered' as const)]);
                    if (accepted) return 'consumed';
                    if (!admissionKnown && admission !== 'rejected') {
                        // A lost POST may still prepare an input. Only a
                        // positive inbox/projection proves its write happened;
                        // a no-op DELETE before admission cannot fence it.
                        const state = await readOpencodeV2Input(opts);
                        if (state === 'delivered') return consume() ? 'consumed' : 'indeterminate';
                        admissionKnown = state === 'pending';
                    }
                    const outcome = admission === 'rejected' ? 'cancelled'
                        : admissionKnown ? await cancelOpencodeV2Steer(opts) : 'unknown';
                    if (accepted || outcome === 'delivered') return consume() ? 'consumed' : 'indeterminate';
                    await resetFinished;
                    if (outcome !== 'cancelled' || abandoned) { unknown(); return 'indeterminate'; }
                    if (purpose === 'explicit') {
                        session.queue.markReservationIndeterminate(taken);
                        const removed = session.queue.cancelByLocalId(localId);
                        release(); remove();
                        return removed;
                    }
                    if (purpose === 'stop' && !taken.originIndeterminate) {
                        const restored = await restore(() => purpose === 'stop' && !abandoned);
                        // Explicit resolution can arrive during the durable
                        // queued-state await. Remove the actual reservation or
                        // restored FIFO item before acknowledging removal.
                        if (currentPurpose() === 'explicit') {
                            session.queue.markReservationIndeterminate(taken);
                            const removed = session.queue.cancelByLocalId(localId);
                            release(); remove();
                            return removed;
                        }
                        if (!restored) unknown();
                        release(); remove();
                        return restored ? true : 'indeterminate';
                    }
                    // Teardown or a previously unknown delivery never becomes
                    // an implicit retry. The durable HAPI row remains unknown.
                    unknown(); remove();
                    return 'indeterminate';
                })().catch((error): OpencodeSteerCancelResult => {
                    logger.debug('[opencode-remote] v2 cancellation could not be verified', error);
                    unknown();
                    return 'indeterminate';
                }).then((result): OpencodeSteerCancelResult => {
                    // Unknown is not terminal native evidence. A later user
                    // Cancel/Retry must be able to reconcile newly admitted input.
                    if (result === 'indeterminate') cancellation = null;
                    return result;
                });
                cancellation = activeCancellation;
                return activeCancellation;
            }
        };
        this.v2Steers.set(localId, entry);
        const admitted = (async () => {
            if (!taken.originIndeterminate) return admitOpencodeV2Steer(opts);
            // Unknown retries never blindly POST again: a previous request
            // might still admit later. Reconcile its stable native identity.
            const state = await readOpencodeV2Input(opts);
            if (state === 'delivered') { consume(); return 'admitted' as const; }
            if (state !== 'pending' || cancelRequested) return 'unknown' as const;
            return steerOpencodeV2Inbox(opts);
        })().then(result => {
            admissionKnown ||= result === 'admitted';
            return result;
        });
        const result = await Promise.race([admitted, delivered.then(() => 'delivered' as const)]);
        if (accepted) return { steered: true };
        if (cancelRequested) return { steered: false, error: 'Active turn changed' };
        if (result === 'rejected') {
            const restored = await restore();
            release(); remove();
            return { steered: false, error: restored ? 'OpenCode rejected steering input' : 'Steer state is indeterminate' };
        }
        if (result !== 'admitted') {
            unknown();
            return { steered: false, error: 'Steer outcome is being reconciled' };
        }
        // SSE owns prompt feedback. Identity-based readback closes missed
        // events/reconnect gaps without treating elapsed time as acceptance.
        void (async () => {
            while (!accepted && !cancelRequested && !abandoned) {
                const state = await readOpencodeV2Input(opts);
                if (accepted || cancelRequested || abandoned) return;
                if (state === 'delivered') { consume(); return; }
                if (state !== 'pending') { unknown(); return; }
                await new Promise<void>(resolve => setTimeout(resolve, 100));
            }
        })();
        return { steered: true };
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
     * stay attached either way. An unanswered delivery becomes indeterminate,
     * so explicit Cancel/Retry can release it; late acceptance may commit only
     * while that request still owns the reservation.
     */
    private closeSteerGate(options?: { detachStrandedSteers?: boolean }): void {
        if (options?.detachStrandedSteers && this.promptInFlight) {
            // A normal foreground request can also still be awaiting native
            // persistence when Stop/stall releases its turn.
            this.invalidateNativeReceiptCorrelation();
        }
        this.steerEpoch++;
        this.promptInFlight = false;
        this.activePromptModeHash = null;
        this.activePromptText = null;
        this.setSteeringActive(false);
        if (options?.detachStrandedSteers === true) {
            for (const operation of Array.from(this.pendingSteerOperations)) {
                if (operation.transportPending) {
                    operation.detach();
                }
            }
        }
    }

    private invalidateNativeReceiptCorrelation(): void {
        this.nativeSteerReceiptCorrelationLost = this.nativeInputWriters.size > 0;
        for (const input of this.nativeInputWriters) input.uncertain = true;
    }

    // Queue resolution and transport counters cannot prove a native writer
    // is fenced. Unknown v2 admissions and detached ACP writers retain their
    // own evidence even after an explicit HAPI row cancellation.
    private hasUnresolvedNativeInput(): boolean {
        return this.v2Steers.size > 0 || this.nativeInputWriters.size > 0
            || this.pendingSteerOperations.size > 0;
    }

    private completeNativeInput(input: { uncertain: boolean }): void {
        this.nativeInputWriters.delete(input);
        if (!Array.from(this.nativeInputWriters).some(writer => writer.uncertain)) {
            this.nativeSteerReceiptCorrelationLost = false;
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
        // v2 uses its experimental durable REST inbox, never concurrent ACP.
        const steeringActive = active && !this.runtimeGate.isBlocked()
            && (this.majorVersion !== 'v2' || this.v2RestInfo !== null);
        this.session.client.updateAgentState?.((state) => ({ ...state, steeringActive }));
    }

    /**
     * Registers a steer operation that the foreground prompt must wait for.
     * Released once its bookkeeping finished, or detached by a cancellation
     * that can strand its ACP request — either way the ACP callbacks attached
     * to that request stay alive.
     */
    private beginSteerOperation(onDetach: () => void): {
        operation: OpencodeSteerOperation;
        release: () => void;
    } {
        const releaseRuntime = this.runtimeGate.enterRuntime();
        let settle!: () => void;
        const operation: OpencodeSteerOperation = {
            settled: new Promise<void>((resolve) => { settle = resolve; }),
            transportPending: false,
            detach: () => {
                onDetach();
                operation.release();
            },
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
            releaseRuntime();
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

    /** Wait for remaining durable writes/restores, including after a plain Stop.
     * closeSteerGate detaches only stranded runtime requests; their callbacks
     * remain attached, while undispatched/settled bookkeeping still gates FIFO. */
    private async drainSteerOperations(): Promise<void> {
        const pending = Array.from(this.pendingSteerOperations, operation => operation.settled);
        await Promise.allSettled(pending);
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
        this.rewindStopped = true;
        this.rewindEntryAbortController.abort();
        this.detachRewindEntry();
        // Synchronous, before anything here could await: a steer parked on a
        // durable-state await must not be able to inject into a backend that is
        // already on its way out.
        this.historyProbeAbortController.abort();
        this.closeSteerGate();
        this.options.onCompactAvailabilityChange?.(false);
        // Withdraw history affordances for the teardown window and any
        // subsequent local mode: the loopback server is going away, so forks
        // can no longer be served (same lifecycle as /compact above).
        this.conversationHistory.setBusy(true);
        void (this.nativeHistoryUnverified
            ? this.conversationHistory.invalidateHistory()
            : this.conversationHistory.disableFork()).catch(() => {});
    }

    protected async cleanup(): Promise<void> {
        this.rewindStopped = true;
        this.detachRewindEntry();
        // Before anything that can fail: a steer still parked on a
        // durable-state await must not be able to send into the backend that is
        // about to be torn down (or a replacement one).
        this.closeSteerGate({ detachStrandedSteers: true });
        this.options.onSteerCancelHandlerChange?.(null);
        await Promise.all(Array.from(this.v2Steers.values(), entry => entry.cancel('teardown')));
        for (const entry of this.v2Steers.values()) entry.abandon();
        this.v2Steers.clear();
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.SteerQueuedMessage, async () => ({
            steered: false,
            error: 'Session ending'
        }));
        // Before anything that can fail: a stream left open would keep
        // reconnecting to a subprocess that is on its way out.
        this.nativeTranscript?.close();
        this.nativeTranscript = null;
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
        const v2Cancellations = Array.from(this.v2Steers.values(), entry => entry.cancel('stop'));
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
            await Promise.all(v2Cancellations);
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
     * The dequeue loop creates compactAbortController before async model/effort
     * setup and passes it here. Replacing it would lose cancellation received
     * during that setup window.
     */
    private async runCompactOperation(
        acpSessionId: string,
        compactAbortController: AbortController,
        localId?: string,
        onMutationIssued?: () => void
    ): Promise<void> {
        const session = this.session;
        session.sendSessionEvent({ type: 'message', message: '📦 Compaction started' });

        try {
            const isCancelled = (): boolean =>
                (localId ? (this.options.isLocalIdCancelled?.(localId) ?? false) : false)
                || compactAbortController.signal.aborted
                || this.compactResultSuppressed;

            const backend = this.backend;
            const v2Rest = this.majorVersion === 'v2' ? this.v2RestInfo : null;
            const baseUrl = v2Rest?.baseUrl ?? this.baseUrl;
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

            // v2: no marker snapshot boundary exists (the v1 capture is
            // v1-only); the POST is abortable and verification polls the v2
            // message GET, feeding the same result switch. Suppression spans
            // the POST *and* the polling loop: v2 returns from the POST
            // before the summary exists, and session/update notifications
            // arriving during the minutes-long poll would otherwise reach
            // the stale pre-compact handler and duplicate the explicit
            // summary (the v1 path suppresses for the same reason).
            //
            // Phase ordering mirrors v1's distinction, adapted to v2's async
            // compaction: 'snapshot' (abortable read-only identity capture)
            // → 'summarize' from just before the POST through the entire
            // poll, because v2's POST only admits the work — everything
            // after admission is server-side mutation a plain Stop must
            // wait out rather than abort as an "interruptible read".
            if (v2Rest) {
                // Identity boundary FIRST, in the abortable 'snapshot' phase
                // (the v2 analogue of v1's marker snapshot): compaction ids
                // visible before the POST. If the POST response cannot be
                // read, any compaction entry appearing afterwards must be
                // ours. Admission is refused without this boundary — a
                // successful POST admits server-side work, so verifying it
                // must never depend on guessing. Wire contract verified
                // against opencode v2.0.29 (release commit 042d0832f):
                // POST /api/session/:id/compact, GET /api/session/:id/message
                // ({data: [Session.Message.Compaction...]}), /api/event SSE
                // with {id, type, data} envelopes, OPENCODE_PASSWORD injected
                // into the serve child (cli/src/services/standalone.ts).
                this.compactOperationPhase = 'snapshot';
                const preExistingIds = await captureCompactionIdsV2({
                    baseUrl,
                    sessionId: acpSessionId,
                    password: v2Rest.password,
                    signal: compactAbortController.signal
                });
                let v2Outcome:
                    | { ok: true; cancelled: true }
                    | { ok: false; error: string }
                    | { ok: true; cancelled: false; result: CompactionResult }
                    | null = null;
                if (compactAbortController.signal.aborted) {
                    // Plain Stop or teardown landed during the read-only
                    // snapshot: nothing was admitted, so exiting here releases
                    // no server-side work.
                    v2Outcome = { ok: true as const, cancelled: true as const };
                } else if (preExistingIds === null) {
                    // No recovery basis → no admission. Report a failure
                    // rather than running a compaction whose outcome could
                    // never be attributed.
                    v2Outcome = {
                        ok: false as const,
                        error: 'OpenCode v2 compaction identity snapshot failed; refusing to admit without a recovery boundary.'
                    };
                } else {
                    this.compactOperationPhase = 'summarize';
                    v2Outcome = await backend.suppressUpdatesDuring(async (): Promise<
                        | { ok: true; cancelled: true }
                        | { ok: false; error: string }
                        | { ok: true; cancelled: false; result: CompactionResult }
                    > => {
                        onMutationIssued?.();
                        const admitted = await triggerOpencodeCompactV2({
                            baseUrl,
                            sessionId: acpSessionId,
                            providerId: split.providerId,
                            modelId: split.modelId,
                            password: v2Rest.password,
                            signal: compactAbortController.signal
                        });
                        if (admitted.kind === 'rejected') {
                            // The server answered and refused: definitive,
                            // nothing was admitted.
                            return { ok: false as const, error: admitted.error };
                        }
                        if (compactAbortController.signal.aborted) {
                            // Teardown (switch/exit) aborted the operation itself:
                            // the POST/poll is dead, nothing server-side to await.
                            return { ok: true as const, cancelled: true as const };
                        }
                        // A plain Stop that landed while the POST was pending only
                        // asked for output suppression — the POST merely admitted
                        // the request and the server-side compaction is still
                        // pending, so verification MUST continue (barrier held)
                        // rather than releasing the queue mid-compaction. The
                        // suppression applies to the terminal outcome below.
                        const admittedId = admitted.kind === 'admitted' ? admitted.compactionId : null;
                        if (admitted.kind === 'transport-error') {
                            // Admission is UNCERTAIN (the server may have accepted
                            // before the connection died): run identity recovery
                            // instead of failing — the exclude-list path below
                            // waits for a NEW compaction entry. Without a
                            // snapshot basis the unverified result still leaves
                            // after the (barrier-covered) wait, which is the
                            // best a no-basis recovery can do.
                            logger.debug(`[opencode-remote] v2 compact admission uncertain (${admitted.message}); recovering via pre-POST snapshot`);
                        }
                        // The poll is bounded — but the bound is a STALL cap (see
                        // pollCompactionResultV2): a visible pending compaction is
                        // genuine server work that legitimately holds the barrier,
                        // while an entry that never appears must not hold the
                        // session forever.
                        const v2Result = await pollCompactionResultV2({
                            baseUrl,
                            sessionId: acpSessionId,
                            password: v2Rest.password,
                            signal: compactAbortController.signal,
                            expectedCompactionId: admittedId,
                            excludeCompactionIds: admittedId === null ? preExistingIds : null
                        });
                        return { ok: true as const, cancelled: false as const, result: v2Result };
                    });
                }
                this.compactOperationPhase = 'idle';
                if (!v2Outcome.ok) {
                    if (!isCancelled()) {
                        session.sendSessionEvent({ type: 'message', message: `📦 Compaction failed: ${v2Outcome.error}` });
                    } else {
                        logger.debug('[opencode-remote] /compact failure suppressed: cancelled or aborted before it resolved');
                    }
                    return;
                }
                if (v2Outcome.cancelled || isCancelled()) {
                    logger.debug('[opencode-remote] /compact result suppressed: cancelled or aborted before it resolved');
                    return;
                }
                switch (v2Outcome.result.status) {
                    case 'success': {
                        session.client.sendAgentMessage({ type: 'compact-summary', summary: v2Outcome.result.text },
                            v2Outcome.result.compactionId ? opencodeCompactionEventId(acpSessionId, v2Outcome.result.compactionId) : undefined);
                        return;
                    }
                    case 'failed':
                        session.sendSessionEvent({ type: 'message', message: `📦 Compaction failed: ${v2Outcome.result.reason}` });
                        return;
                    case 'unverified':
                        session.sendSessionEvent({ type: 'message', message: '📦 Compaction result could not be verified.' });
                        return;
                }
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
            onMutationIssued?.();
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
                    session.client.sendAgentMessage({ type: 'compact-summary', summary: result.text },
                        result.compactionId ? opencodeCompactionEventId(acpSessionId, result.compactionId) : undefined);
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

    private handleAgentMessage(rawMessage: AgentMessage): void {
        const message = presentQuestionToolCall(rawMessage);
        // v1 ACP strips the native summary/parent metadata (and old versions
        // strip message IDs too). The native transcript owns these text streams.
        if (this.nativeTranscript && this.majorVersion === 'v1' && (message.type === 'text' || message.type === 'reasoning')) return;
        const converted = convertAgentMessage(message, this.currentBackendModel);
        if (converted) {
            this.session.sendAgentMessage(converted);
        }

        switch (message.type) {
            case 'text':
                // Interim idle snapshots; the settled text arrives at the
                // segment boundary, which is what belongs in the local log.
                if (message.live) {
                    break;
                }
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
            case 'round_summary':
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
     * leavingRemote distinguishes plain Stop (false, stays in this remote
     * session) from switch-to-local/exit (true, tears down the session).
     * Compact and a prompt must never mutate the same OpenCode session
     * concurrently. Plain Stop aborts only read-only marker/result GETs. It
     * leaves an in-flight summarize POST running so the dequeue loop waits
     * for its real server-side completion; only that phase can still mutate
     * the shared session. Switch/exit aborts every phase because cleanup()
     * disconnects the ACP subprocess right after.
     */
    private async handleAbort(leavingRemote = false): Promise<void> {
        this.roundSummaryAbortController?.abort();
        // Only abandon metadata when no steer or cancellation still owns work.
        if (
            !leavingRemote
            && this.roundSummaryPhase === 'settle'
            && this.pendingSteerOperations.size === 0
            && this.v2Steers.size === 0
            && !Array.from(this.backendSoftSteerOwnership).some(entry =>
                entry.backend === this.backend && entry.turnEpoch === this.steerTurnEpoch
            )
            && !this.v2AbortInProgress
        ) return;

        // A connection-entry fence denies new work, but must not suppress Stop
        // or teardown of work that was admitted before the fence.
        const release = this.runtimeGate.enterCancellation();
        try {
        if (this.majorVersion !== 'v2') return await this.performAbort(leavingRemote);
        if (this.v2AbortInProgress) {
            // One overlapping Stop/switch owns queue.reset. A later reset
            // must not erase an input the first cancellation just restored.
            if (leavingRemote) {
                this.closeSteerGate({ detachStrandedSteers: true });
                this.compactResultSuppressed = true;
                this.compactAbortController?.abort();
            }
            return await this.v2AbortInProgress;
        }
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const abort = new Promise<void>((ok, failed) => { resolve = ok; reject = failed; });
        this.v2AbortInProgress = abort;
        void this.performAbort(leavingRemote).then(resolve, reject);
        try { await abort; }
        finally { if (this.v2AbortInProgress === abort) this.v2AbortInProgress = null; }
        } finally { release(); }
    }

    private async performAbort(leavingRemote: boolean): Promise<void> {
        let resolveReset!: () => void;
        const resetFinished = new Promise<void>(resolve => { resolveReset = resolve; });
        if (this.majorVersion === 'v2') this.v2ResetInProgress = resetFinished;
        const finishReset = () => {
            if (this.v2ResetInProgress === resetFinished) this.v2ResetInProgress = null;
            resolveReset();
        };
        const v2Cancellations = Array.from(this.v2Steers.values(), entry => entry.cancel('stop', resetFinished));
        let resetDone = false;
        try {
            // Synchronous, before any await: a steer parked on its durable-state
            // await must observe the turn as invalid immediately, so it restores
            // its row instead of injecting into a cancelled turn or a new one.
            this.closeSteerGate({ detachStrandedSteers: true });
            // A plain Stop during an in-flight compact deliberately leaves the
            // operation running for real. Its dequeue-loop finally remains
            // the boundary for thinking=false while the native POST can mutate
            // this session; Stop must not report completion before that boundary.
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
            if (backend && this.session.sessionId
                && (!this.runtimeGate.isBlocked() || this.runtimeGate.hasOrdinaryRuntimeActivity())) {
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
            resetDone = true;
            finishReset();
            await Promise.all(v2Cancellations);
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
        } finally {
            if (!resetDone) for (const entry of this.v2Steers.values()) void entry.cancel('teardown');
            finishReset();
        }
    }

    private async handleExitFromUi(): Promise<void> {
        if (this.runtimeGate.isBlocked() && !this.runtimeGate.isRewindBlocked()) {
            await this.requestExit('exit', () => this.handleAbort(true));
            return;
        }
        const release = this.runtimeGate.enterRuntime();
        try {
        await this.requestExit('exit', () => this.handleAbort(true));
        } finally { release(); }
    }

    private async handleSwitchFromUi(): Promise<void> {
        if (this.runtimeGate.isBlocked() && !this.runtimeGate.isRewindBlocked()) {
            await this.requestExit('switch', () => this.handleAbort(true));
            return;
        }
        const release = this.runtimeGate.enterRuntime();
        try {
        await this.requestExit('switch', () => this.handleAbort(true));
        } finally { release(); }
    }

    private async handleSwitchRequest(): Promise<void> {
        if (this.runtimeGate.isBlocked() && !this.runtimeGate.isRewindBlocked()) {
            await this.requestExit('switch', () => this.handleAbort(true));
            return;
        }
        const release = this.runtimeGate.enterRuntime();
        try {
        await this.requestExit('switch', () => this.handleAbort(true));
        } finally { release(); }
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
