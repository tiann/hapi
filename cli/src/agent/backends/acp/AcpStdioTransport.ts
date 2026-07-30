import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { logger } from '@/ui/logger';
import { killProcessByChildProcess } from '@/utils/process';
import { GEMINI_MODEL_PRESETS } from '@hapi/protocol';
import { registerActiveAcpTransport, unregisterActiveAcpTransport } from './agentCliGuard';

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: string | number | null;
    method: string;
    params?: unknown;
}

interface JsonRpcNotification {
    jsonrpc: '2.0';
    method: string;
    params?: unknown;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: string | number | null;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}

type RequestHandler = (params: unknown, requestId: string | number | null) => Promise<unknown>;

export type AcpStderrErrorType = 'rate_limit' | 'model_not_found' | 'authentication' | 'quota_exceeded' | 'unknown';

export type AcpStderrError = {
    type: AcpStderrErrorType;
    message: string;
    raw: string;
};

/** @internal Exported for regression tests. */
export function buildAcpStdioSpawnOptions(env?: Record<string, string>): SpawnOptions {
    return {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        windowsHide: process.platform === 'win32'
    };
}

export class AcpStdioTransport {
    /** Only Cursor's `agent` CLI is single-process; other ACP backends must not block model probes. */
    private readonly shouldGuardAgentCli: boolean;
    private readonly process: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<string | number, {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
    }>();
    private readonly requestHandlers = new Map<string, RequestHandler>();
    private notificationHandler: ((method: string, params: unknown) => void) | null = null;
    private stderrErrorHandler: ((error: AcpStderrError) => void) | null = null;
    private buffer = '';
    private recentStderr = '';
    private emittedModelRejection = false;
    private nextId = 1;
    private protocolError: Error | null = null;
    private guardReleased = false;
    private closed = false;
    private closeError: Error | null = null;
    /** True after process 'exit'; blocks new writes until 'close' drains stderr. */
    private exited = false;
    private exitError: Error | null = null;

    /** Rolling join window for stderr before close-time classification. */
    private static readonly RECENT_STDERR_WINDOW = 8_000;
    /** Max stderr attached to the close Error (prefer model-rejection head). */
    private static readonly CLOSE_STDERR_CAP = 4_000;

    constructor(options: {
        command: string;
        args?: string[];
        env?: Record<string, string>;
    }) {
        this.shouldGuardAgentCli = options.command === 'agent';
        this.process = spawn(
            options.command,
            options.args ?? [],
            buildAcpStdioSpawnOptions(options.env)
        ) as ChildProcessWithoutNullStreams;

        if (this.shouldGuardAgentCli) {
            registerActiveAcpTransport();
        }

        this.process.stdout.setEncoding('utf8');
        this.process.stdout.on('data', (chunk) => this.handleStdout(chunk));

        this.process.stderr.setEncoding('utf8');
        this.process.stderr.on('data', (chunk) => {
            // Chunks are arbitrary byte slices — concatenate raw, do not inject
            // separators (a mid-word split would otherwise break keyword match).
            const raw = chunk.toString();
            if (raw) {
                const next = this.recentStderr + raw;
                const matchIdx = next.search(/Cannot use this model:/i);
                if (matchIdx >= 0) {
                    // Pin from the rejection head so a long Available models catalog
                    // cannot roll `Cannot use this model: <id>` out of the window.
                    const modelStderr = next.slice(matchIdx);
                    this.recentStderr = modelStderr.length > AcpStdioTransport.RECENT_STDERR_WINDOW
                        ? modelStderr.slice(0, AcpStdioTransport.RECENT_STDERR_WINDOW)
                        : modelStderr;
                } else {
                    this.recentStderr = next.length > AcpStdioTransport.RECENT_STDERR_WINDOW
                        ? next.slice(-AcpStdioTransport.RECENT_STDERR_WINDOW)
                        : next;
                }
            }
            const text = raw.trim();
            logger.debug(`[ACP][stderr] ${text}`);
            this.parseStderrError(text);
            // If this chunk alone missed a split keyword/id, retry against the window.
            if (
                text
                && !/Cannot use this model:\s*\S/i.test(text)
                && /Cannot use this model:\s*\S/i.test(this.recentStderr)
            ) {
                this.parseStderrError(this.stderrForCloseError() ?? this.recentStderr);
            }
        });

        // Block new stdin writes as soon as the process exits, but defer markClosed
        // until 'close' so final stderr chunks can still enrich the failure.
        this.process.on('exit', (code, signal) => {
            this.releaseAgentCliGuard();
            this.exited = true;
            this.exitError = new Error(
                `ACP process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
            );
        });

        // Use 'close' (not only 'exit') so final stderr chunks are drained before we
        // classify the failure — Node may fire 'exit' before the last stderr 'data'.
        this.process.on('close', (code, signal) => {
            this.releaseAgentCliGuard();
            const stderr = this.stderrForCloseError();
            let message = `ACP process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
            if (stderr) {
                message = `${message}. stderr: ${stderr}`;
            }
            logger.debug(message);
            const error = new Error(message);
            if (stderr) {
                (error as Error & { stderr?: string }).stderr = stderr;
            }
            this.markClosed(error);
        });

        this.process.on('error', (error) => {
            this.releaseAgentCliGuard();
            logger.debug('[ACP] Process error', error);
            const message = error instanceof Error ? error.message : String(error);
            this.markClosed(new Error(
                `Failed to spawn ${options.command}: ${message}. Is it installed and on PATH?`,
                { cause: error }
            ));
        });
    }

    onNotification(handler: ((method: string, params: unknown) => void) | null): void {
        this.notificationHandler = handler;
    }

    onStderrError(handler: ((error: AcpStderrError) => void) | null): void {
        this.stderrErrorHandler = handler;
    }

    registerRequestHandler(method: string, handler: RequestHandler): void {
        this.requestHandlers.set(method, handler);
    }

    /** Default timeout for requests in milliseconds (2 minutes) */
    static readonly DEFAULT_TIMEOUT_MS = 120_000;

    async sendRequest(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown> {
        if (this.closed || this.exited) {
            return Promise.reject(
                this.closeError ?? this.exitError ?? new Error('ACP transport is closed')
            );
        }

        const id = this.nextId++;
        const payload: JsonRpcRequest = {
            jsonrpc: '2.0',
            id,
            method,
            params
        };

        const timeoutMs = options?.timeoutMs ?? AcpStdioTransport.DEFAULT_TIMEOUT_MS;

        // Skip timeout for infinite/no-timeout requests (e.g., long-running prompts)
        if (!Number.isFinite(timeoutMs)) {
            return new Promise<unknown>((resolve, reject) => {
                this.pending.set(id, { resolve, reject });
                this.writePayload(payload);
            });
        }

        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`ACP request '${method}' timed out after ${timeoutMs}ms`));
                }
            }, timeoutMs);
            // Don't let timer keep Node alive if process wants to exit
            timer.unref();

            this.pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                }
            });
            this.writePayload(payload);
        });
    }

    sendNotification(method: string, params?: unknown): void {
        if (this.closed || this.exited) {
            return;
        }

        const payload: JsonRpcNotification = {
            jsonrpc: '2.0',
            method,
            params
        };
        this.writePayload(payload);
    }

    async close(): Promise<void> {
        this.process.stdin.end();
        await killProcessByChildProcess(this.process);
        this.releaseAgentCliGuard();
        this.markClosed(new Error('ACP transport closed'));
    }

    private releaseAgentCliGuard(): void {
        if (!this.shouldGuardAgentCli || this.guardReleased) {
            return;
        }
        this.guardReleased = true;
        unregisterActiveAcpTransport();
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
        let message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification | null = null;
        try {
            const parsed = JSON.parse(line);
            // Validate JSON is an object (not primitive types like numbers/strings/booleans)
            // Gemini CLI may output non-JSON-RPC data (e.g., numeric IDs) that would break protocol
            if (typeof parsed !== 'object' || parsed === null) {
                logger.debug('[ACP] Ignoring non-object JSON from stdout', { line });
                return;
            }
            message = parsed as JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
        } catch (error) {
            const protocolError = new Error('Failed to parse JSON-RPC from ACP agent');
            this.protocolError = protocolError;
            logger.debug('[ACP] Failed to parse JSON-RPC line', { line, error });
            this.rejectAllPending(protocolError);
            this.process.stdin.end();
            void killProcessByChildProcess(this.process);
            return;
        }

        if (message && 'method' in message) {
            if ('id' in message && message.id !== undefined) {
                this.handleIncomingRequest(message as JsonRpcRequest).catch((error) => {
                    logger.debug('[ACP] Error handling request', error);
                });
                return;
            }
            this.notificationHandler?.(message.method, message.params ?? null);
            return;
        }

        if (message && 'id' in message) {
            this.handleResponse(message as JsonRpcResponse);
        }
    }

    private async handleIncomingRequest(request: JsonRpcRequest): Promise<void> {
        const handler = this.requestHandlers.get(request.method);
        if (!handler) {
            this.writePayload({
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: -32601,
                    message: `Method not found: ${request.method}`
                }
            } satisfies JsonRpcResponse);
            return;
        }

        try {
            const result = await handler(request.params ?? null, request.id ?? null);
            this.writePayload({
                jsonrpc: '2.0',
                id: request.id,
                result
            } satisfies JsonRpcResponse);
        } catch (error) {
            this.writePayload({
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: -32603,
                    message: error instanceof Error ? error.message : 'Internal error'
                }
            } satisfies JsonRpcResponse);
        }
    }

    private handleResponse(response: JsonRpcResponse): void {
        if (response.id === null || response.id === undefined) {
            logger.debug('[ACP] Received response without id');
            return;
        }

        const pending = this.pending.get(response.id);
        if (!pending) {
            logger.debug('[ACP] Received response with no pending request', response.id);
            return;
        }

        this.pending.delete(response.id);

        if (response.error) {
            pending.reject(new Error(response.error.message));
            return;
        }

        pending.resolve(response.result);
    }

    private writePayload(payload: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
        if (this.closed) {
            return;
        }

        try {
            const serialized = JSON.stringify(payload);
            this.process.stdin.write(`${serialized}\n`);
        } catch (error) {
            const writeError = error instanceof Error ? error : new Error(String(error));
            this.markClosed(writeError);
        }
    }

    private markClosed(error: Error): void {
        if (this.closed) {
            return;
        }

        this.closed = true;
        this.closeError = error;
        this.rejectAllPending(error);
    }

    private rejectAllPending(error: Error): void {
        for (const { reject } of this.pending.values()) {
            reject(error);
        }
        this.pending.clear();
    }

    /**
     * Prefer Cursor model-rejection text when present in the rolling stderr window.
     * Cap from the match start so `Cannot use this model: <id>` survives long catalogs.
     */
    private stderrForCloseError(): string | null {
        if (!this.recentStderr) {
            return null;
        }
        const matchIdx = this.recentStderr.search(/Cannot use this model:/i);
        const source = matchIdx >= 0
            ? this.recentStderr.slice(matchIdx).trim()
            : this.recentStderr.trim();
        if (!source) {
            return null;
        }
        return source.length > AcpStdioTransport.CLOSE_STDERR_CAP
            ? source.slice(0, AcpStdioTransport.CLOSE_STDERR_CAP)
            : source;
    }

    private parseStderrError(text: string): void {
        if (!this.stderrErrorHandler) {
            return;
        }

        const lowerText = text.toLowerCase();

        // Cursor rejects `--model` / config ids with this exact stderr shape.
        // Require at least one non-space after the colon so a split before the
        // model id does not emit a partial line and suppress the completed one.
        // Pass the agent text through (including any Available models hint); do not
        // invent a Gemini-style catalog here.
        const modelRejection = text.match(/Cannot use this model:\s*\S[\s\S]*/i);
        if (modelRejection) {
            if (this.emittedModelRejection) {
                return;
            }
            const message = modelRejection[0].trim();
            this.emittedModelRejection = true;
            this.stderrErrorHandler({
                type: 'model_not_found',
                message,
                raw: message
            });
            return;
        }

        // Rate limit errors (429)
        if (lowerText.includes('status 429') || lowerText.includes('ratelimitexceeded') || lowerText.includes('rate limit')) {
            this.stderrErrorHandler({
                type: 'rate_limit',
                message: 'Rate limit exceeded. Please wait before sending more requests.',
                raw: text
            });
            return;
        }

        // Model not found errors (404)
        if (lowerText.includes('status 404') || lowerText.includes('model not found') || lowerText.includes('not_found')) {
            this.stderrErrorHandler({
                type: 'model_not_found',
                message: `Model not found. Available models: ${GEMINI_MODEL_PRESETS.join(', ')}`,
                raw: text
            });
            return;
        }

        // Authentication errors (401/403)
        if (lowerText.includes('status 401') || lowerText.includes('status 403') ||
            lowerText.includes('unauthenticated') || lowerText.includes('permission denied') ||
            lowerText.includes('authentication')) {
            this.stderrErrorHandler({
                type: 'authentication',
                message: 'Authentication failed. Please check your credentials or run "gemini auth login".',
                raw: text
            });
            return;
        }

        // Quota exceeded
        if (lowerText.includes('quota') || lowerText.includes('resource exhausted') || lowerText.includes('resourceexhausted')) {
            this.stderrErrorHandler({
                type: 'quota_exceeded',
                message: 'API quota exceeded. Please check your billing or wait for quota reset.',
                raw: text
            });
            return;
        }

        // Only report as unknown if it looks like an actual error
        if (lowerText.includes('error') || lowerText.includes('failed') || lowerText.includes('exception')) {
            this.stderrErrorHandler({
                type: 'unknown',
                message: text,
                raw: text
            });
        }
    }
}
