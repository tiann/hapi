/**
 * Proxy smoke test for the Bun runtime.
 *
 * socket.io-client goes through npm `ws`, and `ws` never reads HTTP(S)_PROXY;
 * WebSocket traffic only uses a proxy when an agent is passed explicitly. This
 * script uses a real socket.io client plus a local authenticated CONNECT proxy
 * to verify:
 *   1. the agent from socketIoProxyOptions() actually routes WebSockets;
 *   2. proxy authentication is forwarded;
 *   3. NO_PROXY targets connect directly;
 *   4. axios and Bun's env-driven fetch paths also go through the proxy.
 *
 * Run: bun run --cwd cli scripts/proxy-smoke.ts
 */

import { createServer, request as httpRequest, type Server as HttpServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import axios from 'axios';
import { Server } from 'socket.io';
import { io, type Socket } from 'socket.io-client';
import { axiosEgressConfig, socketIoProxyOptions } from '../src/net/proxy';

const PROXY_AUTH = 'user:pass';
const EXPECTED_AUTH = `Basic ${Buffer.from(PROXY_AUTH).toString('base64')}`;

function findNonLoopbackIPv4(): string | null {
    for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (address.family === 'IPv4' && !address.internal) {
                return address.address;
            }
        }
    }
    return null;
}

function listen(server: HttpServer, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, () => {
            server.removeListener('error', reject);
            resolve((server.address() as AddressInfo).port);
        });
    });
}

function waitForConnect(socket: Socket, timeoutMs = 8_000): Promise<'connected' | 'error' | 'timeout'> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), timeoutMs);
        socket.once('connect', () => {
            clearTimeout(timer);
            resolve('connected');
        });
        socket.once('connect_error', () => {
            clearTimeout(timer);
            resolve('error');
        });
    });
}

async function main(): Promise<void> {
    const host = findNonLoopbackIPv4();
    if (!host) {
        console.log('proxy-smoke: SKIP (no non-loopback IPv4 address)');
        return;
    }

    const connectTargets: string[] = [];
    const proxiedHttpRequests: string[] = [];
    const proxyAuthSeen: string[] = [];
    const proxy = createServer((req, res) => {
        // Plain HTTP requests use absolute-URI form (HttpProxyAgent); forward them as-is.
        if (!req.url || !/^http:\/\//.test(req.url)) {
            res.writeHead(405).end();
            return;
        }
        proxiedHttpRequests.push(req.url);
        const target = new URL(req.url);
        const headers = { ...req.headers, host: target.host };
        delete headers['proxy-authorization'];
        const upstream = httpRequest({
            host: target.hostname,
            port: Number(target.port),
            path: `${target.pathname}${target.search}`,
            method: req.method,
            headers
        }, (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(res);
        });
        upstream.on('error', () => res.writeHead(502).end());
        req.pipe(upstream);
        res.on('error', () => upstream.destroy());
    });
    proxy.on('connect', (req, clientSocket, head) => {
        proxyAuthSeen.push(String(req.headers['proxy-authorization'] ?? ''));
        if (req.headers['proxy-authorization'] !== EXPECTED_AUTH) {
            clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
            return;
        }
        connectTargets.push(req.url ?? '');
        const [targetHost, targetPort] = (req.url ?? '').split(':');
        const upstream = connect(Number(targetPort), targetHost, () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length > 0) {
                upstream.write(head);
            }
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
        });
        upstream.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => upstream.destroy());
    });

    const httpServer = createServer((req, res) => {
        if (req.url === '/proxy-check') {
            res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
            return;
        }
        res.writeHead(404).end();
    });
    const socketServer = new Server(httpServer, { path: '/socket.io' });
    socketServer.on('connection', () => {});

    const proxyPort = await listen(proxy, '127.0.0.1');
    const serverPort = await listen(httpServer, '0.0.0.0');
    const targetUrl = `http://${host}:${serverPort}`;
    const proxyUrl = `http://${PROXY_AUTH}@127.0.0.1:${proxyPort}`;
    const env: NodeJS.ProcessEnv = {
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        NO_PROXY: ''
    };

    const failures: string[] = [];
    try {
        const proxied = io(targetUrl, {
            transports: ['websocket'],
            reconnection: false,
            forceNew: true,
            ...socketIoProxyOptions(targetUrl, env)
        });
        const proxiedResult = await waitForConnect(proxied);
        proxied.close();

        if (proxiedResult !== 'connected') {
            failures.push(`proxied socket.io client did not connect (${proxiedResult})`);
        }
        if (connectTargets.length !== 1) {
            failures.push(`expected exactly 1 proxy CONNECT, saw ${connectTargets.length}`);
        }
        if (connectTargets[0] !== `${host}:${serverPort}`) {
            failures.push(`unexpected CONNECT target: ${connectTargets[0]}`);
        }
        if (proxyAuthSeen[0] !== EXPECTED_AUTH) {
            failures.push('proxy did not receive the expected Proxy-Authorization header');
        }

        const bypassOptions = socketIoProxyOptions(targetUrl, { ...env, NO_PROXY: host });
        if (Object.keys(bypassOptions).length !== 0) {
            failures.push('NO_PROXY host should not produce a proxy agent');
        }
        const direct = io(targetUrl, {
            transports: ['websocket'],
            reconnection: false,
            forceNew: true,
            ...bypassOptions
        });
        const directResult = await waitForConnect(direct);
        direct.close();
        if (directResult !== 'connected') {
            failures.push(`direct socket.io client did not connect (${directResult})`);
        }
        if (connectTargets.length !== 1) {
            failures.push(`NO_PROXY client unexpectedly used the proxy (${connectTargets.length} CONNECTs)`);
        }

        // axios path: the explicit agent must route HTTP requests through the same proxy.
        const response = await axios.get(`${targetUrl}/proxy-check`, axiosEgressConfig(targetUrl, env));
        if (response.status !== 200 || response.data !== 'ok') {
            failures.push(`proxied axios request failed (${response.status}, data=${JSON.stringify(response.data)})`);
        }
        if (proxiedHttpRequests.length !== 1) {
            failures.push(`expected exactly 1 proxied HTTP request, saw ${proxiedHttpRequests.length}`);
        }

        // fetch path: Bun resolves the proxy from env (hub FCM/voice/relay rely on this).
        process.env.HTTP_PROXY = proxyUrl;
        process.env.http_proxy = proxyUrl;
        process.env.NO_PROXY = '';
        delete process.env.no_proxy;
        const fetched = await fetch(`${targetUrl}/proxy-check`);
        if (fetched.status !== 200 || await fetched.text() !== 'ok') {
            failures.push(`env-proxied fetch failed (${fetched.status})`);
        }
        if (proxiedHttpRequests.length !== 2) {
            failures.push(`fetch did not use the env proxy (${proxiedHttpRequests.length} HTTP requests)`);
        }
    } finally {
        socketServer.close();
        httpServer.close();
        proxy.close();
    }

    if (failures.length > 0) {
        console.error('proxy-smoke: FAIL');
        for (const failure of failures) {
            console.error(`  - ${failure}`);
        }
        process.exit(1);
    }

    console.log('proxy-smoke: PASS (ws/axios/fetch via authenticated CONNECT, NO_PROXY direct)');
}

void main().catch((error) => {
    console.error('proxy-smoke: FAIL', error);
    process.exit(1);
});
