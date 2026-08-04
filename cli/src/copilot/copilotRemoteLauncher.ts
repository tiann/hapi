import React from 'react';
import { registerAcpSessionTitleSync } from '@/agent/acpSessionTitle';
import { logger } from '@/ui/logger';
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge';
import { convertAgentMessage } from '@/agent/messageConverter';
import type { AgentMessage, McpServerStdio, PromptContent } from '@/agent/types';
import { RemoteLauncherBase, type RemoteLauncherDisplayContext, type RemoteLauncherExitReason } from '@/modules/common/remote/RemoteLauncherBase';
import { CopilotDisplay } from '@/ui/ink/CopilotDisplay';
import type { CopilotSession } from './session';
import type { PermissionMode } from './types';
import { createCopilotBackend } from './utils/copilotBackend';
import { CopilotPermissionHandler } from './utils/permissionHandler';
import { resolveCopilotRuntimeConfig } from './utils/config';
import { getCopilotAgentModeLabel, type CopilotAgentMode } from '@hapi/protocol';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { buildCopilotModelsResponseFromBackend } from '@/modules/common/copilotModels';

export class CopilotRemoteLauncher extends RemoteLauncherBase {
    private readonly session: CopilotSession;
    private readonly model?: string;
    private readonly onModelRollback?: (model: string | null) => void;
    private backend: ReturnType<typeof createCopilotBackend> | null = null;
    private permissionHandler: CopilotPermissionHandler | null = null;
    private happyServer: { stop: () => void } | null = null;
    private abortController = new AbortController();
    private displayModel: string | null = null;
    private displayPermissionMode: PermissionMode | null = null;
    private displayAgentMode: CopilotAgentMode | null = null;
    private currentAgentMode: CopilotAgentMode = 'interactive';
    private currentBackendModel: string | null = null;
    private setModelSupported: boolean | undefined = undefined;
    private setModeSupported: boolean | undefined = undefined;
    private activeSessionId: string | null = null;
    private readonly lastDisplayedToolCall = new Map<string, string>();

    constructor(session: CopilotSession, opts: {
        model?: string;
        onModelRollback?: (model: string | null) => void;
    }) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.model = opts.model;
        this.onModelRollback = opts.onModelRollback;
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(CopilotDisplay, context);
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;

        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client, {
            enableChangeTitle: false,
            skillLookup: { workingDirectory: session.path, flavor: 'copilot' }
        });
        this.happyServer = happyServer;

        const runtimeConfig = resolveCopilotRuntimeConfig({ model: this.model });

        this.currentAgentMode = session.getAgentMode();
        const backend = createCopilotBackend({ agentMode: this.currentAgentMode });
        this.backend = backend;
        registerAcpSessionTitleSync(backend, session.client);

        backend.onStderrError((error) => {
            logger.debug('[copilot-remote] stderr error', error);
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
                logger.warn('[copilot-remote] resume failed, starting new session', error);
                session.sendSessionEvent({
                    type: 'message',
                    message: 'Copilot resume failed; starting a new session.'
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
        this.activeSessionId = acpSessionId;
        session.setRemoteAgentModeApplier((agentMode) => this.applyAgentMode(agentMode));

        this.permissionHandler = new CopilotPermissionHandler(
            session.client,
            backend,
            () => session.getPermissionMode() as PermissionMode | undefined
        );

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
        if (runtimeConfig.model && effectiveModel !== runtimeConfig.model) {
            this.rollbackModel();
        }
        if (effectiveModel) {
            this.displayModel = effectiveModel;
            messageBuffer.addMessage(`[MODEL:${effectiveModel}]`, 'system');
        }
        this.applyDisplayMode(session.getPermissionMode() as PermissionMode, effectiveModel ?? undefined);
        // Resume / session metadata may not inherit spawn `--mode`; apply via ACP set_mode.
        await this.applyInitialAgentMode();

        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListCopilotModels, async () => {
            return await buildCopilotModelsResponseFromBackend(acpSessionId, backend, session.path);
        });

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
                batch.mode.model = await this.applyQueuedModel(batch.mode.model) ?? undefined;
            }

            const desiredAgentMode = batch.mode.agentMode ?? session.getAgentMode();
            if (desiredAgentMode !== this.currentAgentMode) {
                await this.applyAgentMode(desiredAgentMode);
            }

            this.applyDisplayMode(batch.mode.permissionMode, batch.mode.model);

            // Empty isolated ticks can update non-mode session config without
            // inventing a user prompt.
            if (batch.message.length === 0) {
                if (session.queue.size() === 0 && !this.shouldExit) {
                    sendReady();
                }
                continue;
            }

            messageBuffer.addMessage(batch.message, 'user');

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
                logger.warn('[copilot-remote] prompt failed', { message: errorMessage });
                session.sendSessionEvent({
                    type: 'message',
                    message: `Copilot prompt failed: ${errorMessage}`
                });
                messageBuffer.addMessage(`Copilot prompt failed: ${errorMessage}`, 'status');
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
        this.session.setRemoteAgentModeApplier(null);
        this.activeSessionId = null;

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
        const converted = convertAgentMessage(message, this.currentBackendModel);
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
        backend: ReturnType<typeof createCopilotBackend>,
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
            logger.debug('[copilot-remote] session/set_model failed, trying model config option', error);
        }

        const option = backend.getConfigOptionByCategory(sessionId, 'model');
        if (!option) {
            logger.warn(`[copilot-remote] Cannot apply model ${model}: agent exposes no model config option`);
            return null;
        }
        try {
            await backend.setConfigOption(sessionId, option.id, model);
            return model;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`[copilot-remote] Failed to apply model ${model}`, error);
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

    private applyDisplayAgentMode(agentMode: CopilotAgentMode): void {
        if (agentMode !== this.displayAgentMode) {
            this.displayAgentMode = agentMode;
            this.messageBuffer.addMessage(`[AGENT_MODE:${agentMode}]`, 'system');
            this.messageBuffer.addMessage(`Copilot agent mode: ${getCopilotAgentModeLabel(agentMode)}`, 'status');
        }
    }

    public async applyAgentMode(agentMode: CopilotAgentMode): Promise<void> {
        const backend = this.backend;
        const sessionId = this.activeSessionId;
        if (!backend || !sessionId) {
            throw new Error('Copilot agent mode switching is unavailable before the remote session is ready');
        }
        if (this.setModeSupported === false) {
            throw new Error('This Copilot CLI build does not support agent mode switching');
        }

        try {
            await backend.setMode(sessionId, agentMode);
            this.setModeSupported = true;
            logger.debug(`[copilot-remote] Applied agent mode via setMode: ${agentMode}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/method not found|does not support session\/set_mode|no mode config option/i.test(message)) {
                this.setModeSupported = false;
                logger.warn('[copilot-remote] Copilot CLI build does not support set_mode; agent mode changes require restart');
                this.session.sendSessionEvent({
                    type: 'message',
                    message: 'This Copilot CLI build does not support agent mode switching. Restart the session to apply Plan or Autopilot.'
                });
            }
            if (this.setModeSupported === false) {
                throw error;
            }
            logger.warn('[copilot-remote] Failed to apply agent mode', error);
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to switch Copilot agent mode to ${getCopilotAgentModeLabel(agentMode)}: ${message}`
            });
            throw error;
        }

        this.currentAgentMode = agentMode;
        this.applyDisplayAgentMode(agentMode);
    }

    private async applyInitialAgentMode(): Promise<void> {
        const requestedMode = this.currentAgentMode;
        try {
            await this.applyAgentMode(requestedMode);
        } catch (error) {
            if (this.setModeSupported !== false) {
                throw error;
            }
            // The Copilot process was spawned with --mode, so unavailable runtime
            // switching must not prevent startup from reflecting that initial mode.
            this.currentAgentMode = requestedMode;
            this.applyDisplayAgentMode(requestedMode);
        }
    }

    private async applyQueuedModel(model: string): Promise<string | null> {
        const backend = this.backend;
        const sessionId = this.activeSessionId;
        if (!backend || !sessionId) {
            throw new Error('Copilot model switching is unavailable before the remote session is ready');
        }

        logger.debug(`[copilot-remote] Switching model inline: ${this.currentBackendModel} -> ${model}`);
        if (backend.setModel && this.setModelSupported !== false) {
            try {
                await backend.setModel(sessionId, model);
                this.currentBackendModel = model;
                this.setModelSupported = true;
                return model;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (/method not found/i.test(message)) {
                    this.setModelSupported = false;
                    logger.debug('[copilot-remote] session/set_model unavailable; trying model config option', error);
                } else {
                    logger.warn('[copilot-remote] Inline model switch failed', error);
                    this.session.sendSessionEvent({
                        type: 'message',
                        message: `Failed to switch model to ${model}. Continuing with ${this.currentBackendModel}.`
                    });
                    return this.rollbackModel();
                }
            }
        }

        const option = backend.getConfigOptionByCategory(sessionId, 'model');
        if (!option) {
            return this.rollbackModel();
        }
        try {
            await backend.setConfigOption(sessionId, option.id, model);
            this.currentBackendModel = model;
            return model;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn('[copilot-remote] Inline model config option switch failed', error);
            this.session.sendSessionEvent({
                type: 'message',
                message: `Failed to switch model to ${model}: ${message}. Continuing with ${this.currentBackendModel}.`
            });
            return this.rollbackModel();
        }
    }

    private rollbackModel(): string | null {
        const model = this.currentBackendModel === 'auto' ? null : this.currentBackendModel;
        this.session.setModel(model);
        this.session.pushKeepAlive();
        this.onModelRollback?.(model);
        return this.currentBackendModel;
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

export async function copilotRemoteLauncher(
    session: CopilotSession,
    opts: { model?: string; onModelRollback?: (model: string | null) => void }
): Promise<'switch' | 'exit'> {
    const launcher = new CopilotRemoteLauncher(session, opts);
    return launcher.launch();
}
