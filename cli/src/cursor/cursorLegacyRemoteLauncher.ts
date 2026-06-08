import React from 'react';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { logger } from '@/ui/logger';
import { killProcessByChildProcess } from '@/utils/process';
import { convertAgentMessage } from '@/agent/messageConverter';
import { OpencodeDisplay } from '@/ui/ink/OpencodeDisplay';
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase';
import type { CursorSession } from './session';
import type { EnhancedMode } from './loop';
// TODO(cursor-acp): remove legacy stream-json resume path after migration window.
// New Cursor sessions use ACP only. This path exists because pre-ACP Cursor
// session_id values are not loadable via ACP session/load.

import type { CursorStreamEvent } from './utils/cursorLegacyEventConverter';
import { parseCursorEvent, convertCursorEventToAgentMessage } from './utils/cursorLegacyEventConverter';
import { cursorPassThroughStatusMessage, parseCursorSpecialCommand } from './cursorSpecialCommands';

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

    return args;
}

function permissionModeToAgentArgs(mode?: string): { mode?: string; yolo?: boolean } {
    if (mode === 'plan') return { mode: 'plan' };
    if (mode === 'ask') return { mode: 'ask' };
    if (mode === 'debug') return { mode: 'debug' };
    if (mode === 'yolo') return { yolo: true };
    return {};
}

class CursorRemoteLauncher extends RemoteLauncherBase {
    private readonly session: CursorSession;
    private abortController = new AbortController();
    private displayPermissionMode: string | null = null;
    private consecutiveTransientFailures = 0;

    constructor(session: CursorSession) {
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

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleSwitchRequest()
        });

        const sendReady = () => {
            session.sendSessionEvent({ type: 'ready' });
        };

        let cursorSessionId: string | null = session.sessionId;
        if (cursorSessionId) {
            session.onSessionFoundWithProtocol(cursorSessionId, 'stream-json');
        }

        while (!this.shouldExit) {
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

            const { mode: agentMode, yolo } = permissionModeToAgentArgs(mode.permissionMode as string);
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
                yolo
            });

            logger.debug(`[cursor-remote] Spawning agent with args: ${args.join(' ')}`);

            session.onThinkingChange(true);

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
                            const codexMsg = convertAgentMessage(agentMsg);
                            if (codexMsg) {
                                session.sendAgentMessage(codexMsg);
                            }
                            switch (agentMsg.type) {
                                case 'text':
                                    messageBuffer.addMessage(agentMsg.text, 'assistant');
                                    break;
                                case 'tool_call':
                                    messageBuffer.addMessage(`Tool: ${agentMsg.name}`, 'tool');
                                    break;
                                case 'tool_result':
                                    messageBuffer.addMessage('Tool result', 'result');
                                    break;
                                case 'turn_complete':
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
                    session.sendSessionEvent({ type: 'message', message: errMsg });
                    messageBuffer.addMessage(errMsg, 'status');
                }
            } catch (error) {
                this.consecutiveTransientFailures = 0;
                logger.warn('[cursor-remote] Agent run failed', error);
                const errMsg = error instanceof Error ? error.message : String(error);
                session.sendSessionEvent({ type: 'message', message: `Cursor Agent failed: ${errMsg}` });
                messageBuffer.addMessage(`Cursor Agent failed: ${errMsg}`, 'status');
            } finally {
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
            const child = spawn('agent', args, {
                cwd,
                env: process.env,
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: process.platform === 'win32',
                windowsHide: process.platform === 'win32'
            });

            let stderrCapture = '';

            const abortHandler = () => {
                killProcessByChildProcess(child, false).catch(() => {});
                resolve({ exitCode: null, stderr: stderrCapture });
            };
            this.abortController.signal.addEventListener('abort', abortHandler);

            const cleanup = () => {
                this.abortController.signal.removeEventListener('abort', abortHandler);
            };

            child.on('error', (err) => {
                cleanup();
                reject(err);
            });

            // `close` (not `exit`) waits for the stdio streams to flush before
            // firing. Otherwise stderr from an agent that prints + exits quickly
            // (e.g. "Authentication required" → exit 1) can arrive after we
            // already classified the failure, turning a transient error into a
            // dropped message.
            child.on('close', (code, signal) => {
                cleanup();
                resolve({ exitCode: code, stderr: stderrCapture });
            });

            const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
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
            session.sendSessionEvent({ type: 'message', message: dropMsg });
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
        session.sendSessionEvent({ type: 'message', message: friendly });
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

    private async handleAbort(): Promise<void> {
        this.session.queue.reset();
        this.session.onThinkingChange(false);
        this.abortController.abort();
        this.abortController = new AbortController();
        this.messageBuffer.addMessage('Turn aborted', 'status');
    }

    private async handleExitFromUi(): Promise<void> {
        await this.requestExit('exit', () => this.handleAbort());
    }

    private async handleSwitchFromUi(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort());
    }

    private async handleSwitchRequest(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort());
    }
}

export async function cursorLegacyRemoteLauncher(session: CursorSession): Promise<'switch' | 'exit'> {
    const launcher = new CursorRemoteLauncher(session);
    return launcher.launch();
}
