import React from 'react';
import { randomUUID } from 'node:crypto';
import { registerAcpSessionTitleSync } from '@/agent/acpSessionTitle';
import { logger } from '@/ui/logger';
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge';
import { convertAgentMessage } from '@/agent/messageConverter';
import type { AgentMessage, McpServerStdio, PromptContent } from '@/agent/types';
import { RemoteLauncherBase, type RemoteLauncherDisplayContext, type RemoteLauncherExitReason } from '@/modules/common/remote/RemoteLauncherBase';
import { OpencodeDisplay } from '@/ui/ink/OpencodeDisplay';
import type { OpencodeSession } from './session';
import type { OpencodeMode, PermissionMode } from './types';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { allocateFreePort, createOpencodeBackend } from './utils/opencodeBackend';
import { fetchCompactionSummary, splitProviderModel, triggerOpencodeCompact } from './utils/opencodeCompactBridge';
import { OpencodePermissionHandler } from './utils/permissionHandler';
import { OPENCODE_NATIVE_TOOL_INSTRUCTION, PLAN_MODE_INSTRUCTION } from './utils/systemPrompt';
import { resolveThoughtLevelEffort } from './thoughtLevelEffort';

type OpencodeRemoteLauncherOptions = {
    onReasoningEffortRollback?: (effort: string | null) => void;
    // Called with `true` once the ACP backend + internal HTTP baseUrl are
    // ready (so /compact can actually run) and with `false` whenever this
    // session leaves remote mode. runOpencode.ts uses this to decide whether
    // a `/compact` message should be queued or immediately answered with a
    // "not yet supported" reply — see its `slash.kind === 'compact'` branch.
    onCompactAvailabilityChange?: (available: boolean) => void;
    // Consumes (delete-and-return) whether the queued item with this localId
    // was cancelled via runOpencode.ts's `onCancelQueuedMessage` fallback
    // branch (see the comment on `cancelledDequeuedLocalIds` there for what
    // that actually covers — in practice a narrow ack-vs-hub-DB-write race,
    // not "cancel while the REST call is running"). Checked once the REST
    // call (and summary lookup) settles, so a cancelled request's result
    // doesn't surface for an action the user no longer expects a reply from.
    isLocalIdCancelled?: (localId: string) => boolean;
};

class OpencodeRemoteLauncher extends RemoteLauncherBase {
    private readonly session: OpencodeSession;
    private backend: ReturnType<typeof createOpencodeBackend> | null = null;
    /** Loopback base URL of the OpenCode ACP subprocess's internal HTTP API, set once the backend is spawned with an explicit --port/--hostname. */
    private baseUrl: string | null = null;
    private permissionHandler: OpencodePermissionHandler | null = null;
    private happyServer: { stop: () => void } | null = null;
    private abortController = new AbortController();
    private displayPermissionMode: PermissionMode | null = null;
    private instructionsSent = false;
    private currentBackendModel: string | null = null;
    private defaultBackendModel: string | null = null;
    private currentBackendEffort: string | null = null;
    private defaultBackendEffort: string | null = null;
    private setModelSupported: boolean | undefined = undefined;
    private setEffortSupported: boolean | undefined = undefined;

    constructor(
        session: OpencodeSession,
        private readonly options: OpencodeRemoteLauncherOptions = {}
    ) {
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

        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client, {
            enableChangeTitle: false,
            skillLookup: { workingDirectory: session.path, flavor: 'opencode' }
        });
        this.happyServer = happyServer;

        // Pre-select a loopback port for the ACP subprocess's internal HTTP
        // API and pass it explicitly via --port/--hostname. opencode does not
        // announce the bound port anywhere (stdout/stderr/ACP responses) when
        // launched with --port 0, so HAPI must choose it up front to be able
        // to reach that HTTP API later (e.g. for /compact — see
        // opencodeCompactBridge.ts).
        const hostname = '127.0.0.1';
        const port = await allocateFreePort(hostname);
        this.baseUrl = `http://${hostname}:${port}`;

        const backend = createOpencodeBackend({
            cwd: session.path,
            port,
            hostname
        });
        this.backend = backend;
        registerAcpSessionTitleSync(backend, session.client);

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
        this.defaultBackendModel = this.currentBackendModel;
        const thoughtLevelOption = backend.getThoughtLevelConfigOption?.(acpSessionId);
        this.currentBackendEffort = thoughtLevelOption?.currentValue ?? null;
        this.defaultBackendEffort = this.currentBackendEffort;

        // Let the caller (runOpencode.ts) know native /compact can actually
        // run now that the ACP backend + internal HTTP baseUrl exist. The
        // dequeue loop below (not an externally-invoked trigger) is what
        // executes it, in its actual FIFO queue position.
        this.options.onCompactAvailabilityChange?.(true);

        // Expose the cached models metadata via per-session RPC so the hub can
        // forward it to the web UI's model selector without round-tripping ACP.
        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListOpencodeModels, async () => {
            const metadata = backend.getSessionModelsMetadata?.(acpSessionId);
            if (!metadata) {
                return { success: false, error: 'OpenCode model metadata is not available' };
            }
            return {
                success: true,
                availableModels: metadata.availableModels,
                currentModelId: metadata.currentModelId
            };
        });

        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListOpencodeReasoningEffortOptions, async () => {
            const effortOption = backend.getThoughtLevelConfigOption?.(acpSessionId);
            if (!effortOption) {
                return { success: false, error: 'OpenCode reasoning effort options are not available' };
            }
            return {
                success: true,
                options: effortOption.options,
                currentValue: effortOption.currentValue ?? null
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
            // `batch.mode.model` semantics: a string is a specific model id;
            // `null` means "reset to whatever model the backend launched with"
            // (emitted by `/model default`); `undefined` means "no change".
            const requestedModel = batch.mode.model === null
                ? this.defaultBackendModel
                : batch.mode.model;
            // The very first batch seeds currentBackendModel — the OpenCode CLI was
            // launched with that model via --model and there is nothing to switch yet.
            if (requestedModel && this.currentBackendModel === null) {
                this.currentBackendModel = requestedModel;
            } else if (requestedModel && requestedModel !== this.currentBackendModel) {
                if (!backend.setModel || this.setModelSupported === false) {
                    batch.mode.model = this.currentBackendModel ?? undefined;
                } else {
                    logger.debug(`[opencode-remote] Switching model inline: ${this.currentBackendModel} -> ${requestedModel}`);
                    try {
                        await backend.setModel(acpSessionId, requestedModel, { flavor: 'opencode' });
                        this.currentBackendModel = requestedModel;
                        this.setModelSupported = true;
                        // Reflect the resolved model back into the batch so
                        // downstream display logic sees the concrete id rather
                        // than a `null` placeholder.
                        batch.mode.model = requestedModel;
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
                                message: `Failed to switch model to ${requestedModel}. Continuing with ${this.currentBackendModel ?? '(default)'}.`
                            });
                        }
                        batch.mode.model = this.currentBackendModel ?? undefined;
                    }
                }
            }

            const requestedEffort = batch.mode.modelReasoningEffort ?? this.defaultBackendEffort;
            if (requestedEffort && requestedEffort !== this.currentBackendEffort) {
                const thoughtLevelOption = backend.getThoughtLevelConfigOption?.(acpSessionId);
                if (!backend.setConfigOption || !thoughtLevelOption || this.setEffortSupported === false) {
                    this.rollbackReasoningEffort(batch, this.currentBackendEffort);
                } else {
                    const resolvedEffort = resolveThoughtLevelEffort(
                        requestedEffort,
                        thoughtLevelOption,
                        this.currentBackendEffort ?? this.defaultBackendEffort
                    );
                    if (!resolvedEffort || resolvedEffort === this.currentBackendEffort) {
                        if (requestedEffort !== resolvedEffort) {
                            logger.warn(
                                `[opencode-remote] Unsupported reasoning effort "${requestedEffort}"; continuing with ${resolvedEffort ?? this.currentBackendEffort ?? '(default)'}`
                            );
                            this.rollbackReasoningEffort(batch, resolvedEffort ?? this.currentBackendEffort);
                        }
                    } else {
                        logger.debug(`[opencode-remote] Switching effort inline: ${this.currentBackendEffort ?? '(default)'} -> ${resolvedEffort}`);
                        try {
                            await backend.setConfigOption(acpSessionId, thoughtLevelOption.id, resolvedEffort);
                            this.currentBackendEffort = resolvedEffort;
                            this.setEffortSupported = true;
                            if (requestedEffort !== resolvedEffort) {
                                this.rollbackReasoningEffort(batch, resolvedEffort);
                            }
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error);
                            const methodNotFound = /method not found/i.test(message);
                            if (methodNotFound && this.setEffortSupported === undefined) {
                                this.setEffortSupported = false;
                                logger.warn('[opencode-remote] OpenCode build does not support session/set_config_option; inline effort switching disabled for this session');
                                session.sendSessionEvent({
                                    type: 'message',
                                    message: 'This OpenCode build does not support inline reasoning effort switching.'
                                });
                            } else {
                                logger.warn('[opencode-remote] Inline effort switch failed', error);
                                session.sendSessionEvent({
                                    type: 'message',
                                    message: `Failed to switch reasoning effort to ${resolvedEffort}. Continuing with ${this.currentBackendEffort ?? '(default)'}.`
                                });
                            }
                            this.rollbackReasoningEffort(batch, this.currentBackendEffort);
                        }
                    }
                }
            }

            this.applyDisplayMode(batch.mode.permissionMode);
            messageBuffer.addMessage(batch.message, 'user');

            // /compact reaches here through the exact same dequeue loop as
            // any prompt — it was pushed via messageQueue.pushIsolated(...)
            // in runOpencode.ts, so it occupies its real FIFO position
            // relative to prompts queued before or after it (fixes a prior
            // design where /compact ran via an externally-invoked trigger
            // and could execute ahead of an already-queued prompt). The
            // model/effort switch above already ran for this batch just like
            // any other, so compaction runs under whatever model this batch
            // resolved to.
            if (batch.mode.operation === 'compact') {
                // A compact batch is always a single isolated item (pushed
                // via pushIsolated), so its own localId is exactly
                // batch.items[0]?.localId.
                const compactLocalId = batch.items[0]?.localId;
                session.onThinkingChange(true);
                try {
                    await this.runCompactOperation(acpSessionId, compactLocalId);
                } finally {
                    session.onThinkingChange(false);
                    if (session.queue.size() === 0 && !this.shouldExit) {
                        sendReady();
                    }
                }
                continue;
            }

            // Inject title instructions on first prompt
            let messageText = batch.message;
            if (batch.mode.permissionMode === 'plan') {
                messageText = `${PLAN_MODE_INSTRUCTION}\n\n${messageText}`;
            }
            if (!this.instructionsSent) {
                messageText = `${OPENCODE_NATIVE_TOOL_INSTRUCTION}\n\n${messageText}`;
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
                void backend.refreshSessionInfo(acpSessionId, session.path);
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

    private rollbackReasoningEffort(batch: { mode: OpencodeMode }, effort: string | null): void {
        batch.mode.modelReasoningEffort = effort;
        this.session.setModelReasoningEffort(effort);
        this.session.pushKeepAlive();
        this.options.onReasoningEffortRollback?.(effort);
    }

    /**
     * Executes the /compact operation for a queued `operation:'compact'`
     * batch. Reached only through the main dequeue loop (so it never runs
     * concurrently with a prompt turn — see the loop's doc comment), which
     * is also why this needs no timeout/mutex of its own despite the REST
     * call it makes potentially taking several minutes.
     *
     * `localId` is used to detect a cancel that runOpencode.ts's
     * `isLocalIdCancelled` reports for this item (see its declaration there
     * for the real — and narrow — race window that covers) — checked at each
     * point below right before a result would be shown, same as the
     * pre-redesign behavior where this was a single `wasCancelled()` check
     * after one combined async trigger(). "Compaction started" itself is
     * never suppressed (it wasn't before either).
     */
    private async runCompactOperation(acpSessionId: string, localId?: string): Promise<void> {
        const session = this.session;
        session.sendSessionEvent({ type: 'message', message: '📦 Compaction started' });

        const isCancelled = (): boolean => (localId ? (this.options.isLocalIdCancelled?.(localId) ?? false) : false);

        const backend = this.backend;
        const baseUrl = this.baseUrl;
        if (!baseUrl || !backend) {
            if (!isCancelled()) {
                session.sendSessionEvent({
                    type: 'message',
                    message: '📦 Compaction failed: OpenCode internal HTTP API base URL is not available.'
                });
            }
            return;
        }

        const metadata = backend.getSessionModelsMetadata?.(acpSessionId);
        const split = splitProviderModel(metadata?.currentModelId ?? this.currentBackendModel);
        if (!split) {
            if (!isCancelled()) {
                session.sendSessionEvent({
                    type: 'message',
                    message: '📦 Compaction failed: OpenCode model metadata is not available; cannot determine provider/model for compaction.'
                });
            }
            return;
        }

        // Suppressed: OpenCode keeps streaming session/update notifications
        // (agent_thought_chunk etc.) over the ACP transport while this raw
        // HTTP call runs — with no prompt() turn in flight to own them, they
        // would otherwise leak into the previous turn's still-installed
        // onUpdate and render as a duplicate assistant message alongside the
        // explicit summary we show below (from fetchCompactionSummary).
        // See AcpSdkBackend.suppressUpdatesDuring's doc comment.
        const result = await backend.suppressUpdatesDuring(() => triggerOpencodeCompact({
            baseUrl,
            sessionId: acpSessionId,
            providerId: split.providerId,
            modelId: split.modelId
        }));
        if (!result.ok) {
            if (!isCancelled()) {
                session.sendSessionEvent({ type: 'message', message: `📦 Compaction failed: ${result.error}` });
            } else {
                logger.debug('[opencode-remote] /compact failure suppressed: cancelled before it resolved');
            }
            return;
        }

        // Best-effort: fetch the actual summary text OpenCode generated
        // before the final cancellation check, so a cancel landing anywhere
        // during this whole operation (REST call or summary lookup)
        // suppresses "Compaction completed" and the Reasoning block
        // together — this mirrors the pre-redesign behavior, where both were
        // produced by one combined async step checked once.
        const summary = await fetchCompactionSummary({ baseUrl, sessionId: acpSessionId });

        if (isCancelled()) {
            logger.debug('[opencode-remote] /compact result suppressed: cancelled before it resolved');
            return;
        }

        session.sendSessionEvent({ type: 'message', message: '📦 Compaction completed' });
        if (summary.found) {
            const converted = convertAgentMessage({ type: 'reasoning', text: summary.text, id: randomUUID() });
            if (converted) {
                session.sendAgentMessage(converted);
            }
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
                if (message.live) {
                    break;
                }
                this.messageBuffer.addMessage(`[Thinking] ${message.text.substring(0, 100)}...`, 'system');
                break;
            case 'tool_call':
                this.messageBuffer.addMessage(`Tool call: ${message.name}`, 'tool');
                break;
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
    session: OpencodeSession,
    options: OpencodeRemoteLauncherOptions = {}
): Promise<'switch' | 'exit'> {
    const launcher = new OpencodeRemoteLauncher(session, options);
    return launcher.launch();
}
