import React from 'react';
import { registerAcpSessionTitleSync } from '@/agent/acpSessionTitle';
import { logger } from '@/ui/logger';
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge';
import { convertAgentMessage } from '@/agent/messageConverter';
import type { AgentMessage, McpServerStdio, PromptContent } from '@/agent/types';
import { RemoteLauncherBase, type RemoteLauncherDisplayContext, type RemoteLauncherExitReason } from '@/modules/common/remote/RemoteLauncherBase';
import { KimiDisplay } from '@/ui/ink/KimiDisplay';
import type { KimiSession } from './session';
import type { PermissionMode } from './types';
import { createKimiBackend } from './utils/kimiBackend';
import { KimiPermissionHandler } from './utils/permissionHandler';
import { resolveKimiRuntimeConfig } from './utils/config';
class KimiRemoteLauncher extends RemoteLauncherBase {
    private readonly session: KimiSession;
    private readonly model?: string;
    private backend: ReturnType<typeof createKimiBackend> | null = null;
    private permissionHandler: KimiPermissionHandler | null = null;
    private happyServer: { stop: () => void } | null = null;
    private abortController = new AbortController();
    private displayModel: string | null = null;
    private displayPermissionMode: PermissionMode | null = null;
    private currentBackendModel: string | null = null;
    private setModelSupported: boolean | undefined = undefined;
    private lastDisplayedToolCall = new Map<string, string>();
    constructor(session: KimiSession, opts: { model?: string }) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.model = opts.model;
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(KimiDisplay, context);
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;

        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client, {
            enableChangeTitle: false,
            skillLookup: { workingDirectory: session.path, flavor: 'kimi' }
        });
        this.happyServer = happyServer;

        const runtimeConfig = resolveKimiRuntimeConfig({ model: this.model });

        const backend = createKimiBackend();
        this.backend = backend;
        registerAcpSessionTitleSync(backend, session.client);

        backend.onStderrError((error) => {
            logger.debug('[kimi-remote] stderr error', error);
            session.sendSessionEvent({ type: 'message', message: error.message });
            messageBuffer.addMessage(error.message, 'status');
        });

        await backend.initialize();

        const resumeSessionId = session.sessionId;
        const acpMcpServers = toAcpMcpServers(mcpServers);
        let acpSessionId: string;
        if (resumeSessionId) {
            try {
                acpSessionId = await backend.loadSession({
                    sessionId: resumeSessionId,
                    cwd: session.path,
                    mcpServers: acpMcpServers
                });
            } catch (error) {
                logger.warn('[kimi-remote] resume failed, starting new session', error);
                session.sendSessionEvent({
                    type: 'message',
                    message: 'Kimi resume failed; starting a new session.'
                });
                acpSessionId = await backend.newSession({
                    cwd: session.path,
                    mcpServers: acpMcpServers
                });
            }
        } else {
            acpSessionId = await backend.newSession({
                cwd: session.path,
                mcpServers: acpMcpServers
            });
        }
        session.onSessionFound(acpSessionId);

        this.permissionHandler = new KimiPermissionHandler(
            session.client,
            backend,
            () => session.getPermissionMode() as PermissionMode | undefined
        );
        // Model selection goes over ACP: new kimi-code ignores the KIMI_MODEL
        // env var (only the KIMI_MODEL_NAME provider-synthesis family exists),
        // so the resolved model is applied explicitly here. Without one, adopt
        // the agent-reported current model so the UI shows the truth.
        let effectiveModel: string | null = null;
        if (runtimeConfig.model) {
            effectiveModel = await this.applyInitialModel(backend, acpSessionId, runtimeConfig.model);
        }
        if (!effectiveModel) {
            effectiveModel = backend.getConfigOptionByCategory(acpSessionId, 'model')?.currentValue
                ?? backend.getSessionModelsMetadata(acpSessionId)?.currentModelId
                ?? null;
        }
        this.currentBackendModel = effectiveModel;
        if (effectiveModel) {
            this.displayModel = effectiveModel;
            messageBuffer.addMessage(`[MODEL:${effectiveModel}]`, 'system');
        }
        this.applyDisplayMode(session.getPermissionMode() as PermissionMode, effectiveModel ?? undefined);

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleSwitchRequest()
        });

        const sendReady = () => {
            session.sendSessionEvent({ type: 'ready' });
        };

        while (!this.shouldExit) {
            const batch = await session.queue.waitForMessagesAndGetAsString(this.abortController.signal);
            if (!batch) {
                if (this.abortController.signal.aborted && !this.shouldExit) {
                    continue;
                }
                break;
            }

            if (batch.mode.model && batch.mode.model !== this.currentBackendModel) {
                if (!backend.setModel || this.setModelSupported === false) {
                    batch.mode.model = this.currentBackendModel ?? undefined;
                } else {
                    logger.debug(`[kimi-remote] Switching model inline: ${this.currentBackendModel} -> ${batch.mode.model}`);
                    try {
                        await backend.setModel(acpSessionId, batch.mode.model);
                        this.currentBackendModel = batch.mode.model;
                        this.setModelSupported = true;
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        const methodNotFound = /method not found/i.test(message);
                        if (methodNotFound && this.setModelSupported === undefined) {
                            this.setModelSupported = false;
                            logger.warn('[kimi-remote] Kimi CLI build does not support set_session_model; inline switching disabled for this session');
                            session.sendSessionEvent({
                                type: 'message',
                                message: 'This Kimi CLI build does not support inline model switching. Restart the session to apply a different model.'
                            });
                        } else {
                            logger.warn('[kimi-remote] Inline model switch failed', error);
                            session.sendSessionEvent({
                                type: 'message',
                                message: `Failed to switch model to ${batch.mode.model}. Continuing with ${this.currentBackendModel}.`
                            });
                        }
                        batch.mode.model = this.currentBackendModel ?? undefined;
                    }
                }
            }

            this.applyDisplayMode(batch.mode.permissionMode, batch.mode.model);
            messageBuffer.addMessage(batch.message, 'user');

            // skill_lookup discovery lives on the MCP tool description — do not
            // prepend instructions onto user turns (prompt-injection false positive).
            const promptContent: PromptContent[] = [{
                type: 'text',
                text: batch.message
            }];

            session.onThinkingChange(true);

            try {
                await backend.prompt(acpSessionId, promptContent, (message: AgentMessage) => {
                    this.handleAgentMessage(message);
                });
                void backend.refreshSessionInfo(acpSessionId, session.path);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.warn('[kimi-remote] prompt failed', { message: errorMessage });
                session.sendSessionEvent({
                    type: 'message',
                    message: `Kimi prompt failed: ${errorMessage}`
                });
                messageBuffer.addMessage(`Kimi prompt failed: ${errorMessage}`, 'status');
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
            case 'tool_call': {
                const lastName = this.lastDisplayedToolCall.get(message.id);
                if (lastName !== message.name) {
                    this.messageBuffer.addMessage(`Tool call: ${message.name}`, 'tool');
                    this.lastDisplayedToolCall.set(message.id, message.name);
                }
                break;
            }
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
            default: {
                const _exhaustive: never = message;
                return _exhaustive;
            }
        }
    }

    private async applyInitialModel(
        backend: ReturnType<typeof createKimiBackend>,
        sessionId: string,
        model: string
    ): Promise<string | null> {
        try {
            await backend.setModel(sessionId, model);
            this.setModelSupported = true;
            return model;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/method not found/i.test(message)) {
                this.setModelSupported = false;
            }
            logger.debug('[kimi-remote] session/set_model failed, trying model config option', error);
        }

        const option = backend.getConfigOptionByCategory(sessionId, 'model');
        if (!option) {
            logger.warn(`[kimi-remote] Cannot apply model ${model}: agent exposes no model config option`);
            return null;
        }
        try {
            await backend.setConfigOption(sessionId, option.id, model);
            return model;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`[kimi-remote] Failed to apply model ${model}`, error);
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to switch model to ${model}: ${message}. Using the agent default.`
            });
            return null;
        }
    }

    private applyDisplayMode(permissionMode: PermissionMode | undefined, model?: string): void {
        if (permissionMode && permissionMode !== this.displayPermissionMode) {
            this.displayPermissionMode = permissionMode;
            this.messageBuffer.addMessage(`[MODE:${permissionMode}]`, 'system');
        }
        if (model && model !== this.displayModel) {
            this.displayModel = model;
            this.messageBuffer.addMessage(`[MODEL:${model}]`, 'system');
        }
    }

    private async handleAbort(): Promise<void> {
        const backend = this.backend;
        if (backend && this.session.sessionId) {
            await backend.cancelPrompt(this.session.sessionId);
        }
        await this.permissionHandler?.cancelAll('User aborted');
        this.session.sendSessionEvent({ type: 'message', message: 'Session aborted' });
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

export async function kimiRemoteLauncher(
    session: KimiSession,
    opts: { model?: string }
): Promise<'switch' | 'exit'> {
    const launcher = new KimiRemoteLauncher(session, opts);
    return launcher.launch();
}
