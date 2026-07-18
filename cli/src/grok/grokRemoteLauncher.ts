import React from 'react';
import { logger } from '@/ui/logger';
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge';
import { convertAgentMessage } from '@/agent/messageConverter';
import type { AgentMessage, AgentSessionConfig, McpServerStdio, PromptContent } from '@/agent/types';
import { RemoteLauncherBase, type RemoteLauncherDisplayContext, type RemoteLauncherExitReason } from '@/modules/common/remote/RemoteLauncherBase';
import { GrokDisplay } from '@/ui/ink/GrokDisplay';
import type { GrokSession } from './session';
import type { PermissionMode } from './types';
import { createGrokBackend, GrokCancelTimeoutError } from './utils/grokBackend';
import { GrokPermissionHandler } from './utils/grokPermissionHandler';
import { TITLE_INSTRUCTION } from '@/opencode/utils/systemPrompt';
import { isObject } from '@hapi/protocol';
import type { GrokCapabilities } from './utils/grokCapabilities';
import { shouldSurfaceGrokStderr } from './utils/grokDiagnostics';

type GrokSessionOpener = {
    resumeSession(sessionId: string, config: AgentSessionConfig): Promise<{ sessionId: string }>;
    newSession(config: AgentSessionConfig): Promise<string>;
};

export async function openGrokSession(
    backend: GrokSessionOpener,
    existingSessionId: string | null,
    config: AgentSessionConfig,
    publishIdentity: (sessionId: string) => void | Promise<void>
): Promise<string> {
    const sessionId = existingSessionId
        ? (await backend.resumeSession(existingSessionId, config)).sessionId
        : await backend.newSession(config);
    await publishIdentity(sessionId);
    return sessionId;
}

type GrokAbortLifecycle = {
    backend: { cancelPrompt(sessionId: string): Promise<void> } | null;
    nativeSessionId: string | null;
    cancelPermissions: () => Promise<void>;
    resetQueue: () => void;
    setThinkingIdle: () => void;
    resetAbortController: () => void;
    onCancelTimeout: (error: GrokCancelTimeoutError) => void | Promise<void>;
};

export async function settleGrokAbort(lifecycle: GrokAbortLifecycle): Promise<void> {
    let failure: unknown;
    try {
        if (lifecycle.backend && lifecycle.nativeSessionId) {
            await lifecycle.backend.cancelPrompt(lifecycle.nativeSessionId);
        }
    } catch (error) {
        if (error instanceof GrokCancelTimeoutError) {
            try {
                await lifecycle.onCancelTimeout(error);
            } catch (callbackError) {
                failure = callbackError;
            }
        } else {
            failure = error;
        }
    } finally {
        try {
            await lifecycle.cancelPermissions();
        } catch (error) {
            failure ??= error;
        }
        for (const cleanup of [
            lifecycle.resetQueue,
            lifecycle.setThinkingIdle,
            lifecycle.resetAbortController
        ]) {
            try {
                cleanup();
            } catch (error) {
                failure ??= error;
            }
        }
    }
    if (failure !== undefined) throw failure;
}

export function shouldPublishGrokReady(state: {
    queueSize: number;
    shouldExit: boolean;
    isConnected: boolean;
}): boolean {
    return state.queueSize === 0 && !state.shouldExit && state.isConnected;
}

class GrokRemoteLauncher extends RemoteLauncherBase {
    private backend: ReturnType<typeof createGrokBackend> | null = null;
    private nativeSessionId: string | null = null;
    private permissions: GrokPermissionHandler | null = null;
    private happyServer: { stop: () => void } | null = null;
    private abortController = new AbortController();
    private instructionsSent = false;
    private transportTerminalReported = false;
    constructor(private readonly session: GrokSession) { super(process.env.DEBUG ? session.logPath : undefined); }
    launch(): Promise<RemoteLauncherExitReason> {
        return this.start({ onExit: () => this.requestExit('exit', () => this.abort()), onSwitchToLocal: () => this.requestExit('switch', () => this.abort()) });
    }
    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement { return React.createElement(GrokDisplay, context); }
    protected async runMainLoop(): Promise<void> {
        const { server, mcpServers } = await buildHapiMcpBridge(this.session.client);
        this.happyServer = server;
        const permissionMode = (this.session.getPermissionMode() as PermissionMode | undefined) ?? 'default';
        const backend = createGrokBackend({ permissionMode });
        this.backend = backend;
        backend.onTerminalError((error) => {
            logger.warn('[grok-remote] transport terminated', error);
            this.terminalizeClosedTransport(`Grok transport terminated: ${error.message}. Session stopped.`);
        });
        backend.onStderrError((error) => {
            logger.debug('[grok-remote] stderr', error);
            if (!shouldSurfaceGrokStderr(error.message)) return;
            this.session.sendSessionEvent({ type: 'message', message: error.message });
        });
        backend.onUnknownExtension((method, params) => {
            this.session.sendAgentMessage({ type: 'grok-extension', method, params });
        });
        backend.onConfigChanged((config) => {
            this.session.setRuntime(config);
            if (config.model) this.messageBuffer.addMessage(`[MODEL:${config.model}]`, 'system');
            if (config.effort) this.messageBuffer.addMessage(`[EFFORT:${config.effort}]`, 'system');
        });
        backend.onCapabilitiesChanged((capabilities) => this.publishCapabilities(capabilities));
        backend.onStatus((status, data) => {
            const reason = typeof data.reason === 'string' ? `: ${data.reason}` : '';
            const message = `Grok ${status}${reason}`;
            this.messageBuffer.addMessage(message, 'status');
            this.session.sendSessionEvent({ type: 'message', message });
        });
        await backend.initialize();
        const config = { cwd: this.session.path, mcpServers: toAcpMcpServers(mcpServers) };
        let sessionId: string;
        try {
            sessionId = await openGrokSession(
                backend,
                this.session.sessionId,
                config,
                (nativeSessionId) => this.session.onSessionFound(nativeSessionId)
            );
        } catch (error) {
            if (this.session.sessionId) {
                const detail = error instanceof Error ? error.message : String(error);
                logger.warn('[grok-remote] resume failed', error);
                this.session.sendSessionEvent({
                    type: 'message',
                    message: `Grok resume failed: ${detail}. Start a new Grok session explicitly.`
                });
            }
            throw error;
        }
        this.nativeSessionId = sessionId;
        this.session.setRuntimeConfigHandler((config) => backend.setSessionConfig(sessionId, config));
        await this.publishDiscovery(backend, sessionId);
        try {
            const initial = await backend.setSessionConfig(sessionId, {
                model: this.session.getModel(), effort: this.session.getEffort()
            });
            this.session.setRuntime({ model: initial.model as string | undefined, effort: initial.effort as string | undefined });
        } catch (error) {
            const message = `Grok initial model/effort config failed: ${error instanceof Error ? error.message : String(error)}`;
            logger.warn('[grok-remote] initial config failed', error);
            this.session.sendSessionEvent({ type: 'message', message });
            this.messageBuffer.addMessage(message, 'status');
        }
        this.permissions = new GrokPermissionHandler(
            this.session.client, backend, () => this.session.getPermissionMode() as PermissionMode | undefined
        );
        this.setupAbortHandlers(this.session.client.rpcHandlerManager, {
            onAbort: () => this.abort(), onSwitch: () => this.requestExit('switch', () => this.abort())
        });
        while (!this.shouldExit) {
            const signal = this.abortController.signal;
            const batch = await this.session.queue.waitForMessagesAndGetAsString(signal);
            if (!batch) {
                if (signal.aborted && !this.shouldExit) continue;
                break;
            }
            this.session.setRuntime(batch.mode);
            this.messageBuffer.addMessage(batch.message, 'user');
            let text = batch.message;
            if (!this.instructionsSent) { text = `${TITLE_INSTRUCTION}\n\n${text}`; this.instructionsSent = true; }
            const prompt: PromptContent[] = [{ type: 'text', text }];
            const started = Date.now();
            this.session.onThinkingChange(true);
            try {
                await backend.prompt(sessionId, prompt, (message) => this.handleMessage(message));
            } catch (error) {
                logger.warn('[grok-remote] prompt failed', error);
                if (!backend.isConnected()) {
                    this.terminalizeClosedTransport('Grok transport closed while cancelling the prompt. Session stopped.');
                } else {
                    this.session.sendSessionEvent({ type: 'message', message: 'Grok prompt failed. Check logs for details.' });
                }
            } finally {
                this.session.sendSessionEvent({ type: 'turn-duration', durationMs: Math.max(0, Date.now() - started) });
                this.session.onThinkingChange(false);
                await this.permissions?.cancelAll('Prompt finished');
                if (shouldPublishGrokReady({
                    queueSize: this.session.queue.size(),
                    shouldExit: this.shouldExit,
                    isConnected: backend.isConnected()
                })) {
                    this.session.sendSessionEvent({ type: 'ready' });
                }
            }
        }
    }
    private async publishDiscovery(backend: ReturnType<typeof createGrokBackend>, sessionId: string): Promise<void> {
        const capabilities = backend.getCapabilities();
        const methods = ['_x.ai/commands/list', '_x.ai/plugins/list', '_x.ai/mcp/list', '_x.ai/skills/list'] as const;
        const results = await Promise.all(methods.map(async (method) => {
            try { return await backend.requestExtension(method, { sessionId, cwd: this.session.path }); } catch { return null; }
        }));
        const commandNames = new Set(capabilities?.commands.map((command) => command.name) ?? []);
        const commandResult = results[0];
        if (isObject(commandResult) && Array.isArray(commandResult.commands)) {
            for (const entry of commandResult.commands) {
                if (typeof entry === 'string') commandNames.add(entry);
                else if (isObject(entry) && typeof entry.name === 'string') commandNames.add(entry.name);
            }
        }
        this.session.client.updateMetadata((metadata) => ({
            ...metadata,
            slashCommands: Array.from(commandNames),
            tools: methods.slice(1).filter((_method, index) => results[index + 1] !== null),
            grokCapabilities: capabilities ? this.toMetadataCapabilities(capabilities) : undefined
        }));
    }
    private publishCapabilities(capabilities: GrokCapabilities): void {
        this.session.client.updateMetadata((metadata) => ({
            ...metadata,
            grokCapabilities: this.toMetadataCapabilities(capabilities)
        }));
    }
    private toMetadataCapabilities(capabilities: GrokCapabilities) {
        return {
            version: capabilities.version,
            loadSession: capabilities.loadSession,
            image: capabilities.image,
            currentModel: capabilities.currentModelId,
            currentEffort: capabilities.currentEffort,
            models: capabilities.models,
            commands: capabilities.commands
        };
    }
    private handleMessage(message: AgentMessage): void {
        if (message.type === 'user_message') { this.session.sendUserMessage(message.text); return; }
        const converted = convertAgentMessage(message);
        if (converted) this.session.sendAgentMessage(converted);
        if (message.type === 'text') this.messageBuffer.addMessage(message.text, 'assistant');
        else if (message.type === 'reasoning') this.messageBuffer.addMessage(message.text, 'status');
        else if (message.type === 'tool_call') this.messageBuffer.addMessage(`Tool call: ${message.name}`, 'tool');
        else if (message.type === 'tool_result') this.messageBuffer.addMessage('Tool result received', 'result');
        else if (message.type === 'error') this.messageBuffer.addMessage(message.message, 'status');
    }
    private async abort(): Promise<void> {
        await settleGrokAbort({
            backend: this.backend,
            nativeSessionId: this.nativeSessionId,
            cancelPermissions: async () => { await this.permissions?.cancelAll('User aborted'); },
            resetQueue: () => this.session.queue.reset(),
            setThinkingIdle: () => this.session.onThinkingChange(false),
            resetAbortController: () => {
                this.abortController.abort();
                this.abortController = new AbortController();
            },
            onCancelTimeout: (error) => {
                logger.warn('[grok-remote] cancellation timed out', error);
                this.terminalizeClosedTransport(error.message);
            }
        });
    }
    private terminalizeClosedTransport(message: string): void {
        if (!this.exitReason) this.exitReason = 'exit';
        this.shouldExit = true;
        this.abortController.abort();
        if (this.transportTerminalReported) return;
        this.transportTerminalReported = true;
        this.session.sendSessionEvent({ type: 'message', message });
        this.messageBuffer.addMessage(message, 'status');
    }
    protected async cleanup(): Promise<void> {
        this.session.setRuntimeConfigHandler(null);
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);
        await this.permissions?.cancelAll('Session ended');
        await this.backend?.disconnect();
        this.nativeSessionId = null;
        this.happyServer?.stop();
    }
}

function toAcpMcpServers(config: Record<string, { command: string; args: string[] }>): McpServerStdio[] {
    return Object.entries(config).map(([name, entry]) => ({ name, command: entry.command, args: entry.args, env: [] }));
}
export async function grokRemoteLauncher(session: GrokSession): Promise<'switch' | 'exit'> {
    return new GrokRemoteLauncher(session).launch();
}
