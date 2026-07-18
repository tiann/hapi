import type {
    AgentBackend,
    AgentMessage,
    AgentSessionConfig,
    AgentSessionHandle,
    PermissionRequest,
    PermissionResponse,
    PromptContent
} from '@/agent/types';
import { AcpStdioTransport, type AcpStderrError } from '@/agent/backends/acp/AcpStdioTransport';
import { asString, isObject } from '@hapi/protocol';
import { GrokUpdateInterpreter, type GrokInterpreterEvent } from './GrokUpdateInterpreter';
import { parseGrokCapabilities, type GrokCapabilities } from './grokCapabilities';
import packageJson from '../../../package.json';
import { logger } from '@/ui/logger';
import type { GrokPermissionMode } from '@hapi/protocol/types';
import { getGrokSandboxProfile } from './grokSandbox';
import { buildGrokEnv } from './grokEnv';

type RequestHandler = (params: unknown, requestId: string | number | null) => Promise<unknown>;

export interface GrokTransport {
    onNotification(handler: ((method: string, params: unknown) => void) | null): void;
    onStderrError(handler: ((error: AcpStderrError) => void) | null): void;
    onTerminal(handler: ((error: Error) => void) | null): void;
    isOpen(): boolean;
    registerRequestHandler(method: string, handler: RequestHandler): void;
    registerFallbackRequestHandler(handler: ((method: string, params: unknown, requestId: string | number | null) => Promise<{ handled: boolean; result?: unknown }>) | null): void;
    sendRequest(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
    sendNotification(method: string, params?: unknown): void;
    close(): Promise<void>;
}

export type GrokQuestion = {
    question: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean | null;
};

export type GrokAskUserQuestionRequest = {
    sessionId: string;
    toolCallId: string;
    questions: GrokQuestion[];
    mode?: string;
};

export type GrokAskUserQuestionResponse =
    | { outcome: 'accepted'; answers: Record<string, string[]> }
    | { outcome: 'skip_interview' }
    | { outcome: 'chat_about_this'; partial_answers?: Record<string, string[]> };

export type GrokPlanApprovalRequest = {
    sessionId: string;
    toolCallId: string;
    planContent: string;
};

export type GrokPlanApprovalResponse =
    | { outcome: 'approved' }
    | { outcome: 'request_changes'; feedback?: string }
    | { outcome: 'abandoned' };

type PendingPermission = {
    resolve: (result: { outcome: { outcome: string; optionId?: string } }) => void;
};

type TransportFactory = (options: { command: string; args: string[]; env: Record<string, string> }) => GrokTransport;

export class GrokCancelTimeoutError extends Error {
    readonly timeoutMs: number;

    constructor(timeoutMs: number, options?: ErrorOptions) {
        super(`Grok prompt did not settle within ${timeoutMs}ms after cancellation; the ACP transport was closed.`, options);
        this.name = 'GrokCancelTimeoutError';
        this.timeoutMs = timeoutMs;
    }
}

function parseQuestionRequest(params: unknown): GrokAskUserQuestionRequest | null {
    if (!isObject(params)) return null;
    const sessionId = asString(params.sessionId);
    const toolCallId = asString(params.toolCallId);
    if (!sessionId || !toolCallId || !Array.isArray(params.questions)) return null;
    const questions = params.questions.flatMap((entry) => {
        if (!isObject(entry)) return [];
        const question = asString(entry.question);
        if (!question) return [];
        const options = Array.isArray(entry.options)
            ? entry.options.flatMap((option) => {
                if (!isObject(option)) return [];
                const label = asString(option.label);
                if (!label) return [];
                return [{ label, ...(asString(option.description) ? { description: asString(option.description)! } : {}) }];
            })
            : undefined;
        return [{
            question,
            ...(options ? { options } : {}),
            ...(typeof entry.multiSelect === 'boolean' || entry.multiSelect === null
                ? { multiSelect: entry.multiSelect }
                : {})
        }];
    });
    return { sessionId, toolCallId, questions, ...(asString(params.mode) ? { mode: asString(params.mode)! } : {}) };
}

function parsePlanRequest(params: unknown): GrokPlanApprovalRequest | null {
    if (!isObject(params)) return null;
    const sessionId = asString(params.sessionId);
    const toolCallId = asString(params.toolCallId);
    const planContent = asString(params.planContent);
    if (!sessionId || !toolCallId || !planContent) return null;
    return { sessionId, toolCallId, planContent };
}

export class GrokAcpBackend implements AgentBackend {
    private transport: GrokTransport | null = null;
    private capabilities: GrokCapabilities | null = null;
    private activeSessionId: string | null = null;
    private activeOnUpdate: ((message: AgentMessage) => void) | null = null;
    private turnCompleteEmitted = false;
    private readonly pendingPermissions = new Map<string, PendingPermission>();
    private permissionHandler: ((request: PermissionRequest) => void) | null = null;
    private stderrHandler: ((error: AcpStderrError) => void) | null = null;
    private questionHandler: ((request: GrokAskUserQuestionRequest) => Promise<GrokAskUserQuestionResponse>) | null = null;
    private planHandler: ((request: GrokPlanApprovalRequest) => Promise<GrokPlanApprovalResponse>) | null = null;
    private unknownHandler: ((method: string, params: unknown) => void) | null = null;
    private configHandler: ((config: { model: string | null; effort: string | null }) => void) | null = null;
    private capabilitiesHandler: ((capabilities: GrokCapabilities) => void) | null = null;
    private statusHandler: ((status: string, data: Record<string, unknown>) => void) | null = null;
    private terminalErrorHandler: ((error: Error) => void) | null = null;
    private readonly interpreter = new GrokUpdateInterpreter(
        (event) => this.handleInterpreterEvent(event),
        { emitUserMessages: false }
    );
    private readonly transportFactory: TransportFactory;
    private readonly permissionMode: GrokPermissionMode;
    private readonly cancelTimeoutMs: number;
    private activePromptSettlement: Promise<void> | null = null;
    private activeCancellation: Promise<void> | null = null;
    private readonly env: Record<string, string>;
    private expectedCloseTransport: GrokTransport | null = null;

    constructor(options: {
        transportFactory?: TransportFactory;
        permissionMode?: GrokPermissionMode;
        cancelTimeoutMs?: number;
        env?: NodeJS.ProcessEnv;
    } = {}) {
        this.transportFactory = options.transportFactory ?? ((transportOptions) => new AcpStdioTransport(transportOptions));
        this.permissionMode = options.permissionMode ?? 'default';
        this.cancelTimeoutMs = options.cancelTimeoutMs ?? 5_000;
        this.env = buildGrokEnv(options.env ?? process.env);
    }

    async initialize(): Promise<void> {
        if (this.transport) return;
        const options = {
            command: 'grok',
            args: ['--sandbox', getGrokSandboxProfile(this.permissionMode), 'agent', '--no-leader', 'stdio'],
            env: this.env
        };
        const transport = this.transportFactory(options);
        this.transport = transport;
        transport.onTerminal((error) => this.handleTransportTerminal(transport, error));
        transport.onNotification((method, params) => this.handleNotification(method, params));
        transport.onStderrError((error) => this.stderrHandler?.(error));
        transport.registerRequestHandler('session/request_permission', (params) => this.handlePermissionRequest(params));
        transport.registerRequestHandler('_x.ai/ask_user_question', (params) => this.handleAskUserQuestion(params));
        transport.registerRequestHandler('_x.ai/exit_plan_mode', (params) => this.handlePlanApproval(params));
        transport.registerFallbackRequestHandler(async (method, params) => {
            if (!method.startsWith('_x.ai/')) return { handled: false };
            this.unknownHandler?.(method, params);
            return { handled: true, result: null };
        });

        const response = await transport.sendRequest('initialize', {
            protocolVersion: 1,
            clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false
            },
            clientInfo: { name: 'hapi', version: packageJson.version }
        });
        if (!isObject(response) || typeof response.protocolVersion !== 'number') {
            throw new Error('Invalid initialize response from Grok ACP agent');
        }
        this.capabilities = parseGrokCapabilities(response);
    }

    getCapabilities(): GrokCapabilities | null {
        return this.capabilities;
    }

    isConnected(): boolean {
        return this.transport?.isOpen() ?? false;
    }

    async requestExtension(method: string, params?: unknown, timeoutMs = 10_000): Promise<unknown> {
        return this.requireTransport().sendRequest(method, params, { timeoutMs });
    }

    async newSession(config: AgentSessionConfig): Promise<string> {
        const transport = this.requireTransport();
        const response = await transport.sendRequest('session/new', {
            cwd: config.cwd,
            mcpServers: config.mcpServers
        });
        const sessionId = isObject(response) ? asString(response.sessionId) : null;
        if (!sessionId) throw new Error('Invalid Grok session/new response');
        this.activeSessionId = sessionId;
        return sessionId;
    }

    async resumeSession(resumeSessionId: string, config: AgentSessionConfig): Promise<AgentSessionHandle> {
        const transport = this.requireTransport();
        const response = await transport.sendRequest('session/load', {
            sessionId: resumeSessionId,
            cwd: config.cwd,
            mcpServers: config.mcpServers
        });
        if (!isObject(response)) throw new Error('Invalid Grok session/load response');
        const sessionId = asString(response.sessionId);
        if (!sessionId) throw new Error('Invalid Grok session/load response: missing sessionId');
        if (sessionId !== resumeSessionId) {
            throw new Error(
                `Grok session/load identity mismatch: requested '${resumeSessionId}', received '${sessionId}'`
            );
        }
        this.activeSessionId = resumeSessionId;
        return { sessionId: resumeSessionId, resumeSessionId };
    }

    async prompt(sessionId: string, content: PromptContent[], onUpdate: (message: AgentMessage) => void): Promise<void> {
        const transport = this.requireTransport();
        this.activeSessionId = sessionId;
        this.activeOnUpdate = onUpdate;
        this.turnCompleteEmitted = false;
        const promptRequest = transport.sendRequest(
            'session/prompt',
            { sessionId, prompt: content },
            { timeoutMs: Infinity }
        );
        const settlement = promptRequest.then(() => undefined, () => undefined);
        this.activePromptSettlement = settlement;
        try {
            const response = await promptRequest;
            this.interpreter.flush();
            const stopReason = isObject(response) ? asString(response.stopReason) : null;
            if (stopReason && !this.turnCompleteEmitted) {
                onUpdate({ type: 'turn_complete', stopReason });
            }
        } finally {
            if (this.activePromptSettlement === settlement) this.activePromptSettlement = null;
            this.activeOnUpdate = null;
        }
    }

    async cancelPrompt(sessionId: string): Promise<void> {
        if (this.activeCancellation) return this.activeCancellation;
        const cancellation = this.cancelPromptOnce(sessionId);
        this.activeCancellation = cancellation;
        void cancellation.then(
            () => { if (this.activeCancellation === cancellation) this.activeCancellation = null; },
            () => { if (this.activeCancellation === cancellation) this.activeCancellation = null; }
        );
        return cancellation;
    }

    async setSessionConfig(
        sessionId: string,
        config: { model?: string | null; effort?: string | null }
    ): Promise<Record<string, unknown>> {
        const transport = this.requireTransport();
        const applied: Record<string, unknown> = {};
        if (
            typeof config.model === 'string'
            && this.capabilities?.models.length
            && !this.capabilities.models.some((entry) => entry.id === config.model)
        ) {
            throw new Error(`Unknown Grok model: ${config.model}`);
        }
        const model = config.model === null ? this.capabilities?.currentModelId ?? null : config.model;
        const selectedModel = model ?? this.capabilities?.currentModelId ?? null;
        const modelCapabilities = this.capabilities?.models.find((entry) => entry.id === selectedModel);
        if (
            typeof config.effort === 'string'
            && modelCapabilities?.efforts.length
            && !modelCapabilities.efforts.some((entry) => entry.id === config.effort)
        ) {
            throw new Error(`Unsupported Grok effort '${config.effort}' for model '${selectedModel}'`);
        }
        const defaultEffort = modelCapabilities?.efforts.find((entry) => entry.isDefault)?.id
            ?? this.capabilities?.currentEffort ?? null;
        if (model) {
            await transport.sendRequest('session/set_model', { sessionId, modelId: model });
            applied.model = model;
            if (config.effort === undefined && defaultEffort) applied.effort = defaultEffort;
            if (this.capabilities) {
                this.capabilities = { ...this.capabilities, currentModelId: model, currentEffort: defaultEffort };
            }
        }
        const effort = config.effort === null ? defaultEffort : config.effort;
        if (effort) {
            await transport.sendRequest('session/set_mode', { sessionId, modeId: effort });
            applied.effort = effort;
            if (this.capabilities) this.capabilities = { ...this.capabilities, currentEffort: effort };
        }
        return applied;
    }

    onPermissionRequest(handler: (request: PermissionRequest) => void): void {
        this.permissionHandler = handler;
    }

    async respondToPermission(
        _sessionId: string,
        request: PermissionRequest,
        response: PermissionResponse
    ): Promise<void> {
        const pending = this.pendingPermissions.get(request.id);
        if (!pending) return;
        this.pendingPermissions.delete(request.id);
        pending.resolve(response.outcome === 'selected'
            ? { outcome: { outcome: 'selected', optionId: response.optionId } }
            : { outcome: { outcome: 'cancelled' } });
    }

    onAskUserQuestion(handler: (request: GrokAskUserQuestionRequest) => Promise<GrokAskUserQuestionResponse>): void {
        this.questionHandler = handler;
    }

    onPlanApproval(handler: (request: GrokPlanApprovalRequest) => Promise<GrokPlanApprovalResponse>): void {
        this.planHandler = handler;
    }

    onUnknownExtension(handler: (method: string, params: unknown) => void): void {
        this.unknownHandler = handler;
    }

    onConfigChanged(handler: (config: { model: string | null; effort: string | null }) => void): void {
        this.configHandler = handler;
    }

    onCapabilitiesChanged(handler: (capabilities: GrokCapabilities) => void): void {
        this.capabilitiesHandler = handler;
    }

    onStatus(handler: (status: string, data: Record<string, unknown>) => void): void {
        this.statusHandler = handler;
    }

    onStderrError(handler: (error: AcpStderrError) => void): void {
        this.stderrHandler = handler;
    }

    onTerminalError(handler: (error: Error) => void): void {
        this.terminalErrorHandler = handler;
    }

    async disconnect(): Promise<void> {
        this.interpreter.flush();
        const transport = this.transport;
        if (transport) this.expectedCloseTransport = transport;
        try {
            await transport?.close();
        } finally {
            if (this.transport === transport) this.transport = null;
            if (this.expectedCloseTransport === transport) this.expectedCloseTransport = null;
            this.activeSessionId = null;
            this.activeOnUpdate = null;
        }
    }

    private requireTransport(): GrokTransport {
        if (!this.transport?.isOpen()) throw new Error('Grok ACP transport not initialized');
        return this.transport;
    }

    private handleTransportTerminal(transport: GrokTransport, error: Error): void {
        if (this.transport !== transport) return;
        const expected = this.expectedCloseTransport === transport;
        this.transport = null;
        this.activeSessionId = null;
        if (!expected) this.terminalErrorHandler?.(error);
    }

    private async cancelPromptOnce(sessionId: string): Promise<void> {
        const transport = this.transport;
        if (!transport) return;
        transport.sendNotification('session/cancel', { sessionId });
        const settlement = this.activePromptSettlement;
        if (!settlement || await this.waitForPromptSettlement(settlement)) return;

        let closeError: unknown;
        try {
            await transport.close();
        } catch (error) {
            closeError = error;
        } finally {
            if (this.transport === transport) this.transport = null;
        }
        throw new GrokCancelTimeoutError(
            this.cancelTimeoutMs,
            closeError === undefined ? undefined : { cause: closeError }
        );
    }

    private async waitForPromptSettlement(settlement: Promise<void>): Promise<boolean> {
        let timer: NodeJS.Timeout | null = null;
        try {
            return await Promise.race([
                settlement.then(() => true),
                new Promise<false>((resolve) => {
                    timer = setTimeout(() => resolve(false), this.cancelTimeoutMs);
                })
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private handleNotification(method: string, params: unknown): void {
        if (method === '_x.ai/models/update' && isObject(params)) {
            const parsed = parseGrokCapabilities({ _meta: { modelState: params } });
            if (this.capabilities) {
                this.capabilities = {
                    ...this.capabilities,
                    currentModelId: parsed.currentModelId,
                    currentEffort: parsed.currentEffort,
                    models: parsed.models
                };
            } else {
                this.capabilities = parsed;
            }
            this.capabilitiesHandler?.(this.capabilities);
            return;
        }
        if (isObject(params)) {
            const sessionId = asString(params.sessionId);
            if (this.activeSessionId && sessionId && sessionId !== this.activeSessionId) return;
        }
        this.interpreter.handle(method, params);
    }

    private handleInterpreterEvent(event: GrokInterpreterEvent): void {
        if (event.type === 'agent') {
            if (event.message.type === 'turn_complete') this.turnCompleteEmitted = true;
            this.activeOnUpdate?.(event.message);
            return;
        }
        if (event.type === 'config') {
            if (this.capabilities) {
                this.capabilities = {
                    ...this.capabilities,
                    currentModelId: event.model ?? this.capabilities.currentModelId,
                    currentEffort: event.effort ?? this.capabilities.currentEffort
                };
            }
            this.configHandler?.({ model: event.model, effort: event.effort });
            return;
        }
        if (event.type === 'unknown') {
            this.unknownHandler?.(event.method, event.params);
            return;
        }
        if (event.type === 'mode') {
            this.statusHandler?.('mode_changed', { mode: event.mode });
            return;
        }
        if (event.type === 'interaction') {
            this.statusHandler?.(`interaction_${event.status}`, {
                toolCallId: event.toolCallId,
                ...(event.kind ? { kind: event.kind } : {})
            });
            return;
        }
        if (event.type === 'status') {
            logger.debug(`[grok-acp] ${event.status}`, event.data);
            this.statusHandler?.(event.status, event.data);
        }
    }

    private async handlePermissionRequest(params: unknown): Promise<unknown> {
        if (!isObject(params)) return { outcome: { outcome: 'cancelled' } };
        const sessionId = asString(params.sessionId) ?? this.activeSessionId ?? 'unknown';
        const toolCall = isObject(params.toolCall) ? params.toolCall : {};
        const toolCallId = asString(toolCall.toolCallId) ?? `tool-${Date.now()}`;
        const options = Array.isArray(params.options)
            ? params.options.flatMap((entry, index) => {
                if (!isObject(entry)) return [];
                return [{
                    optionId: asString(entry.optionId) ?? `option-${index + 1}`,
                    name: asString(entry.name) ?? `Option ${index + 1}`,
                    kind: asString(entry.kind) ?? 'allow_once'
                }];
            })
            : [];
        const request: PermissionRequest = {
            id: toolCallId,
            sessionId,
            toolCallId,
            title: asString(toolCall.title) ?? undefined,
            kind: asString(toolCall.kind) ?? undefined,
            rawInput: toolCall.rawInput,
            rawOutput: toolCall.rawOutput,
            options
        };
        if (!this.permissionHandler) return { outcome: { outcome: 'cancelled' } };
        const result = new Promise<{ outcome: { outcome: string; optionId?: string } }>((resolve) => {
            this.pendingPermissions.set(toolCallId, { resolve });
        });
        this.permissionHandler(request);
        return result;
    }

    private async handleAskUserQuestion(params: unknown): Promise<GrokAskUserQuestionResponse> {
        const request = parseQuestionRequest(params);
        if (!request || !this.questionHandler) return { outcome: 'skip_interview' };
        return this.questionHandler(request);
    }

    private async handlePlanApproval(params: unknown): Promise<GrokPlanApprovalResponse> {
        const request = parsePlanRequest(params);
        if (!request || !this.planHandler) {
            return { outcome: 'request_changes', feedback: 'No HAPI plan approval handler is available.' };
        }
        return this.planHandler(request);
    }
}

export function createGrokBackend(options: { permissionMode?: GrokPermissionMode } = {}): GrokAcpBackend {
    return new GrokAcpBackend(options);
}
