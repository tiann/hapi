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
    TurnInterruptParams,
    TurnInterruptResponse
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

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function createAbortError(): Error {
    const error = new Error('Request aborted');
    error.name = 'AbortError';
    return error;
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

        this.process = spawn('codex', ['app-server'], {
            env: Object.keys(process.env).reduce((acc, key) => {
                const value = process.env[key];
                if (typeof value === 'string') acc[key] = value;
                return acc;
            }, {} as Record<string, string>),
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
            windowsHide: true
        });

        this.process.stdout.setEncoding('utf8');
        this.process.stdout.on('data', (chunk) => this.handleStdout(chunk));

        this.process.stderr.setEncoding('utf8');
        this.process.stderr.on('data', (chunk) => {
            const text = chunk.toString().trim();
            if (text.length > 0) {
                logger.debug(`[CodexAppServer][stderr] ${text}`);
            }
        });

        this.process.on('exit', (code, signal) => {
            const message = `Codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
            logger.debug(message);
            this.rejectAllPending(new Error(message));
            this.connected = false;
            this.resetParserState();
            this.process = null;
        });

        this.process.on('error', (error) => {
            logger.debug('[CodexAppServer] Process error', error);
            const message = error instanceof Error ? error.message : String(error);
            this.rejectAllPending(new Error(
                `Failed to spawn codex app-server: ${message}. Is it installed and on PATH?`,
                { cause: error }
            ));
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

    async interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
        const response = await this.sendRequest('turn/interrupt', params, {
            timeoutMs: 30_000
        });
        return response as TurnInterruptResponse;
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
                reject(createAbortError());
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
                        reject(new Error(`Codex app-server request '${method}' timed out after ${timeoutMs}ms`));
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
        this.process?.stdin.write(`${serialized}\n`);
    }

    private resetParserState(): void {
        this.buffer = '';
        this.protocolError = null;
    }

    private rejectAllPending(error: Error): void {
        for (const { reject, cleanup } of this.pending.values()) {
            cleanup();
            reject(error);
        }
        this.pending.clear();
    }
}
