import React from 'react';
import { randomUUID } from 'node:crypto';
import { RPC_METHODS, splitAgyModelSelection } from '@hapi/protocol';
import { logger } from '@/ui/logger';
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay';
import { convertAgentMessage } from '@/agent/messageConverter';
import { GenerationClock } from '@/agent/generationClock';
import { createAcpSessionTitleSync, registerAcpSessionTitleSync } from '@/agent/acpSessionTitle';
import type { AgentMessage, FormElicitationRequest, FormElicitationResponse, PermissionRequest, PromptContent } from '@/agent/types';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import { isAcpIndeterminateError } from '@/agent/backends/acp/AcpStdioTransport';
import { AcpPermissionHandler } from '@/modules/common/permission/AcpPermissionHandler';
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase';
import type { SessionEffort, SessionModel } from '@/api/types';
import type { RawJSONLines } from '@/claude/types';
import type { AgySession } from './session';
import { AGY_BACKGROUND_COMMAND_RESULT, mapAgyToolCall, mapAgyToolResult } from './agyToolCards';
import type { AgyMode, PermissionMode } from './types';
import { createAgyAcpBackend } from './utils/agyAcpBackend';
import {
    AgyWakeWatcher,
    WAKE_WATCHER_DEFAULTS,
    createAgyTranscriptSource,
    createAgyWakeWatch,
    parseAgyBackgroundStart,
    parseAgyTaskCompletion,
    type AgyTranscriptSource,
    type AgyWakeLease,
    type WakeWatcherClose
} from './utils/agyLateContinuation';
import type { AgyTranscriptStep } from './legacyStreamJson/agyTranscript';
import {
    QUESTION_TOOL_NAME,
    agyQuestionContent,
    parseAgyQuestionForm,
    questionCardInput,
    questionCardInputFromToolCall
} from './agyQuestion';

type UsageMessage = Extract<AgentMessage, { type: 'usage' }>;

const STEER_CANCEL_GRACE_MS = 3_000;
const CANCEL_HARD_STOP_MS = 10_000;
// Bound on how long a kill waits for the running turn to settle.
const KILL_SETTLE_MS = 5_000;
const PROMPT_SEND_POLL_MS = 50;
const ECHO_BUFFER_LIMIT = 64 * 1024;

/** `always-proceed` stays in agy's default mode; HAPI answers its requests. */
export function agyAcpModeForPermission(mode: PermissionMode | undefined): string {
    switch (mode) {
        case 'acceptEdits':
            return 'accept-edits';
        case 'plan':
            return 'plan';
        case 'request-review':
        case 'always-proceed':
        case undefined:
            return 'default';
    }
}

/**
 * agy ids carry effort as a suffix (`gemini-3.8-flash-low`) while HAPI stores
 * model and effort separately. No model means agy's default, whose effort can
 * still be chosen.
 */
export function resolveAgyAcpModelId(
    model: SessionModel | undefined,
    effort: SessionEffort | undefined,
    defaultModelId: string | null
): string | null {
    const selected = splitAgyModelSelection(model);
    if (!selected.model) {
        if (!defaultModelId) return null;
        if (!effort) return defaultModelId;
        const base = splitAgyModelSelection(defaultModelId).model ?? defaultModelId;
        return `${base}-${effort}`;
    }
    const value = model!.trim();
    return selected.effort || !effort ? value : `${value}-${effort}`;
}

function addOptional(a: number | undefined, b: number | undefined): number | undefined {
    return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

/** Each request of a steered turn reports only its own share, so they add up. */
export function addAgyUsage(total: UsageMessage | null, next: UsageMessage): UsageMessage {
    if (!total) return next;
    return {
        type: 'usage',
        inputTokens: total.inputTokens + next.inputTokens,
        outputTokens: total.outputTokens + next.outputTokens,
        totalTokens: addOptional(total.totalTokens, next.totalTokens),
        thoughtTokens: addOptional(total.thoughtTokens, next.thoughtTokens),
        cacheReadTokens: addOptional(total.cacheReadTokens, next.cacheReadTokens),
        cacheCreationTokens: addOptional(total.cacheCreationTokens, next.cacheCreationTokens)
    };
}

// agy reports no per-step timing, so generation time is the round minus the
// spans spent running tools or waiting for the user: the shared GenerationClock
// (cli/src/agent/generationClock.ts) is fed the same session updates and
// permission waits it always was.

/** The turn's response-footer record; the web reads `provider: 'agy'` summaries. */
export function agyRoundSummary(
    usage: UsageMessage,
    durationMs: number | null,
    model: string | null,
    generationMs: number | null = null,
    // google-antigravity/antigravity-cli#1045: agy ACP reports no per-prompt turn count; HAPI counts model-call
    // steps (PLANNER_RESPONSE, parallel calls in one step count once) from
    // agy's transcript when the result carries no authoritative num_turns.
    numTurns?: number
) {
    // Thinking is generated too, as in OpenCode's tok/s.
    const generatedTokens = usage.outputTokens + (usage.thoughtTokens ?? 0);
    const generation = generationMs !== null && generationMs > 0 && generatedTokens > 0
        ? { generation_ms: Math.round(generationMs), generation_output_tokens: generatedTokens }
        : {};
    return {
        type: 'round-summary',
        summary: {
            provider: 'agy',
            ...(model ? { model } : {}),
            agy_usage: {
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
                ...(usage.thoughtTokens !== undefined ? { thinking_tokens: usage.thoughtTokens } : {}),
                ...(usage.cacheReadTokens !== undefined ? { cache_read_tokens: usage.cacheReadTokens } : {}),
                ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {})
            },
            ...(durationMs !== null ? { duration_ms: durationMs } : {}),
            ...(numTurns !== undefined && numTurns > 0 ? { num_turns: numTurns } : {}),
            ...generation
        }
    } as const;
}

function normalizeEcho(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/** agy's question tool; its permission request must reach the user. */
export function isAgyQuestionRequest(request: PermissionRequest): boolean {
    const input = request.rawInput as { questions?: unknown } | undefined;
    return Array.isArray(input?.questions) || /\bask_question\b/.test(request.title ?? '');
}

/** agy's ask_question tool call (titled "Run ask_question"), as the question card. */
function asQuestionCard(message: AgentMessage): { message: AgentMessage; shownLabels: string[][] | null } {
    if (message.type !== 'tool_call' || !/\bask_question\b/.test(message.name)) return { message, shownLabels: null };
    const input = questionCardInputFromToolCall(message.input);
    if (!input) return { message, shownLabels: null };
    return {
        message: { ...message, name: QUESTION_TOOL_NAME, input },
        shownLabels: input.questions.map((question) => question.options.map((option) => option.label))
    };
}

/** agy acp did not come up; the caller may fall back to another transport. */
export class AgyAcpStartError extends Error {}

type AgyTurn = {
    modeHash: string;
    aborted: boolean;
    stopReason: string | null;
    sentAt: number | null;
    answeredAt: number | null;
    // Generation timing: tool runs and waits for the user become idle windows
    // the shared clock subtracts from the round.
    generation: GenerationClock;
    // Commands agy has not reported an end for; one still open at end_turn was
    // moved to the background.
    openCommands: Set<string>;
    // The command text (or title) by ACP call id, for the hub's background-task indicator.
    bgTaskDescriptions: Map<string, string>;
    usage: UsageMessage | null;
    // Any agent output proves agy accepted the prompt.
    sawActivity: boolean;
    acknowledge: () => void;
    steers: Promise<void>[];
    // Steers agy may have taken; one put back in the queue no longer counts.
    steersTaken: number;
    // agy's answers to the turn's requests, before HAPI drains late output.
    mainAnswered: Promise<void>;
    answerMain: () => void;
    steerAnswers: Promise<void>[];
    // agy echoes the prompt first, and that echo may contain a steer's text.
    promptEcho: { text: string; echo: string; done: boolean };
    unechoedSteers: Array<{ text: string; echo: string; accept: () => void }>;
    // Steers agy answered without an echo; settled when the turn ends.
    answeredSteers: Array<{ accept: () => void; hold: () => void }>;
    abandonSteers: Array<() => void>;
    releaseSteerWait: () => void;
    steerWaitReleased: Promise<void>;
    // The conversation step idx just below this prompt's own steps: the base
    // for the google-antigravity/antigravity-cli#1045 transcript model-call count. null means the
    // activity probe could not read agy's records at all (distinct from a
    // readable-but-empty conversation, which counts from the first step).
    countBaseIdx: number | null;
    // The prompt result's own turn count when agy reported one (google-antigravity/antigravity-cli#1045).
    numTurns?: number;
    // ACP tool-call ids of commands agy moved to the background; the watcher
    // completes their cards with the real result, leftovers get the
    // placeholder at close.
    bgCompletionIds: string[];
    // Surfaced wake tool calls still awaiting their transcript result (FIFO).
    pendingWakeCalls: string[];
    // Set once a continuation label was emitted for this turn's pre-echo block.
    labeledPreEcho: boolean;
};

/**
 * Antigravity over `agy acp`. The agy conversation id is the ACP session id,
 * so a stored `agySessionId` resumes through `session/resume` without replay.
 */
/**
 * Reliably identified state: the only state readiness, the dequeue hold, and
 * the wake window's lifetime may depend on. Every member is keyed by something
 * HAPI or agy's own records identified (an ACP call id, a native task id), or
 * is a count over transcript facts.
 */
type WakeGatingState = {
    /**
     * ACP-turn background commands outstanding at window start. A completion
     * whose native task id is in the background registry settles one even when
     * the text match used for card delivery fails; a legacy id-less completion
     * falls back to launch order; an id HAPI never saw backgrounded belongs to
     * neither side and decrements nothing.
     */
    openAcpCommands: number;
    /** Native task ids backgrounded during this window, not yet completed. */
    openContinuation: Set<string>;
    /**
     * Surfaced planner calls awaiting a terminal tool step or their native-id
     * completion: a count over transcript facts, with no per-card attribution.
     */
    surfacedOpenCalls: number;
    /** Native task ids already settled once: a duplicate completion decrements nothing. */
    settledTaskIds: Set<string>;
};

/**
 * Display-only pairing: routes results onto cards. It may mispair (FIFO order,
 * command-text matching) and must fail open: an unpaired card is left for the
 * next prompt's flush/label path and never extends the window or holds a
 * prompt.
 */
type WakeCardPairing = {
    /** ACP call ids awaiting their completion's result (card delivery only). */
    bgIds: string[];
    /** Synthetic wake-call cards awaiting results, FIFO. */
    pendingWakeCalls: string[];
    /** Native agy task id -> command text, from agy's own backgrounding records. */
    backgrounding: Map<string, string>;
    /** ACP call id -> command text, for pairing a completion with its call. */
    taskDescriptions: Map<string, string>;
    /** Synthetic wake-call id -> command text, for backgrounding records. */
    wakeCommands: Map<string, string>;
    /** Native task id -> the synthetic wake call that launched it. */
    wakeCallByTask: Map<string, string>;
};

export class AgyAcpRemoteLauncher extends RemoteLauncherBase {
    private readonly session: AgySession;
    private readonly createBackend: () => AcpSdkBackend;
    private readonly steerCancelGraceMs: number;
    private readonly cancelHardStopMs: number;
    private readonly killSettleMs: number;
    private turnSettled: Promise<void> | null = null;
    // Option labels each question card showed, by agy tool call id.
    private readonly questionLabels = new Map<string, string[][]>();
    private backend: AcpSdkBackend | null = null;
    private permissionHandler: AcpPermissionHandler | null = null;
    // agy's own tool name by call id, to map results of the calls it started.
    private readonly nativeToolNames = new Map<string, string>();
    private acpSessionId: string | null = null;
    private abortController = new AbortController();
    /** agy's own model at session start; the target of the "Default" selection. */
    private defaultModelId: string | null = null;
    private currentModelId: string | null = null;
    private turnPermissionMode: PermissionMode | undefined = undefined;
    private turn: AgyTurn | null = null;
    // The turn whose wake window is still running after answerMain: agy keeps
    // generating the wakeup, so Stop must still reach it (session/cancel).
    private continuationTurn: AgyTurn | null = null;
    // The most recent turn whose wake window watched a live continuation: the
    // dequeue hold observes the same generation and owns its cancellation.
    private lastContinuationTurn: AgyTurn | null = null;
    private backendLost = false;
    // Transcript source for the late-continuation watcher; null when agy's
    // records cannot be read (workaround for google-antigravity/antigravity-cli#1461, deleted with it).
    private wakeSource: AgyTranscriptSource | null = null;
    private readonly createWakeSource: (sessionId: string) => AgyTranscriptSource | null;
    private readonly createWakeLease: (sessionId: string) => AgyWakeLease | null;
    private readonly wakeTiming: Required<{
        pollMs: number;
        maxPollMs: number;
        quietMs: number;
        capMs: number;
        preEchoWindowMs: number;
    }>;
    private wakeWatcher: AgyWakeWatcher | null = null;
    private wakeIdCounter = 0;
    // Conversation idx through which every step is accounted for: either it
    // went over ACP during a turn, or the watcher surfaced it. The dequeue
    // hold and the drop-mode validity check both read this watermark.
    private accountedIdx: number | null = null;
    // How to treat the next prompt's pre-echo block: 'drop' after a fully
    // surfaced quiet close (agy re-sends what we already showed), 'label' to
    // attribute it to the previous turn instead (cap, restart, disabled).
    private continuationMode: 'drop' | 'label' = 'label';
    // Set once agy delivers session/update frames while no prompt is active:
    // the google-antigravity/antigravity-cli#1461 behavior is fixed upstream, so the transcript paths stand down.
    private acpEmitsIdleUpdates = false;
    // Commands agy moved to the background and has not reported back yet, by
    // ACP call id, with the description the hub's background-task indicator
    // shows. Full snapshots go out on every membership change.
    private readonly activeBgTasks = new Map<string, string>();
    private lastBgSnapshotIds: string[] = [];

    constructor(session: AgySession, opts: {
        createBackend?: () => AcpSdkBackend;
        steerCancelGraceMs?: number;
        cancelHardStopMs?: number;
        killSettleMs?: number;
        createWakeSource?: (sessionId: string) => AgyTranscriptSource | null;
        createWakeLease?: (sessionId: string) => AgyWakeLease | null;
        wakeTiming?: { pollMs?: number; maxPollMs?: number; quietMs?: number; capMs?: number; preEchoWindowMs?: number };
    } = {}) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.createBackend = opts.createBackend ?? createAgyAcpBackend;
        this.steerCancelGraceMs = opts.steerCancelGraceMs ?? STEER_CANCEL_GRACE_MS;
        this.cancelHardStopMs = opts.cancelHardStopMs ?? CANCEL_HARD_STOP_MS;
        this.killSettleMs = opts.killSettleMs ?? KILL_SETTLE_MS;
        this.createWakeSource = opts.createWakeSource ?? ((sessionId) => createAgyTranscriptSource(sessionId));
        this.createWakeLease = opts.createWakeLease ?? ((sessionId) => createAgyWakeWatch(sessionId));
        this.wakeTiming = {
            pollMs: opts.wakeTiming?.pollMs ?? WAKE_WATCHER_DEFAULTS.pollMs,
            maxPollMs: opts.wakeTiming?.maxPollMs ?? WAKE_WATCHER_DEFAULTS.maxPollMs,
            quietMs: opts.wakeTiming?.quietMs ?? WAKE_WATCHER_DEFAULTS.quietMs,
            capMs: opts.wakeTiming?.capMs ?? WAKE_WATCHER_DEFAULTS.capMs,
            preEchoWindowMs: opts.wakeTiming?.preEchoWindowMs ?? 10_000
        };
        this.session.setKillHandler(() => this.handleKill());
    }

    async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({ onExit: () => this.handleExitFromUi() });
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, { ...context, agentLabel: 'Antigravity' });
    }

    protected getCurrentSessionId(): string | null {
        return this.acpSessionId;
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        session.client.updateAgentState((state) => ({ ...state, steeringActive: false }));
        this.messageBuffer.addMessage(
            session.sessionId ? 'Resuming agy session...' : 'Starting agy session...',
            'status'
        );
        // Steering keys on this marker; published before agy starts, it reaches
        // the hub before any turn can take a steer.
        session.client.updateMetadata((metadata) => ({ ...metadata, agyProtocol: 'acp' }));
        session.client.rpcHandlerManager.registerHandler(
            RPC_METHODS.SteerQueuedMessage,
            async (payload: unknown) => await this.handleSteer(payload)
        );
        try {
            await this.startBackend(session.sessionId);
        } catch (error) {
            // A kill during start-up is not a start failure.
            if (this.shouldExit) return;
            // Otherwise the session only ends as crashed, without the reason
            // (agy not signed in, an agy release without `acp`, ...).
            const message = describeAgyStartFailure(error);
            this.reportTurnError(message);
            throw new AgyAcpStartError(message);
        }

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            // AGY is remote-only: a web-initiated switch to local has no target.
            onSwitch: () => {}
        });

        while (!this.shouldExit) {
            // Stop replaces the controller, so check the signal this wait used.
            const signal = this.abortController.signal;
            const batch = await session.queue.waitForMessagesAndGetAsString(signal);
            if (!batch) {
                if (signal.aborted && !this.shouldExit) continue;
                break;
            }
            // Hold (bounded by the watcher cap) while unseen continuation steps
            // are still arriving: with the prompt held back, agy cannot fold it
            // into the running wakeup turn, and the watcher surfaces those
            // steps before the user's message lands in the thread.
            if (!this.acpEmitsIdleUpdates && this.wakeSource && this.accountedIdx !== null && !this.wakeWatcher) {
                const latest = await this.wakeSource.latestStepIdx().catch(() => null);
                if (latest !== null && latest > this.accountedIdx) {
                    session.sendSessionEvent({
                        type: 'message',
                        message: 'Antigravity continued working on its own; showing that before running the new message.'
                    });
                    // The unseen work is agy still generating the last
                    // continuation: Stop must reach it, and thinking must not
                    // outlive the hold.
                    this.continuationTurn = this.lastContinuationTurn;
                    try {
                        const close = await this.runWakeWindow({
                            bgIds: [],
                            signal,
                            accountedIdx: this.accountedIdx,
                            turnBaseIdx: this.accountedIdx,
                            baselineIdx: this.accountedIdx,
                            taskDescriptions: new Map()
                        });
                        this.continuationMode = close.reason === 'quiet' && close.surfacedFully ? 'drop' : 'label';
                    } finally {
                        this.continuationTurn = null;
                        this.session.onThinkingChange(false);
                    }
                }
            }
            // Stop or exit during the hold: the captured signal no longer
            // governs runTurn (Stop replaces the controller), so the held
            // batch must not dispatch on the fresh one. Acknowledge the
            // delivery and hand the text back to the composer, matching the
            // cancelled-prompt restore path.
            if (signal.aborted || this.shouldExit) {
                const heldIds = batch.items
                    .map((item) => item.localId)
                    .filter((localId): localId is string => Boolean(localId));
                if (heldIds.length > 0) session.client.emitMessagesConsumed(heldIds);
                session.sendSessionEvent({ type: 'abort-restore', text: batch.message });
                if (this.shouldExit) break;
                continue;
            }
            const localIds = batch.items
                .map((item) => item.localId)
                .filter((localId): localId is string => Boolean(localId));
            const turnRun = this.runTurn(batch.message, batch.mode, batch.hash, localIds);
            this.turnSettled = turnRun.then(() => {}, () => {});
            await turnRun;
        }
    }

    private async startBackend(resumeSessionId: string | null): Promise<void> {
        const session = this.session;
        const backend = this.createBackend();
        this.backend = backend;
        this.backendLost = false;
        try {
            const titleSync = createAcpSessionTitleSync(session.client);
            registerAcpSessionTitleSync(backend, session.client, titleSync);
            backend.setUserMessageChunkListener((text) => this.handleUserEcho(text));
            backend.onStderrError((error) => {
                logger.debug('[agy-acp] stderr error', error);
                session.sendSessionEvent({ type: 'message', message: error.message });
                this.messageBuffer.addMessage(error.message, 'status');
            });

            await backend.initialize();

            let acpSessionId: string | null = null;
            if (resumeSessionId) {
                try {
                    if (!backend.supportsSessionResume()) {
                        throw new Error('agy acp does not advertise session/resume');
                    }
                    acpSessionId = await backend.resumeSession({
                        sessionId: resumeSessionId,
                        cwd: session.path,
                        mcpServers: []
                    });
                } catch (error) {
                    logger.warn('[agy-acp] resume failed, starting a new conversation', error);
                    session.sendSessionEvent({
                        type: 'message',
                        message: 'Antigravity could not resume the conversation; starting a new one.'
                    });
                }
            }
            if (!acpSessionId) {
                acpSessionId = await backend.newSession({ cwd: session.path, mcpServers: [] });
            }
            this.acpSessionId = acpSessionId;
            session.onSessionFound(acpSessionId);
            session.client.emitSessionReady();
            this.wakeSource = this.createWakeSource(acpSessionId);

            const reported = backend.getSessionModelsMetadata(acpSessionId)?.currentModelId ?? null;
            this.currentModelId = reported;
            // After a relaunch the resumed conversation reports the switched
            // model, not agy's default, so keep the first value.
            if (this.defaultModelId === null) this.defaultModelId = reported;

            this.permissionHandler = new AcpPermissionHandler(
                session.client,
                backend,
                () => this.turnPermissionMode ?? (session.getPermissionMode() as PermissionMode | undefined),
                {
                    // agy titles run_command requests with the command line and
                    // gets no HAPI MCP tools, so the tool-name hints could only
                    // match command text.
                    autoApprovalRules: { alwaysToolNameHints: [], alwaysToolIdHints: [] },
                    autoApproveOnce: true,
                    requiresUser: isAgyQuestionRequest,
                    onUserWait: () => {
                        const turn = this.turn;
                        if (!turn) return () => {};
                        return turn.generation.beginUserWait();
                    }
                }
            );
            backend.onFormElicitation((request) => this.handleQuestion(request));
            void backend.refreshSessionInfo(acpSessionId, session.path);
        } catch (error) {
            // A half-started process must not serve later turns; the next turn
            // starts agy again and resumes the previous conversation.
            this.backendLost = true;
            if (this.backend === backend) this.backend = null;
            await this.retireBackend(backend);
            throw error;
        }
    }

    private async relaunchBackend(): Promise<void> {
        const previous = this.backend;
        this.backend = null;
        if (previous) await this.retireBackend(previous);
        await this.startBackend(this.acpSessionId);
    }

    /** Stops a backend for good: late permission requests are cancelled, not approved. */
    private async retireBackend(backend: AcpSdkBackend): Promise<void> {
        backend.onPermissionRequest((request) => {
            void backend.respondToPermission(request.sessionId, request, { outcome: 'cancelled' });
        });
        // Its late questions must not open cards in the next process's session.
        backend.onFormElicitation(async () => ({ action: 'cancel' }));
        const handler = this.permissionHandler;
        this.permissionHandler = null;
        await handler?.cancelAll('Antigravity stopped');
        try {
            await backend.disconnect();
        } catch (error) {
            logger.debug('[agy-acp] disconnect failed', error);
        }
    }

    /** Apply the batch's mode and model; false when the turn must not run. */
    private async applyTurnConfig(backend: AcpSdkBackend, acpSessionId: string, mode: AgyMode): Promise<boolean> {
        // Sent every turn: agy can change its mode on its own (current_mode_update),
        // which HAPI does not track.
        const acpMode = agyAcpModeForPermission(mode.permissionMode);
        try {
            await backend.setMode(acpSessionId, acpMode);
        } catch (error) {
            this.reportTurnError(`Failed to switch Antigravity mode: ${errorMessage(error)}`);
            return false;
        }

        const modelId = resolveAgyAcpModelId(mode.model, mode.effort, this.defaultModelId);
        if (modelId && modelId !== this.currentModelId) {
            try {
                await backend.setModel(acpSessionId, modelId);
                this.currentModelId = modelId;
                this.messageBuffer.addMessage(`[MODEL:${modelId}]`, 'system');
            } catch (error) {
                this.reportTurnError(`Failed to switch Antigravity model to ${modelId}: ${errorMessage(error)}`);
                return false;
            }
        }
        return true;
    }

    private async runTurn(message: string, mode: AgyMode, modeHash: string, localIds: string[]): Promise<void> {
        const session = this.session;
        session.onThinkingChange(true);
        this.turnPermissionMode = mode.permissionMode;
        let releaseSteerWait!: () => void;
        const steerWaitReleased = new Promise<void>((resolve) => { releaseSteerWait = resolve; });
        let acknowledged = false;
        let answerMain!: () => void;
        const mainAnswered = new Promise<void>((resolve) => { answerMain = resolve; });
        const turn: AgyTurn = {
            modeHash,
            aborted: false,
            stopReason: null,
            sentAt: null,
            answeredAt: null,
            generation: new GenerationClock(),
            openCommands: new Set(),
            bgTaskDescriptions: new Map(),
            usage: null,
            sawActivity: false,
            // AgySession does not acknowledge on dequeue: a message counts as
            // delivered once agy takes it (echo, output, or answer), or when
            // it goes back to the composer.
            acknowledge: () => {
                if (acknowledged || localIds.length === 0) return;
                acknowledged = true;
                session.client.emitMessagesConsumed(localIds);
            },
            steers: [],
            steersTaken: 0,
            mainAnswered,
            answerMain,
            steerAnswers: [],
            promptEcho: { text: normalizeEcho(message), echo: '', done: false },
            unechoedSteers: [],
            answeredSteers: [],
            abandonSteers: [],
            releaseSteerWait,
            steerWaitReleased,
            countBaseIdx: null,
            bgCompletionIds: [],
            pendingWakeCalls: [],
            labeledPreEcho: false
        };
        // Registered before any await so Stop can reach the turn while agy
        // restarts or switches settings.
        this.turn = turn;
        try {
            if (this.backendLost || !this.backend || !this.backend.isTransportAlive()) {
                try {
                    await this.relaunchBackend();
                } catch (error) {
                    this.reportTurnError(`Failed to restart Antigravity: ${errorMessage(error)}`);
                    this.restorePrompt(turn, message);
                    return;
                }
            }
            const backend = this.backend;
            const acpSessionId = this.acpSessionId;
            if (!backend || !acpSessionId || turn.aborted) {
                this.restorePrompt(turn, message);
                return;
            }
            if (!await this.applyTurnConfig(backend, acpSessionId, mode) || turn.aborted) {
                this.restorePrompt(turn, message);
                return;
            }
            // Snapshot the conversation watermark before agy sees the prompt:
            // every PLANNER_RESPONSE step above it belongs to this round, and
            // the google-antigravity/antigravity-cli#1045 count adds the late-continuation calls on top.
            const probed = await this.wakeSource?.latestStepIdx().catch(() => null) ?? null;
            if (probed !== null) {
                turn.countBaseIdx = probed;
            } else {
                // A null watermark is ambiguous: agy's records are unreadable,
                // or the conversation is brand-new. Counting from zero is only
                // sound for the latter; resuming the whole history would
                // inflate the footer (google-antigravity/antigravity-cli#1045 review).
                const probe = this.wakeSource
                    ? await this.wakeSource.countPlannerSteps(-1).catch(() => null)
                    : null;
                turn.countBaseIdx = probe === 0 ? -1 : null;
            }
            // The drop mode is only safe while everything up to now is
            // accounted for; steps that appeared after the last watcher close
            // are unaccounted and must be labeled instead.
            if (this.continuationMode === 'drop' && this.wakeSource && this.accountedIdx !== null) {
                const latest = await this.wakeSource.latestStepIdx().catch(() => null);
                if (latest !== null && latest > this.accountedIdx) this.continuationMode = 'label';
            }
            this.messageBuffer.addMessage(message, 'user');
            const prompt: PromptContent[] = [{ type: 'text', text: message }];
            session.client.updateAgentState((state) => ({ ...state, steeringActive: true }));
            try {
                await backend.prompt(acpSessionId, prompt, (update) => this.handleTurnUpdate(turn, update), {
                    onSent: () => { turn.sentAt = Date.now(); },
                    onAnswered: () => {
                        turn.answeredAt = Date.now();
                        turn.answerMain();
                    }
                });
                // agy answers a cancel with a normal `cancelled` result; with no
                // output yet, the prompt goes back to the composer.
                if (turn.stopReason === 'cancelled' && !turn.sawActivity && turn.steersTaken === 0) {
                    this.restorePrompt(turn, message);
                } else {
                    turn.acknowledge();
                }
            } catch (error) {
                logger.warn('[agy-acp] prompt failed', error);
                if (isAcpIndeterminateError(error)) this.backendLost = true;
                if (!turn.aborted) {
                    this.reportTurnError(`Antigravity prompt failed: ${errorMessage(error)}`);
                }
                if (!turn.sawActivity && turn.steersTaken === 0) this.restorePrompt(turn, message);
                else turn.acknowledge();
            }
            // A steer makes agy answer the request it interrupts right away
            // (end_turn) while the turn goes on under the steer, so the turn
            // ends only when every open request has settled. Steers sent
            // during this wait extend it.
            await this.waitForSteers(turn);
            // agy sends nothing more for a command it moved to the background:
            // its completion arrives as the wakeup's SYSTEM_MESSAGE step (read
            // by the late-continuation watcher) or, when the watcher cannot
            // run, inside a later prompt's stream. Hand the open ACP call ids
            // to the watcher; whatever it never completes gets the placeholder
            // at close.
            if (turn.stopReason === 'end_turn' && !turn.aborted && !this.backendLost) {
                turn.bgCompletionIds = [...turn.openCommands];
                // The background-task indicator mirrors the watcher's card
                // completions: register every command agy left open at
                // end_turn so the hub shows it running until its result lands.
                for (const id of turn.bgCompletionIds) {
                    const description = turn.bgTaskDescriptions.get(id);
                    if (description !== undefined) this.activeBgTasks.set(id, description);
                }
                if (turn.bgCompletionIds.length > 0) this.emitBackgroundTasksSnapshot();
            }
            turn.openCommands.clear();
        } finally {
            this.questionLabels.clear();
            // After a Stop or a lost agy process, agy may have dropped a steer
            // it had not echoed yet.
            const endedCleanly = !turn.aborted && !this.backendLost;
            for (const steer of turn.answeredSteers) {
                if (endedCleanly) steer.accept();
                else steer.hold();
            }
            turn.answerMain();
            if (this.turn === turn) this.turn = null;
            session.client.updateAgentState((state) => ({ ...state, steeringActive: false }));
            this.turnPermissionMode = undefined;

            // Late continuation (workaround for google-antigravity/antigravity-cli#1461): while agy's brain loop
            // keeps working after the end_turn (background task finished),
            // surface its steps live and hold the round footer until it
            // settles, so the summary can include the wakeup's model calls.
            const watcherEligible = endedCleanly
                && turn.stopReason === 'end_turn'
                && turn.bgCompletionIds.length > 0
                && !this.acpEmitsIdleUpdates;
            let watcherClose: WakeWatcherClose | null = null;
            if (watcherEligible && this.wakeSource) {
                // agy is still generating the wakeup; keep it cancellable while
                // the window observes, so Stop reaches it via session/cancel.
                this.lastContinuationTurn = turn;
                this.continuationTurn = turn;
                try {
                    watcherClose = await this.runWakeWindow({
                        bgIds: turn.bgCompletionIds,
                        signal: this.abortController.signal,
                        accountedIdx: this.accountedIdx ?? -1,
                        turnBaseIdx: turn.countBaseIdx ?? this.accountedIdx ?? -1,
                        taskDescriptions: turn.bgTaskDescriptions
                    });
                } finally {
                    this.continuationTurn = null;
                }
            }
            if (watcherClose) {
                this.continuationMode = watcherClose.reason === 'quiet' && watcherClose.surfacedFully
                    ? 'drop'
                    : 'label';
                // The flushed block may carry the background command's real
                // completion: those frames pass the drop gate so the card ends
                // with the actual result, whatever the placeholder showed.
                for (const id of turn.bgCompletionIds) this.continuationCardIds.add(id);
            } else {
                // No watcher ran: the turn's own steps all went over ACP, so
                // they are accounted for up to the newest known step.
                const latest = this.wakeSource
                    ? await this.wakeSource.latestStepIdx().catch(() => null)
                    : null;
                if (latest !== null && latest !== undefined) {
                    this.accountedIdx = Math.max(this.accountedIdx ?? -1, latest);
                }
            }
            // Commands the watcher never completed keep today's placeholder, so
            // the card does not spin until agy flushes the real result.
            if (turn.stopReason === 'end_turn' && !turn.aborted && !this.backendLost) {
                for (const id of turn.bgCompletionIds) {
                    const placeholder = convertAgentMessage(
                        { type: 'tool_result', id, output: AGY_BACKGROUND_COMMAND_RESULT, status: 'completed' },
                        this.currentModelId
                    );
                    if (placeholder) this.session.sendAgentMessage(placeholder);
                }
                turn.bgCompletionIds = [];
            }
            // agy's usage adds up every model call of a request, so it is not a
            // context size: it goes to the response footer, not the context
            // indicator (no token_count).
            if (turn.usage) {
                // agy's own time: HAPI's waits before sending and for late
                // output are not part of it.
                const durationMs = turn.sentAt !== null && turn.answeredAt !== null
                    ? Math.max(0, turn.answeredAt - turn.sentAt)
                    : null;
                const generationMs = turn.generation.generationMs(turn.sentAt, turn.answeredAt);
                // google-antigravity/antigravity-cli#1045: agy reports no num_turns; the authoritative value wins
                // when present, otherwise count model-call steps from agy's
                // transcript (this prompt's plus the late continuation's).
                const numTurns = turn.numTurns
                    ?? (this.wakeSource
                        ? turn.countBaseIdx === null
                            ? null
                            : await this.wakeSource.countPlannerSteps(turn.countBaseIdx).catch(() => null)
                        : null)
                    ?? undefined;
                session.sendAgentMessage(agyRoundSummary(turn.usage, durationMs, this.currentModelId, generationMs, numTurns));
            }
            session.onThinkingChange(false);
            await this.permissionHandler?.cancelAll('Prompt finished');
            if (session.queue.size() === 0 && !this.shouldExit) {
                session.sendSessionEvent({ type: 'ready' });
            }
        }
    }

    private async waitForSteers(turn: AgyTurn): Promise<void> {
        while (turn.steers.length > 0) {
            const pending = [...turn.steers];
            const released = await Promise.race([
                Promise.allSettled(pending).then(() => false),
                turn.steerWaitReleased.then(() => true)
            ]);
            if (released) return;
            turn.steers = turn.steers.filter((steer) => !pending.includes(steer));
        }
    }

    /**
     * The hub RPC is answered once the steer request is written: the request
     * itself only completes with the turn, past the hub's RPC timeout.
     */
    private async handleSteer(payload: unknown): Promise<{ steered: boolean; error?: string }> {
        const session = this.session;
        const localId = typeof (payload as { localId?: unknown } | null)?.localId === 'string'
            ? (payload as { localId: string }).localId
            : '';
        if (!localId) return { steered: false, error: 'Missing localId' };
        const backend = this.backend;
        const acpSessionId = this.acpSessionId;
        const turn = this.turn;
        if (!turn || turn.aborted || !backend || !acpSessionId || this.shouldExit) {
            return { steered: false, error: 'No active steerable turn' };
        }
        // agy rejects a prompt while an approval or a question is open.
        if (this.permissionHandler?.hasPendingRequests()) {
            return { steered: false, error: 'Antigravity is waiting for your approval or answer; respond to it, then steer' };
        }
        const taken = session.queue.takeByLocalId(localId);
        if (!taken) return { steered: false, error: 'Message not in queue' };
        if (taken.item.isolate) {
            session.queue.restoreReservation(taken);
            return { steered: false, error: 'Control commands cannot be steered' };
        }
        if (taken.item.modeHash !== turn.modeHash) {
            session.queue.restoreReservation(taken);
            return { steered: false, error: 'Queued message mode differs from the active turn' };
        }
        if (!session.queue.beginReservationDispatch(taken)) {
            return { steered: false, error: 'Steer cancelled' };
        }
        if (!await session.client.setSteerDeliveryState([localId], 'dispatching')) {
            session.queue.markReservationIndeterminate(taken);
            session.client.emitSteerIndeterminate([localId]);
            return { steered: false, error: 'Steer state is indeterminate' };
        }
        let resolved = false;
        let steerCounted = false;
        let forgetEcho = () => {};
        const markIndeterminate = () => {
            if (resolved) return;
            resolved = true;
            forgetEcho();
            if (session.queue.markReservationIndeterminate(taken)) {
                session.client.emitSteerIndeterminate([localId]);
            }
        };
        const restoreQueued = async (): Promise<void> => {
            if (resolved) return;
            resolved = true;
            forgetEcho();
            if (steerCounted) {
                steerCounted = false;
                turn.steersTaken -= 1;
            }
            if (!taken.originIndeterminate
                && !await session.client.setSteerDeliveryState([localId], 'queued')) {
                if (session.queue.markReservationIndeterminate(taken)) {
                    session.client.emitSteerIndeterminate([localId]);
                }
                return;
            }
            if (taken.state !== 'dispatching' || !session.queue.restoreReservation(taken)) {
                session.client.emitSteerIndeterminate([localId]);
            }
        };
        if (taken.state !== 'dispatching') {
            session.client.emitSteerIndeterminate([localId]);
            return { steered: false, error: 'Steer cancelled' };
        }
        if (this.turn !== turn || this.backend !== backend || turn.aborted) {
            await restoreQueued();
            return { steered: false, error: 'Active turn changed' };
        }
        // An approval or a question may have opened while the hub answered.
        if (this.permissionHandler?.hasPendingRequests()) {
            await restoreQueued();
            return { steered: false, error: 'Antigravity is waiting for your approval or answer; respond to it, then steer' };
        }

        let steer: ReturnType<AcpSdkBackend['beginSoftSteerPrompt']>;
        try {
            steer = backend.beginSoftSteerPrompt(
                acpSessionId,
                [{ type: 'text', text: taken.item.message }],
                {
                    onUsage: (usage) => {
                        // Answered after its turn ended: the turn's summary is already
                        // out, and a second one would read as another turn.
                        if (this.turn !== turn) return;
                        turn.usage = addAgyUsage(turn.usage, usage);
                    }
                }
            );
        } catch (error) {
            if (isAcpIndeterminateError(error)) {
                markIndeterminate();
                return { steered: false, error: 'Steer outcome is being reconciled' };
            }
            // No open request to fold into (the turn just ended): keep it queued.
            logger.debug('[agy-acp] steer could not start', error);
            await restoreQueued();
            return { steered: false, error: 'Failed to steer into the active turn' };
        }
        // Register before awaiting dispatch so the turn cannot end in between.
        const settled = Promise.all([steer.dispatched, steer.completed]).then(() => {}, () => {});
        turn.steers.push(settled);
        turn.steersTaken += 1;
        steerCounted = true;
        turn.steerAnswers.push(steer.answered.then(() => {
            if (this.turn === turn) turn.answeredAt = Date.now();
        }));
        // agy echoes a steer (user_message_chunk) when it folds it into the
        // turn, which is the moment it belongs in the transcript; the request
        // itself is only answered when the turn ends.
        const accept = () => {
            if (resolved) return;
            resolved = true;
            forgetEcho();
            session.queue.commitReservation(taken);
            this.messageBuffer.addMessage(taken.item.message, 'user');
            session.client.emitMessagesConsumed([localId], { steered: true });
        };
        forgetEcho = () => {
            turn.unechoedSteers = turn.unechoedSteers.filter((entry) => entry.accept !== accept);
        };
        turn.unechoedSteers.push({ text: normalizeEcho(taken.item.message), echo: '', accept });
        turn.abandonSteers.push(markIndeterminate);

        try {
            await steer.dispatched;
        } catch (error) {
            if (isAcpIndeterminateError(error)) {
                markIndeterminate();
                return { steered: false, error: 'Steer outcome is being reconciled' };
            }
            await restoreQueued();
            return { steered: false, error: 'Failed to steer into the active turn' };
        }

        void steer.completed.then((stopReason) => {
            // Stop answers an open steer with `cancelled`; without the echo,
            // agy may or may not have folded it in, so hold it for an
            // explicit Retry/Cancel.
            if (stopReason === 'cancelled') {
                markIndeterminate();
                return;
            }
            // A later steer makes agy answer this one's request at once, before
            // agy folds it in, so an answer alone is not delivery: without an
            // echo, it counts only once the turn ends cleanly.
            if (this.turn === turn) turn.answeredSteers.push({ accept, hold: markIndeterminate });
            else accept();
        }, (error) => {
            if (isAcpIndeterminateError(error)) {
                if (this.turn === turn) this.backendLost = true;
                markIndeterminate();
                return;
            }
            // An explicit JSON-RPC error: agy never took the message.
            void restoreQueued();
        });
        return { steered: true };
    }

    /**
     * Runs one late-continuation window: watches agy's records via the
     * watcher — event-driven (fs.watch on the conversations DB) with a
     * backoff poll fallback — and surfaces new steps as a continuation of the
     * turn that just ended. Thinking follows the wakeup's activity; the close
     * record tells the caller whether its own surfacing covers agy's
     * next-prompt flush. While background completions are unseen the window
     * stays armed (the safety cap bounds a task that never reports); the
     * quiet window ends an active wakeup after they are seen.
     */
    private async runWakeWindow(opts: {
        bgIds: string[];
        signal?: AbortSignal;
        /** Watermark below which everything is already accounted for. */
        accountedIdx: number;
        /** The prompt turn's own steps end at this idx; wakeup steps start after the turn's last one. */
        turnBaseIdx: number;
        /** Overrides the baseline sample (the dequeue hold re-watches from its watermark). */
        baselineIdx?: number;
        /** ACP call id -> command text, for pairing completions with their calls. */
        taskDescriptions: Map<string, string>;
    }): Promise<WakeWatcherClose> {
        const source = this.wakeSource;
        if (!source) throw new Error('wake source unavailable');
        const baseline = opts.baselineIdx ?? await source.latestStepIdx().catch(() => null);
        if (baseline === null || baseline < 0) {
            return { reason: 'error', surfacedThroughIdx: null, latestSeenIdx: null, surfacedFully: false, steps: 0 };
        }
        const gating: WakeGatingState = {
            openAcpCommands: opts.bgIds.length,
            openContinuation: new Set(),
            surfacedOpenCalls: 0,
            settledTaskIds: new Set()
        };
        const pairing: WakeCardPairing = {
            bgIds: opts.bgIds,
            pendingWakeCalls: [],
            backgrounding: new Map(),
            taskDescriptions: opts.taskDescriptions,
            wakeCommands: new Map(),
            wakeCallByTask: new Map()
        };
        const surface = (step: AgyTranscriptStep): void => this.surfaceWakeStep(step, gating, pairing);
        // Window-scoped lease: one persistent readonly DB connection for fast
        // progress probes plus the fs.watch event wait; closed with the window.
        const lease = this.acpSessionId ? this.createWakeLease(this.acpSessionId) : null;
        const windowSource: AgyTranscriptSource = lease
            ? {
                readNewSteps: () => source.readNewSteps(),
                readStepsSince: (since) => source.readStepsSince(since),
                latestStepIdx: () => lease.latestStepIdx(),
                countPlannerSteps: (since) => source.countPlannerSteps(since)
            }
            : source;

        try {
            // A wakeup that raced the prompt's drain window already wrote its steps
            // to the transcript before this window started (the ACP fence closed
            // mid-wakeup, so its frames are still pending). Surface them right away
            // instead of polling a transcript that will never grow: scan the turn's
            // own range for the first background-completion SYSTEM step — everything
            // from there on belongs to the wakeup.
            // One stateless read answers both questions: the raced backlog and
            // how far the transcript has actually parsed. The DB can lead the
            // JSONL (its row lands before the transcript line is written or
            // parsed), so the watcher must not skip steps the transcript has
            // not parsed yet: a completion recorded at DB idx N while the
            // JSONL ends at N-1 would otherwise be discarded by the live
            // filter when the line catches up.
            const parsed = await source.readStepsSince(-1).catch(() => [] as AgyTranscriptStep[]);
            const transcriptCoverage = parsed.reduce((max, step) => Math.max(max, step.idx), -1);
            const backlog = parsed.filter((step) => step.idx > Math.max(opts.accountedIdx, opts.turnBaseIdx) && step.idx <= baseline);
            let racedThroughIdx: number | null = null;
            // agy's own backgrounding records pair completions with their
            // original ACP calls by task id: seed the map from the backlog
            // unconditionally — both the turn's own records (pre-baseline) and
            // any that landed with the raced wakeup.
            for (const step of backlog) {
                if (step.kind === 'tool' && step.status === 'running') {
                    const backgrounded = parseAgyBackgroundStart(step.content);
                    if (backgrounded) pairing.backgrounding.set(backgrounded.taskId, backgrounded.description);
                }
            }
            // The turn's outstanding commands: a completion for one of them
            // has not been delivered yet. Text compared whitespace-normalized,
            // like the live pairing.
            const isOutstandingCommand = (description: string): boolean =>
                opts.bgIds.some((id) => sameCommandText(opts.taskDescriptions.get(id) ?? '', description));
            const racedAt = backlog.find((step) => {
                if (step.kind !== 'system') return false;
                const completion = parseAgyTaskCompletion(step.content);
                if (!completion) return false;
                if (completion.taskId === null) return true; // no identity: keep the first-completion behavior
                // A completion for a command that is no longer outstanding was
                // already delivered over ACP; replaying from it would duplicate
                // the frames the turn rendered live.
                const description = pairing.backgrounding.get(completion.taskId);
                return description === undefined || isOutstandingCommand(description);
            });
            if (racedAt) {
                for (const step of backlog) {
                    if (step.idx < racedAt.idx) continue;
                    surface(step);
                }
                // The raced surfacing is not the end of the wakeup — further
                // planner steps may still land. Account for the backlog here and
                // keep watching below; the normal quiet/open-command conditions
                // settle the window.
                racedThroughIdx = backlog.reduce((max, step) => Math.max(max, step.idx), -1);
                this.accountedIdx = Math.max(this.accountedIdx ?? -1, racedThroughIdx);
            }

            const watcher = new AgyWakeWatcher({
                source: windowSource,
                // Skip only what the transcript had already parsed at window
                // start: a step between that coverage and the DB baseline must
                // surface when its line catches up, not fall through both the
                // scan and the live filter.
                baselineIdx: transcriptCoverage >= 0 ? Math.min(baseline, transcriptCoverage) : baseline,
                pollMs: this.wakeTiming.pollMs,
                maxPollMs: this.wakeTiming.maxPollMs,
                quietMs: this.wakeTiming.quietMs,
                capMs: this.wakeTiming.capMs,
                waitForChange: lease?.waitForChange,
                // Live work: the original commands, a surfaced continuation
                // tool call awaiting its result, and commands the continuation
                // backgrounded itself — all bound by the safety cap.
                hasOpenBackgroundCommands: () => gating.openAcpCommands > 0
                    || gating.openContinuation.size > 0
                    || gating.surfacedOpenCalls > 0,
                onStep: surface,
                onActivity: () => this.session.onThinkingChange(true)
            });
            this.wakeWatcher = watcher;
            watcher.start();
            const close = await watcher.waitForSettle(opts.signal);
            this.wakeWatcher = null;
            // Synthetic cards the pairing never completed fail open: give them
            // the placeholder the ACP cards get at close, so they do not spin
            // after the window is gone.
            for (const wakeId of pairing.pendingWakeCalls) {
                const placeholder = convertAgentMessage(
                    { type: 'tool_result', id: wakeId, output: AGY_BACKGROUND_COMMAND_RESULT, status: 'completed' },
                    this.currentModelId
                );
                if (placeholder) this.session.sendAgentMessage(placeholder);
            }
            pairing.pendingWakeCalls.length = 0;
            // The watcher only surfaces post-baseline steps; a raced backlog
            // surfaced above counts toward the close record, so a fully
            // surfaced window (backlog + watch) still reads as drop-mode.
            if (racedThroughIdx !== null) {
                const through = Math.max(close.surfacedThroughIdx ?? -1, racedThroughIdx);
                close.surfacedThroughIdx = through;
                close.surfacedFully = close.latestSeenIdx !== null && through >= close.latestSeenIdx;
            }
            this.noteWakeAccounted(close);
            return close;
        } finally {
            lease?.close();
        }
    }

    /**
     * Folds a watcher close into the accounting watermark: a fully surfaced
     * close accounts for everything the sources know; otherwise only what was
     * actually surfaced, so the dequeue hold re-watches the rest.
     */
    private noteWakeAccounted(close: WakeWatcherClose): void {
        const idx = close.surfacedFully ? close.latestSeenIdx : close.surfacedThroughIdx;
        if (idx === null) return;
        this.accountedIdx = Math.max(this.accountedIdx ?? -1, idx);
    }

    /**
     * Maps one brain-transcript step onto the canonical rows the rest of the
     * ACP thread speaks. Background-task completions (SYSTEM_MESSAGE) close
     * the original ACP tool card; wakeup tool calls and their results pair FIFO.
     */
    private surfaceWakeStep(step: AgyTranscriptStep, gating: WakeGatingState, pairing: WakeCardPairing): void {
        if (step.kind === 'system') {
            const completion = parseAgyTaskCompletion(step.content);
            // An unrelated system message (no completion marker) touches no
            // pending command.
            if (!completion) return;
            // A native task id settles exactly once: a duplicate completion
            // re-attempts the delivery below but decrements nothing.
            const duplicate = completion.taskId !== null && gating.settledTaskIds.has(completion.taskId);
            if (completion.taskId !== null && !duplicate) gating.settledTaskIds.add(completion.taskId);
            if (!duplicate) {
                // Gating counts identified ends: a native id the window saw
                // backgrounded frees its surfaced call; any other completion
                // (the turn's own command by native id even when the text
                // match below fails — that card then fails open to the close
                // placeholder — a legacy id-less one, or an id whose record
                // HAPI never saw) releases one ACP command: uncertain
                // identity fails open toward quiet, never toward the cap.
                if (completion.taskId !== null && gating.openContinuation.delete(completion.taskId) && gating.surfacedOpenCalls > 0) {
                    // The id the window saw backgrounded frees one surfaced
                    // call; a count of zero means the record belonged to an
                    // ACP-turn command surfacing in-window, so the ACP arm
                    // takes it below.
                    gating.surfacedOpenCalls -= 1;
                } else {
                    gating.openAcpCommands = Math.max(0, gating.openAcpCommands - 1);
                }
            }
            let bgId: string | undefined;
            const description = completion.taskId !== null ? pairing.backgrounding.get(completion.taskId) : undefined;
            if (description === undefined) {
                // No native task id on the completion, or no backgrounding
                // record for it (older builds): launch-order pairing, as before.
                bgId = pairing.bgIds.shift();
            } else {
                // Pair by the native task id agy recorded at backgrounding time,
                // so out-of-order completions complete their own card.
                bgId = pairing.bgIds.find((id) => sameCommandText(pairing.taskDescriptions.get(id) ?? '', description));
                if (bgId !== undefined) pairing.bgIds.splice(pairing.bgIds.indexOf(bgId), 1);
            }
            if (bgId !== undefined) {
                this.forwardAgentMessage({
                    type: 'tool_result',
                    id: bgId,
                    output: {
                        output: `Command exited with code ${completion.exitCode}.\n\nCommand output:\n${completion.output}`.trim(),
                        exit_code: completion.exitCode
                    },
                    status: completion.exitCode === 0 ? 'completed' : 'failed'
                });
                this.noteBackgroundTaskSettled(bgId);
            } else if (completion.taskId !== null) {
                // A command the continuation backgrounded itself has no ACP
                // call: settle its synthetic wake card and free the pending
                // entry so the window does not ride the cap after the answer.
                const wakeId = pairing.wakeCallByTask.get(completion.taskId);
                if (wakeId !== undefined) {
                    const at = pairing.pendingWakeCalls.indexOf(wakeId);
                    if (at >= 0) pairing.pendingWakeCalls.splice(at, 1);
                    this.forwardAgentMessage({
                        type: 'tool_result',
                        id: wakeId,
                        output: {
                            output: `Command exited with code ${completion.exitCode}.\n\nCommand output:\n${completion.output}`.trim(),
                            exit_code: completion.exitCode
                        },
                        status: completion.exitCode === 0 ? 'completed' : 'failed'
                    });
                }
            }
            return;
        }
        if (step.kind === 'planner') {
            if (step.content.trim().length > 0) {
                this.forwardAgentMessage({ type: 'text', text: step.content, live: false });
            }
            for (const call of step.toolCalls) {
                const id = `agy-wake-${step.idx}-${this.wakeIdCounter++}`;
                this.forwardAgentMessage({
                    type: 'tool_call',
                    id,
                    name: call.name,
                    input: call.args,
                    status: 'in_progress',
                    nativeName: call.name
                });
                pairing.pendingWakeCalls.push(id);
                gating.surfacedOpenCalls += 1;
                const command = call.args && typeof call.args === 'object' && !Array.isArray(call.args)
                    ? (call.args as { CommandLine?: unknown }).CommandLine
                    : undefined;
                if (typeof command === 'string' && command.trim().length > 0) pairing.wakeCommands.set(id, command);
            }
            return;
        }
        if (step.kind === 'tool') {
            if (step.status === 'running') {
                // agy records the backgrounding itself; remember the native task
                // id so its completion pairs with the original ACP call.
                const backgrounded = parseAgyBackgroundStart(step.content);
                if (backgrounded) {
                    pairing.backgrounding.set(backgrounded.taskId, backgrounded.description);
                    gating.openContinuation.add(backgrounded.taskId);
                    // The synthetic card this command launched under completes
                    // when the task does.
                    const wakeId = pairing.pendingWakeCalls.find((id) => sameCommandText(pairing.wakeCommands.get(id) ?? '', backgrounded.description));
                    if (wakeId !== undefined) pairing.wakeCallByTask.set(backgrounded.taskId, wakeId);
                }
                return; // the ACP card already shows the backgrounded command
            }
            // A terminal tool step frees one surfaced call regardless of which
            // card it belongs to: the count is the reliable fact, the
            // attribution below is display-only.
            gating.surfacedOpenCalls = Math.max(0, gating.surfacedOpenCalls - 1);
            // Settle the oldest pending card with no native-task link: a
            // backgrounded command's card settles on its completion, so a
            // foreground result must not consume it (tiann/hapi#2366 review).
            const linked = new Set(pairing.wakeCallByTask.values());
            const wakeId = pairing.pendingWakeCalls.find((id) => !linked.has(id));
            if (wakeId === undefined) return; // every pending card awaits its completion: nothing to attach
            pairing.pendingWakeCalls.splice(pairing.pendingWakeCalls.indexOf(wakeId), 1);
            this.forwardAgentMessage({
                type: 'tool_result',
                id: wakeId,
                output: step.content,
                status: step.status === 'error' ? 'failed' : 'completed'
            });
        }
    }

    private handleUserEcho(text: string): void {
        const turn = this.turn;
        if (!turn) return;
        turn.acknowledge();
        // Text that does not continue the prompt (a stray echo, or agy
        // skipping the prompt's echo) is checked against the steers, and the
        // prompt's own echo is still recognized when it comes.
        const prompt = turn.promptEcho;
        if (!prompt.done) {
            const echoed = normalizeEcho(`${prompt.echo} ${text}`);
            if (echoed && prompt.text.startsWith(echoed)) {
                prompt.echo = echoed;
                prompt.done = echoed === prompt.text;
                if (prompt.done && this.continuationMode === 'drop') {
                    // The drop was consumed by this turn's pre-echo block; any
                    // later straggler must be labeled, not silently dropped.
                    this.continuationMode = 'label';
                }
                return;
            }
        }
        // An echo may arrive in several chunks, so each steer matches on the
        // text echoed since it was sent, and the longest match wins when one
        // steer's text contains another's. One chunk may echo several steers,
        // so a match only uses up its own text.
        for (const entry of turn.unechoedSteers) {
            entry.echo = normalizeEcho(`${entry.echo} ${text}`).slice(-ECHO_BUFFER_LIMIT);
        }
        for (;;) {
            const match = turn.unechoedSteers
                .filter((entry) => entry.text && entry.echo.includes(entry.text))
                .sort((a, b) => b.text.length - a.text.length)[0];
            if (!match) return;
            for (const entry of turn.unechoedSteers) {
                if (entry !== match) entry.echo = normalizeEcho(entry.echo.replace(match.text, ' '));
            }
            match.accept();
            if (turn.unechoedSteers.includes(match)) return;
        }
    }

    private handleTurnUpdate(turn: AgyTurn, message: AgentMessage): void {
        if (this.turn !== turn) {
            // Frames arriving after the turn closed. agy sends none today (the
            // continuation flush is deferred to the next prompt), so this only
            // fires once agy delivers idle-period updates — the google-antigravity/antigravity-cli#1461 behavior
            // fixed upstream. Trust ACP from then on and retire the watcher.
            this.noteAcpIdleUpdate();
        }
        if (message.type === 'usage') {
            turn.usage = addAgyUsage(turn.usage, message);
            return;
        }
        if (message.type === 'turn_complete') {
            turn.stopReason = message.stopReason;
            if (typeof message.numTurns === 'number') turn.numTurns = message.numTurns;
            return;
        }
        // The pre-echo window: frames agy sends between the session/prompt
        // request and its echo of the prompt. Per google-antigravity/antigravity-cli#1461 that block is the
        // previous turn's continuation. Fully surfaced by the watcher (drop
        // mode) it is suppressed; otherwise it is labeled as a continuation of
        // the previous turn so it cannot read as the new prompt's answer.
        if (this.isPreEchoFrame(turn) && isContinuationContent(message)) {
            const cardCompletion = (message.type === 'tool_call' || message.type === 'tool_result')
                && this.continuationCardIds.has(message.id);
            if (this.continuationMode === 'drop' && !cardCompletion) return;
            if (!turn.labeledPreEcho && !(this.continuationMode === 'drop' && cardCompletion)) {
                turn.labeledPreEcho = true;
                this.session.sendSessionEvent({
                    type: 'message',
                    message: 'Antigravity finished work from the previous turn:'
                });
            }
        }
        turn.sawActivity = true;
        turn.acknowledge();
        turn.generation.observe(message);
        this.trackOpenCommand(turn, message);
        this.forwardAgentMessage(this.showQuestionCard(message));
    }

    /** True while the turn's echo has not completed within the bounded window. */
    private isPreEchoFrame(turn: AgyTurn): boolean {
        if (turn.promptEcho.done || turn.sentAt === null) return false;
        return Date.now() - turn.sentAt < this.wakeTiming.preEchoWindowMs;
    }

    /** Continuation frames the block-dedupe must not swallow: agy's flush of a
     * background command's completion closes the card with the real result. */
    private readonly continuationCardIds = new Set<string>();

    /** agy emitted frames with no prompt active: the upstream bug is fixed. */
    private noteAcpIdleUpdate(): void {
        if (this.acpEmitsIdleUpdates) return;
        this.acpEmitsIdleUpdates = true;
        this.continuationMode = 'label';
        void this.wakeWatcher?.stop('disabled');
    }

    /**
     * agy's ask_question, shown as the question card on its tool call. Never
     * answered automatically: the user's choice goes back as agy's answer.
     */
    private async handleQuestion(request: FormElicitationRequest): Promise<FormElicitationResponse> {
        const form = parseAgyQuestionForm(request);
        const permissionHandler = this.permissionHandler;
        // Not shown to the user, so not declined by them either.
        if (!form || !permissionHandler) return { action: 'cancel' };
        // Only a live turn can be asked on: after Stop, or once that turn has
        // ended, nothing would settle the card.
        if (!this.turn || this.turn.aborted || this.shouldExit) return { action: 'cancel' };
        // Keyed by agy's tool call so the card shows on it, unless that id
        // was already used for a request.
        const id = form.toolCallId && !permissionHandler.isUsed(form.toolCallId)
            ? form.toolCallId
            : `agy-question-${randomUUID()}`;
        const shownLabels = form.toolCallId ? this.questionLabels.get(form.toolCallId) : undefined;
        const answer = await permissionHandler.askUser(id, QUESTION_TOOL_NAME, questionCardInput(form.questions));
        if (answer.decision === 'abort') return { action: 'cancel' };
        if (answer.decision === 'denied') return { action: 'decline' };
        const content = agyQuestionContent(form.questions, answer.answers, shownLabels);
        // An approval without a usable answer must not become an empty answer.
        return Object.keys(content).length > 0 ? { action: 'accept', content } : { action: 'decline' };
    }

    private showQuestionCard(message: AgentMessage): AgentMessage {
        const shown = asQuestionCard(message);
        if (shown.shownLabels && message.type === 'tool_call') this.questionLabels.set(message.id, shown.shownLabels);
        return shown.message;
    }

    /** Tracks commands agy moved to the background; the generation clock reads the same updates. */
    private trackOpenCommand(turn: AgyTurn, message: AgentMessage): void {
        if (message.type !== 'tool_call' && message.type !== 'tool_result') return;
        // Only a command agy reports as running counts: one still waiting
        // for approval (pending) did not start, whatever happens to the turn.
        if (message.type === 'tool_call' && message.nativeName === 'run_command' && message.status === 'in_progress') {
            turn.openCommands.add(message.id);
            turn.bgTaskDescriptions.set(message.id, backgroundTaskDescription(message));
        } else if (message.status !== 'in_progress') {
            turn.openCommands.delete(message.id);
            // A completion delivered in-turn (or via the next prompt's flush)
            // retires the background-task indicator entry.
            this.noteBackgroundTaskSettled(message.id);
        }
    }

    /**
     * The hub's background-task indicator reads Claude's
     * `system/background_tasks_changed` snapshot off the agent output stream
     * (hub/src/sync/backgroundTasks.ts); agy reuses the shape so hub and web
     * need no changes. Full snapshot on every membership change, empty once
     * nothing runs — the launcher skips redundant snapshots itself, and the
     * hub drops identical ones.
     */
    private emitBackgroundTasksSnapshot(): void {
        const ids = [...this.activeBgTasks.keys()];
        if (ids.length === this.lastBgSnapshotIds.length
            && ids.every((id, index) => id === this.lastBgSnapshotIds[index])) return;
        this.lastBgSnapshotIds = ids;
        this.session.client.sendClaudeSessionMessage({
            type: 'system',
            uuid: randomUUID(),
            subtype: 'background_tasks_changed',
            tasks: ids.map((id) => ({
                task_id: id,
                task_type: 'local_bash',
                description: this.activeBgTasks.get(id) ?? ''
            }))
        } as RawJSONLines);
    }

    /** One background command reported its end; empty list once none remain. */
    private noteBackgroundTaskSettled(callId: string): void {
        if (!this.activeBgTasks.delete(callId)) return;
        this.emitBackgroundTasksSnapshot();
    }

    /** Abort and session end clear the indicator with an empty snapshot. */
    private clearBackgroundTasksSnapshot(): void {
        if (this.activeBgTasks.size === 0 && this.lastBgSnapshotIds.length === 0) return;
        this.activeBgTasks.clear();
        this.emitBackgroundTasksSnapshot();
    }

    private forwardAgentMessage(message: AgentMessage): void {
        const converted = convertAgentMessage(this.toCanonicalToolMessage(message), this.currentModelId);
        if (converted) this.session.sendAgentMessage(converted);

        switch (message.type) {
            case 'text':
                if (message.live) break;
                this.messageBuffer.addMessage(message.text, 'assistant');
                break;
            case 'tool_call':
                if (message.status === 'pending' || message.status === 'in_progress') {
                    this.messageBuffer.addMessage(`Tool: ${message.title ?? message.name}`, 'tool');
                }
                break;
            case 'error':
                this.messageBuffer.addMessage(message.message, 'status');
                break;
            case 'generated_image':
            case 'usage':
            case 'reasoning':
            case 'tool_result':
            case 'plan':
            case 'turn_complete':
            case 'round_summary':
                break;
            default: {
                const _exhaustive: never = message;
                return _exhaustive;
            }
        }
    }

    /** agy's own tool name picks the card; the open-command bookkeeping rides along. */
    private toCanonicalToolMessage(message: AgentMessage): AgentMessage {
        if (message.type === 'tool_call') {
            if (message.nativeName) this.nativeToolNames.set(message.id, message.nativeName);
            return mapAgyToolCall(message);
        }
        if (message.type === 'tool_result') {
            const nativeName = this.nativeToolNames.get(message.id);
            this.nativeToolNames.delete(message.id);
            return mapAgyToolResult(message, nativeName);
        }
        return message;
    }

    private reportTurnError(message: string): void {
        this.session.sendSessionEvent({ type: 'error', message });
        this.messageBuffer.addMessage(message, 'status');
    }

    private restorePrompt(turn: AgyTurn, text: string): void {
        turn.acknowledge();
        this.session.sendSessionEvent({ type: 'abort-restore', text });
    }

    private async cancelActiveTurn(): Promise<void> {
        // A live continuation owns no this.turn anymore (answerMain already
        // ran), but agy is still generating: Stop must cancel it too.
        const turn = this.turn ?? this.continuationTurn;
        if (turn) {
            turn.aborted = true;
            this.session.client.updateAgentState((state) => ({ ...state, steeringActive: false }));
        }
        const backend = this.backend;
        const acpSessionId = this.acpSessionId;
        if (backend && acpSessionId && turn && backend.isTransportAlive()) {
            // ACP cancel also ends open tool calls (the hard stop, unlike steer);
            // their final updates still flow to this turn's handler.
            await backend.cancelPrompt(acpSessionId);
            // prompt() waits for the previous turn's output to settle before it
            // sends; a cancel in that window reaches agy before the prompt.
            if (!backend.isPromptRequestInFlight()) this.cancelOnceSent(backend, acpSessionId, turn);
            if (turn.steers.length > 0) this.dropUnansweredSteers(backend, turn);
            this.restartIfCancelIgnored(backend, turn);
        }
        await this.permissionHandler?.cancelAll('User aborted');
    }

    private cancelOnceSent(backend: AcpSdkBackend, acpSessionId: string, turn: AgyTurn): void {
        const timer = setInterval(() => {
            if (this.turn !== turn || this.backend !== backend) {
                clearInterval(timer);
                return;
            }
            if (backend.isPromptRequestInFlight()) {
                clearInterval(timer);
                void backend.cancelPrompt(acpSessionId);
            }
        }, PROMPT_SEND_POLL_MS);
        timer.unref?.();
    }

    private restartIfCancelIgnored(backend: AcpSdkBackend, turn: AgyTurn): void {
        // Measured on agy's answers: HAPI's own wait for late output after
        // them must not count as agy ignoring the cancel.
        let answered = false;
        void Promise.allSettled([turn.mainAnswered, ...turn.steerAnswers]).then(() => { answered = true; });
        const timer = setTimeout(() => {
            if (answered || this.turn !== turn || this.backend !== backend) return;
            logger.warn('[agy-acp] agy did not stop the turn after cancel; restarting it');
            this.session.sendSessionEvent({
                type: 'message',
                message: 'Antigravity did not stop; restarting it.'
            });
            this.backendLost = true;
            for (const abandon of turn.abandonSteers) abandon();
            turn.releaseSteerWait();
            void this.retireBackend(backend);
        }, this.cancelHardStopMs);
        timer.unref?.();
    }

    /**
     * A steer agy never answers would block the turn and the next turn's
     * config calls, so it is dropped after a grace period and agy is stopped,
     * so the abandoned request can neither write into the next turn nor run
     * on with approvals. Not done right away: the cancelled tool calls still
     * report their end through this turn's handler.
     */
    private dropUnansweredSteers(backend: AcpSdkBackend, turn: AgyTurn): void {
        let answered = false;
        void Promise.allSettled([...turn.steerAnswers]).then(() => { answered = true; });
        const timer = setTimeout(() => {
            if (answered || this.turn !== turn || this.backend !== backend) return;
            logger.warn('[agy-acp] agy did not answer a steer after cancel; dropping it');
            for (const abandon of turn.abandonSteers) abandon();
            this.backendLost = true;
            turn.releaseSteerWait();
            void this.retireBackend(backend);
        }, this.steerCancelGraceMs);
        timer.unref?.();
    }

    private async handleAbort(): Promise<void> {
        const hadTurn = this.turn !== null || this.continuationTurn !== null;
        await this.cancelActiveTurn();
        void this.wakeWatcher?.stop('next-prompt');
        this.abortController.abort();
        this.abortController = new AbortController();
        this.clearBackgroundTasksSnapshot();
        if (hadTurn) {
            this.session.sendSessionEvent({ type: 'message', message: 'Turn aborted' });
            this.messageBuffer.addMessage('Turn aborted', 'status');
        }
    }

    private async handleExitFromUi(): Promise<void> {
        await this.requestExit('exit', () => this.handleAbort());
    }

    private async handleKill(): Promise<void> {
        const turnSettled = this.turnSettled;
        await this.requestExit('exit', () => this.handleAbort());
        await this.backend?.disconnect();
        // The runner ends the session and closes the client as soon as kill
        // returns, so the turn must put its prompt back or confirm it first;
        // a stuck agy only delays that by the bound.
        if (turnSettled) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
                turnSettled,
                new Promise<void>((resolve) => { timer = setTimeout(resolve, this.killSettleMs); })
            ]);
            clearTimeout(timer);
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);
        this.clearBackgroundTasksSnapshot();
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.SteerQueuedMessage, async () => ({
            steered: false,
            error: 'Session ending'
        }));
        this.session.client.updateAgentState((state) => ({ ...state, steeringActive: false }));
        await this.permissionHandler?.cancelAll('Session ended');
        this.permissionHandler = null;
        void this.wakeWatcher?.stop('next-prompt');
        const backend = this.backend;
        this.backend = null;
        await backend?.disconnect();
        logger.debug('[agy-acp] cleanup done');
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Content frames the pre-echo gate applies to (bookkeeping frames pass freely). */
function isContinuationContent(message: AgentMessage): boolean {
    return message.type === 'text'
        || message.type === 'reasoning'
        || message.type === 'tool_call'
        || message.type === 'tool_result'
        || message.type === 'plan'
        || message.type === 'generated_image';
}

/** Command-text equality that survives agy's whitespace normalization of multiline commands. */
function sameCommandText(a: string, b: string): boolean {
    return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

/** The command text for the background-task indicator; the card title as fallback. */
function backgroundTaskDescription(message: AgentMessage & { type: 'tool_call' }): string {
    const command = message.nativeArgs && typeof message.nativeArgs === 'object'
        && !Array.isArray(message.nativeArgs)
        ? (message.nativeArgs as { CommandLine?: unknown }).CommandLine
        : undefined;
    if (typeof command === 'string' && command.trim().length > 0) return command;
    if (typeof message.title === 'string' && message.title.trim().length > 0) return message.title;
    return message.name;
}

/** agy releases before 1.5.0 have no `acp` subcommand, so name the floor. */
function describeAgyStartFailure(error: unknown): string {
    return `Failed to start agy acp (requires Antigravity CLI 1.5.0 or newer): ${errorMessage(error)}`;
}

export async function agyAcpRemoteLauncher(session: AgySession): Promise<'switch' | 'exit'> {
    const launcher = new AgyAcpRemoteLauncher(session);
    return launcher.launch();
}
