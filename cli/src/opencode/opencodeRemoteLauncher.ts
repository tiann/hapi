import React from 'react';
import { logger } from '@/ui/logger';
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge';
import { convertAgentMessage } from '@/agent/messageConverter';
import type { AgentMessage, McpServerStdio, PromptContent } from '@/agent/types';
import { RemoteLauncherBase, type RemoteLauncherDisplayContext, type RemoteLauncherExitReason } from '@/modules/common/remote/RemoteLauncherBase';
import { OpencodeDisplay } from '@/ui/ink/OpencodeDisplay';
import type { OpencodeSession } from './session';
import type { PermissionMode } from './types';
import { createOpencodeBackend } from './utils/opencodeBackend';
import { OpencodePermissionHandler } from './utils/permissionHandler';
import { TITLE_INSTRUCTION } from './utils/systemPrompt';

class OpencodeRemoteLauncher extends RemoteLauncherBase {
    private readonly session: OpencodeSession;
    private backend: ReturnType<typeof createOpencodeBackend> | null = null;
    private permissionHandler: OpencodePermissionHandler | null = null;
    private happyServer: { stop: () => void } | null = null;
    private abortController = new AbortController();
    private displayPermissionMode: PermissionMode | null = null;
    private instructionsSent = false;
    private currentBackendModel: string | null = null;
    private setModelSupported: boolean | undefined = undefined;

    constructor(session: OpencodeSession) {
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

        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client);
        this.happyServer = happyServer;

        const backend = createOpencodeBackend({
            cwd: session.path
        });
        this.backend = backend;

        backend.onStderrError((error) => {
            logger.debug('[opencode-remote] stderr error', error);
            session.sendSessionEvent({ type: 'message', message: error.message });
            messageBuffer.addMessage(error.message, 'status');
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

        // Seed currentBackendModel from the ACP session metadata so the first
        // batch — whose model the hub mirrors from the just-discovered session —
        // does not trigger a redundant setModel on the very first turn.
        const initialMetadata = backend.getSessionModelsMetadata?.(acpSessionId);
        this.currentBackendModel = initialMetadata?.currentModelId ?? null;

        // Expose the cached models metadata via per-session RPC so the hub can
        // forward it to the web UI's model selector without round-tripping ACP.
        session.client.rpcHandlerManager.registerHandler('listOpencodeModels', async () => {
            const metadata = backend.getSessionModelsMetadata?.(acpSessionId);
            if (!metadata) {
                return { success: true, availableModels: [], currentModelId: null };
            }
            return {
                success: true,
                availableModels: metadata.availableModels,
                currentModelId: metadata.currentModelId
            };
        });

        this.permissionHandler = new OpencodePermissionHandler(
            session.client,
            backend,
            () => session.getPermissionMode() as PermissionMode | undefined
        );
        this.applyDisplayMode(session.getPermissionMode() as PermissionMode);

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleSwitchRequest()
        });

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

            // Inline model change via ACP RPC (session/set_model — see ACP SDK
            // schema `x-method: session/set_model`). Mirrors the Gemini pattern
            // from PR #543: if the running OpenCode build does not implement the
            // RPC, we learn that from the first method-not-found response and stop
            // attempting it for the rest of this session.
            //
            // The very first batch seeds currentBackendModel — the OpenCode CLI was
            // launched with that model via --model and there is nothing to switch yet.
            if (batch.mode.model && this.currentBackendModel === null) {
                this.currentBackendModel = batch.mode.model;
            } else if (batch.mode.model && batch.mode.model !== this.currentBackendModel) {
                if (!backend.setModel || this.setModelSupported === false) {
                    batch.mode.model = this.currentBackendModel ?? undefined;
                } else {
                    logger.debug(`[opencode-remote] Switching model inline: ${this.currentBackendModel} -> ${batch.mode.model}`);
                    try {
                        await backend.setModel(acpSessionId, batch.mode.model, { flavor: 'opencode' });
                        this.currentBackendModel = batch.mode.model;
                        this.setModelSupported = true;
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
                                message: `Failed to switch model to ${batch.mode.model}. Continuing with ${this.currentBackendModel ?? '(default)'}.`
                            });
                        }
                        batch.mode.model = this.currentBackendModel ?? undefined;
                    }
                }
            }

            this.applyDisplayMode(batch.mode.permissionMode);
            messageBuffer.addMessage(batch.message, 'user');

            // Inject title instructions on first prompt
            let messageText = batch.message;
            if (!this.instructionsSent) {
                messageText = `${TITLE_INSTRUCTION}\n\n${batch.message}`;
                this.instructionsSent = true;
            }

            const promptContent: PromptContent[] = [{
                type: 'text',
                text: messageText
            }];

            session.onThinkingChange(true);

            try {
                await backend.prompt(acpSessionId, promptContent, (message: AgentMessage) => {
                    this.handleAgentMessage(message);
                });
            } catch (error) {
                logger.warn('[opencode-remote] prompt failed', error);
                session.sendSessionEvent({
                    type: 'message',
                    message: 'OpenCode prompt failed. Check logs for details.'
                });
                messageBuffer.addMessage('OpenCode prompt failed', 'status');
            } finally {
                session.onThinkingChange(false);
                await this.permissionHandler?.cancelAll('Prompt finished');
                if (session.queue.size() === 0 && !this.shouldExit) {
                    sendReady();
                }
            }
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);

        if (this.permissionHandler) {
            await this.permissionHandler.cancelAll('Session ended');
            this.permissionHandler = null;
        }

        if (this.backend) {
            await this.backend.disconnect();
            this.backend = null;
        }

        if (this.happyServer) {
            this.happyServer.stop();
            this.happyServer = null;
        }
    }

    private handleAgentMessage(message: AgentMessage): void {
        const converted = convertAgentMessage(message);
        if (converted) {
            this.session.sendAgentMessage(converted);
        }

        switch (message.type) {
            case 'text':
                this.messageBuffer.addMessage(message.text, 'assistant');
                break;
            case 'reasoning':
                this.messageBuffer.addMessage(`[Thinking] ${message.text.substring(0, 100)}...`, 'system');
                break;
            case 'tool_call':
                this.messageBuffer.addMessage(`Tool call: ${message.name}`, 'tool');
                break;
            case 'tool_result':
                this.messageBuffer.addMessage('Tool result received', 'result');
                break;
            case 'plan':
                this.messageBuffer.addMessage('Plan updated', 'status');
                break;
            case 'error':
                this.messageBuffer.addMessage(message.message, 'status');
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

    private async handleAbort(): Promise<void> {
        const backend = this.backend;
        if (backend && this.session.sessionId) {
            await backend.cancelPrompt(this.session.sessionId);
        }
        await this.permissionHandler?.cancelAll('User aborted');
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

function toAcpMcpServers(config: Record<string, { command: string; args: string[] }>): McpServerStdio[] {
    return Object.entries(config).map(([name, entry]) => ({
        name,
        command: entry.command,
        args: entry.args,
        env: []
    }));
}

export async function opencodeRemoteLauncher(
    session: OpencodeSession
): Promise<'switch' | 'exit'> {
    const launcher = new OpencodeRemoteLauncher(session);
    return launcher.launch();
}
