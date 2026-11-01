import React from 'react';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from '@/ui/logger';
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay';
import { AgyPlannerAccumulator, parseAgyNdjsonLine } from './agyNdjsonParser';
import type { AgySession } from '../session';
import type { AgyMode, PermissionMode } from '../types';
import type { AgyTranscriptEntry, AgyToolCall } from '../utils/agyTranscriptTypes';
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason,
} from '@/modules/common/remote/RemoteLauncherBase';
import { createNativeSessionTitleMetadataSync } from '@/agent/nativeSessionTitle';
import { readAgyConversationTitle } from '../utils/agySessionTitle';
import { resolveAgyTurnModels } from '../utils/agyConversationModel';
import { AgyStreamProcess } from './agyStreamProcess';
import { AGY_EFFORT_LEVELS, AGY_MODEL_LABELS, splitAgyModelSelection, type AgyEffortLevel } from '@hapi/protocol';
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand';

const AGY_PRINT_TIMEOUT = '30m';

// Bound on consecutive turns agy fails to accept (spawn error, crash, exit
// before any transcript output). Beyond this the prompt is restored to the
// composer rather than retried indefinitely.
const MAX_UNACCEPTED_RETRIES = 3;

/** Build the persistent process arguments. Prompts travel only over stdin. */
export function buildAgyHeadlessArgs(opts: {
    conversationId?: string;
    model?: string;
    permissionMode: PermissionMode;
    mode?: 'accept-edits' | 'plan';
    effort?: AgyEffortLevel;
}): string[] {
    const selection = splitAgyModelSelection(opts.model);
    if (selection.effort && opts.effort && selection.effort !== opts.effort) {
        throw new Error(`Antigravity model ${opts.model} conflicts with effort ${opts.effort}`);
    }
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
    if (opts.conversationId) {
        args.push('--conversation', opts.conversationId);
    }
    if (opts.model) {
        args.push('--model', opts.model);
    }
    if (opts.mode) {
        args.push('--mode', opts.mode);
    }
    if (opts.effort && !selection.effort) {
        args.push('--effort', opts.effort);
    }
    args.push('--print-timeout', AGY_PRINT_TIMEOUT);
    if (opts.permissionMode === 'always-proceed') {
        args.push('--dangerously-skip-permissions');
    }
    return args;
}

/**
 * Build the spawn env for the persistent agy process. Mirrors the model-probe
 * hardening (agyModels.ts): GEMINI_FORCE_FILE_STORAGE makes agy read the saved
 * OAuth file token directly instead of the keyring.
 *
 * SSH handling differs from the removed PTY wrapper: the TUI path stripped
 * EVERY SSH_* var (the keyring auth path degraded on SSH sessions), but the
 * headless process executes workspace tools (run_command, git, …) that may need
 * the forwarded SSH agent. Only the session markers are removed (so agy does not
 * classify the run as an SSH session and switch auth paths); SSH_AUTH_SOCK and
 * SSH_AGENT_PID are kept for tool subprocesses.
 */
function buildAgySpawnEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, GEMINI_FORCE_FILE_STORAGE: 'true' }
    for (const key of ['SSH_CLIENT', 'SSH_CONNECTION', 'SSH_TTY']) {
        delete env[key]
    }
    return env
}

export type AgyHeadlessDriverOptions = {
    session: AgySession;
    /** Injectable for tests; production spawns the real agy binary. */
    spawnAgy?: (args: string[], cwd: string) => ChildProcessWithoutNullStreams;
};

/** Persistent NDJSON transport. One process serves sequential turns until its
 * queued launch config changes, it fails, or the user interrupts it. */
export class AgyHeadlessDriver extends RemoteLauncherBase {
    private readonly session: AgySession;
    private readonly spawnAgy: (args: string[], cwd: string) => ChildProcessWithoutNullStreams;
    private readonly syncNativeTitle: (title: unknown) => void;
    /** Aborted on exit/switch/kill so an idle queue wait resolves immediately. */
    private readonly loopAbortController = new AbortController();
    private process: AgyStreamProcess | null = null;
    private turnAbortController: AbortController | null = null;
    /** Brain conversation UUID — from resume seed or the first turn's init event. */
    private conversationId: string | null;

    constructor(opts: AgyHeadlessDriverOptions) {
        super(process.env.DEBUG ? opts.session.logPath : undefined);
        this.session = opts.session;
        this.spawnAgy = opts.spawnAgy ?? ((args, cwd) => {
            const child = spawn(getAgentLaunchCommand('agy'), args, {
                cwd,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: buildAgySpawnEnv(),
            }) as ChildProcessWithoutNullStreams;
            return child;
        });
        this.syncNativeTitle = createNativeSessionTitleMetadataSync(this.session.client);
        this.conversationId = this.session.sessionId;
        this.session.setKillHandler(() => this.abort());
        this.session.cancelRetryDelivery = this.cancelRetryItem;
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, context);
    }

    /**
     * A requeued (unaccepted) delivery waiting out the retry backoff. Finalization
     * clears activeWebPrompt/activeLocalIds when a turn finishes, so whole-session
     * shutdown during the backoff would otherwise find nothing to restore and the
     * session-end sweep would stamp the unacknowledged row invoked. Items keep
     * per-message localIds so a Cancel during the backoff can remove individual
     * messages even though the batch is outside MessageQueue2.
     */
    private retryDelivery: {
        text: string;
        localIds: string[];
        items: Array<{ message: string; localId?: string }>;
        mode: AgyMode;
        isolate: boolean;
    } | null = null;
    /** Set when every retry item was canceled during the backoff. */
    private retryFullyCancelled = false;

    /** Cancel a message held in retry backoff (returns false when not found). */
    private cancelRetryItem = (localId: string): boolean => {
        const retry = this.retryDelivery;
        if (!retry) return false;
        const remaining = retry.items.filter((item) => item.localId !== localId);
        if (remaining.length === retry.items.length) return false;
        if (remaining.length === 0) {
            this.retryDelivery = null;
            // Fully canceled: the requeue-after-backoff must not resurrect it.
            this.retryFullyCancelled = true;
            return true;
        }
        this.retryDelivery = {
            ...retry,
            items: remaining,
            text: remaining.map((item) => item.message).join('\n'),
            localIds: remaining
                .map((item) => item.localId)
                .filter((id): id is string => Boolean(id)),
        };
        return true;
    };

    private restoreRetryDelivery(): void {
        const delivery = this.retryDelivery;
        this.retryDelivery = null;
        this.retryFullyCancelled = false;
        if (!delivery) return;
        if (delivery.localIds.length > 0) {
            this.session.client.emitMessagesConsumed(delivery.localIds);
        }
        this.session.client.sendSessionEvent({ type: 'abort-restore', text: delivery.text });
    }

    /**
     * Retry backoff that honors an interrupt: resolves true after the delay, or
     * false immediately when the turn controller is aborted (Stop pressed).
     */
    private waitForRetryBackoff(signal: AbortSignal): Promise<boolean> {
        return new Promise((resolve) => {
            if (signal.aborted) {
                resolve(false);
                return;
            }
            const onAbort = () => {
                clearTimeout(timer);
                resolve(false);
            };
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve(true);
            }, 1500);
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    /**
     * Snapshot the in-flight delivery and restore it to the composer (consuming
     * the hub row so it is neither replayed nor swept). Must run BEFORE any kill:
     * turn finalization clears both fields via resetTurn.
     */
    private snapshotAndRestoreDelivery(): void {
        const prompt = this.activeWebPrompt;
        const localIds = [...this.activeLocalIds];
        this.activeWebPrompt = null;
        this.activeLocalIds = [];
        if (!prompt) return;
        if (localIds.length > 0) {
            this.session.client.emitMessagesConsumed(localIds);
        }
        this.session.client.sendSessionEvent({ type: 'abort-restore', text: prompt });
    }

    /** True while an accepted turn is finalizing its record and awaiting
     * model resolution / transcript sends. During this
     * window the delivery is already accepted, so Stop/kill must not restore or
     * abort it. */
    private turnFinalizing = false;
    /** True once the authoritative result envelope was parsed (before close). */
    private turnCompleted = false;

    /** The in-flight turn promise; awaited during finalization so teardown cannot
     * close the API session before transcript/ack sends finish. */
    private activeTurn: Promise<boolean> | null = null;

    /**
     * Whole-session teardown (exit/switch/kill). Also consumes + restores any
     * in-flight prompt: runTurn already removed the batch from the queue, and the
     * session-end sweep would otherwise stamp the unacknowledged row invoked with
     * no replayable or restored copy.
     */
    private async abort(): Promise<void> {
        this.loopAbortController.abort();
        if (this.turnCompleted || this.turnFinalizing) {
            // The turn is accepted (result parsed) or finalizing (turn finalizer
            // awaiting model resolution / transcript sends): wait for it so the
            // final response and acks land before the API session closes. No
            // restore/abort — the prompt completed. Mark the interrupt on the
            // controller so a signal-style close is not misreported as a crash.
            if (this.turnCompleted) {
                this.turnAbortController?.abort();
            }
            await this.terminateChild();
            await this.activeTurn;
            return;
        }
        this.snapshotAndRestoreDelivery();
        this.restoreRetryDelivery();
        this.turnAbortController?.abort();
        await this.terminateChild();
        // Let turn finalization finish (its restore/ack work is already decided
        // by the snapshot above; the turn promise must settle before teardown
        // closes the API session).
        await this.activeTurn;
    }

    protected getCurrentSessionId(): string | null {
        return this.conversationId;
    }

    private async syncTitleIfKnown(): Promise<void> {
        if (!this.conversationId) return;
        try {
            this.syncNativeTitle(await readAgyConversationTitle(this.conversationId));
        } catch {
            // Title sync is best-effort; the conversation DB may not exist yet.
        }
    }

    /**
     * Terminate the child AND its process tree (agy tool subprocesses such as
     * run_command may outlive the direct child; a bare SIGTERM would leave them
     * mutating the workspace after the turn is reported aborted). Awaits the
     * TERM-to-KILL escalation so session shutdown cannot exit before the tree is
     * actually gone.
     */
    private async terminateChild(graceful = false): Promise<void> {
        const process = this.process;
        if (!process) return;
        await process.retire(graceful);
        if (this.process === process) this.process = null;
    }

    private async getOrStartProcess(args: string[], signal: AbortSignal): Promise<AgyStreamProcess | null> {
        // Conversation ids are discovered after launch and are deliberately not
        // part of the config key: adopting init must not restart the warm process.
        const configKey = JSON.stringify(args);
        if (this.process && (this.process.configKey !== configKey || !this.process.reusable)) {
            await this.terminateChild(true);
        }
        if (signal.aborted || this.loopAbortController.signal.aborted || this.exitReason) return null;
        if (!this.process) {
            const spawnArgs = this.conversationId ? [...args, '--conversation', this.conversationId] : args;
            // Prompts are never included in args or debug logs.
            logger.debug(`[agy-headless] spawn: agy ${spawnArgs.join(' ')}`);
            this.process = new AgyStreamProcess(this.spawnAgy(spawnArgs, this.session.path), configKey);
        }
        return this.process;
    }

    private async handleAbortRequest(): Promise<void> {
        logger.debug('[agy-headless]: handleAbortRequest (interrupt)');
        // A turn that already parsed its result envelope or is in finalization has
        // accepted its delivery — do not restore or abort it (resending could
        // repeat tool side effects).
        if (this.turnCompleted || this.turnFinalizing) {
            // Mark the interrupt on the controller so turn finalization reports
            // 'Turn aborted' (or nothing when the result already landed) instead
            // of a process failure. Do NOT restore — the prompt completed.
            this.turnAbortController?.abort();
            await this.terminateChild();
            return;
        }
        // Snapshot BEFORE the kill: turn finalization (triggered by process
        // termination) resolves the turn and clears activeWebPrompt/activeLocalIds
        // via resetTurn — reading them after the wait would find nothing.
        this.snapshotAndRestoreDelivery();

        this.turnAbortController?.abort();
        await this.terminateChild();
    }

    private async handleExitFromUi(): Promise<void> {
        logger.debug('[agy-headless]: Exiting via Ctrl-C');
        await this.requestExit('exit', async () => {
            await this.abort();
        });
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        // AGY is remote-only: no local mode exists, so no double-space switch
        // action is exposed (an active turn would be aborted without the
        // interrupt handler's abort-restore recovery).
        return this.start({
            onExit: () => this.handleExitFromUi(),
        });
    }

    private describeFailure(code: number | null, stderrTail: string): string {
        const stderr = stderrTail.trim();
        if (/authentication|not signed in|keyring/i.test(stderr)) {
            return 'agy failed to authenticate. Ensure the login keyring is unlocked.';
        }
        if (/quota|limit/i.test(stderr)) {
            return 'Antigravity quota reached';
        }
        return `agy exited with code ${code ?? 'unknown'}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`;
    }

    /**
     * Per-turn prompt currently in flight; surfaced to the web via an
     * abort-restore event so the composer can bring it back after an interrupt.
     */
    private activeWebPrompt: string | null = null;
    /** Local ids of the in-flight delivery (for abort-time acknowledgement). */
    private activeLocalIds: string[] = [];

    /** Serve one queued delivery; only native activity/result proves acceptance. */
    private async runTurn(
        prompt: string,
        localIds: string[],
        mode: AgyMode,
        signal: AbortSignal,
    ): Promise<boolean> {
        const onAbort = () => { void this.terminateChild(); };
        signal.addEventListener('abort', onAbort, { once: true });
        const sessionModel = mode.model ?? undefined;
        const sessionEffort = mode.effort ?? undefined;
        const variantModel = sessionModel && sessionEffort && !splitAgyModelSelection(sessionModel).effort
            ? `${sessionModel}-${sessionEffort}` : sessionModel;
        const variantLabel = variantModel ? AGY_MODEL_LABELS[variantModel as keyof typeof AGY_MODEL_LABELS] : undefined;
        const turnModel = typeof sessionModel === 'string' && sessionModel
            ? variantLabel ?? AGY_MODEL_LABELS[sessionModel as keyof typeof AGY_MODEL_LABELS]
                ?? (splitAgyModelSelection(variantModel).effort ? variantModel : sessionModel)
            : undefined;
        let args: string[];
        try {
            if (!prompt.trim()) throw new Error('Antigravity requires a non-empty prompt');
            args = buildAgyHeadlessArgs({
                model: sessionModel,
                permissionMode: mode.permissionMode,
                effort: (AGY_EFFORT_LEVELS as readonly unknown[]).includes(sessionEffort)
                    ? sessionEffort as AgyEffortLevel : undefined,
            });
        } catch (error) {
            if (localIds.length > 0) this.session.client.emitMessagesConsumed(localIds);
            this.session.client.sendSessionEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) });
            this.session.client.sendSessionEvent({ type: 'abort-restore', text: prompt });
            signal.removeEventListener('abort', onAbort);
            return true;
        }

        this.session.onThinkingChange(true);
        this.activeWebPrompt = prompt;
        this.activeLocalIds = localIds;
        this.turnFinalizing = false;
        this.turnCompleted = false;
        const resetTurn = () => {
            this.session.onThinkingChange(false);
            this.activeWebPrompt = null;
            this.activeLocalIds = [];
            this.turnFinalizing = false;
            this.turnCompleted = false;
            signal.removeEventListener('abort', onAbort);
        };
        let stream: AgyStreamProcess;
        try {
            const process = await this.getOrStartProcess(args, signal);
            if (!process) {
                this.snapshotAndRestoreDelivery();
                resetTurn();
                return false;
            }
            stream = process;
        } catch (error) {
            this.session.client.sendSessionEvent({ type: 'error', message: `Failed to start agy: ${error instanceof Error ? error.message : String(error)}` });
            resetTurn();
            return false;
        }

        stream.stderrTail = '';
        const planner = new AgyPlannerAccumulator();
        let deliveryAcked = false;
        let accepted = false;
        let resultFailure: string | null = null;
        let sawResult = false;
        // Flush every pending planner step (result envelope AND turn close, so
        // prose emitted before a pre-result crash is not lost).
        let lastPlannerContent: string | null = null;
        // Best-effort model resolution for default-model turns: when no explicit
        // --model was selected, the actual generation model is read from agy's
        // conversation DB (mirrors the removed scanner's enrichment).
        const modelByStep = new Map<number, string | null>();
        const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        const resolveModel = async (entry: AgyTranscriptEntry): Promise<string | undefined> => {
            if (turnModel) return turnModel;
            if (entry.step_index !== undefined && entry.step_index >= 0 && this.conversationId) {
                if (!modelByStep.has(entry.step_index)) {
                    // agy's SQLite metadata can settle AFTER the transcript event
                    // (the removed scanner retried 100/200/300 ms for this): retry
                    // before caching a permanent null. Only meaningful for real
                    // brain UUIDs (invalid ids resolve null instantly).
                    let model: string | null = null;
                    const canRetry = CANONICAL_UUID_RE.test(this.conversationId);
                    for (const delayMs of [0, 100, 200, 300]) {
                        if (delayMs && canRetry) {
                            await new Promise((resolve) => setTimeout(resolve, delayMs));
                        }
                        const resolved = await resolveAgyTurnModels(this.conversationId, [entry.step_index]);
                        model = resolved.get(entry.step_index) ?? null;
                        if (model || !canRetry) break;
                    }
                    modelByStep.set(entry.step_index, model);
                }
                return modelByStep.get(entry.step_index) ?? undefined;
            }
            return undefined;
        };
        // Serialize ALL transcript emissions (planner AND tool entries) through one
        // promise chain: model resolution is async, so fire-and-forget would
        // reorder entries (a step with no DB lookup resolves before an earlier one
        // that queries the conversation DB; a tool emit could overtake a pending
        // planner emit from the same stdout chunk). The chain preserves the event
        // order on the wire, and turn finalization awaits it before resolving.
        let sendChain: Promise<void> = Promise.resolve();
        const enqueueTranscript = (send: () => void | Promise<void>): void => {
            sendChain = sendChain.then(send);
        };
        const sendPlanner = (entry: AgyTranscriptEntry) => {
            if (typeof entry.content === 'string') lastPlannerContent = entry.content;
            enqueueTranscript(async () => {
                // Carry the turn's model (display label) on every planner entry so
                // the web's per-turn attribution survives model switches and
                // default-model turns still show the actual generation model.
                const model = await resolveModel(entry);
                await this.session.client.sendAgySessionMessage(
                    model ? { ...entry, model } : entry,
                    this.conversationId ?? undefined,
                );
            });
        };
        const sendTool = (entry: AgyTranscriptEntry, toolCall: AgyToolCall) => {
            enqueueTranscript(() => this.session.client.sendAgySessionMessage(entry, this.conversationId ?? undefined, toolCall));
        };
        const flushPlanner = async () => {
            for (const entry of planner.flushAll()) {
                await sendChain;
                sendPlanner(entry);
            }
            await sendChain;
        };
        let softDenyReported = false;
        const reportSoftDeny = () => {
            if (softDenyReported || !/auto-denied|permissions\.allow|allow-rule/i.test(stream.stderrTail)) return;
            softDenyReported = true;
            const match = /(?:run_command|\S+)\s+auto-denied[^\n]*/i.exec(stream.stderrTail);
            const detail = match?.[0] ? `: ${match[0].trim()}` : '';
            this.session.client.sendSessionEvent({
                type: 'message',
                message: `A tool call was auto-denied (no allow-rule)${detail}. Approve it in agy's settings.json or switch to always-proceed, then resend.`,
            });
        };
        let finalization: Promise<void> | null = null;
        let resolveTurn!: () => void;
        let rejectTurn!: (error: unknown) => void;
        const completed = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
        const finalize = (code?: number | null): void => {
            if (finalization) return;
            // Accepted close/result finalization is a barrier: Stop cannot
            // restore it, and neither a later prompt nor API teardown may pass it.
            this.turnFinalizing = accepted;
            finalization = (async () => {
                await flushPlanner();
                if (!deliveryAcked && accepted && localIds.length > 0) {
                    deliveryAcked = true;
                    this.session.client.emitMessagesConsumed(localIds);
                }
                if (signal.aborted) {
                    if (!sawResult) this.session.client.sendSessionEvent({ type: 'message', message: 'Turn aborted' });
                } else if (resultFailure) {
                    this.session.client.sendSessionEvent({ type: 'error', message: resultFailure });
                } else if (!sawResult && stream.failure) {
                    this.session.client.sendSessionEvent({ type: 'error', message: stream.failure });
                } else if (!sawResult && code !== undefined && code !== 0) {
                    this.session.client.sendSessionEvent({ type: 'error', message: this.describeFailure(code, stream.stderrTail) });
                } else if (accepted && !sawResult) {
                    this.session.client.sendSessionEvent({ type: 'error', message: 'agy exited before returning a result' });
                } else reportSoftDeny();
                // Failed results may be followed by the native process exiting.
                // Retire before releasing the turn so the next write cannot race it.
                if (stream.retiring) await stream.retire(true);
            })();
            void finalization.then(resolveTurn, rejectTurn);
        };
        const handleLine = (line: string): void => {
            if (!line.trim() || sawResult || finalization) return;
            const event = parseAgyNdjsonLine(line);
            // Resume can silently fail: agy may create a REPLACEMENT
            // conversation when the seeded --conversation id is stale.
            // The streamed id is authoritative then — adopt it so later
            // turns stop passing the stale value (the old PTY recovery
            // handled this explicitly).
            const adoptStreamConversationId = (id: string): void => {
                if (!id || id === this.conversationId) return;
                this.conversationId = id;
                this.session.onSessionFound(id);
                // emitSessionReady signals transport/session readiness (hub
                // row resolvable); the user-facing 'ready' chat event is
                // sent AFTER the turn completes (see runMainLoop) — sending
                // it here fires while thinking is still active and would
                // never fire on later turns (same conversation id).
                this.session.client.emitSessionReady();
                void this.syncTitleIfKnown();
            };
            switch (event.kind) {
                case 'init': {
                    // The conversation id is known from the very first
                    // envelope — adopt it immediately (and replace a
                    // stale resume seed when agy started fresh).
                    if (event.conversationId) {
                        adoptStreamConversationId(event.conversationId);
                    }
                    break;
                }
                case 'user-input': {
                    // NDJSON's user_input step is the authoritative
                    // delivery confirmation (replaces PTY echo matching).
                    if (event.conversationId) {
                        adoptStreamConversationId(event.conversationId);
                    }
                    accepted = true;
                    if (!deliveryAcked && localIds.length > 0) {
                        deliveryAcked = true;
                        this.session.client.emitMessagesConsumed(localIds);
                    }
                    break;
                }
                case 'planner-delta': {
                    if (event.conversationId) {
                        adoptStreamConversationId(event.conversationId);
                    }
                    // Any emitted prose/tool activity proves the prompt
                    // was accepted and the turn is running — a later
                    // pre-result failure must NOT trigger a retry that
                    // re-executes destructive tool effects.
                    accepted = true;
                    const entry = planner.feedDelta(event.stepIndex, event.delta, event.isDone);
                    if (entry) {
                        void sendPlanner(entry);
                    }
                    break;
                }
                case 'tool': {
                    if (event.conversationId) {
                        adoptStreamConversationId(event.conversationId);
                    }
                    // Only the DONE state carries the result; the ACTIVE
                    // line is the invocation start (parameters only).
                    accepted = true;
                    if (event.isDone) {
                        sendTool(event.entry, event.toolCall);
                    }
                    break;
                }
                case 'checkpoint':
                case 'ignored':
                    break;
                case 'result': {
                    sawResult = true;
                    // Fallback conversation-id adoption: if the init
                    // line was absent/malformed, the result envelope is
                    // authoritative — without it the next turn would
                    // start a fresh agy conversation and lose context.
                    // (adoptStreamConversationId also replaces a stale
                    // resume seed here.)
                    if (event.conversationId) {
                        adoptStreamConversationId(event.conversationId);
                    }
                    // Flush any planner text that never reached a DONE
                    // line (stream ended / response truncated). A
                    // SUCCESS result carries the authoritative complete
                    // answer: when unfinished deltas were force-flushed,
                    // the last pending step is replaced by the result
                    // response instead of discarding it or leaving a
                    // partial ("hel" → "hello").
                    const pending = planner.flushAll();
                    if (event.status === 'SUCCESS' && event.response?.trim() && pending.length > 0) {
                        for (const entry of pending.slice(0, -1)) {
                            void sendPlanner(entry);
                        }
                        void sendPlanner({ ...pending[pending.length - 1]!, content: event.response });
                    } else {
                        for (const entry of pending) {
                            void sendPlanner(entry);
                        }
                    }
                    accepted = true;
                    // The authoritative result arrived: seal the turn so
                    // a Stop/kill during finalization cannot restore it.
                    this.turnCompleted = true;
                    // A FAILURE envelope proves the prompt ran but the
                    // turn failed; surface it (exit code may still be 0).
                    if (event.status !== 'SUCCESS') {
                        // The reason lives in `error`; `response` is the
                        // answer field and stays filled on a failed turn,
                        // so reading it here repeated the whole answer in
                        // the chat as if it were the failure text.
                        resultFailure = event.error?.trim()
                            || `agy turn failed: ${event.status}`;
                    } else if (event.response?.trim()) {
                        const response = event.response.trim();
                        // Deliver the authoritative final answer unless
                        // it was already emitted verbatim (trimmed — the
                        // envelope often carries a trailing newline the
                        // delta stream does not): a tool turn with
                        // completed pre-tool narration but no final
                        // agent_response would otherwise lose it.
                        if (lastPlannerContent?.trim() !== response) {
                            void sendPlanner({
                                step_index: -1,
                                source: 'MODEL',
                                type: 'PLANNER_RESPONSE',
                                status: 'DONE',
                                created_at: '',
                                content: response,
                            });
                        }
                    }
                    void this.syncTitleIfKnown();
                    if (event.status !== 'SUCCESS') stream.retiring = true;
                    finalize();
                    break;
                }
            }
        };

        stream.onLine = handleLine;
        // stdout/stderr are independent pipes. A warning can arrive just after
        // result; keep this reporter while idle, replacing it on the next turn.
        stream.onStderr = reportSoftDeny;
        const handleClose = (code: number | null) => finalize(code);
        stream.onClose = handleClose;
        try {
            if (stream.closed) finalize(stream.closeCode);
            else if (signal.aborted || stream.retiring) await stream.retire();
            else stream.writePrompt(prompt);
            await completed;
        } finally {
            if (stream.onLine === handleLine) stream.onLine = null;
            if (stream.onClose === handleClose) stream.onClose = null;
            resetTurn();
        }
        return accepted;
    }

    protected async runMainLoop(): Promise<void> {
        logger.debug('[agy-headless] Starting headless driver');

        const session = this.session;
        const messageBuffer = this.messageBuffer;

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbortRequest(),
            // AGY is remote-only: a web-initiated switch to local has no target
            // mode; ignore it instead of aborting the session.
            onSwitch: () => {},
        });

        if (this.conversationId) {
            messageBuffer.addMessage('Resuming agy session...', 'status');
        } else {
            messageBuffer.addMessage('Starting agy session...', 'status');
        }

        try {
            let consecutiveUnaccepted = 0;
            while (!this.exitReason && !this.loopAbortController.signal.aborted) {
                const msg = await session.queue.waitForMessagesAndGetAsString(this.loopAbortController.signal);
                if (!msg) break;
                const localIds = (msg.items ?? [])
                    .map((item) => item.localId)
                    .filter((localId): localId is string => Boolean(localId));
                // Each turn gets its own controller: an RPC abort interrupts the
                // in-flight turn only and the loop keeps serving later messages.
                const turnController = new AbortController();
                this.turnAbortController = turnController;
                const onLoopAbort = () => turnController.abort();
                this.loopAbortController.signal.addEventListener('abort', onLoopAbort, { once: true });
                if (this.loopAbortController.signal.aborted) turnController.abort();
                try {
                    const turn = this.runTurn(msg.message, localIds, msg.mode, turnController.signal);
                    this.activeTurn = turn;
                    let accepted: boolean;
                    try {
                        accepted = await turn;
                    } finally {
                        if (this.activeTurn === turn) this.activeTurn = null;
                    }
                    // agy never accepted the prompt (spawn error, crash, or exit
                    // before the user_input step/result envelope): collectBatch
                    // already removed it from the queue and the hub delivery stays
                    // unacked — requeue it so the user's message is retried, not
                    // silently stuck until session end. Bound the retries so a
                    // persistently broken spawn (ENOENT, auth loop) cannot spin
                    // forever; the message stays queued for the next session.
                    if (!accepted && !turnController.signal.aborted) {
                        consecutiveUnaccepted += 1;
                        if (consecutiveUnaccepted >= MAX_UNACCEPTED_RETRIES) {
                            // Give up on this prompt: ack it (so the hub's
                            // session-end sweep does not force-invoke an
                            // uninvoked row) and restore it to the composer so
                            // the user can resend. Ending the session with the
                            // batch requeued would lose it: runAgy's normal
                            // session-end force-invokes every immediate queued
                            // row, and the in-memory queue dies with the process.
                            logger.warn(`[agy-headless] agy did not accept ${MAX_UNACCEPTED_RETRIES} consecutive prompts; restoring prompt to the composer`);
                            if (localIds.length > 0) {
                                this.session.client.emitMessagesConsumed(localIds);
                            }
                            this.session.client.sendSessionEvent({ type: 'abort-restore', text: msg.message });
                            consecutiveUnaccepted = 0;
                            continue;
                        }
                        // Hold the failed batch OUTSIDE the queue during the retry
                        // backoff: Stop cancellation must not depend on localId
                        // (SendMessageRequestSchema permits id-less deliveries, and
                        // cancelByLocalId removes nothing for them). Requeue only
                        // after the delay wins.
                        this.retryDelivery = {
                            text: msg.message,
                            localIds,
                            items: msg.items ?? [],
                            mode: msg.mode,
                            isolate: msg.isolate,
                        };
                        this.retryFullyCancelled = false;
                        // Give the user a moment to read the failure event before
                        // the retry spawns (avoids a tight crash-retry loop). An
                        // interrupt (Stop) during the wait cancels the retry: the
                        // prompt is consumed + restored and never respawned.
                        const retry = await this.waitForRetryBackoff(turnController.signal);
                        if (!retry) {
                            // Interrupted during the backoff: consume + restore the
                            // delivery and do NOT requeue/respawn (id-less batches
                            // included — nothing was put back on the queue yet).
                            this.restoreRetryDelivery();
                            continue;
                        }
                        // Requeue the batch for the retry, unless the session is
                        // already shutting down or the queue is closed.
                        let requeued = false;
                        if (!this.retryFullyCancelled && !this.loopAbortController.signal.aborted && !this.exitReason) {
                            try {
                                const restore = msg.isolate
                                    ? session.queue.unshiftIsolated.bind(session.queue)
                                    : session.queue.unshift.bind(session.queue);
                                // Requeue from the (possibly partially canceled)
                                // retry state, preserving each item's localId.
                                const remaining = this.retryDelivery
                                    ? this.retryDelivery.items
                                    : (msg.items ?? []);
                                for (const item of [...remaining].reverse()) {
                                    restore(item.message, msg.mode, item.localId);
                                }
                                requeued = true;
                            } catch {
                                // Queue already closed — the delivery stays with the hub.
                            }
                        }
                        if (this.retryFullyCancelled) {
                            // A user canceled every retry item: treat the batch as
                            // a completed queue item — stay alive for newer
                            // messages instead of breaking the whole session.
                            this.retryFullyCancelled = false;
                            consecutiveUnaccepted = 0;
                            continue;
                        }
                        if (!requeued) {
                            break;
                        }
                        this.retryDelivery = null;
                        this.retryFullyCancelled = false;
                    } else {
                        consecutiveUnaccepted = 0;
                        // Turn completed: the user-facing ready signal (waiting
                        // for input) fires once thinking has stopped and the queue
                        // is empty — NOT at conversation-id discovery.
                        if (accepted && session.queue.size() === 0 && !turnController.signal.aborted) {
                            session.client.sendSessionEvent({ type: 'ready' });
                        }
                    }
                } finally {
                    this.loopAbortController.signal.removeEventListener('abort', onLoopAbort);
                    if (this.turnAbortController === turnController) {
                        this.turnAbortController = null;
                    }
                }
            }
        } finally {
            this.clearAbortHandlers(session.client.rpcHandlerManager);
            this.restoreRetryDelivery();
            await this.terminateChild(true);
        }
        logger.debug('[agy-headless]: main loop ended');
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);
        await this.terminateChild(true);
        logger.debug('[agy-headless]: cleanup done');
    }
}

export async function agyHeadlessDriver(session: AgySession): Promise<'switch' | 'exit'> {
    const driver = new AgyHeadlessDriver({ session });
    return driver.launch();
}
