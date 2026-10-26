import { describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { startCodexGateway, type Envelope } from './gateway';

async function fixture(after: (request: Envelope, response: Envelope, connection: string) => Promise<void>) {
    const engine = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>(resolve => engine.once('listening', resolve));
    const connections = new Map<WebSocket, Envelope[]>();
    engine.on('connection', client => {
        connections.set(client, []);
        client.on('message', raw => {
            const request = JSON.parse(raw.toString()) as Envelope;
            connections.get(client)!.push(request);
            client.send(JSON.stringify({ id: request.id, result: { thread: { id: String(request.params) } } }));
        });
    });
    const port = (engine.address() as { port: number }).port;
    const before = vi.fn(async (value: Envelope) => value);
    const gateway = await startCodexGateway({ upstream: `ws://127.0.0.1:${port}`, token: 'secret', hooks: {
        before, after, control: async () => ({})
    } });
    const clients: WebSocket[] = [];
    const connect = async () => {
        const client = new WebSocket(gateway.endpoint, { headers: { Authorization: 'Bearer secret' } }); clients.push(client);
        await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject); }); return client;
    };
    return { gateway, connect, before, async close() {
        for (const client of clients) client.terminate(); await gateway.close();
        for (const client of engine.clients) client.terminate();
        await new Promise<void>(resolve => engine.close(() => resolve()));
    } };
}
describe('native gateway barriers', () => {
    it('namespaces colliding native request IDs by connection and withholds replies until binding', async () => {
        let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
        const after = vi.fn(async () => { await barrier; }); const f = await fixture(after);
        try {
            const first = await f.connect(); const second = await f.connect(); const replies: unknown[] = [];
            first.on('message', value => replies.push(value)); second.on('message', value => replies.push(value));
            first.send(JSON.stringify({ id: 1, method: 'thread/start', params: 'a' }));
            second.send(JSON.stringify({ id: 1, method: 'thread/start', params: 'b' }));
            await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(2)); expect(replies).toHaveLength(0);
            const calls = after.mock.calls as unknown as Array<[Envelope, Envelope, string]>;
            expect(calls[0][2]).not.toBe(calls[1][2]); release();
            await vi.waitFor(() => expect(replies).toHaveLength(2));
        } finally { release(); await f.close(); }
    });
    it('finishes a dispatched lifecycle even when its terminal detaches before the response', async () => {
        let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
        const bound = vi.fn(); const f = await fixture(async () => { await barrier; bound(); });
        try {
            const client = await f.connect(); client.send(JSON.stringify({ id: 1, method: 'thread/start', params: 'a' }));
            await vi.waitFor(() => expect(f.before).toHaveBeenCalled()); client.close(); release();
            await vi.waitFor(() => expect(bound).toHaveBeenCalledOnce());
        } finally { release(); await f.close(); }
    });
    it('rejects unauthenticated loopback connections', async () => {
        const f = await fixture(async () => {});
        try {
            const client = new WebSocket(f.gateway.endpoint);
            const response = await new Promise<number>(resolve => {
                client.on('unexpected-response', (_request, response) => { resolve(response.statusCode!); response.resume(); client.terminate(); });
                client.on('error', () => {});
            });
            expect(response).toBe(401);
        } finally { await f.close(); }
    });
});
