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
import { killProcessByChildProcess } from '@/utils/process';
import { AGY_MODEL_LABELS } from '@hapi/protocol';

const AGY_PRINT_TIMEOUT = '30m';

// Bound on consecutive turns agy fails to accept (spawn error, crash, exit
// before any transcript output). Beyond this the session ends with the messages
// still queued rather than spinning forever.
const MAX_UNACCEPTED_RETRIES = 3;

/**
 * Per-turn spawn args for agy's headless print mode:
 *
 *   agy -p <msg> --conversation <uuid> --output-format stream-json \
 *       --model <slug> --mode accept-edits|plan --effort <level> \
 *       --print-timeout 30m [--dangerously-skip-permissions]
 *
 * One spawn per user turn (the only official multi-turn headless channel is
 * `--conversation` resume; the TUI is not used at all). The conversation id is
 * learned from the `init` event on the first turn and persisted to session
 * metadata, so every later turn resumes the same brain conversation.
 */
export function buildAgyHeadlessArgs(opts: {
    prompt: string;
    conversationId?: string;
    model?: string;
    permissionMode: PermissionMode;
    mode?: 'accept-edits' | 'plan';
    effort?: 'low' | 'medium' | 'high';
}): string[] {
    const args = ['-p', opts.prompt, '--output-format', 'stream-json'];
    if (opts.conversationId) {
        args.push('--conversation', opts.conversationId);
    }
    if (opts.model) {
        args.push('--model', opts.model);
    }
    if (opts.mode) {
        args.push('--mode', opts.mode);
    }
    if (opts.effort) {
        args.push('--effort', opts.effort);
    }
    args.push('--print-timeout', AGY_PRINT_TIMEOUT);
    if (opts.permissionMode === 'always-proceed') {
        args.push('--dangerously-skip-permissions');
    }
    return args;
}

/**
 * Build the spawn env for the per-turn agy process. Mirrors the model-probe
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

/**
 * Headless print-mode transport for agy (replaces the PTY/TUI wrapper).
 *
 * Turn loop:
 *   1. wait for a queued user message (MessageQueue2)
 *   2. spawn `agy -p <msg> --conversation <uuid> --output-format stream-json …`
 *   3. stream NDJSON stdout through parseAgyNdjsonLine, mapping events onto the
 *      existing transcript-entry channel (session.client.sendAgySessionMessage)
 *   4. kill the child on abort; the conversation id from the `init` envelope is
 *      adopted into session metadata (onSessionFound) so resume works
 */
export class AgyHeadlessDriver extends RemoteLauncherBase {
    private readonly session: AgySession;
    private readonly spawnAgy: (args: string[], cwd: string) => ChildProcessWithoutNullStreams;
    private readonly syncNativeTitle: (title: unknown) => void;
    /** Aborted on exit/switch/kill so an idle queue wait resolves immediately. */
    private readonly loopAbortController = new AbortController();
    private child: ChildProcessWithoutNullStreams | null = null;
    private turnAbortController: AbortController | null = null;
    /** Brain conversation UUID — from resume seed or the first turn's init event. */
    private conversationId: string | null;
    private stderrTail = '';

    constructor(opts: AgyHeadlessDriverOptions) {
        super(process.env.DEBUG ? opts.session.logPath : undefined);
        this.session = opts.session;
        this.spawnAgy = opts.spawnAgy ?? ((args, cwd) => {
            const child = spawn('agy', args, {
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
     * A requeued (unaccepted) delivery waiting out the retry backoff. finishTurn
     * clears activeWebPrompt/activeLocalIds when the turn closes, so whole-session
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
     * the child close handler clears both fields via finishTurn.
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

    /** True while the close handler is finalizing a completed turn (parsing the
     * final record, awaiting model resolution / transcript sends). During this
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
            // The turn is accepted (result parsed) or finalizing (close handler
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
        // Let the close handler finish (its restore/ack work is already decided
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
    private async terminateChild(): Promise<void> {
        const child = this.child;
        if (!child || child.exitCode !== null) return;
        const terminated = await killProcessByChildProcess(child);
        if (!terminated && child.exitCode === null) {
            // Last resort if tree-kill reports failure; the close handler is the
            // real exit authority either way.
            if (!child.killed) child.kill('SIGKILL');
        }
    }

    private async handleAbortRequest(): Promise<void> {
        logger.debug('[agy-headless]: handleAbortRequest (interrupt)');
        // A turn that already parsed its result envelope or is in finalization has
        // accepted its delivery — do not restore or abort it (resending could
        // repeat tool side effects).
        if (this.turnCompleted || this.turnFinalizing) {
            // Mark the interrupt on the controller so the close handler reports
            // 'Turn aborted' (or nothing when the result already landed) instead
            // of a process failure. Do NOT restore — the prompt completed.
            this.turnAbortController?.abort();
            await this.terminateChild();
            return;
        }
        // Snapshot BEFORE the kill: the child close handler (triggered by the
        // termination) resolves the turn and clears activeWebPrompt/activeLocalIds
        // via finishTurn — reading them after the wait would find nothing.
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

    private describeFailure(code: number | null): string {
        const stderr = this.stderrTail.trim();
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

    /**
     * True when the last turn's stderr carried a soft-deny notice (agy rejects a
     * tool call under request-review because no allow-rule matches). Surfaced as
     * a chat hint so the user can approve and resend.
     */
    private lastTurnSoftDenied = false;

    /**
     * Run a single turn: spawn agy with the queued prompt, stream NDJSON
     * events onto the transcript-entry channel, wait for the `result` envelope
     * or process exit. Returns whether agy accepted the prompt (user_input
     * step seen or result envelope received). Aborting the returned
     * controller's signal interrupts only this turn (the session loop stays
     * alive for the next queued message).
     */
    private async runTurn(
        prompt: string,
        localIds: string[],
        // The spawn config snapshot captured when the batch was queued — the
        // session's live mode may have changed before dequeue, and a batch queued
        // under request-review must never gain --dangerously-skip-permissions,
        // nor must a queued prompt run on a model selected after it was sent.
        mode: AgyMode,
        signal: AbortSignal,
    ): Promise<boolean> {
        const onAbort = () => {
            void this.terminateChild();
        };
        signal.addEventListener('abort', onAbort, { once: true });

        const sessionModel = mode.model ?? undefined;
        const sessionEffort = mode.effort ?? undefined;
        // Snapshot the model at turn start: a mid-response switch must not change
        // attribution within one turn.
        const turnModel = typeof sessionModel === 'string' && sessionModel
            ? AGY_MODEL_LABELS[sessionModel as keyof typeof AGY_MODEL_LABELS] ?? sessionModel
            : undefined;
        const args = buildAgyHeadlessArgs({
            prompt,
            conversationId: this.conversationId ?? undefined,
            model: sessionModel,
            permissionMode: mode.permissionMode,
            effort: sessionEffort === 'low' || sessionEffort === 'medium' || sessionEffort === 'high'
                ? sessionEffort
                : undefined,
        });
        // Never persist the user's prompt to the log (HAPI debug logs can be
        // forwarded under remote-debug configuration); keep the spawn shape.
        const safeArgs = args.map((arg, index) => (args[index - 1] === '-p' ? '<redacted>' : arg));
        logger.debug(`[agy-headless] spawn: agy ${safeArgs.map((a) => (a.length > 80 ? `${a.slice(0, 80)}…` : a)).join(' ')}`);

        this.session.onThinkingChange(true);
        this.stderrTail = '';
        this.activeWebPrompt = prompt;
        this.activeLocalIds = localIds;
        this.lastTurnSoftDenied = false;
        this.turnFinalizing = false;
        this.turnCompleted = false;

        // Per-turn planner: partial text must never leak into a later turn's
        // response if this turn is aborted or crashes mid-stream.
        const planner = new AgyPlannerAccumulator();

        const child = this.spawnAgy(args, this.session.path);
        this.child = child;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        let turnDone = false;
        let deliveryAcked = false;
        let stdoutBuffer = '';
        let accepted = false;
        let resultFailure: string | null = null;
        let sawResult = false;
        // Flush every pending planner step (result envelope AND turn close, so
        // prose emitted before a pre-result crash is not lost).
        let plannerResponseSent = false;
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
        // order on the wire, and the close handler awaits it before resolving.
        let sendChain: Promise<void> = Promise.resolve();
        const enqueueTranscript = (send: () => void | Promise<void>): void => {
            sendChain = sendChain.then(send);
        };
        const sendPlanner = (entry: AgyTranscriptEntry) => {
            plannerResponseSent = true;
            if (typeof entry.content === 'string') lastPlannerContent = entry.content;
            enqueueTranscript(async () => {
                // Carry the turn's model (display label) on every planner entry so
                // the web's per-turn attribution survives model switches and
                // default-model turns still show the actual generation model.
                const model = await resolveModel(entry);
                this.session.client.sendAgySessionMessage(
                    model ? { ...entry, model } : entry,
                    this.conversationId ?? undefined,
                );
            });
        };
        const sendTool = (entry: AgyTranscriptEntry, toolCall: AgyToolCall) => {
            enqueueTranscript(() => {
                this.session.client.sendAgySessionMessage(entry, this.conversationId ?? undefined, toolCall);
            });
        };
        const flushPlanner = async () => {
            for (const entry of planner.flushAll()) {
                await sendChain;
                sendPlanner(entry);
            }
            await sendChain;
        };
        const finishTurn = () => {
            if (turnDone) return;
            turnDone = true;
            this.session.onThinkingChange(false);
            this.child = null;
            this.activeWebPrompt = null;
            this.activeLocalIds = [];
            this.turnFinalizing = false;
            this.turnCompleted = false;
            signal.removeEventListener('abort', onAbort);
        };

        try {
            await new Promise<void>((resolve) => {
                const resolveTurn = () => resolve();

                // Parse a complete NDJSON line. Extracted so both the streaming
                // data handler and the close handler (EOF without trailing newline)
                // can parse buffered records.
                const handleLine = (line: string): void => {
                    if (!line.trim()) return;
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
                                // a Stop/kill before child close cannot restore it.
                                this.turnCompleted = true;
                                // A FAILURE envelope proves the prompt ran but the
                                // turn failed; surface it (exit code may still be 0).
                                if (event.status !== 'SUCCESS') {
                                    resultFailure = event.response?.trim()
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
                                // Do NOT resolve here: the child's close handler is
                                // the turn boundary. Resolving early would let the
                                // queue loop spawn the next turn before this child
                                // has closed, racing shared turnAbortController /
                                // stderrTail state and briefly running two processes
                                // against the same conversation.
                                break;
                            }
                        }
                };

                child.stdout.on('data', (chunk: string) => {
                    // stdout chunks are arbitrary and do not preserve line
                    // boundaries: buffer partial lines across chunks before
                    // parsing, or a JSON object split across chunks would be
                    // parsed as two malformed lines (losing init ids, delivery
                    // acks, tool output, or assistant text).
                    stdoutBuffer += chunk;
                    const lines = stdoutBuffer.split('\n');
                    stdoutBuffer = lines.pop() ?? '';
                    for (const line of lines) {
                        handleLine(line);
                    }
                });

                child.stderr.on('data', (chunk: string) => {
                    this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4096);
                });
                // Swallow pipe errors (e.g. ECONNRESET when we kill the child);
                // the close handler is the real exit authority.
                child.stdout.on('error', () => {});
                child.stderr.on('error', () => {});

                let spawnFailed = false;
                child.on('error', (err) => {
                    spawnFailed = true;
                    logger.debug(`[agy-headless] spawn error: ${err.message}`);
                    this.session.client.sendSessionEvent({ type: 'error', message: `Failed to start agy: ${err.message}` });
                    // Node's ChildProcess emits close AFTER error; do NOT resolve
                    // here — close remains the sole turn boundary, so a late close
                    // cannot mutate shared state belonging to the next retry.
                });

                child.on('close', async (code) => {
                    logger.debug(`[agy-headless] agy exited with code ${code}`);
                    // EOF without a trailing newline: the final buffered record
                    // (result envelope, replacement id, failure status) would
                    // otherwise be discarded. Parse it FIRST — acceptance may be
                    // established by that record.
                    if (stdoutBuffer.trim()) {
                        handleLine(stdoutBuffer);
                        stdoutBuffer = '';
                    }
                    // Seal the delivery ONLY when the turn was accepted: a close
                    // with no acceptance signal (crash, spawn error) must remain
                    // restorable/retryable — a concurrent archive/kill would
                    // otherwise skip snapshotAndRestoreDelivery and lose the prompt.
                    this.turnFinalizing = accepted;
                    // A close before the result envelope (crash, kill) must still
                    // deliver any prose emitted so far — and ALL pending emits
                    // (planner + tool) must land before the turn resolves, or a
                    // later turn could overtake them.
                    await flushPlanner();
                    await sendChain;
                    // Ack whenever agy accepted the prompt — the user_input step
                    // or a result envelope (SUCCESS or failure: either proves the
                    // prompt was received, so the hub row must not stay stale),
                    // regardless of the exit code.
                    if (!deliveryAcked && accepted && localIds.length > 0) {
                        deliveryAcked = true;
                        this.session.client.emitMessagesConsumed(localIds);
                    }
                    if (this.turnAbortController?.signal.aborted) {
                        // A deliberate Stop (the controller is marked aborted, and
                        // a killed child closes with code null) is NOT an agy
                        // crash: report it as an interrupt, unless the result
                        // already landed (then the turn completed normally).
                        if (!sawResult) {
                            this.session.client.sendSessionEvent({ type: 'message', message: 'Turn aborted' });
                        }
                    } else if (code !== 0 && !spawnFailed) {
                        // spawnFailed already surfaced the real cause via the
                        // error handler; avoid a second generic exit error.
                        this.session.client.sendSessionEvent({
                            type: 'error',
                            message: this.describeFailure(code),
                        });
                    } else if (resultFailure) {
                        // Exit 0 with a FAILURE result envelope: the turn ran but
                        // failed (e.g. quota, model error). Ack the delivery (it
                        // was accepted) but surface the failure visibly.
                        this.session.client.sendSessionEvent({
                            type: 'error',
                            message: resultFailure,
                        });
                    } else if (accepted && !sawResult) {
                        // The prompt was accepted (user_input/planner/tool) but
                        // agy exited without a result envelope: the turn ended
                        // with no answer. Ack the delivery (it ran) but surface
                        // the truncation instead of silently consuming it.
                        this.session.client.sendSessionEvent({
                            type: 'error',
                            message: 'agy exited before returning a result',
                        });
                    } else if (/auto-denied|permissions\.allow|allow-rule/i.test(this.stderrTail)) {
                        // Exit 0 with a soft-deny notice: surface a chat hint
                        // (headless has no mid-turn approval dialog).
                        this.lastTurnSoftDenied = true;
                        const match = /(?:run_command|\S+)\s+auto-denied[^\n]*/i.exec(this.stderrTail);
                        const detail = match?.[0] ? `: ${match[0].trim()}` : '';
                        this.session.client.sendSessionEvent({
                            type: 'message',
                            message: `A tool call was auto-denied (no allow-rule)${detail}. Approve it in agy's settings.json or switch to always-proceed, then resend.`,
                        });
                    }
                    resolveTurn();
                });
            });
        } finally {
            finishTurn();
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
        }
        logger.debug('[agy-headless]: main loop ended');
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);
        logger.debug('[agy-headless]: cleanup done');
    }
}

export async function agyHeadlessDriver(session: AgySession): Promise<'switch' | 'exit'> {
    const driver = new AgyHeadlessDriver({ session });
    return driver.launch();
}
