import React from 'react';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { logger } from '@/ui/logger';
import {
    killProcessByChildProcess,
    killRetainedProcessTree,
    snapshotProcessTreeIdentities,
    type RetainedProcessIdentity,
} from '@/utils/process';
import { convertAgentMessage } from '@/agent/messageConverter';
import { OpencodeDisplay } from '@/ui/ink/OpencodeDisplay';
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase';
import type { CursorSession } from './session';
import type { EnhancedMode } from './loop';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand';
// TODO(cursor-acp): remove legacy stream-json resume path after migration window.
// New Cursor sessions use ACP only. This path exists because pre-ACP Cursor
// session_id values are not loadable via ACP session/load.

import type { CursorStreamEvent } from './utils/cursorLegacyEventConverter';
import { parseCursorEvent, convertCursorEventToAgentMessage } from './utils/cursorLegacyEventConverter';
import { cursorPassThroughStatusMessage, parseCursorSpecialCommand } from './cursorSpecialCommands';
// NOTE: model-error detection (cursorAgentMessageClassifier) is intentionally
// NOT wired into the legacy launcher. The hub auto-migrates legacy stream-json
// sessions to ACP at resume time via maybeAutoMigrateLegacyCursorSession (PR
// #844). The legacy launcher is reached only when migration soft-fails — a
// degraded fallback path, not a supported flow. Carrying duplicate
// model-error logic here would (a) double the surface for bugs in the
// model-error contract, (b) imply legacy is a real path that needs feature
// parity, and (c) be dead code in practice. New cursor sessions are ACP from
// inception. If you find yourself wanting model-error detection on this
// path, fix the migration failure case instead.

// Transient `agent` failures (auth expiry, rate limits, transient network) come back
// as exit code 1 with a recognisable stderr signature. We requeue and retry instead
// of silently swallowing the user message.
const TRANSIENT_STDERR_PATTERN = /authentication required|please run ['"]?agent login['"]?|rate limit|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i;
const AUTH_STDERR_PATTERN = /authentication required|please run ['"]?agent login['"]?/i;
const RATE_LIMIT_STDERR_PATTERN = /rate limit/i;
const DEFAULT_TRANSIENT_BACKOFF_MS = 2_000;
const MAX_CONSECUTIVE_TRANSIENT_FAILURES = 5;
const STDERR_DISPLAY_LIMIT = 400;
// In-memory stderr cap. Display only uses STDERR_DISPLAY_LIMIT chars; this is a
// safety bound so a chatty `agent` failure cannot balloon CLI process memory.
const STDERR_CAPTURE_LIMIT = 8_192;
/** After a confirmed tree kill, bound how long we wait for stdio close before
 *  publishing settlement so a stuck descendant pipe cannot block Archive. */
const STOP_DRAIN_MS = Number(process.env.HAPI_CURSOR_STOP_DRAIN_MS) || 10_000;

function getTransientBackoffMs(): number {
    const raw = process.env.CURSOR_LEGACY_TRANSIENT_BACKOFF_MS;
    if (raw === undefined) return DEFAULT_TRANSIENT_BACKOFF_MS;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 0) return DEFAULT_TRANSIENT_BACKOFF_MS;
    return parsed;
}

function isTransientAgentError(exitCode: number, stderr: string): boolean {
    // Known transient failures (auth expiry, rate limit, transient network)
    // all come back as exit code 1. Keep the retry path narrow to that contract;
    // signal-kills (137 SIGKILL, 143 SIGTERM) and crashes (134 SIGABRT, etc.)
    // should never auto-retry even if their stderr happens to contain a matching
    // keyword.
    return exitCode === 1 && TRANSIENT_STDERR_PATTERN.test(stderr);
}

function truncateStderrForDisplay(stderr: string): string {
    const trimmed = stderr.trim();
    if (!trimmed) return '(no stderr)';
    return trimmed.length > STDERR_DISPLAY_LIMIT
        ? `${trimmed.slice(0, STDERR_DISPLAY_LIMIT)}...`
        : trimmed;
}

function friendlyTransientMessage(exitCode: number, stderr: string): string {
    if (AUTH_STDERR_PATTERN.test(stderr)) {
        return "Cursor authentication expired. Re-run 'agent login' or set CURSOR_API_KEY. Your message is queued and will retry automatically.";
    }
    if (RATE_LIMIT_STDERR_PATTERN.test(stderr)) {
        return 'Cursor rate limit hit. Your message is queued and will retry automatically.';
    }
    return `Cursor agent failed transiently (exit ${exitCode}). Your message is queued and will retry automatically.`;
}

function buildAgentArgs(opts: {
    message: string;
    cwd: string;
    sessionId: string | null;
    mode?: string;
    model?: string;
    yolo?: boolean;
    autoReview?: boolean;
}): string[] {
    const args = ['-p', opts.message, '--output-format', 'stream-json', '--trust', '--workspace', opts.cwd];

    if (opts.sessionId) {
        args.push('--resume', opts.sessionId);
    }
    if (opts.mode && (opts.mode === 'plan' || opts.mode === 'ask' || opts.mode === 'debug')) {
        args.push('--mode', opts.mode);
    }
    if (opts.model) {
        args.push('--model', opts.model);
    }
    if (opts.yolo) {
        args.push('--yolo');
    }
    if (opts.autoReview) {
        args.push('--auto-review');
    }

    return args;
}

function permissionModeToAgentArgs(mode?: string): { mode?: string; yolo?: boolean; autoReview?: boolean } {
    if (mode === 'plan') return { mode: 'plan' };
    if (mode === 'ask') return { mode: 'ask' };
    if (mode === 'debug') return { mode: 'debug' };
    if (mode === 'yolo') return { yolo: true };
    if (mode === 'autoReview') return { autoReview: true };
    return {};
}

class CursorRemoteLauncher extends RemoteLauncherBase {
    private readonly session: CursorSession;
    private abortController = new AbortController();
    private displayPermissionMode: string | null = null;
    private consecutiveTransientFailures = 0;
    /** Live agent subprocess — kept across abortController swaps so a second
     *  Stop can retry tree termination when the first kill did not confirm. */
    private activeChild: ChildProcess | null = null;
    /** Escalate to force kill on Stop retry after an unconfirmed soft kill. */
    private stopKillEscalated = false;
    /** Arm the post-Stop stdout drain bound only after tree kill confirms. */
    private stopDrainArmed = false;
    /** Invoked after a confirmed kill so a Stop retry can still bound drain
     *  after the original abortController was replaced. */
    private armActiveChildDrain: (() => void) | null = null;
    /**
     * Latest Stop tree-kill outcome for the active child. `null` while kill is
     * still running; aborted turns must not settle until this is `true` (#2021).
     */
    private stopTreeVerified: boolean | null = null;
    /**
     * Generation-bound snapshot of the original agent tree, captured before the
     * first Stop signal. Retries kill/verify these members — not a fresh scan
     * from a possibly-exited root (#2021 tip Major).
     */
    private retainedStopTree: RetainedProcessIdentity[] | null = null;
    /** Resolve a close that arrived before Stop finished verifying the tree. */
    private resolveAfterStopTreeVerified: (() => void) | null = null;
    /**
     * Rejected Switch/Exit abandons the Stop verify gate so a later natural
     * process close is not stranded (#2021).
     */
    private abandonStopVerification: (() => void) | null = null;

    constructor(session: CursorSession) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
    }

    /** Publish scoped settlement for call ids still open after a subprocess
     *  drains. Used after Stop (and any exit that left tools unsettled) so
     *  Archive does not stick on in_progress rows (#2021). */
    private publishToolSettlements(settledCallIds: string[]): void {
        if (settledCallIds.length === 0) return;
        const settlement = convertAgentMessage({
            type: 'turn_complete',
            stopReason: 'cancelled',
            settledCallIds,
        });
        if (settlement) this.session.sendAgentMessage(settlement);
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(OpencodeDisplay, { ...context, agentName: 'Cursor' });
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleSwitchRequest()
        }, () => this.abortController.abort(),
        // A rejected cancel must not leave the loop on the aborted signal.
        () => { if (this.abortController.signal.aborted) this.abortController = new AbortController(); });

        session.client.rpcHandlerManager.registerHandler(
            RPC_METHODS.SteerQueuedMessage,
            async () => ({
                steered: false,
                error: 'Mid-turn steering requires a Cursor ACP session'
            })
        );

        const sendReady = () => {
            session.sendSessionEvent({ type: 'ready' });
        };

        let cursorSessionId: string | null = session.sessionId;
        if (cursorSessionId) {
            session.onSessionFoundWithProtocol(cursorSessionId, 'stream-json');
        }

        while (!this.shouldExit) {
            await this.waitForAbortBarrier();
            if (this.shouldExit) break;
            const waitSignal = this.abortController.signal;
            const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);
            if (!batch) {
                if (waitSignal.aborted && !this.shouldExit) {
                    continue;
                }
                break;
            }

            const { message, mode, isolate: batchIsolated } = batch;
            const specialCommand = parseCursorSpecialCommand(message);

            const { mode: agentMode, yolo, autoReview } = permissionModeToAgentArgs(mode.permissionMode as string);
            this.applyDisplayMode(mode.permissionMode as string);
            messageBuffer.addMessage(message, 'user');

            if (specialCommand.type === 'pass-through') {
                logger.debug(`[cursor-remote] /${specialCommand.command} — pass-through to agent -p`);
                messageBuffer.addMessage(cursorPassThroughStatusMessage(specialCommand.command), 'status');
            }

            const args = buildAgentArgs({
                message,
                cwd: session.path,
                sessionId: cursorSessionId,
                mode: agentMode,
                model: mode.model,
                yolo,
                autoReview
            });

            logger.debug(`[cursor-remote] Spawning agent with args: ${args.join(' ')}`);

            session.onThinkingChange(true);
            // Per-subprocess open ids so Stop can settle after stdout drains,
            // including buffered tool_call starts that arrive between abort and
            // close (#2021).
            const processOpenToolCallIds = new Set<string>();

            try {
                const { exitCode, stderr } = await this.runAgentProcess(args, session.path, (event) => {
                    if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
                        cursorSessionId = event.session_id;
                        session.onSessionFoundWithProtocol(event.session_id, 'stream-json');
                    } else if (event.type === 'thinking') {
                        if (event.subtype === 'completed') {
                            // keep thinking until we get assistant/result
                        }
                    } else if (event.type === 'assistant' || event.type === 'tool_call' || event.type === 'result') {
                        const agentMsg = convertCursorEventToAgentMessage(event);
                        if (agentMsg) {
                            const codexMsg = convertAgentMessage(agentMsg, session.model);
                            if (codexMsg) {
                                session.sendAgentMessage(codexMsg);
                            }
                            switch (agentMsg.type) {
                                case 'text':
                                    messageBuffer.addMessage(agentMsg.text, 'assistant');
                                    break;
                                case 'tool_call':
                                    processOpenToolCallIds.add(agentMsg.id);
                                    messageBuffer.addMessage(`Tool: ${agentMsg.name}`, 'tool');
                                    break;
                                case 'tool_result':
                                    processOpenToolCallIds.delete(agentMsg.id);
                                    messageBuffer.addMessage('Tool result', 'result');
                                    break;
                                case 'turn_complete':
                                    // Keep unmatched ids until subprocess close.
                                    // A final `result` converts to turn_complete
                                    // with no settlement IDs — clearing here would
                                    // leave the close handler with nothing to
                                    // publish (#2021).
                                    break;
                                default:
                                    break;
                            }
                        }
                    }
                });

                if (exitCode === 0 || exitCode === null) {
                    this.consecutiveTransientFailures = 0;
                } else if (isTransientAgentError(exitCode, stderr)) {
                    await this.handleTransientAgentFailure(exitCode, stderr, message, mode, batchIsolated);
                } else {
                    this.consecutiveTransientFailures = 0;
                    const errMsg = `Agent exited (${exitCode}): ${truncateStderrForDisplay(stderr)}`;
                    logger.warn(`[cursor-remote] ${errMsg}`);
                    const converted = convertAgentMessage({ type: 'error', message: errMsg });
                    if (converted) {
                        session.sendAgentMessage(converted);
                    }
                    messageBuffer.addMessage(errMsg, 'status');
                }
            } catch (error) {
                this.consecutiveTransientFailures = 0;
                logger.warn('[cursor-remote] Agent run failed', error);
                const errMsg = error instanceof Error ? error.message : String(error);
                const message = `Cursor Agent failed: ${errMsg}`;
                const converted = convertAgentMessage({ type: 'error', message });
                if (converted) {
                    session.sendAgentMessage(converted);
                }
                messageBuffer.addMessage(message, 'status');
            } finally {
                // Settle after close/drain so a late buffered tool_call start
                // between abort and close is included in settledCallIds.
                const unsettled = [...processOpenToolCallIds];
                processOpenToolCallIds.clear();
                this.publishToolSettlements(unsettled);
                session.onThinkingChange(false);
                if (session.queue.size() === 0 && !this.shouldExit) {
                    sendReady();
                }
            }
        }
    }

    private runAgentProcess(
        args: string[],
        cwd: string,
        onEvent: (event: ReturnType<typeof parseCursorEvent> & object) => void
    ): Promise<{ exitCode: number | null; stderr: string }> {
        return new Promise((resolve, reject) => {
            const child = spawn(getAgentLaunchCommand('cursor'), args, {
                cwd,
                env: process.env,
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: process.platform === 'win32',
                windowsHide: process.platform === 'win32'
            });
            this.activeChild = child;
            this.stopKillEscalated = false;
            this.stopDrainArmed = false;
            this.stopTreeVerified = null;
            this.retainedStopTree = null;
            this.resolveAfterStopTreeVerified = null;
            this.abandonStopVerification = null;

            let stderrCapture = '';
            let settled = false;
            let drainTimer: ReturnType<typeof setTimeout> | undefined;
            let stdoutClosed = false;
            let closeExitCode: number | null = null;

            // Abort marks the turn cancelled but must NOT resolve early — wait
            // for `close` (or the post-kill drain bound) so buffered stdout
            // drains before settlement (#2021). Capture abort on a local flag:
            // handleAbort replaces this.abortController after signalling, so
            // reading the new controller's signal from `close` would miss it.
            // Tree kill itself lives in handleAbort so a second Stop can retry
            // against the same activeChild when the first kill is unconfirmed.
            // For Stop, also wait for tree verification — root stdio can close
            // while a descendant survives (#2021).
            let aborted = false;
            const runSignal = this.abortController.signal;
            const finish = (exitCode: number | null) => {
                if (settled) return;
                settled = true;
                cleanup(true);
                resolve({ exitCode, stderr: stderrCapture });
            };
            const tryFinishAfterStop = () => {
                if (settled || !aborted || !stdoutClosed) return;
                if (this.stopTreeVerified === true) {
                    this.resolveAfterStopTreeVerified = null;
                    finish(null);
                    return;
                }
                // Unverified or still pending: keep activeChild for Stop retry.
                this.resolveAfterStopTreeVerified = () => {
                    if (settled || !stdoutClosed) return;
                    if (this.stopTreeVerified === true) finish(null);
                };
            };
            this.abandonStopVerification = () => {
                // Rejected Switch: keep the Stop gate and process identity so a
                // later Stop can retry. Do NOT finish the turn here — stdout
                // close alone must not settle while descendants may live (#2021).
                this.resolveAfterStopTreeVerified = () => {
                    if (settled || !stdoutClosed) return;
                    if (this.stopTreeVerified === true) finish(null);
                };
            };
            const armDrainBound = () => {
                if (settled || drainTimer !== undefined || !this.stopDrainArmed) return;
                drainTimer = setTimeout(() => {
                    if (settled) return;
                    stdoutClosed = true;
                    try { child.stdout?.destroy(); } catch { /* ignore */ }
                    try { child.stderr?.destroy(); } catch { /* ignore */ }
                    tryFinishAfterStop();
                    if (!aborted) finish(null);
                }, STOP_DRAIN_MS);
                drainTimer.unref?.();
            };
            this.armActiveChildDrain = armDrainBound;
            const abortHandler = () => {
                aborted = true;
                armDrainBound();
            };
            runSignal.addEventListener('abort', abortHandler);

            const cleanup = (clearChild: boolean) => {
                runSignal.removeEventListener('abort', abortHandler);
                if (drainTimer !== undefined) clearTimeout(drainTimer);
                if (clearChild && this.activeChild === child) {
                    this.activeChild = null;
                    this.stopKillEscalated = false;
                    this.stopDrainArmed = false;
                    this.armActiveChildDrain = null;
                    this.resolveAfterStopTreeVerified = null;
                    this.abandonStopVerification = null;
                    this.stopTreeVerified = null;
                    this.retainedStopTree = null;
                }
            };

            child.on('error', (err) => {
                if (settled) return;
                settled = true;
                cleanup(true);
                reject(err);
            });

            // `close` (not `exit`) waits for the stdio streams to flush before
            // firing. Otherwise stderr from an agent that prints + exits quickly
            // (e.g. "Authentication required" → exit 1) can arrive after we
            // already classified the failure, turning a transient error into a
            // dropped message. Stop also relies on this so settlement runs
            // after the last buffered tool_call line is forwarded — and after
            // tree verification when the turn was explicitly stopped (#2021).
            child.on('close', (code, _signal) => {
                if (settled) return;
                stdoutClosed = true;
                closeExitCode = aborted ? null : code;
                if (aborted) {
                    tryFinishAfterStop();
                    return;
                }
                finish(closeExitCode);
            });

            const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
            rl.on('line', (line) => {
                const event = parseCursorEvent(line);
                if (event) {
                    onEvent(event);
                }
            });

            child.stderr?.on('data', (chunk) => {
                const text = chunk.toString();
                if (stderrCapture.length < STDERR_CAPTURE_LIMIT) {
                    stderrCapture += text.slice(0, STDERR_CAPTURE_LIMIT - stderrCapture.length);
                }
                if (text.trim()) {
                    logger.debug('[cursor-remote] agent stderr:', text.trim());
                }
            });
        });
    }

    private async handleTransientAgentFailure(
        exitCode: number,
        stderr: string,
        message: string,
        mode: EnhancedMode,
        batchIsolated: boolean
    ): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;
        this.consecutiveTransientFailures += 1;

        if (this.consecutiveTransientFailures >= MAX_CONSECUTIVE_TRANSIENT_FAILURES) {
            const summary = truncateStderrForDisplay(stderr);
            const dropMsg = `Cursor agent failed ${MAX_CONSECUTIVE_TRANSIENT_FAILURES} times in a row (${summary}). Dropping the queued message; resolve the issue ('agent login', wait out rate limit, etc.) and resend.`;
            logger.warn(
                `[cursor-remote] transient agent failures hit cap (${MAX_CONSECUTIVE_TRANSIENT_FAILURES}); dropping message`,
                { exitCode, stderr: stderr.slice(0, STDERR_DISPLAY_LIMIT) }
            );
            const converted = convertAgentMessage({ type: 'error', message: dropMsg });
            if (converted) {
                session.sendAgentMessage(converted);
            }
            messageBuffer.addMessage(dropMsg, 'status');
            this.consecutiveTransientFailures = 0;
            return;
        }

        logger.warn(
            '[cursor-remote] transient agent failure, requeueing user message',
            {
                exitCode,
                attempt: this.consecutiveTransientFailures,
                stderr: stderr.slice(0, STDERR_DISPLAY_LIMIT)
            }
        );
        // Preserve isolation when the original batch was isolated (e.g. a
        // pass-through slash command queued via pushIsolated). Without this the
        // requeued command could be batched with a sibling prompt on retry and
        // change semantics. parseCursorSpecialCommand is the same gate
        // enqueueCursorUserMessage uses to decide isolation in the first place.
        const requeueIsolated = batchIsolated || parseCursorSpecialCommand(message).type !== null;
        if (requeueIsolated) {
            session.queue.unshiftIsolated(message, mode);
        } else {
            session.queue.unshift(message, mode);
        }
        const friendly = friendlyTransientMessage(exitCode, stderr);
        const converted = convertAgentMessage({ type: 'error', message: friendly });
        if (converted) {
            session.sendAgentMessage(converted);
        }
        messageBuffer.addMessage(friendly, 'status');
        await this.transientBackoff(getTransientBackoffMs());
    }

    private async transientBackoff(ms: number): Promise<void> {
        if (ms <= 0) return;
        const signal = this.abortController.signal;
        if (signal.aborted) return;
        await new Promise<void>((resolve) => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            // Single completion path so the abort listener is always removed,
            // whether the timer or the abort wins. Without this, repeated
            // transient retries on the same AbortController accumulate stale
            // listeners until the next abort fires them in bulk.
            const finish = () => {
                if (timer !== null) {
                    clearTimeout(timer);
                    timer = null;
                }
                signal.removeEventListener('abort', finish);
                resolve();
            };
            timer = setTimeout(finish, ms);
            signal.addEventListener('abort', finish, { once: true });
        });
    }

    private applyDisplayMode(permissionMode: string | undefined): void {
        if (permissionMode && permissionMode !== this.displayPermissionMode) {
            this.displayPermissionMode = permissionMode;
            this.messageBuffer.addMessage(`[MODE:${permissionMode}]`, 'system');
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);
        this.abortController.abort();
    }

    private async handleAbort(leavingRemote = false): Promise<void> {
        // Kill the live agent against activeChild — not only via the abort
        // signal — so a second Stop can retry when the first tree kill did
        // not confirm (descendant holding stdio, soft kill refused) (#2021).
        const child = this.activeChild;
        let stopped = !child?.pid;
        if (child?.pid) {
            // Capture the original tree once — later retries must not rescan
            // from a root that already exited and left reparented descendants.
            if (!this.retainedStopTree) {
                this.retainedStopTree = snapshotProcessTreeIdentities(child.pid);
            }
            let force = this.stopKillEscalated || leavingRemote;
            const attempts = leavingRemote ? 2 : 1;
            for (let i = 0; i < attempts; i += 1) {
                try {
                    if (this.retainedStopTree) {
                        stopped = await killRetainedProcessTree(this.retainedStopTree, force);
                    } else {
                        // Incomplete snapshot: best-effort kill, never claim verified.
                        await killProcessByChildProcess(child, force);
                        stopped = false;
                    }
                } catch (error) {
                    logger.debug('[cursor-remote] Stop kill failed', error);
                    stopped = false;
                }
                if (stopped) break;
                force = true;
                this.stopKillEscalated = true;
            }
            this.stopTreeVerified = stopped;
            if (stopped) {
                this.retainedStopTree = null;
                this.stopDrainArmed = true;
                this.armActiveChildDrain?.();
                this.resolveAfterStopTreeVerified?.();
            } else if (leavingRemote) {
                // Keep the launcher recoverable: do not reset the queue or mark
                // the turn aborted until the process tree is confirmed gone (#2021).
                // Preserve verification gate + activeChild for a later Stop.
                this.stopDrainArmed = false;
                this.stopTreeVerified = false;
                this.abandonStopVerification?.();
                this.messageBuffer.addMessage(
                    'Exit: agent process still open after force kill — handoff blocked',
                    'status'
                );
                throw new Error('Cannot switch/exit: agent process still open after force kill');
            } else {
                this.stopDrainArmed = false;
                this.messageBuffer.addMessage(
                    this.stopKillEscalated
                        ? 'Stop: agent process still open after force kill — press Stop again to retry'
                        : 'Stop: agent process still open — press Stop again to retry with force',
                    'status'
                );
            }
        } else {
            // No live child — still abort waiters; nothing to drain-bound.
            this.stopDrainArmed = true;
            this.stopTreeVerified = true;
            this.resolveAfterStopTreeVerified?.();
        }
        // Terminal cleanup resets the queue only after kill confirms — a rejected
        // Switch must leave queued work and launcher state recoverable (#2021).
        if (leavingRemote) {
            this.session.queue.reset();
        }

        // Keep thinking=true while the subprocess is still open so the web
        // composer leaves Stop enabled for a retry (#2021). Clear only after
        // confirmed termination (or when there was no child).
        if (stopped) {
            this.session.onThinkingChange(false);
        }

        this.abortController.abort();
        this.abortController = new AbortController();
        this.messageBuffer.addMessage('Turn aborted', 'status');
        // Settlement waits for subprocess `close` (or the post-kill drain
        // bound) inside runAgentProcess so late buffered tool_call starts are
        // included (#2021).
    }

    protected onTerminalTeardownRejected(): void {
        // requestExit already set shouldExit/exitReason before the handler ran.
        // Clear them so a rejected Switch leaves the remote launcher runnable.
        this.shouldExit = false;
        this.exitReason = null;
    }

    /**
     * Confirm process-tree kill *before* requestExit commits shouldExit /
     * exitReason. Hold the abort/dequeue barrier so the main loop cannot
     * acknowledge a queued prompt and spawn a replacement child while kill
     * verification is still polling (#2021).
     */
    private async confirmLeaveThenExit(reason: 'switch' | 'exit'): Promise<void> {
        // Hold dequeue barrier through kill verification (#2021). Abort the
        // wait signal first so an idle loop re-enters the barrier instead of
        // collecting a batch mid-kill — same order as Abort's onAbortEntry.
        await this.runAbortUnderBarrier(async () => {
            this.abortController.abort();
            try {
                await this.handleAbort(true);
            } catch (error) {
                if (this.abortController.signal.aborted) {
                    this.abortController = new AbortController();
                }
                throw error;
            }
        });
        await this.requestExit(reason, async () => {});
    }

    private async handleExitFromUi(): Promise<void> {
        await this.confirmLeaveThenExit('exit');
    }

    private async handleSwitchFromUi(): Promise<void> {
        await this.confirmLeaveThenExit('switch');
    }

    private async handleSwitchRequest(): Promise<void> {
        await this.confirmLeaveThenExit('switch');
    }
}

export async function cursorLegacyRemoteLauncher(session: CursorSession): Promise<'switch' | 'exit'> {
    const launcher = new CursorRemoteLauncher(session);
    return launcher.launch();
}
