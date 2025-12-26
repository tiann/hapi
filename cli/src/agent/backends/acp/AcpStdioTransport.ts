import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from '@/ui/logger';
import { killProcessByChildProcess } from '@/utils/process';

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

export class AcpStdioTransport {
    private readonly process: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<string | number, {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
    }>();
    private readonly requestHandlers = new Map<string, RequestHandler>();
    private notificationHandler: ((method: string, params: unknown) => void) | null = null;
    private buffer = '';
    private nextId = 1;
    private protocolError: Error | null = null;

    constructor(options: {
        command: string;
        args?: string[];
        env?: Record<string, string>;
    }) {
        this.process = spawn(options.command, options.args ?? [], {
            env: options.env,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        this.process.stdout.setEncoding('utf8');
        this.process.stdout.on('data', (chunk) => this.handleStdout(chunk));

        this.process.stderr.setEncoding('utf8');
        this.process.stderr.on('data', (chunk) => {
            logger.debug(`[ACP][stderr] ${chunk.toString().trim()}`);
        });

        this.process.on('exit', (code, signal) => {
            const message = `ACP process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
            logger.debug(message);
            this.rejectAllPending(new Error(message));
        });

        this.process.on('error', (error) => {
            logger.debug('[ACP] Process error', error);
            const message = error instanceof Error ? error.message : String(error);
            this.rejectAllPending(new Error(
                `Failed to spawn ${options.command}: ${message}. Is it installed and on PATH?`,
                { cause: error }
            ));
        });
    }

    onNotification(handler: ((method: string, params: unknown) => void) | null): void {
        this.notificationHandler = handler;
    }

    registerRequestHandler(method: string, handler: RequestHandler): void {
        this.requestHandlers.set(method, handler);
    }

    async sendRequest(method: string, params?: unknown): Promise<unknown> {
        const id = this.nextId++;
        const payload: JsonRpcRequest = {
            jsonrpc: '2.0',
            id,
            method,
            params
        };

        return new Promise<unknown>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.writePayload(payload);
        });
    }

    sendNotification(method: string, params?: unknown): void {
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
        this.rejectAllPending(new Error('ACP transport closed'));
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
            message = JSON.parse(line) as JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
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
        const serialized = JSON.stringify(payload);
        this.process.stdin.write(`${serialized}\n`);
    }

    private rejectAllPending(error: Error): void {
        for (const { reject } of this.pending.values()) {
            reject(error);
        }
        this.pending.clear();
    }
}
