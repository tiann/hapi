import { randomUUID } from 'node:crypto';
import React from 'react';
import { logger } from '@/ui/logger';
import { convertAgentMessage } from '@/agent/messageConverter';
import type { AgentMessage, PromptContent } from '@/agent/types';
import { RemoteLauncherBase, type RemoteLauncherDisplayContext, type RemoteLauncherExitReason } from '@/modules/common/remote/RemoteLauncherBase';
import { AgyDisplay } from '@/ui/ink/AgyDisplay';
import type { AgySession } from './session';
import type { PermissionMode } from './types';
import { createAgyBackend, isNativeAgyConversationId } from './utils/agyBackend';
import { resolveAgyRuntimeConfig } from './utils/config';
import { buildAgyAdditionalDirectories, resolveAgyLogFile } from './utils/paths';
import { agySystemPrompt } from './utils/systemPrompt';
import { deriveAgyFallbackTitle, extractAgyTitleMarker } from './utils/title';
import { applyHapiTitleToMetadata } from '@/codex/utils/codexThreadTitle';

const CONTINUATION_INSTRUCTION = 'Continue this HAPI Antigravity agy session. Use the prior transcript as context; answer only the latest user message unless it asks otherwise.';
const DEFAULT_AUTH_RETRY_DELAY_MS = 3_000;

export function isRetryableAgyBrowserAuthTimeout(message: string): boolean {
    return message.includes('Authentication required. Please visit the URL to log in:')
        && /Error: authentication (?:timed out|failed or timed out)\.?/i.test(message);
}

function sanitizeAgyPromptError(message: string): string {
    if (isRetryableAgyBrowserAuthTimeout(message)) {
        return 'auth_error: Antigravity browser authentication timed out after one retry';
    }
    return message;
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) {
        return false;
    }
    if (delayMs <= 0) {
        return true;
    }
    return new Promise<boolean>((resolve) => {
        const onAbort = () => {
            clearTimeout(timeout);
            signal.removeEventListener('abort', onAbort);
            resolve(false);
        };
        const timeout = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve(true);
        }, delayMs);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

class AgyRemoteLauncher extends RemoteLauncherBase {
    private readonly session: AgySession;
    private readonly model?: string;
    private backend: ReturnType<typeof createAgyBackend> | null = null;
    private abortController = new AbortController();
    private displayModel: string | null = null;
    private displayPermissionMode: PermissionMode | null = null;
    private transcript: string[] = [];
    private instructionsSent = false;
    private pendingFallbackTitleSource: string | null = null;

    constructor(session: AgySession, private readonly opts: {
        additionalDirectories?: string[];
        logFile?: string;
        model?: string;
        printTimeout?: string;
        authRetryDelayMs?: number;
    }) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.model = this.opts.model;
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(AgyDisplay, context);
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;
        const runtimeConfig = resolveAgyRuntimeConfig({ model: this.model });
        this.displayModel = runtimeConfig.model;
        messageBuffer.addMessage(`[MODEL:${runtimeConfig.model}]`, 'system');

        const backend = createAgyBackend({
            additionalDirectories: buildAgyAdditionalDirectories({
                cwd: session.path,
                additionalDirectories: this.opts.additionalDirectories
            }),
            logFile: resolveAgyLogFile(session.logPath, this.opts.logFile),
            model: runtimeConfig.model,
            cwd: session.path,
            permissionMode: session.getPermissionMode() as string | undefined,
            printTimeout: this.opts.printTimeout
        });
        this.backend = backend;

        backend.onStderrError((error) => {
            logger.debug('[agy-remote] stderr error', error);
            session.sendSessionEvent({ type: 'message', message: error.message });
            messageBuffer.addMessage(error.message, 'status');
        });

        await backend.initialize();

        const resumeSessionId = session.sessionId;
        let agySessionId: string;
        if (resumeSessionId) {
            try {
                agySessionId = await backend.loadSession({
                    sessionId: resumeSessionId,
                    cwd: session.path,
                    mcpServers: []
                });
            } catch (error) {
                logger.warn('[agy-remote] resume failed, starting a new print session', error);
                session.sendSessionEvent({
                    type: 'message',
                    message: 'Antigravity agy resume failed; starting a new print session.'
                });
                agySessionId = await backend.newSession({ cwd: session.path, mcpServers: [] });
            }
        } else {
            agySessionId = await backend.newSession({ cwd: session.path, mcpServers: [] });
        }
        await session.onSessionFound(agySessionId);

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

            this.applyDisplayMode(batch.mode.permissionMode, batch.mode.model);
            messageBuffer.addMessage(batch.message, 'user');
            if (this.shouldInitializeTitle()) {
                this.pendingFallbackTitleSource = batch.message;
            }

            let messageText = this.buildPrompt(batch.message, isNativeAgyConversationId(agySessionId));
            if (!this.instructionsSent) {
                messageText = `${agySystemPrompt}\n\n${messageText}`;
                this.instructionsSent = true;
            }
            const promptContent: PromptContent[] = [{ type: 'text', text: messageText }];

            session.onThinkingChange(true);
            const turnStartedAt = Date.now();
            const turnAbortSignal = this.abortController.signal;

            try {
                let authAttempt = 0;
                while (true) {
                    try {
                        await backend.prompt(agySessionId, promptContent, (message: AgentMessage) => {
                            this.handleAgentMessage(message);
                        }, {
                            model: batch.mode.model,
                            permissionMode: batch.mode.permissionMode
                        });
                        break;
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        if (
                            authAttempt === 0
                            && !turnAbortSignal.aborted
                            && !this.shouldExit
                            && isRetryableAgyBrowserAuthTimeout(errorMessage)
                        ) {
                            authAttempt += 1;
                            logger.warn('[agy-remote] browser OAuth timed out before prompt submission; retrying once');
                            const retryReady = await waitForRetry(
                                this.opts.authRetryDelayMs ?? DEFAULT_AUTH_RETRY_DELAY_MS,
                                turnAbortSignal
                            );
                            if (retryReady && !this.shouldExit) {
                                continue;
                            }
                        }
                        throw error;
                    }
                }
                const nativeConversationId = backend.getLastNativeConversationId();
                if (nativeConversationId && nativeConversationId !== agySessionId) {
                    try {
                        await session.onSessionFound(nativeConversationId);
                    } catch (error) {
                        this.exitReason = 'exit';
                        this.shouldExit = true;
                        this.abortController.abort();
                        throw error;
                    }
                    agySessionId = nativeConversationId;
                    logger.debug(`[agy-remote] Native Antigravity conversation ID discovered: ${nativeConversationId}`);
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const reportableError = sanitizeAgyPromptError(errorMessage);
                logger.warn('[agy-remote] prompt failed', { message: reportableError });
                session.sendSessionEvent({
                    type: 'message',
                    message: `Antigravity agy prompt failed: ${reportableError}`
                });
                messageBuffer.addMessage(`Antigravity agy prompt failed: ${reportableError}`, 'status');
            } finally {
                session.sendSessionEvent({
                    type: 'turn-duration',
                    durationMs: Math.max(0, Date.now() - turnStartedAt)
                });
                session.onThinkingChange(false);
                if (session.queue.size() === 0 && !this.shouldExit) {
                    sendReady();
                }
            }
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);
        if (this.backend) {
            await this.backend.disconnect();
            this.backend = null;
        }
    }

    private buildPrompt(latestUserMessage: string, hasNativeConversation: boolean): string {
        const prior = !hasNativeConversation && this.transcript.length > 0
            ? `${CONTINUATION_INSTRUCTION}\n\nPrior transcript:\n${this.transcript.join('\n\n')}\n\nLatest user message:\n${latestUserMessage}`
            : latestUserMessage;
        this.transcript.push(`User: ${latestUserMessage}`);
        return prior;
    }

    private shouldInitializeTitle(): boolean {
        const metadata = this.session.client.getMetadataSnapshot();
        return !metadata?.title && !metadata?.name;
    }

    private applyTitle(title: string | null): void {
        if (!title) {
            return;
        }
        const metadata = this.session.client.getMetadataSnapshot();
        const currentTitle = metadata?.title ?? metadata?.name ?? null;
        const updated = applyHapiTitleToMetadata(metadata ?? { path: this.session.path, host: '' }, title);
        if (!updated.title || updated.title === currentTitle) {
            return;
        }

        this.session.client.sendClaudeSessionMessage({
            type: 'summary',
            summary: updated.title,
            leafUuid: randomUUID()
        } as never);
        this.session.client.updateMetadata((currentMetadata) => applyHapiTitleToMetadata(currentMetadata, updated.title));
        this.pendingFallbackTitleSource = null;
        logger.debug(`[agy-remote] HAPI title updated from agy response: ${updated.title}`);
    }

    private normalizeAgentMessage(message: AgentMessage): AgentMessage | null {
        if (message.type !== 'text') {
            return message;
        }

        const extracted = extractAgyTitleMarker(message.text);
        if (extracted.title) {
            this.applyTitle(extracted.title);
        } else if (this.pendingFallbackTitleSource && this.shouldInitializeTitle()) {
            this.applyTitle(deriveAgyFallbackTitle(this.pendingFallbackTitleSource));
        }

        const text = extracted.text.trim();
        if (!text) {
            return null;
        }
        return { ...message, text };
    }

    private handleAgentMessage(message: AgentMessage): void {
        const normalized = this.normalizeAgentMessage(message);
        if (!normalized) {
            return;
        }

        const converted = convertAgentMessage(normalized);
        if (converted) {
            this.session.sendAgentMessage(converted);
        }

        switch (normalized.type) {
            case 'text':
                this.transcript.push(`Assistant: ${normalized.text}`);
                this.messageBuffer.addMessage(normalized.text, 'assistant');
                break;
            case 'reasoning':
                this.messageBuffer.addMessage(normalized.text, 'status');
                break;
            case 'user_message':
                this.transcript.push(`User: ${normalized.text}`);
                this.messageBuffer.addMessage(normalized.text, 'user');
                break;
            case 'moa_reference':
                this.messageBuffer.addMessage(`MoA reference: ${normalized.label}`, 'status');
                break;
            case 'moa_aggregating':
                this.messageBuffer.addMessage(`MoA aggregating${normalized.aggregator ? `: ${normalized.aggregator}` : ''}`, 'status');
                break;
            case 'tool_call':
                this.messageBuffer.addMessage(`Tool call: ${normalized.name}`, 'tool');
                break;
            case 'tool_result':
                this.messageBuffer.addMessage('Tool result received', 'result');
                break;
            case 'plan':
                this.messageBuffer.addMessage('Plan updated', 'status');
                break;
            case 'error':
                this.messageBuffer.addMessage(normalized.message, 'status');
                break;
            case 'turn_complete':
                this.messageBuffer.addMessage('Turn complete', 'status');
                break;
            case 'title':
                break;
            default: {
                const _exhaustive: never = normalized;
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

export async function agyRemoteLauncher(
    session: AgySession,
    opts: {
        additionalDirectories?: string[];
        logFile?: string;
        model?: string;
        printTimeout?: string;
        authRetryDelayMs?: number;
    }
): Promise<'switch' | 'exit'> {
    const launcher = new AgyRemoteLauncher(session, opts);
    return launcher.launch();
}
