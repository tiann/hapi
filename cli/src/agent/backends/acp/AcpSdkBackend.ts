import type { AgentFlavor } from '@hapi/protocol';
import type { AgentBackend, AgentMessage, AgentSessionConfig, PermissionRequest, PermissionResponse, PromptContent } from '@/agent/types';
import { asString, isObject } from '@hapi/protocol';
import { AcpStdioTransport, type AcpStderrError } from './AcpStdioTransport';
import { AcpMessageHandler, type AcpTextChunkMode } from './AcpMessageHandler';
import { ACP_SESSION_UPDATE_TYPES } from './constants';
import { logger } from '@/ui/logger';
import { withRetry } from '@/utils/time';
import packageJson from '../../../../package.json';

type PendingPermission = {
    resolve: (result: { outcome: { outcome: string; optionId?: string } }) => void;
};

type AcpPromptUsage = {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    thoughtTokens?: number;
    cacheReadTokens?: number;
};

type AcpUsageUpdate = {
    contextTokens: number | undefined;
    contextWindow: number | undefined;
};

export type AcpSessionInfoUpdate = {
    title?: string | null;
};

export type AcpModelDescriptor = {
    modelId: string;
    name?: string;
    reasoningEfforts?: Array<{ value: string; name?: string; isDefault?: boolean }>;
};

export type AcpSessionModelsMetadata = {
    availableModels: AcpModelDescriptor[];
    currentModelId: string | null;
};

export type AcpConfigOptionDescriptor = {
    id: string;
    category?: string;
    currentValue?: string;
    options: Array<{ value: string; name?: string }>;
};

type AcpInitializeResult = {
    protocolVersion: number;
    authMethods?: Array<{ id: string; name?: string }>;
    agentCapabilities?: {
        loadSession?: boolean;
        promptCapabilities?: unknown;
        sessionCapabilities?: unknown;
    };
};

export class AcpSdkBackend implements AgentBackend {
    private transport: AcpStdioTransport | null = null;
    private permissionHandler: ((request: PermissionRequest) => void) | null = null;
    private stderrErrorHandler: ((error: AcpStderrError) => void) | null = null;
    private readonly pendingPermissions = new Map<string, PendingPermission>();
    private readonly sessionModelsMetadata = new Map<string, AcpSessionModelsMetadata>();
    private readonly sessionConfigOptions = new Map<string, AcpConfigOptionDescriptor[]>();
    private readonly initialAvailableCommands = new Set<string>();
    private readonly sessionAvailableCommands = new Map<string, Set<string>>();
    private autoPermissionModeEnabled: boolean | null = null;
    private messageHandler: AcpMessageHandler | null = null;
    private activeSessionId: string | null = null;
    private initializeResult: AcpInitializeResult | null = null;
    private setModeSupported: boolean | undefined = undefined;
    private isProcessingMessage = false;
    private responseCompleteResolvers: Array<() => void> = [];
    private lastSessionUpdateAt = 0;
    private latestUsageUpdate: AcpUsageUpdate | null = null;
    private promptUsageCallback: ((msg: AgentMessage) => void) | null = null;
    private usageUpdateListener: ((msg: AgentMessage) => void) | null = null;
    private sessionInfoUpdateListener: ((update: AcpSessionInfoUpdate) => void) | null = null;
    private lastForwardedUsageUpdate: AcpUsageUpdate | null = null;

    /** Retry configuration for ACP initialization */
    private static readonly INIT_RETRY_OPTIONS = {
        maxAttempts: 3,
        minDelay: 1000,
        maxDelay: 5000
    };
    private static readonly UPDATE_QUIET_PERIOD_MS = 120;
    private static readonly UPDATE_DRAIN_TIMEOUT_MS = 2000;
    private static readonly PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 200;
    private static readonly PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 1200;
    // After the initial post-prompt drain, slow-tailing models (DeepSeek,
    // GPT-5.5, etc.) can keep sending agentMessageChunk notifications. We poll
    // drainBuffers() on a short interval so the UI keeps streaming smoothly,
    // and block prompt() from resolving until the model is truly quiet — that
    // way turn_complete and the launcher's ready signal only fire after every
    // straggler has been emitted to the current turn's onUpdate. Bounded by
    // LATE_FLUSH_WINDOW_MS so a stuck stream never wedges the session.
    //
    // 6000ms covers tails up to ~5s observed against GPT-5.5 / DeepSeek V4 Pro
    // with 1s headroom. 250ms quiet is anchored to drainLateBuffers entry
    // time, so every turn pays at least one quiet period before resolving —
    // that minimum is what catches stragglers arriving just after
    // session/prompt resolves when the model paused mid-turn. 50ms polling
    // keeps the UI responsive without measurable CPU cost (drainBuffers is a
    // no-op on empty buffers). All three can be tightened once we have
    // telemetry on real-world tail distributions.
    private static readonly LATE_FLUSH_INTERVAL_MS = 50;
    private static readonly LATE_FLUSH_QUIET_PERIOD_MS = 250;
    private static readonly LATE_FLUSH_WINDOW_MS = 6000;

    constructor(private readonly options: {
        command: string;
        args?: string[];
        env?: Record<string, string>;
        textChunkMode?: AcpTextChunkMode;
    }) {}

    async initialize(): Promise<void> {
        if (this.transport) return;

        this.transport = new AcpStdioTransport({
            command: this.options.command,
            args: this.options.args,
            env: this.options.env
        });

        this.transport.onNotification((method, params) => {
            if (method === 'session/update') {
                this.handleSessionUpdate(params);
            } else if (
                method === '_x.ai/settings/update'
                && isObject(params)
                && 'auto_permission_mode_enabled' in params
            ) {
                this.autoPermissionModeEnabled = params.auto_permission_mode_enabled === true;
            }
        });

        this.transport.onStderrError((error) => {
            this.stderrErrorHandler?.(error);
        });

        this.transport.registerRequestHandler('session/request_permission', async (params, requestId) => {
            return await this.handlePermissionRequest(params, requestId);
        });

        const response = await withRetry(
            () => this.transport!.sendRequest('initialize', {
                protocolVersion: 1,
                clientCapabilities: {
                    fs: { readTextFile: false, writeTextFile: false },
                    terminal: false,
                    _meta: {
                        // Cursor ACP exposes Composer's non-fast/fast choice as separate
                        // `model` + `fast` config options only when the client advertises
                        // this capability. Agents that do not know this metadata ignore it.
                        parameterizedModelPicker: true
                    }
                },
                clientInfo: {
                    name: 'hapi',
                    version: packageJson.version
                }
            }),
            {
                ...AcpSdkBackend.INIT_RETRY_OPTIONS,
                onRetry: (error, attempt, nextDelayMs) => {
                    logger.debug(`[ACP] Initialize attempt ${attempt} failed, retrying in ${nextDelayMs}ms`, error);
                }
            }
        );

        if (!isObject(response) || typeof response.protocolVersion !== 'number') {
            throw new Error('Invalid initialize response from ACP agent');
        }

        this.captureAvailableCommands(null, response);

        this.initializeResult = {
            protocolVersion: response.protocolVersion,
            authMethods: Array.isArray(response.authMethods)
                ? response.authMethods
                    .filter((entry): entry is Record<string, unknown> => isObject(entry))
                    .map((entry) => ({
                        id: asString(entry.id) ?? '',
                        name: asString(entry.name) ?? undefined
                    }))
                    .filter((entry) => entry.id.length > 0)
                : undefined,
            agentCapabilities: isObject(response.agentCapabilities)
                ? {
                    loadSession: response.agentCapabilities.loadSession === true,
                    promptCapabilities: response.agentCapabilities.promptCapabilities,
                    sessionCapabilities: response.agentCapabilities.sessionCapabilities
                }
                : undefined
        };

        logger.debug(`[ACP] Initialized with protocol version ${response.protocolVersion}`);
    }

    async authenticate(methodId: string): Promise<void> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }
        await this.transport.sendRequest('_client/authenticate', { methodId });
    }

    async authenticateIfAvailable(methodId: string): Promise<void> {
        const methods = this.initializeResult?.authMethods ?? [];
        if (!methods.some((method) => method.id === methodId)) {
            logger.debug(`[ACP] Auth method not advertised: ${methodId}`);
            return;
        }
        try {
            await this.authenticate(methodId);
        } catch (error) {
            // Cursor advertises cursor_login but may not implement _client/authenticate yet.
            logger.debug(`[ACP] authenticate skipped (${methodId})`, error);
        }
    }

    supportsLoadSession(): boolean {
        return this.initializeResult?.agentCapabilities?.loadSession === true;
    }

    getSessionConfigOptions(sessionId: string): AcpConfigOptionDescriptor[] | undefined {
        return this.sessionConfigOptions.get(sessionId);
    }

    getConfigOptionByCategory(sessionId: string, category: string): AcpConfigOptionDescriptor | undefined {
        return this.sessionConfigOptions.get(sessionId)?.find((option) => option.category === category);
    }

    registerExtensionRequestHandler(
        method: string,
        handler: (params: unknown, requestId: string | number | null) => Promise<unknown>
    ): void {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }
        this.transport.registerRequestHandler(method, handler);
    }

    async setMode(sessionId: string, modeId: string): Promise<void> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        await this.waitForResponseComplete();

        if (this.setModeSupported !== false) {
            try {
                await this.transport.sendRequest('session/set_mode', { sessionId, modeId });
                this.setModeSupported = true;
                this.updateThoughtLevelCurrentValue(sessionId, modeId);
                return;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (/method not found/i.test(message)) {
                    this.setModeSupported = false;
                } else {
                    throw error;
                }
            }
        }

        const modeOption = this.getConfigOptionByCategory(sessionId, 'mode');
        if (!modeOption) {
            throw new Error('ACP agent does not support session/set_mode and no mode config option is available');
        }

        await this.setConfigOption(sessionId, modeOption.id, modeId);
    }

    async newSession(config: AgentSessionConfig): Promise<string> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        const response = await withRetry(
            () => this.transport!.sendRequest('session/new', {
                cwd: config.cwd,
                mcpServers: config.mcpServers
            }),
            {
                ...AcpSdkBackend.INIT_RETRY_OPTIONS,
                onRetry: (error, attempt, nextDelayMs) => {
                    logger.debug(`[ACP] session/new attempt ${attempt} failed, retrying in ${nextDelayMs}ms`, error);
                }
            }
        );

        const sessionId = isObject(response) ? asString(response.sessionId) : null;
        if (!sessionId) {
            throw new Error('Invalid session/new response from ACP agent');
        }

        this.activeSessionId = sessionId;
        this.captureSessionMetadata(sessionId, response);
        return sessionId;
    }

    async loadSession(config: AgentSessionConfig & { sessionId: string }): Promise<string> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        const response = await withRetry(
            () => this.transport!.sendRequest('session/load', {
                sessionId: config.sessionId,
                cwd: config.cwd,
                mcpServers: config.mcpServers
            }),
            {
                ...AcpSdkBackend.INIT_RETRY_OPTIONS,
                onRetry: (error, attempt, nextDelayMs) => {
                    logger.debug(`[ACP] session/load attempt ${attempt} failed, retrying in ${nextDelayMs}ms`, error);
                }
            }
        );

        const loadedSessionId = isObject(response) ? asString(response.sessionId) : null;
        const sessionId = loadedSessionId ?? config.sessionId;
        this.activeSessionId = sessionId;
        this.captureSessionMetadata(sessionId, response);
        return sessionId;
    }

    async setModel(
        sessionId: string,
        modelId: string,
        opts?: { flavor?: AgentFlavor }
    ): Promise<void> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        // The launcher serializes setModel between turns, but defensively wait for any
        // in-flight prompt to drain so we never interleave a switch with a session/prompt.
        await this.waitForResponseComplete();

        // ACP defines `session/set_model` ({ sessionId, modelId }) for inline model
        // switching — see ACP SDK schema `x-method: session/set_model`. OpenCode
        // 1.14.30 implements this exact wire name (the SDK's TypeScript helper is
        // exposed as `unstable_setSessionModel` but the JSON-RPC method on the wire
        // is unprefixed). Errors (including JSON-RPC 'method not found') propagate
        // as rejections from the transport; the launcher's catch block handles them.
        const response = await this.transport.sendRequest('session/set_model', {
            sessionId,
            modelId
        });

        if (opts?.flavor === 'opencode' || opts?.flavor === 'grok') {
            // OpenCode's set_model response only carries an opaque `_meta` block,
            // not `availableModels`/`currentModelId`. Optimistically update the
            // cached currentModelId (the call succeeded, so the agent has switched)
            // while preserving the availableModels list captured from session/new.
            this.updateCurrentModelOptimistic(sessionId, modelId);
        } else {
            // For other flavors (e.g. Gemini), if the response carries metadata,
            // capture it. Missing fields are silently ignored.
            this.captureSessionMetadata(sessionId, response);
        }
    }

    async setConfigOption(
        sessionId: string,
        configId: string,
        value: string
    ): Promise<void> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        await this.waitForResponseComplete();

        const response = await this.transport.sendRequest('session/set_config_option', {
            sessionId,
            configId,
            value
        });
        this.captureSessionMetadata(sessionId, response);
    }

    /**
     * Returns the per-session models metadata captured from session/new (or
     * session/load, or session/set_model). Returns undefined if the agent did
     * not include the optional `models` block in its response.
     */
    getSessionModelsMetadata(sessionId: string): AcpSessionModelsMetadata | undefined {
        return this.sessionModelsMetadata.get(sessionId);
    }

    getThoughtLevelConfigOption(sessionId: string): AcpConfigOptionDescriptor | undefined {
        return this.sessionConfigOptions.get(sessionId)?.find((option) => option.category === 'thought_level');
    }

    hasAvailableCommand(sessionId: string, command: string): boolean {
        if (command === 'auto' && this.autoPermissionModeEnabled === true) {
            return true;
        }
        return this.sessionAvailableCommands.get(sessionId)?.has(command)
            ?? this.initialAvailableCommands.has(command);
    }

    /** Forwards ACP `usage_update` to the web status bar when no prompt is active (e.g. session resume). */
    setUsageUpdateListener(listener: ((msg: AgentMessage) => void) | null): void {
        this.usageUpdateListener = listener;
    }

    /** Forwards ACP `session_info_update` metadata independently of prompt turns. */
    setSessionInfoUpdateListener(listener: ((update: AcpSessionInfoUpdate) => void) | null): void {
        this.sessionInfoUpdateListener = listener;
    }

    async prompt(
        sessionId: string,
        content: PromptContent[],
        onUpdate: (msg: AgentMessage) => void
    ): Promise<void> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        this.activeSessionId = sessionId;
        // Single-phase handler swap: drain any chunks still buffered in the
        // previous turn's handler so they emit via that turn's onUpdate, then
        // immediately install the new handler. The post-prompt drainLateBuffers
        // means by this point the previous turn should already be quiet; this
        // wait is a cheap safety net for the rare case where a chunk arrived
        // between prompt() resolving and the next turn starting.
        await this.waitForSessionUpdateQuiet(
            AcpSdkBackend.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS,
            AcpSdkBackend.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS
        );
        this.messageHandler?.drainBuffers();
        this.messageHandler = new AcpMessageHandler(onUpdate, { textChunkMode: this.options.textChunkMode });
        this.isProcessingMessage = true;
        this.lastSessionUpdateAt = Date.now();
        this.latestUsageUpdate = null;
        this.lastForwardedUsageUpdate = null;
        this.promptUsageCallback = onUpdate;
        let stopReason: string | null = null;
        let promptUsage: AcpPromptUsage | null = null;

        try {
            // No timeout for prompt requests - they can run for extended periods
            // during complex tasks, tool-heavy operations, or slow model responses
            const response = await this.transport.sendRequest('session/prompt', {
                sessionId,
                prompt: content
            }, { timeoutMs: Infinity });

            stopReason = isObject(response) ? asString(response.stopReason) : null;
            promptUsage = this.extractPromptUsage(response);
        } finally {
            await this.waitForSessionUpdateQuiet(
                AcpSdkBackend.UPDATE_QUIET_PERIOD_MS,
                AcpSdkBackend.UPDATE_DRAIN_TIMEOUT_MS
            );
            this.messageHandler?.drainBuffers();
            // Block here until the model truly stops streaming straggler
            // chunks (or LATE_FLUSH_WINDOW_MS elapses), so turn_complete and
            // the launcher's ready signal only fire once every chunk has been
            // emitted to this turn's onUpdate.
            await this.drainLateBuffers();
            try {
                const latestUsageUpdate = this.readLatestUsageUpdate();
                if (promptUsage) {
                    onUpdate({
                        type: 'usage',
                        inputTokens: promptUsage.inputTokens,
                        outputTokens: promptUsage.outputTokens,
                        totalTokens: promptUsage.totalTokens,
                        thoughtTokens: promptUsage.thoughtTokens,
                        cacheReadTokens: promptUsage.cacheReadTokens,
                        contextTokens: latestUsageUpdate ? latestUsageUpdate.contextTokens : undefined,
                        contextWindow: latestUsageUpdate ? latestUsageUpdate.contextWindow : undefined
                    });
                } else if (
                    latestUsageUpdate
                    && (latestUsageUpdate.contextTokens !== undefined || latestUsageUpdate.contextWindow !== undefined)
                    && !this.hasForwardedUsage(latestUsageUpdate)
                ) {
                    // Agent did not return prompt usage (slash-handled turns,
                    // errored turns), but we did see ACP usage updates during
                    // the turn. Emit a context-only usage so the status bar
                    // reflects the current context size.
                    onUpdate({
                        type: 'usage',
                        inputTokens: 0,
                        outputTokens: 0,
                        contextTokens: latestUsageUpdate.contextTokens,
                        contextWindow: latestUsageUpdate.contextWindow
                    });
                }
                if (stopReason) {
                    onUpdate({ type: 'turn_complete', stopReason });
                }
            } finally {
                this.promptUsageCallback = null;
                this.isProcessingMessage = false;
                this.notifyResponseComplete();
            }
        }
    }

    async cancelPrompt(sessionId: string): Promise<void> {
        if (!this.transport) {
            return;
        }

        this.transport.sendNotification('session/cancel', { sessionId });
    }

    async respondToPermission(
        _sessionId: string,
        request: PermissionRequest,
        response: PermissionResponse
    ): Promise<void> {
        const pending = this.pendingPermissions.get(request.id);
        if (!pending) {
            logger.debug('[ACP] No pending permission request for id', request.id);
            return;
        }

        this.pendingPermissions.delete(request.id);

        if (response.outcome === 'cancelled') {
            pending.resolve({ outcome: { outcome: 'cancelled' } });
            return;
        }

        pending.resolve({
            outcome: {
                outcome: 'selected',
                optionId: response.optionId
            }
        });
    }

    onPermissionRequest(handler: (request: PermissionRequest) => void): void {
        this.permissionHandler = handler;
    }

    onStderrError(handler: (error: AcpStderrError) => void): void {
        this.stderrErrorHandler = handler;
    }

    /**
     * Returns true if currently processing a message (prompt in progress).
     * Useful for checking if it's safe to perform session operations.
     */
    get processingMessage(): boolean {
        return this.isProcessingMessage;
    }

    getLastSessionUpdateAt(): number {
        return this.lastSessionUpdateAt;
    }

    /**
     * Wait for any in-progress response to complete.
     * Resolves immediately if no response is being processed.
     * Use this before performing operations that require the response to be complete,
     * like session swap or sending task_complete.
     */
    async waitForResponseComplete(): Promise<void> {
        if (!this.isProcessingMessage) {
            return;
        }
        return new Promise<void>((resolve) => {
            this.responseCompleteResolvers.push(resolve);
        });
    }

    async disconnect(): Promise<void> {
        if (!this.transport) return;
        this.messageHandler?.drainBuffers();
        this.messageHandler = null;
        this.activeSessionId = null;
        this.isProcessingMessage = false;
        this.sessionModelsMetadata.clear();
        this.initialAvailableCommands.clear();
        this.sessionAvailableCommands.clear();
        this.autoPermissionModeEnabled = null;
        this.notifyResponseComplete();
        await this.transport.close();
        this.transport = null;
    }

    private handleSessionUpdate(params: unknown): void {
        if (!isObject(params)) return;
        const sessionId = asString(params.sessionId);
        if (this.activeSessionId && sessionId && sessionId !== this.activeSessionId) {
            return;
        }
        this.lastSessionUpdateAt = Date.now();
        const update = params.update;
        if (sessionId) {
            this.captureAvailableCommands(sessionId, update);
        }
        this.captureSessionInfoUpdate(update);
        this.captureUsageUpdate(update);
        this.messageHandler?.handleUpdate(update);
    }

    private captureSessionInfoUpdate(update: unknown): void {
        if (!isObject(update)) return;
        if (asString(update.sessionUpdate) !== ACP_SESSION_UPDATE_TYPES.sessionInfoUpdate) return;
        if (!Object.prototype.hasOwnProperty.call(update, 'title')) return;

        const title = update.title;
        if (typeof title !== 'string' && title !== null) return;
        this.sessionInfoUpdateListener?.({ title });
    }

    private captureUsageUpdate(update: unknown): void {
        if (!isObject(update)) return;

        const sessionUpdate = asString(update.sessionUpdate);
        let contextTokens: number | null = null;
        let contextWindow: number | null = null;

        if (sessionUpdate === ACP_SESSION_UPDATE_TYPES.usageUpdate) {
            contextTokens = this.asFiniteNumber(update.used);
            contextWindow = this.asFiniteNumber(update.size);
        } else if (sessionUpdate === ACP_SESSION_UPDATE_TYPES.sessionInfoUpdate) {
            contextTokens = this.asFiniteNumber(
                update.used
                ?? update.contextTokens
                ?? update.context_tokens
                ?? update.contextUsed
            );
            contextWindow = this.asFiniteNumber(
                update.size
                ?? update.contextWindow
                ?? update.context_window
                ?? update.contextLimit
            );
        } else {
            return;
        }

        this.latestUsageUpdate = {
            contextTokens: contextTokens ?? undefined,
            contextWindow: contextWindow ?? undefined
        };
        this.forwardUsageUpdate();
    }

    private hasForwardedUsage(update: AcpUsageUpdate): boolean {
        return this.lastForwardedUsageUpdate !== null
            && this.lastForwardedUsageUpdate.contextTokens === update.contextTokens
            && this.lastForwardedUsageUpdate.contextWindow === update.contextWindow;
    }

    private forwardUsageUpdate(): void {
        const update = this.latestUsageUpdate;
        if (
            !update
            || (update.contextTokens === undefined && update.contextWindow === undefined)
        ) {
            return;
        }

        if (
            this.lastForwardedUsageUpdate
            && this.lastForwardedUsageUpdate.contextTokens === update.contextTokens
            && this.lastForwardedUsageUpdate.contextWindow === update.contextWindow
        ) {
            return;
        }

        this.lastForwardedUsageUpdate = update;
        const message: AgentMessage = {
            type: 'usage',
            inputTokens: 0,
            outputTokens: 0,
            contextTokens: update.contextTokens,
            contextWindow: update.contextWindow
        };

        if (this.promptUsageCallback) {
            this.promptUsageCallback(message);
        } else if (this.usageUpdateListener) {
            this.usageUpdateListener(message);
        }
    }

    private readLatestUsageUpdate(): AcpUsageUpdate | null {
        return this.latestUsageUpdate;
    }

    /**
     * Poll drainBuffers() on a short interval until the model has been quiet
     * for LATE_FLUSH_QUIET_PERIOD_MS or LATE_FLUSH_WINDOW_MS elapses. Polling
     * keeps the UI streaming smoothly while we wait; the quiet-window check
     * lets fast models exit almost immediately (Claude tail typically < 100ms)
     * while still bounding slow-tailing models (GPT-5.5, DeepSeek V4 Pro).
     *
     * The quiet measurement is anchored to entry time, not just
     * lastSessionUpdateAt: if session/prompt paused mid-turn (chunks → pause
     * → stopReason), lastSessionUpdateAt is already stale on entry and we
     * would otherwise exit immediately, missing any straggler that arrives
     * just after session/prompt resolves.
     */
    private async drainLateBuffers(): Promise<void> {
        const quietBaseline = Date.now();
        const deadline = quietBaseline + AcpSdkBackend.LATE_FLUSH_WINDOW_MS;
        while (Date.now() < deadline) {
            const latestActivityAt = Math.max(this.lastSessionUpdateAt, quietBaseline);
            const elapsedSinceUpdate = Date.now() - latestActivityAt;
            if (elapsedSinceUpdate >= AcpSdkBackend.LATE_FLUSH_QUIET_PERIOD_MS) {
                return;
            }
            const remainingBudget = deadline - Date.now();
            const waitMs = Math.max(1, Math.min(AcpSdkBackend.LATE_FLUSH_INTERVAL_MS, remainingBudget));
            await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
            this.messageHandler?.drainBuffers();
        }
    }

    private async waitForSessionUpdateQuiet(quietMs: number, timeoutMs: number): Promise<void> {
        if (quietMs <= 0 || timeoutMs <= 0) {
            return;
        }

        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const elapsedSinceUpdate = Date.now() - this.lastSessionUpdateAt;
            if (elapsedSinceUpdate >= quietMs) {
                return;
            }

            const remainingToQuiet = quietMs - elapsedSinceUpdate;
            const remainingBudget = deadline - Date.now();
            const waitMs = Math.max(1, Math.min(remainingToQuiet, remainingBudget));
            await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        }
    }

    private async handlePermissionRequest(params: unknown, requestId: string | number | null): Promise<unknown> {
        if (!isObject(params)) {
            return { outcome: { outcome: 'cancelled' } };
        }

        const sessionId = asString(params.sessionId) ?? this.activeSessionId ?? 'unknown';
        const toolCall = isObject(params.toolCall) ? params.toolCall : {};
        const toolCallId = asString(toolCall.toolCallId) ?? `tool-${Date.now()}`;
        const title = asString(toolCall.title) ?? undefined;
        const kind = asString(toolCall.kind) ?? undefined;
        const rawInput = 'rawInput' in toolCall ? toolCall.rawInput : undefined;
        const rawOutput = 'rawOutput' in toolCall ? toolCall.rawOutput : undefined;
        const options = Array.isArray(params.options)
            ? params.options
                .filter((option) => isObject(option))
                .map((option, index) => ({
                    optionId: asString(option.optionId) ?? `option-${index + 1}`,
                    name: asString(option.name) ?? `Option ${index + 1}`,
                    kind: asString(option.kind) ?? 'allow_once'
                }))
            : [];

        const request: PermissionRequest = {
            id: toolCallId,
            sessionId,
            toolCallId,
            title,
            kind,
            rawInput,
            rawOutput,
            options
        };

        const responsePromise = new Promise((resolve) => {
            this.pendingPermissions.set(toolCallId, { resolve });
        });

        if (this.permissionHandler) {
            try {
                this.permissionHandler(request);
            } catch (error) {
                this.pendingPermissions.delete(toolCallId);
                throw error;
            }
        } else {
            logger.debug('[ACP] No permission handler registered; cancelling request');
            this.pendingPermissions.delete(toolCallId);
            return { outcome: { outcome: 'cancelled' } };
        }

        return await responsePromise;
    }

    private notifyResponseComplete(): void {
        const resolvers = this.responseCompleteResolvers;
        this.responseCompleteResolvers = [];
        for (const resolve of resolvers) {
            resolve();
        }
    }

    /**
     * Optimistically update the cached `currentModelId` for a session after a
     * successful `session/set_model` call whose response does not echo the
     * model metadata (OpenCode 1.14.30 returns only `_meta.opencode.modelId`).
     * The previously captured `availableModels` list is preserved.
     */
    private updateCurrentModelOptimistic(sessionId: string, modelId: string): void {
        const existing = this.sessionModelsMetadata.get(sessionId);
        this.sessionModelsMetadata.set(sessionId, {
            availableModels: existing?.availableModels ?? [],
            currentModelId: modelId
        });
    }

    private updateThoughtLevelCurrentValue(sessionId: string, value: string): void {
        const options = this.sessionConfigOptions.get(sessionId);
        if (!options) return;
        this.sessionConfigOptions.set(sessionId, options.map((option) => (
            option.category === 'thought_level'
                ? { ...option, currentValue: value }
                : option
        )));
    }

    /** After a successful model config apply, avoid stale base-only ACP currentValue overwriting cache. */
    pinSessionModelWireId(sessionId: string, modelId: string): void {
        this.updateCurrentModelOptimistic(sessionId, modelId);
    }

    private extractPromptUsage(response: unknown): AcpPromptUsage | null {
        if (!isObject(response) || !isObject(response.usage)) return null;
        const usage = response.usage;
        const inputTokens = this.asFiniteNumber(usage.inputTokens ?? usage.input_tokens);
        const outputTokens = this.asFiniteNumber(usage.outputTokens ?? usage.output_tokens);
        if (inputTokens === null || outputTokens === null) return null;

        return {
            inputTokens,
            outputTokens,
            totalTokens: this.asFiniteNumber(usage.totalTokens ?? usage.total_tokens) ?? undefined,
            thoughtTokens: this.asFiniteNumber(usage.thoughtTokens ?? usage.thought_tokens) ?? undefined,
            cacheReadTokens: this.asFiniteNumber(
                usage.cachedReadTokens
                ?? usage.cached_read_tokens
                ?? usage.cachedInputTokens
                ?? usage.cached_input_tokens
            ) ?? undefined
        };
    }

    private asFiniteNumber(value: unknown): number | null {
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }


    private captureSessionMetadata(sessionId: string, response: unknown): void {
        this.captureSessionModelsMetadata(sessionId, response);
        this.captureSessionConfigOptions(sessionId, response);
        this.captureAvailableCommands(sessionId, response);
    }

    private captureAvailableCommands(sessionId: string | null, source: unknown): void {
        if (!isObject(source)) return;

        const meta = isObject(source._meta) ? source._meta : null;
        const rawCommands = Array.isArray(source.availableCommands)
            ? source.availableCommands
            : meta && Array.isArray(meta.availableCommands)
                ? meta.availableCommands
                : null;
        if (!rawCommands) return;

        const commands = new Set(
            rawCommands
                .filter((entry): entry is Record<string, unknown> => isObject(entry))
                .map((entry) => asString(entry.name) ?? '')
                .filter((name) => name.length > 0)
        );
        if (sessionId) {
            this.sessionAvailableCommands.set(sessionId, commands);
            return;
        }

        this.initialAvailableCommands.clear();
        for (const command of commands) {
            this.initialAvailableCommands.add(command);
        }
    }

    private captureSessionConfigOptions(sessionId: string, response: unknown): void {
        if (!isObject(response)) return;

        const options = (Array.isArray(response.configOptions) ? response.configOptions : [])
            .filter((entry): entry is Record<string, unknown> => isObject(entry))
            .map((entry): AcpConfigOptionDescriptor | null => {
                const id = asString(entry.id);
                if (!id) return null;
                const rawOptions = Array.isArray(entry.options) ? entry.options : [];
                return {
                    id,
                    category: asString(entry.category) ?? undefined,
                    currentValue: asString(entry.currentValue) ?? undefined,
                    options: rawOptions
                        .filter((option): option is Record<string, unknown> => isObject(option))
                        .map((option) => ({
                            value: asString(option.value) ?? '',
                            name: asString(option.name) ?? undefined
                        }))
                        .filter((option) => option.value.length > 0)
                };
            })
            .filter((entry): entry is AcpConfigOptionDescriptor => entry !== null);

        const meta = isObject(response._meta) ? response._meta : null;
        const xaiConfig = meta && isObject(meta['x.ai/sessionConfig'])
            ? meta['x.ai/sessionConfig']
            : null;
        const xaiOptions = xaiConfig && Array.isArray(xaiConfig.options)
            ? xaiConfig.options.filter((entry): entry is Record<string, unknown> => isObject(entry))
            : [];
        const effortOptions = xaiOptions
            .filter((entry) => asString(entry.category) === 'mode')
            .map((entry) => ({
                value: asString(entry.id) ?? '',
                name: asString(entry.label) ?? undefined,
                selected: entry.selected === true
            }))
            .filter((entry) => entry.value.length > 0);
        if (effortOptions.length > 0) {
            options.push({
                id: 'x.ai/reasoning-effort',
                category: 'thought_level',
                currentValue: effortOptions.find((entry) => entry.selected)?.value,
                options: effortOptions.map(({ value, name }) => ({ value, name }))
            });
        }

        if (options.length > 0) {
            this.sessionConfigOptions.set(sessionId, options);
        }
    }

    /**
     * Extract `availableModels` and `currentModelId` from an ACP response and
     * store them keyed by sessionId. Both top-level and nested-under-`models`
     * shapes are accepted because different agents use different conventions.
     * Missing or malformed fields are silently ignored — flavors that do not
     * expose model metadata (e.g. current Gemini ACP build) simply leave the
     * cache untouched.
     */
    private extractModelConfigOption(response: Record<string, unknown>): {
        currentValue: string | null;
        options: unknown[];
    } | null {
        if (!Array.isArray(response.configOptions)) return null;

        for (const entry of response.configOptions) {
            if (!isObject(entry)) continue;
            if (asString(entry.category) !== 'model' && asString(entry.id) !== 'model') continue;
            return {
                currentValue: asString(entry.currentValue),
                options: Array.isArray(entry.options) ? entry.options : []
            };
        }

        return null;
    }

    private captureSessionModelsMetadata(sessionId: string, response: unknown): void {
        if (!isObject(response)) return;

        const directList = response.availableModels;
        const directCurrent = response.currentModelId;
        const nested = isObject(response.models) ? response.models : null;
        const nestedList = nested?.availableModels;
        const nestedCurrent = nested?.currentModelId;

        const configModelOption = this.extractModelConfigOption(response);
        const rawModels = Array.isArray(directList)
            ? directList
            : Array.isArray(nestedList)
                ? nestedList
                : configModelOption?.options ?? null;
        const rawCurrent = typeof directCurrent === 'string'
            ? directCurrent
            : typeof nestedCurrent === 'string'
                ? nestedCurrent
                : configModelOption?.currentValue ?? null;

        if (rawModels === null && rawCurrent === null) {
            return;
        }

        const byModelId = new Map<string, AcpModelDescriptor>();
        const addModel = (
            modelId: string,
            name?: string,
            reasoningEfforts?: AcpModelDescriptor['reasoningEfforts']
        ) => {
            const trimmedId = modelId.trim();
            if (!trimmedId) return;
            const trimmedName = name?.trim();
            const existing = byModelId.get(trimmedId);
            if (!existing) {
                byModelId.set(
                    trimmedId,
                    trimmedName && trimmedName !== trimmedId
                        ? { modelId: trimmedId, name: trimmedName, ...(reasoningEfforts ? { reasoningEfforts } : {}) }
                        : { modelId: trimmedId, ...(reasoningEfforts ? { reasoningEfforts } : {}) }
                );
                return;
            }
            if (!existing.name && trimmedName && trimmedName !== trimmedId) {
                byModelId.set(trimmedId, { ...existing, name: trimmedName });
            }
        };

        if (Array.isArray(rawModels)) {
            for (const entry of rawModels) {
                if (!isObject(entry)) continue;
                const modelId = asString(entry.modelId) ?? asString(entry.value);
                if (!modelId) continue;
                const meta = isObject(entry._meta) ? entry._meta : null;
                const reasoningEfforts = meta && Array.isArray(meta.reasoningEfforts)
                    ? meta.reasoningEfforts
                        .filter((effort): effort is Record<string, unknown> => isObject(effort))
                        .map((effort) => ({
                            value: asString(effort.value) ?? asString(effort.id) ?? '',
                            name: asString(effort.label) ?? undefined,
                            isDefault: effort.default === true
                        }))
                        .filter((effort) => effort.value.length > 0)
                    : undefined;
                addModel(modelId, asString(entry.name) ?? undefined, reasoningEfforts);
            }
        } else {
            // Preserve previously-captured availableModels when the response only
            // updates currentModelId (e.g. a setModel response from some agents).
            const existing = this.sessionModelsMetadata.get(sessionId);
            for (const entry of existing?.availableModels ?? []) {
                addModel(entry.modelId, entry.name, entry.reasoningEfforts);
            }
        }

        // Cursor often lists one wire id per family in `models` but every variant in
        // `configOptions` category=model — merge so metadata matches Zed-style pickers.
        if (configModelOption) {
            for (const entry of configModelOption.options) {
                if (!isObject(entry)) continue;
                const modelId = asString(entry.value) ?? asString(entry.modelId);
                if (!modelId) continue;
                addModel(modelId, asString(entry.name) ?? undefined);
            }
        }

        const existing = this.sessionModelsMetadata.get(sessionId);
        const currentModelId = this.preferSpecificCursorWireId(
            rawCurrent,
            existing?.currentModelId ?? null
        );

        this.sessionModelsMetadata.set(sessionId, {
            availableModels: [...byModelId.values()],
            currentModelId
        });
    }

    private preferSpecificCursorWireId(
        incoming: string | null,
        existing: string | null
    ): string | null {
        if (!incoming) {
            return existing;
        }
        if (!existing) {
            return incoming;
        }

        const incomingBase = incoming.split('[')[0];
        const existingBase = existing.split('[')[0];
        if (incomingBase !== existingBase) {
            return incoming;
        }

        const incomingHasVariant = incoming.includes('[');
        const existingHasVariant = existing.includes('[');
        if (!incomingHasVariant && existingHasVariant) {
            return existing;
        }

        return incoming;
    }
}
