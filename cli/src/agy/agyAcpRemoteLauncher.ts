import React from 'react';
import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
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
import type { AgySession } from './session';
import { AGY_BACKGROUND_COMMAND_RESULT, mapAgyToolCall, mapAgyToolResult } from './agyToolCards';
import {
    addAgyUsage,
    advanceAgyTurnTranscriptCursor,
    agyTranscriptPaths,
    convertAgyParkedWakeupSlice,
    convertAgyReactiveSteps,
    defaultAgyBrainDir,
    extractAgyBackgroundTaskIds,
    inspectAgyReactiveSteps,
    inspectSyntheticBackgroundCommandMatch,
    readAgyTranscriptStepsAfter,
    readLatestAgyTranscriptStepIndex,
    resolveAgyBackgroundTaskIds,
    type AgyOpenBackgroundCommand,
    type AgyParkedWakeupCall,
    type AgyReactiveTimingConfig,
    type AgyTranscriptStep
} from './agyReactiveWakeup';
import type { AgyMode, PermissionMode } from './types';
import { createAgyAcpBackend, type AgyAcpBackendOptions } from './utils/agyAcpBackend';
import {
    QUESTION_TOOL_NAME,
    agyQuestionContent,
    parseAgyQuestionForm,
    questionCardInput,
    questionCardInputFromToolCall
} from './agyQuestion';

export { addAgyUsage };

type UsageMessage = Extract<AgentMessage, { type: 'usage' }>;

const STEER_CANCEL_GRACE_MS = 3_000;
const CANCEL_HARD_STOP_MS = 10_000;
// Bound on how long a kill waits for the running turn to settle.
const KILL_SETTLE_MS = 5_000;
const PROMPT_SEND_POLL_MS = 50;
const ECHO_BUFFER_LIMIT = 64 * 1024;
const REACTIVE_POLL_MS = 350;
const REACTIVE_SETTLE_MS = 250;
const REACTIVE_TOOL_PARK_MS = 1_500;
const REACTIVE_SLOW_TOOL_PARK_MS = 10_000;
const REACTIVE_MAX_IDLE_MS = 10 * 60_000;

/**
 * Maps HAPI permission modes to `agy acp` session modes. `always-proceed`
 * launches `agy acp --dangerously-skip-permissions` while keeping ACP's mode
 * at `default` (plus HAPI's `AcpPermissionHandler` as belt-and-suspenders).
 */
export function agyAcpModeForPermission(mode: PermissionMode | undefined): string {
    switch (mode) {
        case 'acceptEdits':
            return 'accept-edits';
        case 'auto':
            return 'auto';
        case 'plan':
            return 'plan';
        case 'request-review':
        case 'always-proceed':
        case undefined:
            return 'default';
    }
}

export function isAgySkipPermissionsMode(mode: PermissionMode | undefined): boolean {
    return mode === 'always-proceed';
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

// agy reports no per-step timing, so generation time is the round minus the
// spans spent running tools or waiting for the user: the shared GenerationClock
// (cli/src/agent/generationClock.ts) is fed the same session updates and
// permission waits it always was.

/** The turn's response-footer record; the web reads `provider: 'agy'` summaries. */
export function agyRoundSummary(
    usage: UsageMessage,
    durationMs: number | null,
    model: string | null,
    generationMs: number | null = null
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
    // All `run_command` call IDs seen in this turn in arrival order, kept even
    // if an earlier command completes during a steer so call ordinals stay 1:1
    // with transcript `PLANNER_RESPONSE.tool_calls` entries.
    commandCallIds: string[];
    // Original arrival order of current-turn `run_command` tool_calls (including
    // provisionally deferred ones) so flushing deferred calls restores 1:1 ordinals.
    commandArrivalOrder: string[];
    // Background command call IDs already tracked from earlier turns, excluded
    // from current-turn `commandCallIds` ordinals when their completion arrives.
    priorBackgroundCallIds: Set<string>;
    // Ambiguous `run_command` tool_calls held briefly until `tool_result`
    // output disambiguates multiple synthetic background candidates.
    deferredLiveCommandCalls: Map<string, Extract<AgentMessage, { type: 'tool_call' }>>;
    corroboratedSyntheticMatches: number;
    turnStartStepIndex: number;
    // Settled non-live assistant text segments streamed during this turn, used
    // to distinguish intra-turn SYSTEM_MESSAGE folds from post-turn wakeups.
    streamedTextCounts: Map<string, number>;
    // Prefix texts already forwarded before reattaching a parked wakeup, so an
    // optional backend replay does not emit duplicate assistant messages.
    preEmittedTexts: Map<string, number>;
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
};

/**
 * Antigravity over `agy acp`. The agy conversation id is the ACP session id,
 * so a stored `agySessionId` resumes through `session/resume` without replay.
 */
export class AgyAcpRemoteLauncher extends RemoteLauncherBase {
    private readonly session: AgySession;
    private readonly createBackend: (opts?: AgyAcpBackendOptions) => AcpSdkBackend;
    private readonly steerCancelGraceMs: number;
    private readonly cancelHardStopMs: number;
    private readonly killSettleMs: number;
    private readonly brainDir: string;
    private readonly reactivePollMs: number;
    private readonly reactiveTimings: AgyReactiveTimingConfig;
    private turnSettled: Promise<void> | null = null;
    // Option labels each question card showed, by agy tool call id.
    private readonly questionLabels = new Map<string, string[][]>();
    private backend: AcpSdkBackend | null = null;
    private backendSkipPermissions: boolean | null = null;
    private pendingIdleModeSync = false;
    private idleConfigWake: (() => void) | null = null;
    private pendingParkedResolution: {
        parkedCallId: string;
        toolName: string;
        aliasedLiveId: string | null;
        decisionConsumed: boolean;
        decision: 'approved' | 'approved_for_session' | 'denied';
        answers?: Record<string, string[]>;
        shownLabels?: string[][];
        preEmittedTexts: Map<string, number>;
    } | null = null;
    private permissionHandler: AcpPermissionHandler | null = null;
    // agy's own tool name by call id, to map results of the calls it started.
    private readonly nativeToolNames = new Map<string, string>();
    // Maps native ACP toolCallIds to synthetic `agy-wakeup-*` IDs when a command
    // backgrounded in a reactive wakeup completes during a later live ACP turn.
    private readonly syntheticCallAliases = new Map<string, string>();
    // Live ACP completions held while multiple compatible synthetic commands
    // remain open with incomplete `SYSTEM_MESSAGE` persistence.
    private readonly retainedAmbiguousCompletions: Array<{
        turnStartStepIndex: number;
        callMessage?: Extract<AgentMessage, { type: 'tool_call' }>;
        resultMessage: Extract<AgentMessage, { type: 'tool_result' }>;
        nativeArgs?: Record<string, unknown>;
    }> = [];
    // Background `run_command` entries awaiting completion across turns.
    private readonly backgroundCommands: AgyOpenBackgroundCommand[] = [];
    private acpSessionId: string | null = null;
    private lastTranscriptStepIndex = -1;
    // Latest step_index seen when an unfinished wakeup hit `maxIdleMs`, so
    // tracking resumes as soon as late output appends a newer step.
    private pausedWakeupStepIndex: number | null = null;
    private lastTurnTranscriptState: {
        turnStartStepIndex: number;
        streamedTextCounts: Map<string, number>;
    } | null = null;
    private reactiveWakeupAbort: AbortController | null = null;
    private lastTurnMode: AgyMode | null = null;
    private lastSessionModeSnapshot: {
        permissionMode: PermissionMode | undefined;
        model: SessionModel | undefined;
        effort: SessionEffort | undefined;
    } | null = null;
    private abortController = new AbortController();
    /** agy's own model at session start; the target of the "Default" selection. */
    private defaultModelId: string | null = null;
    private currentModelId: string | null = null;
    private turnPermissionMode: PermissionMode | undefined = undefined;
    private turn: AgyTurn | null = null;
    private backendLost = false;

    constructor(session: AgySession, opts: {
        createBackend?: (opts?: AgyAcpBackendOptions) => AcpSdkBackend;
        steerCancelGraceMs?: number;
        cancelHardStopMs?: number;
        killSettleMs?: number;
        brainDir?: string;
        reactivePollMs?: number;
        reactiveSettleMs?: number;
        reactiveToolParkMs?: number;
        reactiveSlowToolParkMs?: number;
        reactiveMaxIdleMs?: number;
    } = {}) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.createBackend = opts.createBackend ?? createAgyAcpBackend;
        this.steerCancelGraceMs = opts.steerCancelGraceMs ?? STEER_CANCEL_GRACE_MS;
        this.cancelHardStopMs = opts.cancelHardStopMs ?? CANCEL_HARD_STOP_MS;
        this.killSettleMs = opts.killSettleMs ?? KILL_SETTLE_MS;
        this.brainDir = opts.brainDir ?? defaultAgyBrainDir();
        this.reactivePollMs = opts.reactivePollMs ?? REACTIVE_POLL_MS;
        this.reactiveTimings = {
            settleMs: opts.reactiveSettleMs ?? REACTIVE_SETTLE_MS,
            toolParkMs: opts.reactiveToolParkMs ?? REACTIVE_TOOL_PARK_MS,
            slowToolParkMs: opts.reactiveSlowToolParkMs ?? REACTIVE_SLOW_TOOL_PARK_MS,
            maxIdleMs: opts.reactiveMaxIdleMs ?? REACTIVE_MAX_IDLE_MS
        };
        this.session.setKillHandler(() => this.handleKill());
        this.session.onPermissionModeChanged = () => {
            this.pendingIdleModeSync = true;
            this.idleConfigWake?.();
        };
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
            const initialPermissionMode = session.queue.queue[0]?.mode.permissionMode
                ?? (session.getPermissionMode() as PermissionMode | undefined);
            await this.startBackend(session.sessionId, isAgySkipPermissionsMode(initialPermissionMode));
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
            const nextWork = await this.waitForNextBatchOrWakeup(signal);
            if (nextWork.kind === 'config') {
                await this.syncIdleBackendConfig();
                continue;
            }
            if (nextWork.kind === 'wakeup') {
                const wakeupRun = this.runReactiveWakeup();
                this.turnSettled = wakeupRun.then(() => {}, () => {});
                await wakeupRun;
                continue;
            }
            const batch = nextWork.batch;
            if (!batch) {
                if (signal.aborted && !this.shouldExit) continue;
                break;
            }
            const localIds = batch.items
                .map((item) => item.localId)
                .filter((localId): localId is string => Boolean(localId));
            const turnRun = this.runTurn(batch.message, batch.mode, batch.hash, localIds);
            this.turnSettled = turnRun.then(() => {}, () => {});
            await turnRun;
        }
    }

    private async syncIdleBackendConfig(): Promise<void> {
        this.pendingIdleModeSync = false;
        if (this.shouldExit || !this.acpSessionId || this.session.queue.size() > 0) return;
        const mode = this.currentWakeupMode();
        const wantSkip = isAgySkipPermissionsMode(mode.permissionMode);
        if (
            this.backendLost
            || !this.backend
            || !this.backend.isTransportAlive()
            || this.backendSkipPermissions !== wantSkip
        ) {
            try {
                await this.relaunchBackend(wantSkip);
            } catch (error) {
                this.reportTurnError(`Failed to restart Antigravity: ${errorMessage(error)}`);
                return;
            }
        }
        if (this.backend && this.acpSessionId && !this.shouldExit) {
            await this.applyTurnConfig(this.backend, this.acpSessionId, mode);
        }
    }

    private syncTranscriptCursor(): void {
        const acpSessionId = this.acpSessionId;
        if (!acpSessionId) return;
        this.reconcileRetainedAmbiguousCompletions(null);
        this.advanceCursorFromLastTurnState();
        this.lastTurnTranscriptState = null;
        const latest = readLatestAgyTranscriptStepIndex(this.brainDir, acpSessionId);
        if (latest > this.lastTranscriptStepIndex) {
            this.lastTranscriptStepIndex = latest;
        }
        this.pausedWakeupStepIndex = null;
    }

    private syncTurnTranscriptCursor(turn: AgyTurn, turnStartStepIndex: number): void {
        const acpSessionId = this.acpSessionId;
        if (!acpSessionId) return;
        this.lastTurnTranscriptState = {
            turnStartStepIndex,
            streamedTextCounts: new Map(turn.streamedTextCounts)
        };
        this.advanceCursorFromLastTurnState();
        this.pausedWakeupStepIndex = null;
    }

    private advanceCursorFromLastTurnState(): void {
        const acpSessionId = this.acpSessionId;
        const state = this.lastTurnTranscriptState;
        if (!acpSessionId || !state) return;
        const stepsAfterStart = readAgyTranscriptStepsAfter(this.brainDir, acpSessionId, state.turnStartStepIndex);
        const nextCursor = advanceAgyTurnTranscriptCursor(
            stepsAfterStart,
            state.turnStartStepIndex,
            state.streamedTextCounts
        );
        if (nextCursor > this.lastTranscriptStepIndex) {
            this.lastTranscriptStepIndex = nextCursor;
        }
    }

    private hasPendingReactiveWakeup(): boolean {
        const acpSessionId = this.acpSessionId;
        if (!acpSessionId || this.backendLost || !this.backend?.isTransportAlive()) return false;
        if (this.retainedAmbiguousCompletions.length > 0) {
            this.reconcileRetainedAmbiguousCompletions(null);
        }
        this.advanceCursorFromLastTurnState();
        const steps = readAgyTranscriptStepsAfter(this.brainDir, acpSessionId, this.lastTranscriptStepIndex);
        if (steps.length === 0) return false;
        if (!steps.some((step) => step.source === 'SYSTEM' && step.type === 'SYSTEM_MESSAGE')) {
            return false;
        }
        if (this.pausedWakeupStepIndex !== null) {
            const latest = steps[steps.length - 1]!.step_index;
            return latest > this.pausedWakeupStepIndex;
        }
        return true;
    }

    private async waitForNextBatchOrWakeup(outerSignal: AbortSignal): Promise<
        | { kind: 'batch'; batch: Awaited<ReturnType<AgySession['queue']['waitForMessagesAndGetAsString']>> }
        | { kind: 'wakeup' }
        | { kind: 'config' }
    > {
        const queue = this.session.queue;
        if (queue.size() > 0 || queue.isClosed() || outerSignal.aborted) {
            return { kind: 'batch', batch: await queue.waitForMessagesAndGetAsString(outerSignal) };
        }
        if (this.pendingIdleModeSync) {
            return { kind: 'config' };
        }
        if (this.hasPendingReactiveWakeup()) {
            return { kind: 'wakeup' };
        }

        const waitController = new AbortController();
        let wakeupTriggered = false;
        let configTriggered = false;
        const watchRef: { current: FSWatcher | null } = { current: null };

        const onOuterAbort = () => waitController.abort();
        outerSignal.addEventListener('abort', onOuterAbort, { once: true });
        this.idleConfigWake = () => {
            if (waitController.signal.aborted || this.shouldExit || queue.size() > 0) return;
            configTriggered = true;
            waitController.abort();
        };

        const tryAttachWatcher = () => {
            if (watchRef.current || !this.acpSessionId) return;
            const paths = agyTranscriptPaths(this.brainDir, this.acpSessionId);
            if (!paths) return;
            try {
                const fsWatcher = watch(paths.logsDir, () => checkWakeup());
                fsWatcher.unref?.();
                watchRef.current = fsWatcher;
            } catch {
                watchRef.current = null;
            }
        };

        const checkWakeup = () => {
            if (wakeupTriggered || configTriggered || waitController.signal.aborted || this.shouldExit || queue.size() > 0) return;
            if (this.pendingIdleModeSync) {
                configTriggered = true;
                waitController.abort();
                return;
            }
            tryAttachWatcher();
            if (this.hasPendingReactiveWakeup()) {
                wakeupTriggered = true;
                waitController.abort();
            }
        };

        tryAttachWatcher();
        const timer = setInterval(checkWakeup, this.reactivePollMs);
        timer.unref?.();

        try {
            const batch = await queue.waitForMessagesAndGetAsString(waitController.signal);
            if (batch) return { kind: 'batch', batch };
            if (configTriggered && !outerSignal.aborted && !this.shouldExit) {
                return { kind: 'config' };
            }
            if (wakeupTriggered && !outerSignal.aborted && !this.shouldExit) {
                return { kind: 'wakeup' };
            }
            return { kind: 'batch', batch: null };
        } finally {
            this.idleConfigWake = null;
            clearInterval(timer);
            watchRef.current?.close();
            outerSignal.removeEventListener('abort', onOuterAbort);
        }
    }

    private waitWakeupTick(acpSessionId: string, delayMs: number, signal: AbortSignal): Promise<void> {
        return new Promise((resolve) => {
            if (signal.aborted) {
                resolve();
                return;
            }
            let settled = false;
            let watcher: FSWatcher | null = null;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                watcher?.close();
                signal.removeEventListener('abort', finish);
                resolve();
            };
            const timer = setTimeout(finish, delayMs);
            timer.unref?.();
            signal.addEventListener('abort', finish, { once: true });
            const paths = agyTranscriptPaths(this.brainDir, acpSessionId);
            if (paths) {
                try {
                    watcher = watch(paths.logsDir, finish);
                    watcher.unref?.();
                } catch {
                    watcher = null;
                }
            }
        });
    }

    /**
     * Advances `agy acp`'s internal `SkipHistory` cursor via `session/resume`
     * after HAPI emits a completed reactive wakeup from `transcript.jsonl`,
     * preventing the next `session/prompt` from replaying those steps twice.
     */
    private async advanceBackendCursor(): Promise<void> {
        const backend = this.backend;
        const acpSessionId = this.acpSessionId;
        if (!backend || !acpSessionId || this.backendLost || !backend.isTransportAlive()) return;
        if (!backend.supportsSessionResume()) return;
        try {
            await backend.resumeSession({
                sessionId: acpSessionId,
                cwd: this.session.path,
                mcpServers: []
            });
            const reported = backend.getSessionModelsMetadata(acpSessionId)?.currentModelId ?? null;
            if (reported) this.currentModelId = reported;
        } catch (error) {
            logger.debug('[agy-acp] session/resume cursor sync failed', error);
            if (isAcpIndeterminateError(error)) {
                this.backendLost = true;
            }
        }
    }

    private currentWakeupMode(): AgyMode {
        const sessionPerm = this.session.getPermissionMode() as PermissionMode | undefined;
        const sessionModel = this.session.getModel();
        const sessionEffort = this.session.getEffort();
        const snap = this.lastSessionModeSnapshot;
        const permissionMode = snap && sessionPerm !== snap.permissionMode
            ? sessionPerm
            : (this.lastTurnMode?.permissionMode ?? sessionPerm);
        const model = snap && sessionModel !== snap.model
            ? sessionModel
            : (this.lastTurnMode?.model ?? sessionModel);
        const effort = snap && sessionEffort !== snap.effort
            ? sessionEffort
            : (this.lastTurnMode?.effort ?? sessionEffort);
        const mode: AgyMode = {
            permissionMode: permissionMode ?? 'request-review'
        };
        if (model !== undefined) mode.model = model;
        if (effort !== undefined) mode.effort = effort;
        return mode;
    }

    /**
     * Handles autonomous `agy` wakeups (background `run_command` completions,
     * subagent replies, scheduled timers) that `agy acp` runs outside any open
     * `session/prompt`. Under `--dangerously-skip-permissions` (`always-proceed`),
     * non-question tools run to completion in `transcript.jsonl`, then HAPI emits
     * the converted messages and advances `agy`'s cursor via `session/resume`.
     * When a wakeup parks on tool approval (non-skip modes) or `ask_question`,
     * HAPI surfaces the pending approval/question card with zero hidden writes
     * to `transcript.jsonl` and waits for the user's explicit visible action.
     */
    private async runReactiveWakeup(): Promise<void> {
        const session = this.session;
        const acpSessionId = this.acpSessionId;
        if (!acpSessionId || this.shouldExit) return;

        const abortController = new AbortController();
        this.reactiveWakeupAbort = abortController;
        session.onThinkingChange(true);

        let watchedStepIndex = this.pausedWakeupStepIndex ?? this.lastTranscriptStepIndex;
        let lastProgressAtMs = Date.now();
        const pollIntervalMs = Math.max(10, Math.min(this.reactivePollMs, 50));

        try {
            for (;;) {
                if (this.shouldExit || session.queue.isClosed()) {
                    session.onThinkingChange(false);
                    return;
                }
                if (abortController.signal.aborted) {
                    this.syncTranscriptCursor();
                    await this.advanceBackendCursor();
                    session.onThinkingChange(false);
                    if (session.queue.size() === 0 && !this.shouldExit) {
                        session.sendSessionEvent({ type: 'ready' });
                    }
                    return;
                }
                if (session.queue.size() > 0) {
                    return;
                }

                const nowMs = Date.now();
                const steps = readAgyTranscriptStepsAfter(this.brainDir, acpSessionId, this.lastTranscriptStepIndex);
                const inspection = inspectAgyReactiveSteps(
                    steps,
                    session.path,
                    nowMs,
                    lastProgressAtMs,
                    this.reactiveTimings,
                    { skipPermissions: this.backendSkipPermissions === true }
                );

                if (inspection.state === 'none') {
                    session.onThinkingChange(false);
                    return;
                }

                if (inspection.latestStepIndex > watchedStepIndex) {
                    watchedStepIndex = inspection.latestStepIndex;
                    this.pausedWakeupStepIndex = null;
                    lastProgressAtMs = nowMs;
                    await this.waitWakeupTick(acpSessionId, pollIntervalMs, abortController.signal);
                    continue;
                }

                if (inspection.state === 'completed') {
                    this.pausedWakeupStepIndex = null;
                    this.lastTranscriptStepIndex = Math.max(this.lastTranscriptStepIndex, inspection.latestStepIndex);
                    const wakeupFirstStepIndex = inspection.steps[0]?.step_index;
                    resolveAgyBackgroundTaskIds(
                        this.brainDir,
                        acpSessionId,
                        this.backgroundCommands,
                        wakeupFirstStepIndex !== undefined ? wakeupFirstStepIndex - 1 : undefined
                    );
                    this.reconcileRetainedAmbiguousCompletions(null);
                    const converted = convertAgyReactiveSteps(
                        acpSessionId,
                        inspection.steps,
                        this.backgroundCommands
                    );
                    if (!this.backgroundCommands.some((entry) => entry.synthetic)) {
                        this.retainedAmbiguousCompletions.length = 0;
                    }
                    await this.advanceBackendCursor();
                    for (const msg of converted.messages) {
                        this.forwardAgentMessage(this.showQuestionCard(msg));
                    }
                    if (converted.usage) {
                        session.sendAgentMessage(
                            agyRoundSummary(converted.usage, converted.durationMs, this.currentModelId, null)
                        );
                    }
                    session.onThinkingChange(false);
                    if (session.queue.size() === 0 && !this.shouldExit) {
                        session.sendSessionEvent({ type: 'ready' });
                    }
                    return;
                }

                if (inspection.state === 'timed_out') {
                    // Pause idle polling without advancing completion cursors so
                    // late output under the same `SYSTEM_MESSAGE` still wakes HAPI.
                    this.pausedWakeupStepIndex = inspection.latestStepIndex;
                    session.onThinkingChange(false);
                    if (session.queue.size() === 0 && !this.shouldExit) {
                        session.sendSessionEvent({ type: 'ready' });
                    }
                    return;
                }

                if (inspection.state === 'parked_on_tool') {
                    this.pausedWakeupStepIndex = null;
                    await this.handleParkedWakeup(acpSessionId, inspection.steps, inspection.parkedCall, abortController);
                    return;
                }

                await this.waitWakeupTick(acpSessionId, pollIntervalMs, abortController.signal);
            }
        } finally {
            if (this.reactiveWakeupAbort === abortController) {
                this.reactiveWakeupAbort = null;
            }
        }
    }

    private async handleParkedWakeup(
        acpSessionId: string,
        steps: AgyTranscriptStep[],
        parkedCall: AgyParkedWakeupCall,
        abortController: AbortController
    ): Promise<void> {
        const session = this.session;
        const permissionHandler = this.permissionHandler;
        if (!permissionHandler || this.shouldExit) {
            session.onThinkingChange(false);
            return;
        }

        const replayAfterStepIndex = this.lastTranscriptStepIndex;
        const wakeupFirstStepIndex = steps[0]?.step_index;
        resolveAgyBackgroundTaskIds(
            this.brainDir,
            acpSessionId,
            this.backgroundCommands,
            wakeupFirstStepIndex !== undefined ? wakeupFirstStepIndex - 1 : undefined
        );
        this.reconcileRetainedAmbiguousCompletions(null);

        const slice = convertAgyParkedWakeupSlice(
            acpSessionId,
            steps,
            parkedCall,
            this.backgroundCommands
        );
        for (const msg of slice.messages) {
            this.forwardAgentMessage(this.showQuestionCard(msg));
        }

        const isQuestion = parkedCall.toolName === 'ask_question';
        let cardToolName: string;
        let cardToolInput: unknown;
        if (isQuestion) {
            const parsedInput = questionCardInputFromToolCall(parkedCall.decodedArgs);
            cardToolName = QUESTION_TOOL_NAME;
            cardToolInput = parsedInput
                ? {
                    questions: parsedInput.questions.map((q) => ({
                        ...q,
                        allowFreeText: true
                    }))
                }
                : parkedCall.decodedArgs;
        } else {
            const mapped = mapAgyToolCall(slice.parkedToolCall);
            cardToolName = mapped.name;
            cardToolInput = mapped.input;
        }

        // Session is now waiting on explicit user approval/answer; nothing has
        // been written to agy's transcript.jsonl.
        session.onThinkingChange(false);

        const waitAnswer = permissionHandler.askUser(slice.parkedCallId, cardToolName, cardToolInput);
        let checkTimer: ReturnType<typeof setInterval> | null = null;
        const superseded = new Promise<'superseded'>((resolve) => {
            const check = () => {
                if (this.shouldExit || abortController.signal.aborted || session.queue.isClosed()) {
                    resolve('superseded');
                    return;
                }
                if (session.queue.size() > 0) {
                    resolve('superseded');
                    return;
                }
                if (
                    this.pendingIdleModeSync
                    && isAgySkipPermissionsMode(session.getPermissionMode() as PermissionMode | undefined) !== this.backendSkipPermissions
                ) {
                    resolve('superseded');
                }
            };
            this.idleConfigWake = check;
            abortController.signal.addEventListener('abort', check, { once: true });
            checkTimer = setInterval(check, Math.max(10, Math.min(this.reactivePollMs, 50)));
            checkTimer.unref?.();
        });

        let outcome: Awaited<typeof waitAnswer> | 'superseded';
        try {
            outcome = await Promise.race([waitAnswer, superseded]);
        } finally {
            if (checkTimer) clearInterval(checkTimer);
            this.idleConfigWake = null;
        }

        if (abortController.signal.aborted) {
            this.syncTranscriptCursor();
            await this.advanceBackendCursor();
            session.onThinkingChange(false);
            if (session.queue.size() === 0 && !this.shouldExit) {
                session.sendSessionEvent({ type: 'ready' });
            }
            return;
        }

        if (outcome === 'superseded' || outcome.decision === 'abort') {
            await this.permissionHandler?.cancelAll('Superseded');
            // Advance past any already-emitted prefix steps if a mode switch or
            // user message took over before answering the card, while keeping
            // pendingParkedResolution's preEmittedTexts for deduplication.
            if (session.queue.size() > 0) {
                this.pendingParkedResolution = {
                    parkedCallId: slice.parkedCallId,
                    toolName: parkedCall.toolName,
                    aliasedLiveId: null,
                    decisionConsumed: true,
                    decision: 'denied',
                    preEmittedTexts: slice.preEmittedTexts
                };
            } else {
                this.pausedWakeupStepIndex = steps[steps.length - 1]?.step_index ?? null;
            }
            return;
        }

        if (this.reactiveWakeupAbort === abortController) {
            this.reactiveWakeupAbort = null;
        }

        if (outcome.mode) {
            session.setPermissionMode(outcome.mode as PermissionMode);
            this.pendingIdleModeSync = false;
        }

        const userActionText = formatParkedUserActionText(parkedCall, isQuestion, {
            decision: outcome.decision,
            reason: outcome.reason,
            answers: outcome.answers
        });
        session.sendUserMessage(userActionText);

        this.pendingParkedResolution = {
            parkedCallId: slice.parkedCallId,
            toolName: parkedCall.toolName,
            aliasedLiveId: null,
            decisionConsumed: false,
            decision: outcome.decision,
            ...(outcome.answers ? { answers: outcome.answers } : {}),
            ...(this.questionLabels.has(slice.parkedCallId)
                ? { shownLabels: this.questionLabels.get(slice.parkedCallId)! }
                : {}),
            preEmittedTexts: slice.preEmittedTexts
        };

        const mode = this.currentWakeupMode();
        const modeHash = session.queue.modeHasher(mode);
        await this.runTurn(userActionText, mode, modeHash, [], {
            replayAfterStepIndex,
            userMessageAlreadyMirrored: true
        });
    }

    private async startBackend(resumeSessionId: string | null, skipPermissions?: boolean): Promise<void> {
        const session = this.session;
        const effectiveSkip = skipPermissions
            ?? isAgySkipPermissionsMode(session.getPermissionMode() as PermissionMode | undefined);
        const backend = this.createBackend({ skipPermissions: effectiveSkip });
        this.backend = backend;
        this.backendSkipPermissions = effectiveSkip;
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
                this.backgroundCommands.length = 0;
                this.retainedAmbiguousCompletions.length = 0;
                this.nativeToolNames.clear();
                this.syntheticCallAliases.clear();
            }
            if (this.acpSessionId !== acpSessionId) {
                this.lastTranscriptStepIndex = -1;
                this.pausedWakeupStepIndex = null;
                this.lastTurnTranscriptState = null;
            }
            this.acpSessionId = acpSessionId;
            this.syncTranscriptCursor();
            session.onSessionFound(acpSessionId);
            session.client.emitSessionReady();

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
                    resolvePreDecided: (request) => {
                        const pending = this.pendingParkedResolution;
                        if (!pending || pending.decisionConsumed || pending.toolName === 'ask_question') {
                            return null;
                        }
                        if (pending.aliasedLiveId && request.toolCallId !== pending.aliasedLiveId) {
                            return null;
                        }
                        if (!pending.aliasedLiveId && request.toolCallId) {
                            pending.aliasedLiveId = request.toolCallId;
                            this.syntheticCallAliases.set(request.toolCallId, pending.parkedCallId);
                            this.nativeToolNames.set(pending.parkedCallId, pending.toolName);
                        }
                        pending.decisionConsumed = true;
                        return pending.decision;
                    },
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
            if (this.backend === backend) {
                this.backend = null;
                this.backendSkipPermissions = null;
            }
            await this.retireBackend(backend);
            throw error;
        }
    }

    private async relaunchBackend(skipPermissions?: boolean): Promise<void> {
        const previous = this.backend;
        this.backend = null;
        this.backendSkipPermissions = null;
        if (previous) await this.retireBackend(previous);
        await this.startBackend(this.acpSessionId, skipPermissions);
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

        const effectiveModel = mode.model !== undefined ? mode.model : this.session.getModel();
        const effectiveEffort = mode.effort !== undefined ? mode.effort : this.session.getEffort();
        const modelId = resolveAgyAcpModelId(effectiveModel, effectiveEffort, this.defaultModelId);
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

    private async runTurn(
        message: string,
        mode: AgyMode,
        modeHash: string,
        localIds: string[],
        opts: { replayAfterStepIndex?: number; userMessageAlreadyMirrored?: boolean } = {}
    ): Promise<void> {
        const userMessageAlreadyMirrored = opts.userMessageAlreadyMirrored === true;
        const session = this.session;
        this.pendingIdleModeSync = false;
        this.lastTurnMode = mode;
        this.lastSessionModeSnapshot = {
            permissionMode: session.getPermissionMode() as PermissionMode | undefined,
            model: session.getModel(),
            effort: session.getEffort()
        };
        session.onThinkingChange(true);
        this.turnPermissionMode = mode.permissionMode;
        let releaseSteerWait!: () => void;
        const steerWaitReleased = new Promise<void>((resolve) => { releaseSteerWait = resolve; });
        let acknowledged = false;
        let answerMain!: () => void;
        const mainAnswered = new Promise<void>((resolve) => { answerMain = resolve; });
        const restoreIfUserTurn = () => {
            if (!userMessageAlreadyMirrored) this.restorePrompt(turn, message);
        };
        const turn: AgyTurn = {
            modeHash,
            aborted: false,
            stopReason: null,
            sentAt: null,
            answeredAt: null,
            generation: new GenerationClock(),
            openCommands: new Set(),
            commandCallIds: [],
            commandArrivalOrder: [],
            priorBackgroundCallIds: new Set(this.backgroundCommands.map((entry) => entry.callId)),
            deferredLiveCommandCalls: new Map(),
            corroboratedSyntheticMatches: 0,
            turnStartStepIndex: this.lastTranscriptStepIndex,
            streamedTextCounts: new Map(this.pendingParkedResolution?.preEmittedTexts ?? []),
            preEmittedTexts: new Map(this.pendingParkedResolution?.preEmittedTexts ?? []),
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
            steerWaitReleased
        };
        // Registered before any await so Stop can reach the turn while agy
        // restarts or switches settings.
        this.turn = turn;
        try {
            let relaunched = false;
            const wantSkip = isAgySkipPermissionsMode(mode.permissionMode);
            if (
                this.backendLost
                || !this.backend
                || !this.backend.isTransportAlive()
                || this.backendSkipPermissions !== wantSkip
            ) {
                try {
                    await this.relaunchBackend(wantSkip);
                    relaunched = true;
                } catch (error) {
                    this.reportTurnError(`Failed to restart Antigravity: ${errorMessage(error)}`);
                    restoreIfUserTurn();
                    return;
                }
            }
            const backend = this.backend;
            const acpSessionId = this.acpSessionId;
            if (!backend || !acpSessionId || turn.aborted) {
                restoreIfUserTurn();
                return;
            }
            if (!await this.applyTurnConfig(backend, acpSessionId, mode) || turn.aborted) {
                restoreIfUserTurn();
                return;
            }
            const preSyncStepIndex = this.lastTranscriptStepIndex;
            this.syncTranscriptCursor();
            const turnStartStepIndex = this.lastTranscriptStepIndex;
            let commandWindowAfterStepIndex = turnStartStepIndex;
            if (!relaunched) {
                const baseAfterStep = Math.min(
                    opts.replayAfterStepIndex ?? preSyncStepIndex,
                    preSyncStepIndex,
                    turnStartStepIndex
                );
                if (baseAfterStep < turnStartStepIndex) {
                    // Only rows from a pending autonomous `SYSTEM_MESSAGE` wakeup onward
                    // can be replayed by `agy`; earlier rows are late-flushed steps from
                    // the already-completed previous turn.
                    const interTurnSteps = readAgyTranscriptStepsAfter(this.brainDir, acpSessionId, baseAfterStep);
                    const firstWakeupStep = interTurnSteps.find(
                        (step) => step.source === 'SYSTEM' && step.type === 'SYSTEM_MESSAGE'
                    );
                    if (firstWakeupStep !== undefined) {
                        commandWindowAfterStepIndex = Math.max(baseAfterStep, firstWakeupStep.step_index - 1);
                    }
                }
            }
            turn.turnStartStepIndex = commandWindowAfterStepIndex;
            turn.priorBackgroundCallIds = new Set(this.backgroundCommands.map((entry) => entry.callId));
            resolveAgyBackgroundTaskIds(this.brainDir, acpSessionId, this.backgroundCommands, commandWindowAfterStepIndex);
            for (const entry of this.backgroundCommands) {
                if (!entry.taskId && entry.maxStepIndex === undefined) {
                    entry.maxStepIndex = commandWindowAfterStepIndex;
                }
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
                    restoreIfUserTurn();
                } else {
                    turn.acknowledge();
                }
            } catch (error) {
                logger.warn('[agy-acp] prompt failed', error);
                if (isAcpIndeterminateError(error)) this.backendLost = true;
                if (!turn.aborted) {
                    this.reportTurnError(`Antigravity prompt failed: ${errorMessage(error)}`);
                }
                if (!turn.sawActivity && turn.steersTaken === 0) restoreIfUserTurn();
                else turn.acknowledge();
            }
            // A steer makes agy answer the request it interrupts right away
            // (end_turn) while the turn goes on under the steer, so the turn
            // ends only when every open request has settled. Steers sent
            // during this wait extend it.
            await this.waitForSteers(turn);
            this.flushDeferredLiveCommandCalls(turn);
            if (!turn.aborted && !this.backendLost) {
                this.syncTurnTranscriptCursor(turn, turnStartStepIndex);
            }
            this.closeBackgroundCommands(turn, commandWindowAfterStepIndex);
        } finally {
            if (turn.aborted) this.syncTranscriptCursor();
            this.pendingParkedResolution = null;
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
                session.sendAgentMessage(agyRoundSummary(turn.usage, durationMs, this.currentModelId, generationMs));
            }
            session.onThinkingChange(false);
            await this.permissionHandler?.cancelAll('Prompt finished');
            if (session.queue.size() === 0 && !this.shouldExit) {
                session.sendSessionEvent({ type: 'ready' });
            }
        }
    }

    /**
     * agy sends nothing more for a command it moved to the background: its
     * completion arrives inside a later prompt's stream. Until then the card
     * would spin, so it shows the command as running in the background; the
     * real result replaces this one when it comes.
     */
    private closeBackgroundCommands(turn: AgyTurn, turnStartStepIndex: number): void {
        if (turn.aborted || this.backendLost || turn.stopReason !== 'end_turn') return;
        const openIds = [...turn.openCommands].sort((a, b) => {
            const ordA = turn.commandCallIds.indexOf(a);
            const ordB = turn.commandCallIds.indexOf(b);
            return (ordA >= 0 ? ordA : Number.MAX_SAFE_INTEGER) - (ordB >= 0 ? ordB : Number.MAX_SAFE_INTEGER);
        });
        const turnSteps = openIds.length > 0 && this.acpSessionId
            ? readAgyTranscriptStepsAfter(this.brainDir, this.acpSessionId, turnStartStepIndex)
            : [];
        const taskIds = extractAgyBackgroundTaskIds(turnSteps);
        for (let idx = 0; idx < openIds.length; idx += 1) {
            const id = openIds[idx]!;
            const callOrdinal = turn.commandCallIds.indexOf(id);
            const ordinalInTurn = callOrdinal >= 0 ? callOrdinal : idx;
            const taskId = taskIds[ordinalInTurn];
            const existing = this.backgroundCommands.find((entry) => entry.callId === id);
            if (!existing) {
                this.backgroundCommands.push({
                    callId: id,
                    afterStepIndex: turnStartStepIndex,
                    ordinalInTurn,
                    ...(taskId ? { taskId } : {})
                });
            } else if (taskId && !existing.taskId) {
                existing.taskId = taskId;
            }
            const placeholder = convertAgentMessage(
                { type: 'tool_result', id, output: AGY_BACKGROUND_COMMAND_RESULT, status: 'completed' },
                this.currentModelId
            );
            if (placeholder) this.session.sendAgentMessage(placeholder);
        }
        turn.openCommands.clear();
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
            if (this.turn === turn) {
                turn.answeredAt = Date.now();
            }
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

    private emitDeferredLiveCommandCall(
        turn: AgyTurn,
        callMessage: Extract<AgentMessage, { type: 'tool_call' }>
    ): void {
        turn.generation.observe(callMessage);
        this.trackOpenCommand(turn, callMessage, true);
        this.forwardAgentMessage(this.showQuestionCard(callMessage));
    }

    private flushDeferredLiveCommandCalls(turn: AgyTurn): void {
        if (turn.deferredLiveCommandCalls.size > 0) {
            const pending = [...turn.deferredLiveCommandCalls.values()];
            turn.deferredLiveCommandCalls.clear();
            for (const callMessage of pending) {
                this.emitDeferredLiveCommandCall(turn, callMessage);
            }
        }
        this.reconcileRetainedAmbiguousCompletions(turn);
    }

    private reconcileRetainedAmbiguousCompletions(turn: AgyTurn | null): void {
        const acpSessionId = this.acpSessionId;
        if (!acpSessionId || this.retainedAmbiguousCompletions.length === 0) return;

        let progressed = true;
        while (progressed && this.retainedAmbiguousCompletions.length > 0) {
            progressed = false;
            for (let idx = 0; idx < this.retainedAmbiguousCompletions.length; idx += 1) {
                const item = this.retainedAmbiguousCompletions[idx]!;
                const match = inspectSyntheticBackgroundCommandMatch(
                    this.brainDir,
                    acpSessionId,
                    this.backgroundCommands,
                    item.turnStartStepIndex,
                    {
                        liveCallId: item.resultMessage.id,
                        nativeArgs: item.nativeArgs,
                        resultOutput: item.resultMessage.output,
                        resultStatus: item.resultMessage.status
                    }
                );
                if (match.kind === 'matched') {
                    this.retainedAmbiguousCompletions.splice(idx, 1);
                    idx -= 1;
                    progressed = true;
                    if (turn) turn.corroboratedSyntheticMatches += 1;
                    this.nativeToolNames.set(match.entry.callId, 'run_command');
                    const effectiveResult: AgentMessage = { ...item.resultMessage, id: match.entry.callId };
                    if (turn) {
                        turn.generation.observe(effectiveResult);
                        this.trackOpenCommand(turn, effectiveResult, false);
                    } else {
                        const bgIdx = this.backgroundCommands.findIndex((entry) => entry.callId === match.entry.callId);
                        if (bgIdx >= 0) this.backgroundCommands.splice(bgIdx, 1);
                    }
                    this.forwardAgentMessage(this.showQuestionCard(effectiveResult));
                } else if (match.kind === 'none') {
                    this.retainedAmbiguousCompletions.splice(idx, 1);
                    idx -= 1;
                    progressed = true;
                    if (item.callMessage && turn) {
                        this.emitDeferredLiveCommandCall(turn, item.callMessage);
                    } else if (item.callMessage) {
                        this.forwardAgentMessage(this.showQuestionCard(item.callMessage));
                    }
                    if (turn) {
                        turn.generation.observe(item.resultMessage);
                        this.trackOpenCommand(turn, item.resultMessage, false);
                    }
                    this.forwardAgentMessage(this.showQuestionCard(item.resultMessage));
                }
            }
        }
    }

    private reconcileSyntheticCommandMessage(
        turn: AgyTurn,
        message: AgentMessage
    ): { message: AgentMessage; suppressForward: boolean; recordCallOrdinal?: boolean; skipTracking?: boolean } {
        if ((message.type === 'tool_call' || message.type === 'tool_result') && this.syntheticCallAliases.has(message.id)) {
            const syntheticId = this.syntheticCallAliases.get(message.id)!;
            const isParkedCall = this.pendingParkedResolution?.parkedCallId === syntheticId;
            if (message.type === 'tool_result') {
                this.syntheticCallAliases.delete(message.id);
            }
            return {
                message: { ...message, id: syntheticId },
                suppressForward: message.type === 'tool_call',
                ...(isParkedCall ? { recordCallOrdinal: true } : {})
            };
        }
        const pendingParked = this.pendingParkedResolution;
        if (
            pendingParked
            && !pendingParked.decisionConsumed
            && pendingParked.aliasedLiveId === null
            && message.type === 'tool_call'
            && (message.nativeName === pendingParked.toolName || message.name === pendingParked.toolName)
        ) {
            pendingParked.aliasedLiveId = message.id;
            this.syntheticCallAliases.set(message.id, pendingParked.parkedCallId);
            this.nativeToolNames.set(pendingParked.parkedCallId, pendingParked.toolName);
            return {
                message: { ...message, id: pendingParked.parkedCallId },
                suppressForward: true,
                recordCallOrdinal: true
            };
        }
        const acpSessionId = this.acpSessionId;
        if (!acpSessionId) return { message, suppressForward: false };

        if (
            message.type === 'tool_call'
            && message.nativeName === 'run_command'
            && message.status !== 'pending'
            && !turn.commandCallIds.includes(message.id)
            && !turn.priorBackgroundCallIds.has(message.id)
        ) {
            if (!turn.commandArrivalOrder.includes(message.id)) {
                turn.commandArrivalOrder.push(message.id);
            }
            const nativeArgs = message.nativeArgs && typeof message.nativeArgs === 'object' && !Array.isArray(message.nativeArgs)
                ? (message.nativeArgs as Record<string, unknown>)
                : undefined;
            const match = inspectSyntheticBackgroundCommandMatch(
                this.brainDir,
                acpSessionId,
                this.backgroundCommands,
                turn.turnStartStepIndex,
                { liveCallId: message.id, nativeArgs, callStatus: message.status }
            );
            if (match.kind === 'matched') {
                turn.deferredLiveCommandCalls.delete(message.id);
                turn.commandArrivalOrder = turn.commandArrivalOrder.filter((id) => id !== message.id);
                turn.corroboratedSyntheticMatches += 1;
                this.syntheticCallAliases.set(message.id, match.entry.callId);
                return { message: { ...message, id: match.entry.callId }, suppressForward: true };
            }
            if (match.kind === 'ambiguous') {
                turn.deferredLiveCommandCalls.set(message.id, message);
                return { message, suppressForward: true, skipTracking: true };
            }
            turn.deferredLiveCommandCalls.delete(message.id);
        }

        if (message.type === 'tool_result') {
            const deferredCall = turn.deferredLiveCommandCalls.get(message.id);
            if (deferredCall) {
                turn.deferredLiveCommandCalls.delete(message.id);
            }
            if (deferredCall || !this.nativeToolNames.has(message.id)) {
                const nativeArgs = deferredCall?.nativeArgs
                    && typeof deferredCall.nativeArgs === 'object'
                    && !Array.isArray(deferredCall.nativeArgs)
                    ? (deferredCall.nativeArgs as Record<string, unknown>)
                    : undefined;
                const match = inspectSyntheticBackgroundCommandMatch(
                    this.brainDir,
                    acpSessionId,
                    this.backgroundCommands,
                    turn.turnStartStepIndex,
                    {
                        liveCallId: message.id,
                        nativeArgs,
                        resultOutput: message.output,
                        resultStatus: message.status
                    }
                );
                if (match.kind === 'matched') {
                    turn.corroboratedSyntheticMatches += 1;
                    this.nativeToolNames.set(match.entry.callId, 'run_command');
                    return { message: { ...message, id: match.entry.callId }, suppressForward: false };
                }
                if (match.kind === 'ambiguous') {
                    this.retainedAmbiguousCompletions.push({
                        turnStartStepIndex: turn.turnStartStepIndex,
                        callMessage: deferredCall,
                        resultMessage: message,
                        nativeArgs
                    });
                    return { message, suppressForward: true, skipTracking: true };
                }
                if (deferredCall) {
                    this.emitDeferredLiveCommandCall(turn, deferredCall);
                }
            }
        }

        return { message, suppressForward: false };
    }

    private handleTurnUpdate(turn: AgyTurn, message: AgentMessage): void {
        switch (message.type) {
            case 'usage':
                turn.usage = addAgyUsage(turn.usage, message);
                return;
            case 'turn_complete':
                turn.stopReason = message.stopReason;
                return;
            default: {
                turn.sawActivity = true;
                turn.acknowledge();
                const reconciled = this.reconcileSyntheticCommandMessage(turn, message);
                if (reconciled.skipTracking) {
                    return;
                }
                const effective = reconciled.message;
                turn.generation.observe(effective);
                if (effective.type === 'text' && !effective.live) {
                    const trimmed = effective.text.trim();
                    if (trimmed) {
                        const preEmittedCount = turn.preEmittedTexts.get(trimmed) ?? 0;
                        if (preEmittedCount > 0) {
                            turn.preEmittedTexts.set(trimmed, preEmittedCount - 1);
                            return;
                        }
                        turn.streamedTextCounts.set(trimmed, (turn.streamedTextCounts.get(trimmed) ?? 0) + 1);
                    }
                }
                this.trackOpenCommand(turn, effective, reconciled.recordCallOrdinal ?? !reconciled.suppressForward);
                if (!reconciled.suppressForward) {
                    this.forwardAgentMessage(this.showQuestionCard(effective));
                }
                if (effective.type === 'tool_result' && this.retainedAmbiguousCompletions.length > 0) {
                    this.reconcileRetainedAmbiguousCompletions(turn);
                }
            }
        }
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

        const pendingParked = this.pendingParkedResolution;
        if (
            pendingParked
            && !pendingParked.decisionConsumed
            && pendingParked.toolName === 'ask_question'
            && (!pendingParked.aliasedLiveId || !form.toolCallId || pendingParked.aliasedLiveId === form.toolCallId)
        ) {
            if (!pendingParked.aliasedLiveId && form.toolCallId) {
                pendingParked.aliasedLiveId = form.toolCallId;
                this.syntheticCallAliases.set(form.toolCallId, pendingParked.parkedCallId);
                this.nativeToolNames.set(pendingParked.parkedCallId, 'ask_question');
            }
            pendingParked.decisionConsumed = true;
            if (pendingParked.decision === 'denied') return { action: 'decline' };
            const content = agyQuestionContent(form.questions, pendingParked.answers, pendingParked.shownLabels);
            return Object.keys(content).length > 0 ? { action: 'accept', content } : { action: 'decline' };
        }

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
    private trackOpenCommand(turn: AgyTurn, message: AgentMessage, recordCallOrdinal = true): void {
        if (message.type !== 'tool_call' && message.type !== 'tool_result') return;
        const isPriorBackground = turn.priorBackgroundCallIds.has(message.id)
            || this.backgroundCommands.some((entry) => entry.callId === message.id);
        if (isPriorBackground) {
            turn.priorBackgroundCallIds.add(message.id);
        }
        if (
            recordCallOrdinal
            && !isPriorBackground
            && message.type === 'tool_call'
            && message.nativeName === 'run_command'
        ) {
            if (!turn.commandArrivalOrder.includes(message.id)) {
                turn.commandArrivalOrder.push(message.id);
            }
            if (!turn.commandCallIds.includes(message.id)) {
                turn.commandCallIds.push(message.id);
                turn.commandCallIds.sort(
                    (a, b) => turn.commandArrivalOrder.indexOf(a) - turn.commandArrivalOrder.indexOf(b)
                );
            }
        }
        // Only a command agy reports as running counts: one still waiting
        // for approval (pending) did not start, whatever happens to the turn.
        if (message.type === 'tool_call' && message.nativeName === 'run_command' && message.status === 'in_progress') {
            turn.openCommands.add(message.id);
        } else if (message.status !== 'in_progress') {
            turn.openCommands.delete(message.id);
            const bgIdx = this.backgroundCommands.findIndex((entry) => entry.callId === message.id);
            if (bgIdx >= 0) this.backgroundCommands.splice(bgIdx, 1);
        }
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
            if (!this.backgroundCommands.some((entry) => entry.callId === message.id)) {
                this.nativeToolNames.delete(message.id);
            }
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
        const turn = this.turn;
        const wakeupAbort = this.reactiveWakeupAbort;
        if (wakeupAbort) {
            this.reactiveWakeupAbort = null;
            wakeupAbort.abort();
        }
        if (turn) {
            turn.aborted = true;
            this.session.client.updateAgentState((state) => ({ ...state, steeringActive: false }));
        }
        const backend = this.backend;
        const acpSessionId = this.acpSessionId;
        if (backend && acpSessionId && backend.isTransportAlive()) {
            if (turn) {
                // ACP cancel also ends open tool calls (the hard stop, unlike steer);
                // their final updates still flow to this turn's handler.
                await backend.cancelPrompt(acpSessionId);
                // prompt() waits for the previous turn's output to settle before it
                // sends; a cancel in that window reaches agy before the prompt.
                if (!backend.isPromptRequestInFlight()) this.cancelOnceSent(backend, acpSessionId, turn);
                if (turn.steers.length > 0) this.dropUnansweredSteers(backend, turn);
                this.restartIfCancelIgnored(backend, turn);
            } else if (wakeupAbort) {
                await backend.cancelPrompt(acpSessionId);
            }
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
        const hadTurn = this.turn !== null || this.reactiveWakeupAbort !== null;
        await this.cancelActiveTurn();
        this.abortController.abort();
        this.abortController = new AbortController();
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
        this.session.onPermissionModeChanged = null;
        this.idleConfigWake = null;
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);
        this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.SteerQueuedMessage, async () => ({
            steered: false,
            error: 'Session ending'
        }));
        this.session.client.updateAgentState((state) => ({ ...state, steeringActive: false }));
        await this.permissionHandler?.cancelAll('Session ended');
        this.permissionHandler = null;
        const backend = this.backend;
        this.backend = null;
        this.backendSkipPermissions = null;
        await backend?.disconnect();
        logger.debug('[agy-acp] cleanup done');
    }
}

function formatParkedUserActionText(
    parkedCall: AgyParkedWakeupCall,
    isQuestion: boolean,
    outcome: {
        decision: 'approved' | 'approved_for_session' | 'denied';
        reason?: string;
        answers?: Record<string, string[]>;
    }
): string {
    if (isQuestion) {
        if (outcome.decision === 'denied') {
            return outcome.reason ? `Declined question: ${outcome.reason}` : 'Declined question.';
        }
        const selected = Object.values(outcome.answers ?? {})
            .flat()
            .map((entry) => entry.trim())
            .filter(Boolean);
        return selected.length > 0 ? `Answered question: ${selected.join(', ')}` : 'Answered question.';
    }

    const detail = typeof parkedCall.decodedArgs.CommandLine === 'string' && parkedCall.decodedArgs.CommandLine.trim()
        ? parkedCall.decodedArgs.CommandLine.trim()
        : typeof parkedCall.decodedArgs.Path === 'string' && parkedCall.decodedArgs.Path.trim()
            ? parkedCall.decodedArgs.Path.trim()
            : parkedCall.toolName;
    if (outcome.decision === 'denied') {
        return outcome.reason ? `Denied: ${detail} (${outcome.reason})` : `Denied: ${detail}`;
    }
    return `Approved: ${detail}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** agy releases before 1.5.0 have no `acp` subcommand, so name the floor. */
function describeAgyStartFailure(error: unknown): string {
    return `Failed to start agy acp (requires Antigravity CLI 1.5.0 or newer): ${errorMessage(error)}`;
}

export async function agyAcpRemoteLauncher(session: AgySession): Promise<'switch' | 'exit'> {
    const launcher = new AgyAcpRemoteLauncher(session);
    return launcher.launch();
}
