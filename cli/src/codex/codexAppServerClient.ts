import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { logger } from '@/ui/logger';
import { JsonLineParser } from '@/utils/jsonLineParser';
import { killProcessByChildProcess } from '@/utils/process';
import type {
    CollaborationModeListResponse,
    InitializeParams,
    InitializeResponse,
    ModelListParams,
    ModelListResponse,
    SkillsListParams,
    SkillsListResponse,
    ThreadStartParams,
    ThreadStartResponse,
    ThreadResumeParams,
    ThreadResumeResponse,
    ThreadForkParams,
    ThreadForkResponse,
    ThreadReadParams,
    ThreadReadResponse,
    TurnStartParams,
    TurnStartResponse,
    TurnInterruptParams,
    TurnInterruptResponse,
    TurnSteerParams,
    TurnSteerResponse,
    ThreadRollbackParams,
    ThreadRollbackResponse,
    ThreadCompactStartParams,
    ThreadCompactStartResponse,
    ThreadGoalSetParams,
    ThreadGoalSetResponse,
    ThreadGoalGetParams,
    ThreadGoalGetResponse,
    ThreadGoalClearParams,
    ThreadGoalClearResponse,
    ExperimentalFeatureEnablementSetParams,
    ExperimentalFeatureEnablementSetResponse
} from './appServerTypes';

type JsonRpcLiteRequest = {
    id: number;
    method: string;
    params?: unknown;
};

type JsonRpcLiteNotification = {
    method: string;
    params?: unknown;
};

type JsonRpcLiteResponse = {
    id: number | string | null;
    result?: unknown;
    error?: {
        code?: number;
        message: string;
        data?: unknown;
    };
};

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;

type PendingRequest = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
};

type CodexAppServerClientOptions = {
    cwd?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

/** Transport failures leave steer delivery outcome unknown; JSON-RPC errors are explicit rejection. */
export const CODEX_APP_SERVER_INDETERMINATE_SYMBOL = Symbol('codex-app-server-indeterminate');

function markCodexAppServerIndeterminate(error: Error): Error {
    Object.defineProperty(error, CODEX_APP_SERVER_INDETERMINATE_SYMBOL, { value: true });
    return error;
}

export function isCodexAppServerIndeterminateError(error: unknown): boolean {
    return typeof error === 'object' && error !== null
        && (error as Record<symbol, unknown>)[CODEX_APP_SERVER_INDETERMINATE_SYMBOL] === true;
}

function createAbortError(): Error {
    const error = new Error('Request aborted');
    error.name = 'AbortError';
    return error;
}

type CodexCommandCandidate = {
    command: string;
    source: 'desktop' | 'path';
    version: number[] | null;
};

function parseCodexVersion(output: string): number[] | null {
    const match = /(\d+)\.(\d+)\.(\d+)(?:[-+][^\s]+)?/u.exec(output);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function getCodexVersion(command: string): number[] | null {
    try {
        const output = execFileSync(command, ['--version'], {
            encoding: 'utf8',
            timeout: 3_000,
            stdio: ['ignore', 'pipe', 'ignore']
        });
        return parseCodexVersion(output);
    } catch {
        return null;
    }
}

function compareVersion(a: number[] | null, b: number[] | null): number {
    if (!a && !b) return 0;
    if (a && !b) return 1;
    if (!a && b) return -1;
    for (let index = 0; index < 3; index += 1) {
        const diff = (a?.[index] ?? 0) - (b?.[index] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

function resolveCodexAppServerCommand(): string {
    if (process.env.HAPI_CODEX_APP_SERVER_BIN) {
        return process.env.HAPI_CODEX_APP_SERVER_BIN;
    }

    const candidates: CodexCommandCandidate[] = [{
        command: 'codex',
        source: 'path',
        version: getCodexVersion('codex')
    }];

    if (process.platform === 'darwin') {
        const desktopCodex = '/Applications/Codex.app/Contents/Resources/codex';
        if (existsSync(desktopCodex)) {
            candidates.push({
                command: desktopCodex,
                source: 'desktop',
                version: getCodexVersion(desktopCodex)
            });
        }
    }

    // 中文注释：Codex Desktop 与 npm CLI 都可能写 thread-store；恢复时选择版本更新的 app-server，
    // 避免旧 CLI 读取新 rollout 格式失败。版本相同优先 Desktop，和用户看到的 Codex.app 保持一致。
    const best = candidates.sort((left, right) => {
        const versionDiff = compareVersion(right.version, left.version);
        if (versionDiff !== 0) return versionDiff;
        if (left.source === right.source) return 0;
        return left.source === 'desktop' ? -1 : 1;
    })[0];

    logger.debug('[CodexAppServer] Resolved codex command', {
        selected: best.command,
        candidates: candidates.map((candidate) => ({
            command: candidate.command,
            source: candidate.source,
            version: candidate.version?.join('.') ?? null
        }))
    });
    return best.command;
}

export class CodexAppServerClient extends JsonLineParser {
    private process: ChildProcessWithoutNullStreams | null = null;
    private connected = false;
    private initialized = false;

    isConnected(): boolean {
        return this.connected;
    }

    isInitialized(): boolean {
        return this.initialized;
    }

    private nextId = 1;
    private readonly pending = new Map<number, PendingRequest>();
    private readonly requestHandlers = new Map<string, RequestHandler>();
    private notificationHandler: ((method: string, params: unknown) => void) | null = null;
    private transportAbandonedHandler: (() => void) | null = null;
    private stderrHandler: ((text: string) => void) | null = null;
    private protocolError: Error | null = null;

    static readonly DEFAULT_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;

    constructor(private readonly options: CodexAppServerClientOptions = {}) {
        super();
    }

    setStderrHandler(handler: ((text: string) => void) | null): void {
        this.stderrHandler = handler;
    }

    async connect(): Promise<void> {
        if (this.connected) {
            return;
        }

        const codexCommand = resolveCodexAppServerCommand();
        logger.debug(`[CodexAppServer] Starting ${codexCommand} app-server`);
        const child = spawn(codexCommand, ['app-server'], {
            cwd: this.options.cwd,
            env: Object.keys(process.env).reduce((acc, key) => {
                const value = process.env[key];
                if (typeof value === 'string') acc[key] = value;
                return acc;
            }, {} as Record<string, string>),
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
            windowsHide: process.platform === 'win32'
        });
        this.process = child;

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            if (this.process === child) this.feed(chunk);
        });

        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            if (this.process !== child) return;
            const text = chunk.toString().trim();
            if (text.length > 0) {
                logger.debug(`[CodexAppServer][stderr] ${text}`);
                this.stderrHandler?.(text);
            }
        });

        child.on('exit', (code, signal) => {
            if (this.process !== child) return;
            const message = `Codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
            logger.debug(message);
            this.rejectAllPending(new Error(message));
            this.connected = false;
            this.initialized = false;
            this.resetParserState();
            this.process = null;
            this.transportAbandonedHandler?.();
        });

        child.on('error', (error) => {
            if (this.process !== child) return;
            logger.debug('[CodexAppServer] Process error', error);
            const message = error instanceof Error ? error.message : String(error);
            this.rejectAllPending(new Error(
                `Failed to spawn codex app-server: ${message}. Is it installed and on PATH?`,
                { cause: error }
            ));
            this.connected = false;
            this.initialized = false;
            this.resetParserState();
            this.process = null;
            this.transportAbandonedHandler?.();
        });

        this.connected = true;
        logger.debug('[CodexAppServer] Connected');
    }

    setNotificationHandler(handler: ((method: string, params: unknown) => void) | null): void {
        this.notificationHandler = handler;
    }

    setTransportAbandonedHandler(handler: (() => void) | null): void {
        this.transportAbandonedHandler = handler;
    }

    registerRequestHandler(method: string, handler: RequestHandler): void {
        this.requestHandlers.set(method, handler);
    }

    async initialize(params: InitializeParams): Promise<InitializeResponse> {
        const response = await this.sendRequest('initialize', params, { timeoutMs: 30_000 });
        this.sendNotification('initialized');
        this.initialized = true;
        return response as InitializeResponse;
    }

    async listModels(params?: ModelListParams): Promise<ModelListResponse> {
        const response = await this.sendRequest('model/list', params ?? {}, {
            timeoutMs: 30_000
        });
        return response as ModelListResponse;
    }

    async listSkills(params: SkillsListParams): Promise<SkillsListResponse> {
        const response = await this.sendRequest('skills/list', params, {
            timeoutMs: 30_000
        });
        return response as SkillsListResponse;
    }

    async listCollaborationModes(): Promise<CollaborationModeListResponse> {
        const response = await this.sendRequest('collaborationMode/list', {}, {
            timeoutMs: 30_000
        });
        return response as CollaborationModeListResponse;
    }

    async setExperimentalFeatureEnablement(
        params: ExperimentalFeatureEnablementSetParams
    ): Promise<ExperimentalFeatureEnablementSetResponse> {
        const response = await this.sendRequest('experimentalFeature/enablement/set', params, {
            timeoutMs: 30_000
        });
        return response as ExperimentalFeatureEnablementSetResponse;
    }

    async startThread(params: ThreadStartParams, options?: { signal?: AbortSignal }): Promise<ThreadStartResponse> {
        const response = await this.sendRequest('thread/start', params, {
            signal: options?.signal,
            timeoutMs: CodexAppServerClient.DEFAULT_TIMEOUT_MS
        });
        return response as ThreadStartResponse;
    }

    async resumeThread(params: ThreadResumeParams, options?: { signal?: AbortSignal }): Promise<ThreadResumeResponse> {
        const response = await this.sendRequest('thread/resume', params, {
            signal: options?.signal,
            timeoutMs: CodexAppServerClient.DEFAULT_TIMEOUT_MS
        });
        return response as ThreadResumeResponse;
    }

    async forkThread(params: ThreadForkParams, options?: { signal?: AbortSignal }): Promise<ThreadForkResponse> {
        const response = await this.sendRequest('thread/fork', params, {
            signal: options?.signal,
            timeoutMs: CodexAppServerClient.DEFAULT_TIMEOUT_MS
        });
        return response as ThreadForkResponse;
    }

    async supportsMethod(method: 'thread/fork' | 'thread/rollback'): Promise<boolean> {
        try {
            await this.sendRequest(method, { threadId: '__hapi_capability_probe__' }, { timeoutMs: 30_000 });
            return true;
        } catch (error) {
            return !/method not found|unknown method|unsupported/i.test(
                error instanceof Error ? error.message : String(error)
            );
        }
    }

    async readThread(params: ThreadReadParams, options?: { signal?: AbortSignal }): Promise<ThreadReadResponse> {
        const response = await this.sendRequest('thread/read', params, {
            signal: options?.signal,
            timeoutMs: CodexAppServerClient.DEFAULT_TIMEOUT_MS
        });
        return response as ThreadReadResponse;
    }

    async startTurn(params: TurnStartParams, options?: { signal?: AbortSignal }): Promise<TurnStartResponse> {
        const response = await this.sendRequest('turn/start', params, {
            signal: options?.signal,
            timeoutMs: CodexAppServerClient.DEFAULT_TIMEOUT_MS
        });
        return response as TurnStartResponse;
    }

    async interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
        const response = await this.sendRequest('turn/interrupt', params, {
            timeoutMs: 30_000
        });
        return response as TurnInterruptResponse;
    }

    async steerTurn(params: TurnSteerParams, options?: { signal?: AbortSignal }): Promise<TurnSteerResponse> {
        const response = await this.sendRequest('turn/steer', params, {
            signal: options?.signal,
            // Leave margin below the hub RPC timeout; timeout is classified
            // as indeterminate so the launcher consumes at most once.
            timeoutMs: 20_000
        });
        return response as TurnSteerResponse;
    }

    /**
     * Deprecated upstream, but still required to match Codex's native
     * safety-buffering retry flow. Keep the protocol call isolated here so it
     * can be replaced when app-server exposes a successor.
     */
    async rollbackThread(params: ThreadRollbackParams): Promise<ThreadRollbackResponse> {
        const response = await this.sendRequest('thread/rollback', params, {
            timeoutMs: 30_000
        });
        return response as ThreadRollbackResponse;
    }

    async compactThread(
        params: ThreadCompactStartParams,
        options?: { signal?: AbortSignal }
    ): Promise<ThreadCompactStartResponse> {
        const response = await this.sendRequest('thread/compact/start', params, {
            signal: options?.signal,
            timeoutMs: CodexAppServerClient.DEFAULT_TIMEOUT_MS
        });
        return response as ThreadCompactStartResponse;
    }

    async setThreadGoal(
        params: ThreadGoalSetParams,
        options?: { signal?: AbortSignal }
    ): Promise<ThreadGoalSetResponse> {
        const response = await this.sendRequest('thread/goal/set', params, {
            signal: options?.signal,
            timeoutMs: 30_000
        });
        return response as ThreadGoalSetResponse;
    }

    async getThreadGoal(
        params: ThreadGoalGetParams,
        options?: { signal?: AbortSignal }
    ): Promise<ThreadGoalGetResponse> {
        const response = await this.sendRequest('thread/goal/get', params, {
            signal: options?.signal,
            timeoutMs: 30_000
        });
        return response as ThreadGoalGetResponse;
    }

    async clearThreadGoal(
        params: ThreadGoalClearParams,
        options?: { signal?: AbortSignal }
    ): Promise<ThreadGoalClearResponse> {
        const response = await this.sendRequest('thread/goal/clear', params, {
            signal: options?.signal,
            timeoutMs: 30_000
        });
        return response as ThreadGoalClearResponse;
    }

    async disconnect(): Promise<void> {
        if (!this.connected) {
            return;
        }

        const child = this.process;
        this.process = null;

        try {
            child?.stdin.end();
            if (child) {
                await killProcessByChildProcess(child);
            }
        } catch (error) {
            logger.debug('[CodexAppServer] Error while stopping process', error);
        } finally {
            this.rejectAllPending(new Error('Codex app-server disconnected'));
            this.connected = false;
            this.initialized = false;
            this.resetParserState();
        }

        logger.debug('[CodexAppServer] Disconnected');
    }

    private async sendRequest(
        method: string,
        params?: unknown,
        options?: { signal?: AbortSignal; timeoutMs?: number }
    ): Promise<unknown> {
        if (!this.connected) {
            await this.connect();
        }

        const id = this.nextId++;
        const payload: JsonRpcLiteRequest = {
            id,
            method,
            params
        };

        const timeoutMs = options?.timeoutMs ?? CodexAppServerClient.DEFAULT_TIMEOUT_MS;

        return new Promise((resolve, reject) => {
            let timeout: ReturnType<typeof setTimeout> | null = null;
            let aborted = false;

            const cleanup = () => {
                if (timeout) {
                    clearTimeout(timeout);
                }
                if (options?.signal) {
                    options.signal.removeEventListener('abort', onAbort);
                }
            };

            const onAbort = () => {
                if (aborted) return;
                aborted = true;
                this.pending.delete(id);
                cleanup();
                reject(markCodexAppServerIndeterminate(createAbortError()));
            };

            if (options?.signal) {
                if (options.signal.aborted) {
                    onAbort();
                    return;
                }
                options.signal.addEventListener('abort', onAbort, { once: true });
            }

            if (Number.isFinite(timeoutMs)) {
                timeout = setTimeout(() => {
                    if (this.pending.has(id)) {
                        this.pending.delete(id);
                        cleanup();
                        reject(markCodexAppServerIndeterminate(
                            new Error(`Codex app-server request '${method}' timed out after ${timeoutMs}ms`)
                        ));
                    }
                }, timeoutMs);
                timeout.unref();
            }

            this.pending.set(id, {
                resolve: (value) => {
                    cleanup();
                    resolve(value);
                },
                reject: (error) => {
                    cleanup();
                    reject(error);
                },
                cleanup
            });

            this.writePayload(payload);
        });
    }

    private sendNotification(method: string, params?: unknown): void {
        const payload: JsonRpcLiteNotification = { method, params };
        this.writePayload(payload);
    }

    protected handleLine(line: string): void {
        if (this.protocolError) {
            return;
        }

        let message: Record<string, unknown> | null = null;
        try {
            const parsed = JSON.parse(line);
            message = asRecord(parsed);
            if (!message) {
                logger.debug('[CodexAppServer] Ignoring non-object JSON from stdout', { line });
                return;
            }
        } catch (error) {
            const protocolError = new Error('Failed to parse JSON from codex app-server');
            this.protocolError = protocolError;
            logger.debug('[CodexAppServer] Failed to parse JSON line', { line, error });
            this.rejectAllPending(protocolError);
            this.process?.stdin.end();
            return;
        }

        if (typeof message.method === 'string') {
            const method = message.method;
            const params = 'params' in message ? message.params : null;

            if ('id' in message && message.id !== undefined) {
                const requestId = message.id;
                void this.handleIncomingRequest({
                    id: requestId,
                    method,
                    params
                });
                return;
            }

            this.notificationHandler?.(method, params ?? null);
            return;
        }

        if ('id' in message) {
            this.handleResponse(message as JsonRpcLiteResponse);
        }
    }

    private async handleIncomingRequest(request: { id: unknown; method: string; params?: unknown }): Promise<void> {
        const responseId = typeof request.id === 'number' || typeof request.id === 'string'
            ? request.id
            : null;
        const handler = this.requestHandlers.get(request.method);

        if (!handler) {
            this.writePayload({
                id: responseId,
                error: {
                    code: -32601,
                    message: `Method not found: ${request.method}`
                }
            } satisfies JsonRpcLiteResponse);
            return;
        }

        try {
            const result = await handler(request.params ?? null);
            this.writePayload({
                id: responseId,
                result
            } satisfies JsonRpcLiteResponse);
        } catch (error) {
            this.writePayload({
                id: responseId,
                error: {
                    code: -32603,
                    message: error instanceof Error ? error.message : 'Internal error'
                }
            } satisfies JsonRpcLiteResponse);
        }
    }

    private handleResponse(response: JsonRpcLiteResponse): void {
        if (response.id === null || response.id === undefined) {
            logger.debug('[CodexAppServer] Received response without id');
            return;
        }

        if (typeof response.id !== 'number') {
            logger.debug('[CodexAppServer] Received response with non-numeric id', response.id);
            return;
        }

        const pending = this.pending.get(response.id);
        if (!pending) {
            logger.debug('[CodexAppServer] Received response with no pending request', response.id);
            return;
        }

        this.pending.delete(response.id);

        if (response.error) {
            pending.reject(new Error(response.error.message));
            return;
        }

        pending.resolve(response.result);
    }

    private writePayload(payload: JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteResponse): void {
        const serialized = JSON.stringify(payload);
        const child = this.process;
        if (!child) {
            throw new Error('Codex app-server is not connected');
        }
        try {
            child.stdin.write(`${serialized}\n`, (error) => {
                if (!error || this.process !== child) return;
                this.abandonTransport(child, markCodexAppServerIndeterminate(error));
            });
        } catch (error) {
            const writeError = error instanceof Error ? error : new Error(String(error));
            if ('id' in payload && typeof payload.id === 'number') {
                const current = this.pending.get(payload.id);
                this.pending.delete(payload.id);
                current?.reject(writeError);
            }
            this.rejectAllPending(new Error(writeError.message, { cause: writeError }));
            throw writeError;
        }
    }

    private abandonTransport(child: ChildProcessWithoutNullStreams, error: Error): void {
        if (this.process !== child) return;
        this.process = null;
        this.connected = false;
        this.initialized = false;
        try {
            child?.stdin.destroy();
        } catch (destroyError) {
            logger.debug('[CodexAppServer] Error destroying stalled stdin', destroyError);
        }
        this.rejectAllPending(error);
        this.resetParserState();
        this.transportAbandonedHandler?.();
    }

    private resetParserState(): void {
        this.reset();
        this.protocolError = null;
    }

    private rejectAllPending(error: Error): void {
        const indeterminate = markCodexAppServerIndeterminate(error);
        for (const { reject, cleanup } of this.pending.values()) {
            cleanup();
            reject(indeterminate);
        }
        this.pending.clear();
    }
}
