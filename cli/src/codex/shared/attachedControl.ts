import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { CodexRuntimeRecord } from './registry';

/** Local bridge control only; never proxies native RPCs or approvals. */
export async function startAttachedControl(sessionId: string, detach: () => void): Promise<{
    endpoint: string; token: string; close(): Promise<void>;
}> {
    const token = randomBytes(32).toString('hex');
    const server = createServer((request, response) => {
        const actual = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${token}`);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { response.writeHead(401).end(); return; }
        if (request.method !== 'POST' || request.url !== `/detach/${encodeURIComponent(sessionId)}`) { response.writeHead(404).end(); return; }
        // Let the acknowledgement leave before closing this connection.
        response.once('finish', detach);
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true }));
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); throw new Error('No attached control address'); }
    return { endpoint: `http://127.0.0.1:${address.port}`, token, async close() {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    } };
}

export async function attachedRuntimeControl(runtime: CodexRuntimeRecord, method: string, sessionId: string): Promise<unknown> {
    if (!['hapi/stopSession', 'hapi/detach'].includes(method)) throw new Error('Attached workers only support detach, not native terminal attachment');
    if (runtime.kind !== 'attached' || !runtime.sessions[sessionId]?.active || !runtime.token) throw new Error('No active attached binding');
    const url = new URL(runtime.endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('Invalid attached control endpoint');
    }
    const response = await fetch(`${url.origin}/detach/${encodeURIComponent(sessionId)}`, {
        method: 'POST', headers: { Authorization: `Bearer ${runtime.token}` }, signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`Attached detach failed (${response.status})`);
    return response.json();
}
