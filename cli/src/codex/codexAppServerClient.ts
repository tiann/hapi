import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from '@/ui/logger';
import { killProcessByChildProcess } from '@/utils/process';
import type {
    InitializeParams,
    InitializeResponse,
    ThreadStartParams,
    ThreadStartResponse,
    ThreadResumeParams,
    ThreadResumeResponse,
    TurnStartParams,
    TurnStartResponse,
    TurnSteerParams,
    TurnSteerResponse,
    TurnInterruptParams,
    TurnInterruptResponse,
    ThreadCompactStartParams,
    ThreadCompactStartResponse,
    ThreadGoalGetParams,
    ThreadGoalGetResponse,
    ThreadGoalSetParams,
    ThreadGoalSetResponse,
    ThreadGoalClearParams,
    ThreadGoalClearResponse
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
    method: string;
    writeState: 'not-written' | 'written';
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
};

export class CodexAppServerError extends Error {
    readonly method: string;
    readonly code?: number;
    readonly data?: unknown;
    readonly childExit?: { code: number | null; signal: string | null };
    readonly writeState: 'not-written' | 'written';

    constructor(options: {
        method: string;
        message: string;
        code?: number;
        data?: unknown;
        childExit?: { code: number | null; signal: string | null };
        writeState: 'not-written' | 'written';
        cause?: unknown;
    }) {
        super(sanitizeCodexErrorMessage(options.message, options.method, options.code, options.childExit));
        this.name = 'CodexAppServerError';
        this.method = options.method;
        this.code = options.code;
        this.data = sanitizeCodexErrorData(options.data);
        this.childExit = options.childExit;
        this.writeState = options.writeState;
    }
}

function sanitizeCodexErrorData(value: unknown): unknown {
    const record = asRecord(value);
    if (!record) return undefined;
    const safe: Record<string, string | number | boolean> = {};
    for (const key of ['kind', 'type', 'status']) {
        const item = record[key];
        if (typeof item === 'string') safe[key] = redactCodexErrorText(item).slice(0, 100);
        else if (typeof item === 'number' || typeof item === 'boolean') safe[key] = item;
    }
    return Object.keys(safe).length > 0 ? safe : undefined;
}

export function redactCodexErrorText(message: string): string {
    return message
        .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
        .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
        .replace(/\b[A-Z][A-Z0-9_]*(?:API_KEY|API_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|PRIVATE_KEY)\s*=\s*[^\s,;]+/gi, '[REDACTED_CREDENTIAL]')
        .slice(0, 500);
}

function sanitizeCodexErrorMessage(
    message: string,
    method: string,
    code?: number,
    childExit?: { code: number | null; signal: string | null }
): string {
    if (childExit) return 'Codex app-server exited';
    if (/request aborted|aborted by user/i.test(message)) return 'Request aborted';
    if (/operation not permitted|permission denied|system policy/i.test(message)) return 'Permission denied';
    if (/turn.*(?:active|in progress)|already.*turn/i.test(message)) return 'Turn already active';
    if (method === 'thread/resume' && /not found|missing|unknown/i.test(message)) return 'Thread not found';
    if (code === -32601 || /method not found/i.test(message)) return 'Method not found';
    if (/timed out|timeout/i.test(message)) return 'Request timed out';
    return 'Request failed';
}

export function formatCodexAppServerFailure(error: unknown): string {
    if (error instanceof CodexAppServerError) {
        if (error.childExit) return `Process exited unexpectedly (code=${error.childExit.code ?? 'null'}, signal=${error.childExit.signal ?? 'null'})`;
        if (error.name === 'AbortError') return 'Aborted by user';
        if (error.method === 'thread/resume') return `Native resume failed: ${error.message}`;
        if (/operation not permitted|permission denied|system policy/i.test(error.message)) return `Codex could not access the workspace: ${error.message}`;
        if (/turn.*(?:active|in progress)|already.*turn/i.test(error.message)) return `Codex already has an active turn: ${error.message}`;
        return `Codex ${error.method} failed: ${error.message}`;
    }
    if (error instanceof Error && error.name === 'AbortError') return 'Aborted by user';
    return 'Codex request failed';
}

export function getCodexAppServerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const blockedPrefixes = ['ANTHROPIC_', 'CLAUDE_', 'AGY_', 'ANTIGRAVITY_', 'GOOGLE_', 'GEMINI_', 'GROK_', 'ARK_', 'VOLCENGINE_', 'HERMES_'];
    const blockedManaged = new Set([
        'HAPI_LAUNCH_NONCE', 'HAPI_RUNNER_INSTANCE_ID', 'HAPI_MANAGED_OUTCOME_FD',
        'HAPI_RESUME_PROFILE_FINGERPRINT', 'HAPI_EXPECTED_NATIVE_RESUME_ID'
    ]);
    return Object.entries(env).reduce((acc, [key, value]) => {
        if (blockedManaged.has(key) || blockedPrefixes.some((prefix) => key.startsWith(prefix))) return acc;
        if (typeof value === 'string') acc[key] = value;
        return acc;
    }, {} as Record<string, string>);
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

export function buildCodexAppServerArgs(
    env: Record<string, string | undefined> = process.env
): string[] {
    const args = ['app-server'];
    const rawAutoCompactLimit = env.HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT?.trim();

    if (!rawAutoCompactLimit) {
        return args;
    }

    const autoCompactLimit = Number(rawAutoCompactLimit);
    if (
        !Number.isSafeInteger(autoCompactLimit) ||
        autoCompactLimit <= 0 ||
        String(autoCompactLimit) !== rawAutoCompactLimit
    ) {
        throw new Error('HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT must be a positive integer');
    }

    args.push('-c', `model_auto_compact_token_limit=${autoCompactLimit}`);
    return args;
}

export class CodexAppServerClient {
    private process: ChildProcessWithoutNullStreams | null = null;
    private connected = false;
    private buffer = '';
    private nextId = 1;
    private readonly pending = new Map<number, PendingRequest>();
    private readonly requestHandlers = new Map<string, RequestHandler>();
    private notificationHandler: ((method: string, params: unknown) => void) | null = null;
    private protocolError: Error | null = null;

    static readonly DEFAULT_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;

    async connect(): Promise<void> {
        if (this.connected) {
            return;
        }

        this.process = spawn('codex', buildCodexAppServerArgs(), {
            env: getCodexAppServerEnv(process.env),
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: process.platform === 'win32'
        });

        this.process.stdout.setEncoding('utf8');
        this.process.stdout.on('data', (chunk) => this.handleStdout(chunk));

        this.process.stderr.setEncoding('utf8');
        this.process.stderr.on('data', (chunk) => {
            const text = chunk.toString().trim();
            if (text.length > 0) {
                logger.debug(`[CodexAppServer][stderr] ${Buffer.byteLength(text, 'utf8')} bytes suppressed`);
            }
        });

        this.process.on('exit', (code, signal) => {
            const message = `Codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
            logger.debug(message);
            this.rejectAllPending((pending) => new CodexAppServerError({
                method: pending.method,
                message,
                childExit: { code, signal },
                writeState: pending.writeState
            }));
            this.connected = false;
            this.resetParserState();
            this.process = null;
        });

        this.process.on('error', (error) => {
            logger.debug('[CodexAppServer] Process error', error);
            const message = error instanceof Error ? error.message : String(error);
            this.rejectAllPending((pending) => new CodexAppServerError({
                method: pending.method,
                message: `Failed to spawn codex app-server: ${message}. Is it installed and on PATH?`,
                writeState: pending.writeState,
                cause: error
            }));
            this.connected = false;
            this.resetParserState();
            this.process = null;
        });

        this.connected = true;
        logger.debug('[CodexAppServer] Connected');
    }

    setNotificationHandler(handler: ((method: string, params: unknown) => void) | null): void {
        this.notificationHandler = handler;
    }

    registerRequestHandler(method: string, handler: RequestHandler): void {
        this.requestHandlers.set(method, handler);
    }

    async initialize(params: InitializeParams): Promise<InitializeResponse> {
        const response = await this.sendRequest('initialize', params, { timeoutMs: 30_000 });
        this.sendNotification('initialized');
        return response as InitializeResponse;
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

    async startTurn(params: TurnStartParams, options?: { signal?: AbortSignal }): Promise<TurnStartResponse> {
        const response = await this.sendRequest('turn/start', params, {
            signal: options?.signal,
            timeoutMs: CodexAppServerClient.DEFAULT_TIMEOUT_MS
        });
        return response as TurnStartResponse;
    }

    async steerTurn(params: TurnSteerParams, options?: { signal?: AbortSignal }): Promise<TurnSteerResponse> {
        const response = await this.sendRequest('turn/steer', params, {
            signal: options?.signal,
            timeoutMs: CodexAppServerClient.DEFAULT_TIMEOUT_MS
        });
        const record = asRecord(response);
        if (!record || typeof record.turnId !== 'string' || record.turnId.length === 0) {
            throw new CodexAppServerError({
                method: 'turn/steer',
                message: 'Malformed turn steer response',
                writeState: 'written'
            });
        }
        return response as TurnSteerResponse;
    }

    async interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
        const response = await this.sendRequest('turn/interrupt', params, {
            timeoutMs: 30_000
        });
        return response as TurnInterruptResponse;
    }

    async compactThread(params: ThreadCompactStartParams, options?: { signal?: AbortSignal }): Promise<ThreadCompactStartResponse> {
        const response = await this.sendRequest('thread/compact/start', params, {
            signal: options?.signal,
            timeoutMs: CodexAppServerClient.DEFAULT_TIMEOUT_MS
        });
        return response as ThreadCompactStartResponse;
    }

    async getThreadGoal(params: ThreadGoalGetParams, options?: { signal?: AbortSignal }): Promise<ThreadGoalGetResponse> {
        const response = await this.sendRequest('thread/goal/get', params, {
            signal: options?.signal,
            timeoutMs: 30_000
        });
        return response as ThreadGoalGetResponse;
    }

    async setThreadGoal(params: ThreadGoalSetParams, options?: { signal?: AbortSignal }): Promise<ThreadGoalSetResponse> {
        const response = await this.sendRequest('thread/goal/set', params, {
            signal: options?.signal,
            timeoutMs: 30_000
        });
        return response as ThreadGoalSetResponse;
    }

    async clearThreadGoal(params: ThreadGoalClearParams, options?: { signal?: AbortSignal }): Promise<ThreadGoalClearResponse> {
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
            this.rejectAllPending((pending) => new CodexAppServerError({
                method: pending.method,
                message: 'Codex app-server disconnected',
                writeState: pending.writeState
            }));
            this.connected = false;
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
                const writeState = this.pending.get(id)?.writeState ?? 'not-written';
                this.pending.delete(id);
                cleanup();
                const error = new CodexAppServerError({ method, message: 'Request aborted', writeState });
                error.name = 'AbortError';
                reject(error);
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
                        reject(new CodexAppServerError({
                            method,
                            message: `Codex app-server request timed out after ${timeoutMs}ms`,
                            writeState: 'written'
                        }));
                    }
                }, timeoutMs);
                timeout.unref();
            }

            this.pending.set(id, {
                method,
                writeState: 'not-written',
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
            const pending = this.pending.get(id)!;
            try {
                this.writePayload(payload);
                pending.writeState = 'written';
            } catch (error) {
                this.pending.delete(id);
                cleanup();
                reject(new CodexAppServerError({ method, message: error instanceof Error ? error.message : String(error), writeState: 'not-written', cause: error }));
            }
        });
    }

    private sendNotification(method: string, params?: unknown): void {
        const payload: JsonRpcLiteNotification = { method, params };
        this.writePayload(payload);
    }

    private handleStdout(chunk: string): void {
        this.buffer += chunk;
        let newlineIndex = this.buffer.indexOf('\n');

        while (newlineIndex >= 0) {
            const line = this.buffer.slice(0, newlineIndex).trim();
            this.buffer = this.buffer.slice(newlineIndex + 1);

            if (line.length > 0) {
                this.handleLine(line);
            }

            newlineIndex = this.buffer.indexOf('\n');
        }
    }

    private handleLine(line: string): void {
        if (this.protocolError) {
            return;
        }

        let message: Record<string, unknown> | null = null;
        try {
            const parsed = JSON.parse(line);
            message = asRecord(parsed);
            if (!message) {
                logger.debug('[CodexAppServer] Ignoring non-object JSON from stdout', { bytes: Buffer.byteLength(line, 'utf8') });
                return;
            }
        } catch (error) {
            const protocolError = new Error('Failed to parse JSON from codex app-server');
            this.protocolError = protocolError;
            logger.debug('[CodexAppServer] Failed to parse JSON line', {
                bytes: Buffer.byteLength(line, 'utf8'),
                error: error instanceof Error ? error.message : 'unknown parse error'
            });
            this.rejectAllPending((pending) => new CodexAppServerError({
                method: pending.method,
                message: protocolError.message,
                writeState: pending.writeState,
                cause: error
            }));
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
            pending.reject(new CodexAppServerError({
                method: pending.method,
                message: response.error.message,
                code: response.error.code,
                data: response.error.data,
                writeState: pending.writeState
            }));
            return;
        }

        pending.resolve(response.result);
    }

    private writePayload(payload: JsonRpcLiteRequest | JsonRpcLiteNotification | JsonRpcLiteResponse): void {
        const serialized = JSON.stringify(payload);
        this.process?.stdin.write(`${serialized}\n`);
    }

    private resetParserState(): void {
        this.buffer = '';
        this.protocolError = null;
    }

    private rejectAllPending(error: Error | ((pending: PendingRequest) => Error)): void {
        for (const pending of this.pending.values()) {
            const { reject, cleanup } = pending;
            cleanup();
            reject(typeof error === 'function' ? error(pending) : error);
        }
        this.pending.clear();
    }
}
