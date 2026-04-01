import React from 'react';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { logger } from '@/ui/logger';
import { convertAgentMessage } from '@/agent/messageConverter';
import { OpencodeDisplay } from '@/ui/ink/OpencodeDisplay';
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase';
import type { CursorSession } from './session';
import type { CursorStreamEvent } from './utils/cursorEventConverter';
import { parseCursorEvent, convertCursorEventToAgentMessage } from './utils/cursorEventConverter';

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
    if (opts.mode && (opts.mode === 'plan' || opts.mode === 'ask')) {
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
    if (mode === 'yolo') return { yolo: true };
    return {};
}

class CursorRemoteLauncher extends RemoteLauncherBase {
    private readonly session: CursorSession;
    private abortController = new AbortController();
    private displayPermissionMode: string | null = null;

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

        while (!this.shouldExit) {
            const waitSignal = this.abortController.signal;
            const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);
            if (!batch) {
                if (waitSignal.aborted && !this.shouldExit) {
                    continue;
                }
                break;
            }

            const { message, mode } = batch;
            const { mode: agentMode, yolo } = permissionModeToAgentArgs(mode.permissionMode as string);
            this.applyDisplayMode(mode.permissionMode as string);
            messageBuffer.addMessage(message, 'user');

            const args = buildAgentArgs({
                message,
                cwd: session.path,
                sessionId: cursorSessionId,
                mode: agentMode,
                model: session.model,
                yolo
            });

            logger.debug(`[cursor-remote] Spawning agent with args: ${args.join(' ')}`);

            session.onThinkingChange(true);

            try {
                const exitCode = await this.runAgentProcess(args, session.path, (event) => {
                    if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
                        cursorSessionId = event.session_id;
                        session.onSessionFound(event.session_id);
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

                if (exitCode !== 0 && exitCode !== null) {
                    logger.debug(`[cursor-remote] Agent exited with code ${exitCode}`);
                    messageBuffer.addMessage(`Agent exited with code ${exitCode}`, 'status');
                }
            } catch (error) {
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
    ): Promise<number | null> {
        return new Promise((resolve, reject) => {
            const child = spawn('agent', args, {
                cwd,
                env: process.env,
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: process.platform === 'win32'
            });

            const abortHandler = () => {
                try {
                    child.kill('SIGTERM');
                } catch {
                    // ignore
                }
                resolve(null);
            };
            this.abortController.signal.addEventListener('abort', abortHandler);

            const cleanup = () => {
                this.abortController.signal.removeEventListener('abort', abortHandler);
            };

            child.on('error', (err) => {
                cleanup();
                reject(err);
            });

            child.on('exit', (code, signal) => {
                cleanup();
                resolve(code);
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
                if (text.trim()) {
                    logger.debug('[cursor-remote] agent stderr:', text.trim());
                }
            });
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

export async function cursorRemoteLauncher(session: CursorSession): Promise<'switch' | 'exit'> {
    const launcher = new CursorRemoteLauncher(session);
    return launcher.launch();
}
