import React from 'react';
import { logger } from '@/ui/logger';
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge';
import { convertAgentMessage } from '@/agent/messageConverter';
import type { AgentMessage, McpServerStdio, PromptContent } from '@/agent/types';
import { RemoteLauncherBase, type RemoteLauncherDisplayContext, type RemoteLauncherExitReason } from '@/modules/common/remote/RemoteLauncherBase';
import { GeminiDisplay } from '@/ui/ink/GeminiDisplay';
import type { GeminiSession } from './session';
import type { PermissionMode } from './types';
import { createGeminiBackend } from './utils/geminiBackend';
import { GeminiPermissionHandler } from './utils/permissionHandler';
import { resolveGeminiRuntimeConfig } from './utils/config';

class GeminiRemoteLauncher extends RemoteLauncherBase {
    private readonly session: GeminiSession;
    private readonly model?: string;
    private readonly hookSettingsPath?: string;
    private backend: ReturnType<typeof createGeminiBackend> | null = null;
    private permissionHandler: GeminiPermissionHandler | null = null;
    private happyServer: { stop: () => void } | null = null;
    private abortController = new AbortController();
    private displayModel: string | null = null;
    private displayPermissionMode: PermissionMode | null = null;

    constructor(session: GeminiSession, opts: { model?: string; hookSettingsPath?: string }) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.model = opts.model;
        this.hookSettingsPath = opts.hookSettingsPath;
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(GeminiDisplay, context);
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;

        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client);
        this.happyServer = happyServer;

        const runtimeConfig = resolveGeminiRuntimeConfig({ model: this.model });
        this.displayModel = runtimeConfig.model;
        messageBuffer.addMessage(`[MODEL:${runtimeConfig.model}]`, 'system');

        const backend = createGeminiBackend({
            model: runtimeConfig.model,
            token: runtimeConfig.token,
            resumeSessionId: session.sessionId,
            hookSettingsPath: this.hookSettingsPath,
            cwd: session.path
        });
        this.backend = backend;

        backend.onStderrError((error) => {
            logger.debug('[gemini-remote] stderr error', error);
            session.sendSessionEvent({ type: 'message', message: error.message });
            messageBuffer.addMessage(error.message, 'status');
        });

        await backend.initialize();

        let acpSessionId = await backend.newSession({
            cwd: session.path,
            mcpServers: toAcpMcpServers(mcpServers)
        });
        session.onSessionFound(acpSessionId);

        this.permissionHandler = new GeminiPermissionHandler(
            session.client,
            backend,
            () => session.getPermissionMode() as PermissionMode | undefined
        );
        this.applyDisplayMode(session.getPermissionMode() as PermissionMode, runtimeConfig.model);

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

            if (batch.isolate && batch.message.trim() === '/new') {
                this.messageBuffer.addMessage('Starting new Gemini session...', 'status');
                acpSessionId = await backend.newSession({
                    cwd: session.path,
                    mcpServers: toAcpMcpServers(mcpServers)
                });
                session.onSessionFound(acpSessionId);
                sendReady();
                continue;
            }

            this.applyDisplayMode(batch.mode.permissionMode, batch.mode.model);
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
            } catch (error) {
                logger.warn('[gemini-remote] prompt failed', error);
                session.sendSessionEvent({
                    type: 'message',
                    message: 'Gemini prompt failed. Check logs for details.'
                });
                messageBuffer.addMessage('Gemini prompt failed', 'status');
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
            this.session.sendCodexMessage(converted);
        }

        switch (message.type) {
            case 'text':
                this.messageBuffer.addMessage(message.text, 'assistant');
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

export async function geminiRemoteLauncher(
    session: GeminiSession,
    opts: { model?: string; hookSettingsPath?: string }
): Promise<'switch' | 'exit'> {
    const launcher = new GeminiRemoteLauncher(session, opts);
    return launcher.launch();
}
