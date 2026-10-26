import { createServer } from 'node:http';
import { chmod, unlink } from 'node:fs/promises';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { z } from 'zod';

export const EnvelopeSchema = z.object({
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(), params: z.unknown().optional(),
    result: z.unknown().optional(), error: z.unknown().optional()
}).passthrough();
export type Envelope = z.infer<typeof EnvelopeSchema>;
export function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function string(value: unknown): string | undefined { return typeof value === 'string' && value.length ? value : undefined; }
export function socketUrl(endpoint: string): string {
    return endpoint.startsWith('unix://') ? `ws+unix://${endpoint.slice(7)}:/` : endpoint;
}

export type GatewayHooks = {
    before(request: Envelope, connectionId: string): Promise<Envelope>;
    after(request: Envelope, response: Envelope, connectionId: string): Promise<void | Envelope[]>;
    disconnected?(connectionId: string): void;
    control(method: string, params: unknown): Promise<unknown>;
};

/** Byte-preserving for normal traffic; only lifecycle requests have a binding barrier. */
export async function startCodexGateway(options: {
    upstream: string; upstreamToken?: string; path?: string; token: string; hooks: GatewayHooks;
}): Promise<{ endpoint: string; close(): Promise<void> }> {
    const server = createServer((_request, response) => { response.writeHead(404).end(); });
    const websocket = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    const connections = new Map<WebSocket, WebSocket>();
    server.on('upgrade', (request, socket, head) => {
        if (!options.path) {
            const provided = Buffer.from(request.headers.authorization ?? '');
            const expected = Buffer.from(`Bearer ${options.token}`);
            if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
                socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                return;
            }
        }
        websocket.handleUpgrade(request, socket, head, client => websocket.emit('connection', client));
    });
    websocket.on('connection', downstream => {
        const connectionId = randomUUID();
        const upstream = new WebSocket(socketUrl(options.upstream), {
            headers: { Host: 'localhost', ...(options.upstreamToken ? { Authorization: `Bearer ${options.upstreamToken}` } : {}) },
            handshakeTimeout: 10_000, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false
        });
        connections.set(downstream, upstream);
        const pending = new Map<string | number, Envelope>();
        const ready = new Promise<void>((resolve, reject) => { upstream.once('open', resolve); upstream.once('error', reject); });
        void ready.catch(() => downstream.close(1011, 'Codex unavailable'));
        let detached = false;
        let finished = false;
        let processing = 0;
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        let incoming = Promise.resolve();
        let outgoing = Promise.resolve();
        const finish = () => {
            if (finished) return;
            finished = true; clearTimeout(drainTimer);
            connections.delete(downstream); upstream.close();
            options.hooks.disconnected?.(connectionId);
        };
        const drained = () => { if (detached && processing === 0 && pending.size === 0) finish(); };
        const send = (target: WebSocket, value: Envelope) => {
            if (target.readyState === WebSocket.OPEN) target.send(JSON.stringify(value));
        };
        downstream.on('message', raw => {
            let message: Envelope;
            try { message = EnvelopeSchema.parse(JSON.parse(raw.toString())); }
            catch { downstream.close(1007, 'Invalid JSON-RPC'); return; }
            // Answers must bypass the lifecycle barrier (initialization itself may elicit input).
            if (!message.method) { void ready.then(() => send(upstream, message)).catch(() => {}); return; }
            processing++;
            incoming = incoming.then(async () => {
                await ready;
                try {
                    if (message.method?.startsWith('hapi/')) {
                        send(downstream, { id: message.id, result: await options.hooks.control(message.method, message.params) });
                        return;
                    }
                    const transformed = await options.hooks.before(message, connectionId);
                    if (transformed.id !== undefined && ['thread/start', 'thread/resume', 'thread/fork', 'thread/archive', 'thread/revert', 'thread/rollback', 'thread/queue/delete'].includes(transformed.method ?? '')) {
                        pending.set(transformed.id, transformed);
                    }
                    send(upstream, transformed);
                } catch (error) {
                    send(downstream, { id: message.id, error: { code: -32600, message: error instanceof Error ? error.message : String(error) } });
                }
            }).catch(() => downstream.close(1011, 'Codex connection failed')).finally(() => { processing--; drained(); });
        });
        upstream.on('message', raw => {
            outgoing = outgoing.then(async () => {
                const message = EnvelopeSchema.parse(JSON.parse(raw.toString()));
                const request = message.method === undefined && message.id !== undefined ? pending.get(message.id) : undefined;
                let replay: void | Envelope[] = undefined;
                if (request) {
                    try { replay = await options.hooks.after(request, message, connectionId); }
                    catch (error) {
                        send(downstream, { id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
                        return;
                    } finally { pending.delete(message.id!); drained(); }
                }
                send(downstream, message);
                for (const notification of replay ?? []) send(downstream, notification);
            }).catch(() => downstream.close(1011, 'Invalid Codex response'));
        });
        upstream.on('close', () => {
            downstream.close(1011, 'Codex disconnected');
            void incoming.then(() => outgoing).finally(finish);
        });
        upstream.on('error', () => downstream.close(1011, 'Codex unavailable'));
        downstream.on('error', () => downstream.close());
        downstream.on('close', () => {
            detached = true;
            // A terminal can exit after dispatching /new but before its reply.
            // Keep the upstream alive until binding finishes; never lose the
            // new root or treat transport loss as proof the mutation failed.
            drainTimer = setTimeout(finish, 60_000); drainTimer.unref(); drained();
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        if (options.path) server.listen(options.path, resolve);
        else server.listen(0, '127.0.0.1', resolve);
    });
    if (options.path) await chmod(options.path, 0o600);
    const address = server.address();
    const endpoint = options.path ? `unix://${options.path}` : `ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    return { endpoint, async close() {
        for (const [client, upstream] of connections) { client.terminate(); upstream.terminate(); }
        websocket.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
        if (options.path) await unlink(options.path).catch(() => {});
    } };
}
