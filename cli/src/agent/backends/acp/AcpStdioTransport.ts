import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import {
    acquireAgentCliSpawnLease,
    releaseAgentCliSpawnLeaseFromAcpRegisterSync
} from '@hapi/protocol/agentCliSpawnLease';
import { resolveHapiHomeDir } from '@/configuration';
import { logger } from '@/ui/logger';
import { killProcessByChildProcess } from '@/utils/process';
import { GEMINI_MODEL_PRESETS } from '@hapi/protocol';
import {
    describeAgentAcpGuardState,
    getAgentAcpLockDir,
    recordActiveAcpChildPid,
    registerActiveAcpTransport,
    unregisterActiveAcpTransport
} from './agentCliGuard';
import { matchesAcpHttp2Cancel, matchesAcpRetryBackoff } from './acpStderrErrors';

/** Marks transport-level failures whose request outcome is unknown (unlike an
 * explicit JSON-RPC error response). */
export const ACP_INDETERMINATE_SYMBOL = Symbol('acp-indeterminate');

function markAcpIndeterminate(error: Error): Error {
    Object.defineProperty(error, ACP_INDETERMINATE_SYMBOL, { value: true });
    return error;
}

export function isAcpIndeterminateError(error: unknown): boolean {
    return typeof error === 'object' && error !== null
        && (error as Record<symbol, unknown>)[ACP_INDETERMINATE_SYMBOL] === true;
}

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
    private readonly command: string;
    private readonly process: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<string | number, {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        rejectDispatched: (error: Error) => void;
    }>();
    private readonly requestHandlers = new Map<string, RequestHandler>();
    private notificationHandler: ((method: string, params: unknown) => void) | null = null;
    private stderrErrorHandler: ((error: AcpStderrError) => void) | null = null;
    private buffer = '';
    private recentStderr = '';
    private stderrParseBuffer = '';
    private stderrPartialErrorReported = false;
    private emittedModelRejection = false;
    private nextId = 1;
    private protocolError: Error | null = null;
    private guardReleased = false;
    private closed = false;
    private closeError: Error | null = null;
    /** True after process 'exit'; blocks new writes until 'close' drains stderr. */
    private exited = false;
    private exitError: Error | null = null;
    /** ACP child PID when known (for lock attribution / exit logs). */
    private childPid: number | null = null;

    /** Rolling join window for stderr before close-time classification. */
    private static readonly RECENT_STDERR_WINDOW = 8_000;
    /** Max stderr attached to the close Error (prefer model-rejection head). */
    private static readonly CLOSE_STDERR_CAP = 4_000;

    static async create(options: {
        command: string;
        args?: string[];
        env?: Record<string, string>;
    }): Promise<AcpStdioTransport> {
        const shouldGuardAgentCli = options.command === 'agent';
        if (shouldGuardAgentCli) {
            await acquireAgentCliSpawnLease(resolveHapiHomeDir());
            try {
                registerActiveAcpTransport();
                try {
                    const process = spawn(
                        options.command,
                        options.args ?? [],
                        buildAcpStdioSpawnOptions(options.env)
                    ) as ChildProcessWithoutNullStreams;
                    return new AcpStdioTransport(process, true, options.command);
                } catch (error) {
                    unregisterActiveAcpTransport();
                    throw error;
                }
            } finally {
                releaseAgentCliSpawnLeaseFromAcpRegisterSync();
            }
        }

        const process = spawn(
            options.command,
            options.args ?? [],
            buildAcpStdioSpawnOptions(options.env)
        ) as ChildProcessWithoutNullStreams;
        return new AcpStdioTransport(process, false, options.command);
    }

    private constructor(process: ChildProcessWithoutNullStreams, shouldGuardAgentCli: boolean, command: string) {
        this.shouldGuardAgentCli = shouldGuardAgentCli;
        this.command = command;
        this.process = process;

        if (this.shouldGuardAgentCli) {
            const childPid = typeof this.process.pid === 'number' ? this.process.pid : null;
            this.childPid = childPid;
            if (childPid !== null) {
                recordActiveAcpChildPid(childPid);
            }
            logger.debug('[ACP] agent CLI guard armed', describeAgentAcpGuardState(childPid));
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
            this.parseStderrRecords(raw);
            this.flushActionableStderrTail();
            this.stderrParseBuffer = this.stderrParseBuffer.slice(-AcpStdioTransport.RECENT_STDERR_WINDOW);
        });

        // Block new stdin writes as soon as the process exits, but defer markClosed
        // until 'close' so final stderr chunks can still enrich the failure.
        // Do NOT release the agent CLI guard here — exit→close is exactly when
        // list-models can race another `agent` and SIGTERM remaining ACP children.
        this.process.on('exit', (code, signal) => {
            this.exited = true;
            const attribution = this.formatExitAttribution(code, signal);
            const guardState = describeAgentAcpGuardState(this.childPid);
            logger.debug(`[ACP] process exit ${attribution}`, guardState);
            if (guardState.childAlive === true) {
                // Node reported exit, but the recorded ACP PID is still alive —
                // likely a Cursor-internal worker/stdio quirk. Do not claim a
                // definitive process death in the error string operators grep.
                this.exitError = new Error(
                    `ACP transport reported exit (${attribution}) but OS PID ${this.childPid} is still alive ` +
                    `(lock=${getAgentAcpLockDir()}); treating as transport disruption, not confirmed child death`
                );
            } else {
                this.exitError = new Error(`ACP process exited (${attribution})`);
            }
        });

        // Use 'close' (not only 'exit') so final stderr chunks are drained before we
        // classify the failure — Node may fire 'exit' before the last stderr 'data'.
        this.process.on('close', (code, signal) => {
            this.releaseAgentCliGuard();
            this.flushStderrParseBuffer();
            const attribution = this.formatExitAttribution(code, signal);
            const guardState = describeAgentAcpGuardState(this.childPid);
            const stderr = this.stderrForCloseError();
            let message = guardState.childAlive === true
                ? `ACP transport closed (${attribution}) but OS PID ${this.childPid} is still alive ` +
                  `(lock=${getAgentAcpLockDir()})`
                : `ACP process exited (${attribution})`;
            if (stderr) {
                message = `${message}. stderr: ${stderr}`;
            }
            logger.debug(message, guardState);
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
                `Failed to spawn ${this.command}: ${message}. Is it installed and on PATH?`,
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

    async sendRequest(method: string, params?: unknown, options?: { timeoutMs?: number; dispatchTimeoutMs?: number }): Promise<unknown> {
        const request = this.sendRequestWithDispatch(method, params, options);
        void request.dispatched.catch(() => {});
        return request.completed;
    }

    /**
     * Split a request into transport dispatch (stdin accepted) and completion
     * (JSON-RPC response). Lets callers commit state once stdin accepted the
     * request without waiting for the (possibly long-running) response.
     */
    sendRequestWithDispatch(
        method: string,
        params?: unknown,
        options?: { timeoutMs?: number; dispatchTimeoutMs?: number }
    ): { dispatched: Promise<void>; completed: Promise<unknown> } {
        if (this.closed || this.exited) {
            const error = markAcpIndeterminate(this.closeError ?? this.exitError ?? new Error('ACP transport is closed'));
            return { dispatched: Promise.reject(error), completed: Promise.reject(error) };
        }

        const id = this.nextId++;
        const payload: JsonRpcRequest = {
            jsonrpc: '2.0',
            id,
            method,
            params
        };

        const timeoutMs = options?.timeoutMs ?? AcpStdioTransport.DEFAULT_TIMEOUT_MS;
        const dispatchTimeoutMs = options?.dispatchTimeoutMs ?? timeoutMs;

        let timer: ReturnType<typeof setTimeout> | null = null;
        let dispatchTimer: ReturnType<typeof setTimeout> | null = null;
        let resolveDispatched!: () => void;
        let rejectDispatched!: (error: Error) => void;
        let resolveCompleted!: (value: unknown) => void;
        let rejectCompleted!: (error: Error) => void;
        const dispatched = new Promise<void>((resolve, reject) => {
            resolveDispatched = resolve;
            rejectDispatched = reject;
        });
        const completed = new Promise<unknown>((resolve, reject) => {
            resolveCompleted = resolve;
            rejectCompleted = reject;
        });
        let dispatchSettled = false;

        const clearTimers = () => {
            if (timer) clearTimeout(timer);
            if (dispatchTimer) clearTimeout(dispatchTimer);
        };
        const failRequest = (error: Error) => {
            this.pending.delete(id);
            clearTimers();
            if (!dispatchSettled) {
                dispatchSettled = true;
                rejectDispatched(error);
            }
            rejectCompleted(error);
        };
        if (Number.isFinite(timeoutMs)) {
            timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    failRequest(markAcpIndeterminate(new Error(`ACP request '${method}' timed out after ${timeoutMs}ms`)));
                }
            }, timeoutMs);
            timer.unref();
        }
        if (Number.isFinite(dispatchTimeoutMs)) {
            dispatchTimer = setTimeout(() => {
                if (this.pending.has(id) && !dispatchSettled) {
                    const error = markAcpIndeterminate(new Error(`ACP request '${method}' dispatch timed out after ${dispatchTimeoutMs}ms`));
                    try {
                        this.process.stdin.destroy();
                    } catch (destroyError) {
                        logger.debug('[ACP] Error destroying stalled stdin', destroyError);
                    }
                    this.markClosed(error);
                }
            }, dispatchTimeoutMs);
            dispatchTimer.unref();
        }

        this.pending.set(id, {
            resolve: (value) => {
                clearTimers();
                if (!dispatchSettled) {
                    dispatchSettled = true;
                    resolveDispatched();
                }
                resolveCompleted(value);
            },
            reject: (error) => {
                clearTimers();
                if (!dispatchSettled) {
                    dispatchSettled = true;
                    resolveDispatched();
                }
                rejectCompleted(error);
            },
            rejectDispatched: (error) => {
                if (!dispatchSettled) {
                    dispatchSettled = true;
                    rejectDispatched(error);
                }
            }
        });

        try {
            const serialized = JSON.stringify(payload);
            this.process.stdin.write(`${serialized}\n`, (error) => {
                if (error) {
                    const writeError = markAcpIndeterminate(error instanceof Error ? error : new Error(String(error)));
                    this.markClosed(writeError);
                    failRequest(writeError);
                    return;
                }
                if (!dispatchSettled) {
                    dispatchSettled = true;
                    if (dispatchTimer) clearTimeout(dispatchTimer);
                    resolveDispatched();
                }
            });
        } catch (error) {
            const writeError = error instanceof Error ? error : new Error(String(error));
            this.markClosed(writeError);
            failRequest(writeError);
        }

        return { dispatched, completed };
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

    private formatExitAttribution(code: number | null, signal: NodeJS.Signals | null): string {
        const base = `code=${code ?? 'null'}, signal=${signal ?? 'null'}`;
        if (!this.shouldGuardAgentCli) {
            return base;
        }
        const child = this.childPid ?? this.process.pid ?? 'unknown';
        return `${base}, childPid=${child}, lock=${getAgentAcpLockDir()}`;
    }

    private releaseAgentCliGuard(): void {
        if (!this.shouldGuardAgentCli || this.guardReleased) {
            return;
        }
        this.guardReleased = true;
        unregisterActiveAcpTransport(
            this.childPid !== null ? { childPid: this.childPid } : undefined
        );
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
            // Cursor `--worktree` prints `Using worktree: …` on stdout before ACP
            // JSON-RPC. Only that known banner is noise; other parse failures stay fatal
            // so pending requests (incl. session/prompt with infinite timeout) fail fast.
            if (this.shouldGuardAgentCli && line.startsWith('Using worktree:')) {
                logger.debug('[ACP] Ignoring Cursor worktree stdout banner', { line });
                return;
            }

            const protocolError = new Error('Failed to parse JSON-RPC from ACP agent');
            this.protocolError = protocolError;
            logger.debug('[ACP] Failed to parse JSON-RPC line', { line, error });
            this.markClosed(protocolError);
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
        const indeterminate = markAcpIndeterminate(error);
        for (const { reject, rejectDispatched } of this.pending.values()) {
            rejectDispatched(indeterminate);
            reject(indeterminate);
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

    private parseStderrRecords(raw: string): void {
        const lines = (this.stderrParseBuffer + raw).split(/\r\n|[\r\n]/);
        this.stderrParseBuffer = lines.pop() ?? '';
        for (const line of lines) {
            const text = line.trim();
            if (text) {
                this.parseStderrError(text, true);
                this.stderrPartialErrorReported = false;
            }
        }
    }

    private flushActionableStderrTail(): void {
        const pending = this.stderrParseBuffer.trim();
        if (pending && this.parseStderrError(pending) === 'reported-complete') {
            this.stderrParseBuffer = '';
            this.stderrPartialErrorReported = false;
        }
    }

    private flushStderrParseBuffer(): void {
        const text = this.stderrParseBuffer.trim();
        this.stderrParseBuffer = '';
        if (text) {
            this.parseStderrError(text, true);
        }
        this.stderrPartialErrorReported = false;
    }

    private parseStderrError(
        text: string,
        completeRecord = false
    ): 'none' | 'reported-partial' | 'reported-complete' {
        if (!this.stderrErrorHandler) {
            return 'none';
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
                return 'reported-complete';
            }
            const message = modelRejection[0].trim();
            this.emittedModelRejection = true;
            this.stderrErrorHandler({
                type: 'model_not_found',
                message,
                raw: message
            });
            return 'reported-complete';
        }

        // Rate limit errors (429)
        if (lowerText.includes('status 429') || lowerText.includes('ratelimitexceeded') || lowerText.includes('rate limit')) {
            this.stderrErrorHandler({
                type: 'rate_limit',
                message: 'Rate limit exceeded. Please wait before sending more requests.',
                raw: text
            });
            return 'reported-complete';
        }

        // Model not found errors (404)
        if (lowerText.includes('status 404') || lowerText.includes('model not found') || lowerText.includes('not_found')) {
            this.stderrErrorHandler({
                type: 'model_not_found',
                message: `Model not found. Available models: ${GEMINI_MODEL_PRESETS.join(', ')}`,
                raw: text
            });
            return 'reported-complete';
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
            return 'reported-complete';
        }

        // Quota exceeded
        if (lowerText.includes('quota') || lowerText.includes('resource exhausted') || lowerText.includes('resourceexhausted')) {
            this.stderrErrorHandler({
                type: 'quota_exceeded',
                message: 'API quota exceeded. Please check your billing or wait for quota reset.',
                raw: text
            });
            return 'reported-complete';
        }

        if (matchesAcpRetryBackoff(text)) {
            this.stderrErrorHandler({
                type: 'unknown',
                message: 'The ACP agent is retrying after an upstream failure. The turn may be stalled.',
                raw: text
            });
            return 'reported-complete';
        }

        if (matchesAcpHttp2Cancel(text)) {
            this.stderrErrorHandler({
                type: 'unknown',
                message: 'Upstream request was cancelled. The agent may be retrying or stalled.',
                raw: text
            });
            return 'reported-complete';
        }

        // Keep cancellation errors buffered until a later chunk can classify them.
        if (lowerText.includes('canceled') && !completeRecord) {
            return 'none';
        }

        // Only report as unknown if it looks like an actual error
        if (lowerText.includes('error') || lowerText.includes('failed') || lowerText.includes('exception')) {
            if (!this.stderrPartialErrorReported) {
                this.stderrPartialErrorReported = true;
                this.stderrErrorHandler({
                    type: 'unknown',
                    message: text,
                    raw: text
                });
            }
            return 'reported-partial';
        }
        return 'none';
    }
}
