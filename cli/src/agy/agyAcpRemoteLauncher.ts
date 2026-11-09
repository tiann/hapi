import React from 'react';
import { randomUUID } from 'node:crypto';
import { RPC_METHODS, splitAgyModelSelection } from '@hapi/protocol';
import { logger } from '@/ui/logger';
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay';
import { convertAgentMessage } from '@/agent/messageConverter';
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
import type { AgyMode, PermissionMode } from './types';
import { createAgyAcpBackend } from './utils/agyAcpBackend';
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

type TimeWindow = { start: number; end: number | null };

/**
 * agy reports no per-step timing, so generation time is the round minus the
 * spans spent running tools or waiting for the user. Spans are clipped to the
 * round and merged, so overlaps count once; an open span ends with the round.
 */
export function agyGenerationMs(sentAt: number | null, answeredAt: number | null, windows: TimeWindow[]): number | null {
    if (sentAt === null || answeredAt === null || answeredAt <= sentAt) return null;
    const clipped = windows
        .map(({ start, end }) => ({ start: Math.max(start, sentAt), end: Math.min(end ?? answeredAt, answeredAt) }))
        .filter(({ start, end }) => end > start)
        .sort((a, b) => a.start - b.start);
    let excluded = 0;
    let coveredUntil = sentAt;
    for (const { start, end } of clipped) {
        const from = Math.max(start, coveredUntil);
        if (end > from) excluded += end - from;
        coveredUntil = Math.max(coveredUntil, end);
    }
    return answeredAt - sentAt - excluded;
}

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
    // Tool runs and waits for the user, which are not generation time.
    idleWindows: TimeWindow[];
    toolWindows: Map<string, TimeWindow>;
    // Commands agy has not reported an end for; one still open at end_turn was
    // moved to the background.
    openCommands: Set<string>;
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
    private backendLost = false;

    constructor(session: AgySession, opts: {
        createBackend?: () => AcpSdkBackend;
        steerCancelGraceMs?: number;
        cancelHardStopMs?: number;
        killSettleMs?: number;
    } = {}) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.createBackend = opts.createBackend ?? createAgyAcpBackend;
        this.steerCancelGraceMs = opts.steerCancelGraceMs ?? STEER_CANCEL_GRACE_MS;
        this.cancelHardStopMs = opts.cancelHardStopMs ?? CANCEL_HARD_STOP_MS;
        this.killSettleMs = opts.killSettleMs ?? KILL_SETTLE_MS;
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
                        const window: TimeWindow = { start: Date.now(), end: null };
                        turn.idleWindows.push(window);
                        return () => { window.end ??= Date.now(); };
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
            idleWindows: [],
            toolWindows: new Map(),
            openCommands: new Set(),
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
            this.closeBackgroundCommands(turn);
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
            // agy's usage adds up every model call of a request, so it is not a
            // context size: it goes to the response footer, not the context
            // indicator (no token_count).
            if (turn.usage) {
                // agy's own time: HAPI's waits before sending and for late
                // output are not part of it.
                const durationMs = turn.sentAt !== null && turn.answeredAt !== null
                    ? Math.max(0, turn.answeredAt - turn.sentAt)
                    : null;
                const generationMs = turn.sawActivity
                    ? agyGenerationMs(turn.sentAt, turn.answeredAt, turn.idleWindows)
                    : null;
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
    private closeBackgroundCommands(turn: AgyTurn): void {
        if (turn.aborted || this.backendLost || turn.stopReason !== 'end_turn') return;
        for (const id of turn.openCommands) {
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

    private handleTurnUpdate(turn: AgyTurn, message: AgentMessage): void {
        switch (message.type) {
            case 'usage':
                turn.usage = addAgyUsage(turn.usage, message);
                return;
            case 'turn_complete':
                turn.stopReason = message.stopReason;
                return;
            default:
                turn.sawActivity = true;
                turn.acknowledge();
                this.trackToolWindow(turn, message);
                this.forwardAgentMessage(this.showQuestionCard(message));
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

    private trackToolWindow(turn: AgyTurn, message: AgentMessage): void {
        if (message.type !== 'tool_call' && message.type !== 'tool_result') return;
        // Only a command agy reports as running counts: one still waiting
        // for approval (pending) did not start, whatever happens to the turn.
        if (message.type === 'tool_call' && message.nativeName === 'run_command' && message.status === 'in_progress') {
            turn.openCommands.add(message.id);
        } else if (message.status !== 'in_progress') {
            turn.openCommands.delete(message.id);
        }
        const now = Date.now();
        let window = turn.toolWindows.get(message.id);
        if (!window) {
            window = { start: now, end: null };
            turn.toolWindows.set(message.id, window);
            turn.idleWindows.push(window);
        }
        if (message.status === 'completed' || message.status === 'failed') window.end ??= now;
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
        const turn = this.turn;
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
        const hadTurn = this.turn !== null;
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
        await backend?.disconnect();
        logger.debug('[agy-acp] cleanup done');
    }
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
