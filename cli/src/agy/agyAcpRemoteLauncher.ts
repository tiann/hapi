import React from 'react';
import { splitAgyModelSelection } from '@hapi/protocol';
import { logger } from '@/ui/logger';
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay';
import { convertAgentMessage } from '@/agent/messageConverter';
import { createAcpSessionTitleSync, registerAcpSessionTitleSync } from '@/agent/acpSessionTitle';
import type { AgentMessage, PermissionRequest, PromptContent } from '@/agent/types';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import { isAcpIndeterminateError } from '@/agent/backends/acp/AcpStdioTransport';
import { AcpPermissionHandler } from '@/modules/common/permission/AcpPermissionHandler';
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase';
import type { SessionEffort, SessionModel } from '@/api/types';
import type { AgySession } from './session';
import type { AgyMode, PermissionMode } from './types';
import { createAgyAcpBackend } from './utils/agyAcpBackend';

type UsageMessage = Extract<AgentMessage, { type: 'usage' }>;

/** `always-proceed` stays in agy's default mode; HAPI answers its requests. */
export function agyAcpModeForPermission(mode: PermissionMode | undefined): string {
    switch (mode) {
        case 'acceptEdits':
            return 'accept-edits';
        case 'plan':
            return 'plan';
        case 'request-review':
        case 'always-proceed':
        case undefined:
            return 'default';
    }
}

/**
 * agy ids carry effort as a suffix (`gemini-3.8-flash-low`) while HAPI stores
 * model and effort separately. No model means agy's default, whose effort can
 * still be chosen.
 */
export function resolveAgyAcpModelId(
    model: SessionModel | undefined,
    effort: SessionEffort | undefined,
    defaultModelId: string | null
): string | null {
    const selected = splitAgyModelSelection(model);
    if (!selected.model) {
        if (!defaultModelId) return null;
        if (!effort) return defaultModelId;
        const base = splitAgyModelSelection(defaultModelId).model ?? defaultModelId;
        return `${base}-${effort}`;
    }
    const value = model!.trim();
    return selected.effort || !effort ? value : `${value}-${effort}`;
}

function addOptional(a: number | undefined, b: number | undefined): number | undefined {
    return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

/**
 * Each request of a steered turn reports only its own share, so they add up.
 * The summed input is not a context size, and agy sends no `usage_update`, so
 * the context is the latest request's input.
 */
export function addAgyUsage(total: UsageMessage | null, next: UsageMessage): UsageMessage {
    if (!total) return next;
    return {
        type: 'usage',
        inputTokens: total.inputTokens + next.inputTokens,
        outputTokens: total.outputTokens + next.outputTokens,
        totalTokens: addOptional(total.totalTokens, next.totalTokens),
        thoughtTokens: addOptional(total.thoughtTokens, next.thoughtTokens),
        cacheReadTokens: addOptional(total.cacheReadTokens, next.cacheReadTokens),
        cacheCreationTokens: addOptional(total.cacheCreationTokens, next.cacheCreationTokens),
        contextTokens: next.contextTokens
            ?? next.inputTokens + (next.cacheReadTokens ?? 0) + (next.cacheCreationTokens ?? 0),
        contextWindow: next.contextWindow ?? total.contextWindow
    };
}

/** agy's question tool; its permission request must reach the user. */
export function isAgyQuestionRequest(request: PermissionRequest): boolean {
    const input = request.rawInput as { questions?: unknown } | undefined;
    return Array.isArray(input?.questions) || /\bask_question\b/.test(request.title ?? '');
}

type AgyTurn = {
    usage: UsageMessage | null;
    // Any agent output proves agy accepted the prompt.
    sawActivity: boolean;
    acknowledge: () => void;
};

/**
 * Antigravity over `agy acp`. The agy conversation id is the ACP session id,
 * so a stored `agySessionId` resumes through `session/resume` without replay.
 */
export class AgyAcpRemoteLauncher extends RemoteLauncherBase {
    private readonly session: AgySession;
    private readonly createBackend: () => AcpSdkBackend;
    private backend: AcpSdkBackend | null = null;
    private permissionHandler: AcpPermissionHandler | null = null;
    private acpSessionId: string | null = null;
    private abortController = new AbortController();
    /** agy's own model at session start; the target of the "Default" selection. */
    private defaultModelId: string | null = null;
    private currentModelId: string | null = null;
    private turnPermissionMode: PermissionMode | undefined = undefined;
    private turn: AgyTurn | null = null;
    private backendLost = false;

    constructor(session: AgySession, opts: { createBackend?: () => AcpSdkBackend } = {}) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.createBackend = opts.createBackend ?? createAgyAcpBackend;
        this.session.setKillHandler(() => this.handleKill());
    }

    async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({ onExit: () => this.handleExitFromUi() });
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, { ...context, agentLabel: 'Antigravity' });
    }

    protected getCurrentSessionId(): string | null {
        return this.acpSessionId;
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        this.messageBuffer.addMessage(
            session.sessionId ? 'Resuming agy session...' : 'Starting agy session...',
            'status'
        );
        await this.startBackend(session.sessionId);

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            // AGY is remote-only: a web-initiated switch to local has no target.
            onSwitch: () => {}
        });

        while (!this.shouldExit) {
            const batch = await session.queue.waitForMessagesAndGetAsString(this.abortController.signal);
            if (!batch) {
                if (this.abortController.signal.aborted && !this.shouldExit) continue;
                break;
            }
            const localIds = batch.items
                .map((item) => item.localId)
                .filter((localId): localId is string => Boolean(localId));
            await this.runTurn(batch.message, batch.mode, localIds);
        }
    }

    private async startBackend(resumeSessionId: string | null): Promise<void> {
        const session = this.session;
        const backend = this.createBackend();
        this.backend = backend;
        this.backendLost = false;
        try {
            const titleSync = createAcpSessionTitleSync(session.client);
            registerAcpSessionTitleSync(backend, session.client, titleSync);
            backend.onStderrError((error) => {
                logger.debug('[agy-acp] stderr error', error);
                session.sendSessionEvent({ type: 'message', message: error.message });
                this.messageBuffer.addMessage(error.message, 'status');
            });

            try {
                await backend.initialize();
            } catch (error) {
                throw new Error(describeAgyStartFailure(error));
            }

            let acpSessionId: string | null = null;
            if (resumeSessionId) {
                try {
                    if (!backend.supportsSessionResume()) {
                        throw new Error('agy acp does not advertise session/resume');
                    }
                    acpSessionId = await backend.resumeSession({
                        sessionId: resumeSessionId,
                        cwd: session.path,
                        mcpServers: []
                    });
                } catch (error) {
                    logger.warn('[agy-acp] resume failed, starting a new conversation', error);
                    session.sendSessionEvent({
                        type: 'message',
                        message: 'Antigravity could not resume the conversation; starting a new one.'
                    });
                }
            }
            if (!acpSessionId) {
                acpSessionId = await backend.newSession({ cwd: session.path, mcpServers: [] });
            }
            this.acpSessionId = acpSessionId;
            // Marks the session as running on agy acp.
            session.onSessionFound(acpSessionId, { agyProtocol: 'acp' });
            session.client.emitSessionReady();

            const reported = backend.getSessionModelsMetadata(acpSessionId)?.currentModelId ?? null;
            this.currentModelId = reported;
            // After a relaunch the resumed conversation reports the switched
            // model, not agy's default, so keep the first value.
            if (this.defaultModelId === null) this.defaultModelId = reported;

            this.permissionHandler = new AcpPermissionHandler(
                session.client,
                backend,
                () => this.turnPermissionMode ?? (session.getPermissionMode() as PermissionMode | undefined),
                {
                    // agy titles run_command requests with the command line and
                    // gets no HAPI MCP tools, so the tool-name hints could only
                    // match command text.
                    autoApprovalRules: { alwaysToolNameHints: [], alwaysToolIdHints: [] },
                    autoApproveOnce: true,
                    requiresUser: isAgyQuestionRequest
                }
            );
            void backend.refreshSessionInfo(acpSessionId, session.path);
        } catch (error) {
            // A half-started process must not serve later turns; the next turn
            // starts agy again and resumes the previous conversation.
            this.backendLost = true;
            if (this.backend === backend) this.backend = null;
            await this.retireBackend(backend);
            throw error;
        }
    }

    private async relaunchBackend(): Promise<void> {
        const previous = this.backend;
        this.backend = null;
        if (previous) await this.retireBackend(previous);
        await this.startBackend(this.acpSessionId);
    }

    /** Stops a backend for good: late permission requests are cancelled, not approved. */
    private async retireBackend(backend: AcpSdkBackend): Promise<void> {
        backend.onPermissionRequest((request) => {
            void backend.respondToPermission(request.sessionId, request, { outcome: 'cancelled' });
        });
        const handler = this.permissionHandler;
        this.permissionHandler = null;
        await handler?.cancelAll('Antigravity stopped');
        try {
            await backend.disconnect();
        } catch (error) {
            logger.debug('[agy-acp] disconnect failed', error);
        }
    }

    /** Apply the batch's mode and model; false when the turn must not run. */
    private async applyTurnConfig(backend: AcpSdkBackend, acpSessionId: string, mode: AgyMode): Promise<boolean> {
        // Sent every turn: agy can change its mode on its own (current_mode_update),
        // which HAPI does not track.
        const acpMode = agyAcpModeForPermission(mode.permissionMode);
        try {
            await backend.setMode(acpSessionId, acpMode);
        } catch (error) {
            this.reportTurnError(`Failed to switch Antigravity mode: ${errorMessage(error)}`);
            return false;
        }

        const modelId = resolveAgyAcpModelId(mode.model, mode.effort, this.defaultModelId);
        if (modelId && modelId !== this.currentModelId) {
            try {
                await backend.setModel(acpSessionId, modelId);
                this.currentModelId = modelId;
                this.messageBuffer.addMessage(`[MODEL:${modelId}]`, 'system');
            } catch (error) {
                this.reportTurnError(`Failed to switch Antigravity model to ${modelId}: ${errorMessage(error)}`);
                return false;
            }
        }
        return true;
    }

    private async runTurn(message: string, mode: AgyMode, localIds: string[]): Promise<void> {
        const session = this.session;
        session.onThinkingChange(true);
        this.turnPermissionMode = mode.permissionMode;
        let acknowledged = false;
        const turn: AgyTurn = {
            usage: null,
            sawActivity: false,
            // AgySession does not acknowledge on dequeue: a message counts as
            // delivered once agy takes it (output or answer), or when it goes
            // back to the composer.
            acknowledge: () => {
                if (acknowledged || localIds.length === 0) return;
                acknowledged = true;
                session.client.emitMessagesConsumed(localIds);
            }
        };
        this.turn = turn;
        try {
            if (this.backendLost || !this.backend || !this.backend.isTransportAlive()) {
                try {
                    await this.relaunchBackend();
                } catch (error) {
                    this.reportTurnError(`Failed to restart Antigravity: ${errorMessage(error)}`);
                    this.restorePrompt(turn, message);
                    return;
                }
            }
            const backend = this.backend;
            const acpSessionId = this.acpSessionId;
            if (!backend || !acpSessionId) {
                this.restorePrompt(turn, message);
                return;
            }
            if (!await this.applyTurnConfig(backend, acpSessionId, mode)) {
                this.restorePrompt(turn, message);
                return;
            }
            this.messageBuffer.addMessage(message, 'user');
            const prompt: PromptContent[] = [{ type: 'text', text: message }];
            try {
                await backend.prompt(acpSessionId, prompt, (update) => this.handleTurnUpdate(turn, update));
                turn.acknowledge();
            } catch (error) {
                logger.warn('[agy-acp] prompt failed', error);
                if (isAcpIndeterminateError(error)) this.backendLost = true;
                this.reportTurnError(`Antigravity prompt failed: ${errorMessage(error)}`);
                if (!turn.sawActivity) this.restorePrompt(turn, message);
                else turn.acknowledge();
            }
        } finally {
            if (this.turn === turn) this.turn = null;
            this.turnPermissionMode = undefined;
            if (turn.usage) this.forwardAgentMessage(turn.usage);
            session.onThinkingChange(false);
            await this.permissionHandler?.cancelAll('Prompt finished');
            if (session.queue.size() === 0 && !this.shouldExit) {
                session.sendSessionEvent({ type: 'ready' });
            }
        }
    }

    private handleTurnUpdate(turn: AgyTurn, message: AgentMessage): void {
        switch (message.type) {
            case 'usage':
                turn.usage = addAgyUsage(turn.usage, message);
                return;
            case 'turn_complete':
                return;
            default:
                turn.sawActivity = true;
                turn.acknowledge();
                this.forwardAgentMessage(message);
        }
    }

    private forwardAgentMessage(message: AgentMessage): void {
        const converted = convertAgentMessage(message, this.currentModelId);
        if (converted) this.session.sendAgentMessage(converted);

        switch (message.type) {
            case 'text':
                if (message.live) break;
                this.messageBuffer.addMessage(message.text, 'assistant');
                break;
            case 'tool_call':
                if (message.status === 'pending' || message.status === 'in_progress') {
                    this.messageBuffer.addMessage(`Tool: ${message.title ?? message.name}`, 'tool');
                }
                break;
            case 'error':
                this.messageBuffer.addMessage(message.message, 'status');
                break;
            case 'generated_image':
            case 'usage':
            case 'reasoning':
            case 'tool_result':
            case 'plan':
            case 'turn_complete':
            case 'round_summary':
                break;
            default: {
                const _exhaustive: never = message;
                return _exhaustive;
            }
        }
    }

    private reportTurnError(message: string): void {
        this.session.sendSessionEvent({ type: 'error', message });
        this.messageBuffer.addMessage(message, 'status');
    }

    private restorePrompt(turn: AgyTurn, text: string): void {
        turn.acknowledge();
        this.session.sendSessionEvent({ type: 'abort-restore', text });
    }

    private async cancelActiveTurn(): Promise<void> {
        const backend = this.backend;
        const acpSessionId = this.acpSessionId;
        if (backend && acpSessionId && this.turn && backend.isTransportAlive()) {
            // ACP cancel also ends open tool calls.
            await backend.cancelPrompt(acpSessionId);
        }
        await this.permissionHandler?.cancelAll('User aborted');
    }

    private async handleAbort(): Promise<void> {
        const hadTurn = this.turn !== null;
        await this.cancelActiveTurn();
        this.abortController.abort();
        this.abortController = new AbortController();
        if (hadTurn) {
            this.session.sendSessionEvent({ type: 'message', message: 'Turn aborted' });
            this.messageBuffer.addMessage('Turn aborted', 'status');
        }
    }

    private async handleExitFromUi(): Promise<void> {
        await this.requestExit('exit', () => this.handleAbort());
    }

    private async handleKill(): Promise<void> {
        await this.requestExit('exit', () => this.handleAbort());
        await this.backend?.disconnect();
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);
        await this.permissionHandler?.cancelAll('Session ended');
        this.permissionHandler = null;
        const backend = this.backend;
        this.backend = null;
        await backend?.disconnect();
        logger.debug('[agy-acp] cleanup done');
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** agy releases before 1.5.0 have no `acp` subcommand, so name the floor. */
function describeAgyStartFailure(error: unknown): string {
    return `Failed to start agy acp (requires Antigravity CLI 1.5.0 or newer): ${errorMessage(error)}`;
}

export async function agyAcpRemoteLauncher(session: AgySession): Promise<'switch' | 'exit'> {
    const launcher = new AgyAcpRemoteLauncher(session);
    return launcher.launch();
}
