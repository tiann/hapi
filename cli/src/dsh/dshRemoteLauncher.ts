import React from 'react';
import { registerAcpSessionTitleSync } from '@/agent/acpSessionTitle';
import { logger } from '@/ui/logger';
import { convertAgentMessage } from '@/agent/messageConverter';
import type { AgentMessage, PromptContent } from '@/agent/types';
import { RemoteLauncherBase, type RemoteLauncherDisplayContext, type RemoteLauncherExitReason } from '@/modules/common/remote/RemoteLauncherBase';
import { DshDisplay } from '@/ui/ink/DshDisplay';
import type { DshSession } from './session';
import type { PermissionMode } from './types';
import { createDshBackend } from './utils/dshBackend';
import { DshPermissionHandler } from './utils/dshPermissionHandler';
import { resolveDshRuntimeConfig } from './utils/config';
class DshRemoteLauncher extends RemoteLauncherBase {
    private readonly session: DshSession;
    private readonly model?: string;
    private readonly effort?: string;
    private readonly preset?: string;
    private backend: ReturnType<typeof createDshBackend> | null = null;
    private permissionHandler: DshPermissionHandler | null = null;
    private abortController = new AbortController();
    private displayModel: string | null = null;
    private displayPermissionMode: PermissionMode | null = null;
    private currentBackendModel: string | null = null;
    private lastDisplayedToolCall = new Map<string, string>();
    constructor(session: DshSession, opts: { model?: string; effort?: string; preset?: string }) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.model = opts.model;
        this.effort = opts.effort;
        this.preset = opts.preset;
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(DshDisplay, { ...context, onSwitchToLocal: undefined });
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;

        const runtimeConfig = resolveDshRuntimeConfig({ model: this.model });

        // DSH ACP is automation-only (no runtime set_model / set_config_option),
        // so permission, reasoning effort, and model are fixed at spawn through
        // environment variables read by the cordis.yml.
        const backend = createDshBackend({
            permissionMode: session.getPermissionMode() as PermissionMode | undefined,
            effort: this.effort,
            model: runtimeConfig.model,
            preset: this.preset
        });
        this.backend = backend;
        registerAcpSessionTitleSync(backend, session.client);

        backend.onStderrError((error) => {
            logger.debug('[dsh-remote] stderr error', error);
            session.sendSessionEvent({ type: 'message', message: error.message });
            messageBuffer.addMessage(error.message, 'status');
        });

        await backend.initialize();

        // DSH ACP exposes fresh sessions only: it has no `session/load` and
        // rejects non-empty `mcpServers`, so always create a new session with
        // no MCP servers (DSH's own tool stack replaces Hapi's MCP bridge).
        const acpSessionId = await backend.newSession({
            cwd: session.path,
            mcpServers: []
        });
        session.onSessionFound(acpSessionId);

        this.permissionHandler = new DshPermissionHandler(
            session.client,
            backend,
            () => session.getPermissionMode() as PermissionMode | undefined
        );
        // Model is fixed at spawn via DSH_MODEL env; the resolved model is the
        // session's only truth (no runtime switching).
        this.currentBackendModel = runtimeConfig.model ?? null;
        if (this.currentBackendModel) {
            this.displayModel = this.currentBackendModel;
            messageBuffer.addMessage(`[MODEL:${this.currentBackendModel}]`, 'system');
        }
        this.applyDisplayMode(session.getPermissionMode() as PermissionMode, this.currentBackendModel ?? undefined);

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
                // DSH's ACP exposes no `session/list`, so the title-refresh call
                // would only emit a -32601 "Method not found" on stderr. Skip it.
                // void backend.refreshSessionInfo(acpSessionId, session.path);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.warn('[dsh-remote] prompt failed', { message: errorMessage });
                session.sendSessionEvent({
                    type: 'message',
                    message: `DeepSeek Harness prompt failed: ${errorMessage}`
                });
                messageBuffer.addMessage(`DeepSeek Harness prompt failed: ${errorMessage}`, 'status');
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

    private handleSwitchFromUi(): void {
        this.session.sendSessionEvent({
            type: 'message',
            message: 'DeepSeek Harness has no local terminal mode; this session stays remote.'
        });
    }

    private handleSwitchRequest(): void {
        this.session.sendSessionEvent({
            type: 'message',
            message: 'DeepSeek Harness has no local terminal mode; this session stays remote.'
        });
    }
}

export async function dshRemoteLauncher(
    session: DshSession,
    opts: { model?: string; effort?: string; preset?: string }
): Promise<'switch' | 'exit'> {
    const launcher = new DshRemoteLauncher(session, opts);
    return launcher.launch();
}
