import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock, spawnMock } = vi.hoisted(() => ({
    execFileSyncMock: vi.fn(() => 'codex-cli 1.0.0'),
    spawnMock: vi.fn()
}));

vi.mock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    return {
        ...actual,
        execFileSync: execFileSyncMock,
        spawn: spawnMock
    };
});

vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    return { ...actual, existsSync: vi.fn(() => false) };
});

vi.mock('@/utils/process', () => ({
    killProcessByChildProcess: vi.fn(async () => true)
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() }
}));

import { CodexAppServerClient, isIndeterminateError, supportsThreadScopedMcpStatus } from './codexAppServerClient';
import { killProcessByChildProcess } from '@/utils/process';

function fakeStream(): EventEmitter & { setEncoding: ReturnType<typeof vi.fn> } {
    return Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
}

function fakeChild() {
    return Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        signalCode: null as string | null,
        stdin: Object.assign(new EventEmitter(), {
            end: vi.fn(),
            write: vi.fn(),
            destroyed: false,
            writable: true,
            writableEnded: false
        }),
        stdout: fakeStream(),
        stderr: fakeStream()
    });
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe('CodexAppServerClient process cwd', () => {
    beforeEach(() => {
        execFileSyncMock.mockClear();
        spawnMock.mockReset();
        vi.mocked(killProcessByChildProcess).mockClear();
    });

    it('lets a completed read/fork helper exit on stdin EOF without process-tree probing', async () => {
        const child = fakeChild();
        child.stdin.end.mockImplementation(() => { child.exitCode = 0; child.emit('exit', 0, null); });
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient();
        await client.connect();
        await client.disconnect({ gracefulTimeoutMs: 100 });
        expect(child.stdin.end).toHaveBeenCalledTimes(1);
        expect(killProcessByChildProcess).not.toHaveBeenCalled();
        expect(client.isConnected()).toBe(false);
    });

    it('falls back to exact child cleanup if graceful helper shutdown does not finish', async () => {
        vi.useFakeTimers();
        try {
            const child = fakeChild();
            spawnMock.mockReturnValue(child);
            const client = new CodexAppServerClient();
            await client.connect();
            const closing = client.disconnect({ gracefulTimeoutMs: 100 });
            await vi.advanceTimersByTimeAsync(100);
            await closing;
            expect(killProcessByChildProcess).toHaveBeenCalledWith(child);
        } finally { vi.useRealTimers(); }
    });

    it('passes an explicit neutral cwd to the app-server process', async () => {
        spawnMock.mockReturnValue(fakeChild());
        const client = new CodexAppServerClient({ cwd: '/neutral-home' });

        await client.connect();

        expect(spawnMock).toHaveBeenCalledWith(
            'codex',
            ['app-server'],
            expect.objectContaining({ cwd: '/neutral-home' })
        );
        await client.disconnect();
    });

    it('passes the explicit catalog to a single app-server without preparation processes', async () => {
        const file = process.platform === 'win32' ? 'C:\\Models with spaces\\catalog.json' : '/Models with spaces/catalog.json';
        vi.stubEnv('HAPI_CODEX_MODEL_CATALOG_JSON', file);
        const client = new CodexAppServerClient();
        try {
            spawnMock.mockReturnValue(fakeChild());
            await client.connect();
            expect(spawnMock).toHaveBeenCalledTimes(1);
            expect(spawnMock).toHaveBeenCalledWith('codex', ['app-server', '-c', `model_catalog_json=${JSON.stringify(file)}`],
                expect.objectContaining({ shell: false }));
        } finally {
            await client.disconnect();
            vi.unstubAllEnvs();
        }
    });

    it.each([
        ['hapi/0.167.0 (Linux 6; x64)', true],
        ['Codex Desktop/0.167.0 (Windows; x64)', true],
        ['Codex Desktop/0.167.0+desktop.1 (Windows; x64)', true],
        ['codex_vscode/0.166.3 (Windows; x64) (hapi; 1)', false],
        ['hapi/0.167.0-alpha.1 (Linux 6; x64)', false],
        ['unknown (hapi/0.168.0)', false],
        [undefined, false]
    ])('gates connection reuse on the app-server build version %s', (userAgent, supported) => {
        expect(supportsThreadScopedMcpStatus(userAgent)).toBe(supported);
    });

    it.each([false, true])('never requests broad MCP discovery (supported=%s)', async supported => {
        const child = fakeChild();
        child.stdin.write.mockImplementation((data: string, done?: (error?: Error | null) => void) => {
            const request = JSON.parse(data);
            done?.();
            if (request.id !== undefined) {
                const result = request.method === 'initialize' ? { userAgent: `hapi/${supported ? '0.167.0' : '0.166.0'} (Linux)` } : { data: [] };
                queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ id: request.id, result }) + '\n')));
            }
            return true;
        });
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient();
        await client.connect();
        try {
            await client.initialize({ clientInfo: { name: 'hapi', version: '1' }, capabilities: { experimentalApi: true } });
            await expect(client.readThreadMcpServerStatus('thread', ' ')).rejects.toThrow('unavailable');
            const result = client.readThreadMcpServerStatus('thread', 'docs');
            if (supported) await expect(result).resolves.toEqual({ data: [] });
            else await expect(result).rejects.toThrow('unavailable');
            const requests = child.stdin.write.mock.calls.map(([text]) => JSON.parse(text)).filter(row => row.method === 'mcpServerStatus/list');
            expect(requests.map(row => row.params)).toEqual(supported ? [{ threadId: 'thread', serverName: 'docs', detail: 'toolsAndAuthOnly' }] : []);
            expect(spawnMock).toHaveBeenCalledTimes(1);
        } finally { await client.disconnect(); }
    });

    it('steerTurn resolves dispatch on stdin accept and completes with the turn response', async () => {
        const child = fakeChild();
        child.stdin.write = vi.fn((_data: unknown, cb?: (error?: Error | null) => void) => {
            cb?.();
            return true;
        });
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient({ cwd: '/neutral-home' });

        await client.connect();
        const steer = await client.steerTurn({
            threadId: 'thread-1',
            input: [{ type: 'text', text: 'pivot now' }],
            expectedTurnId: 'turn-1',
            clientUserMessageId: 'local-1'
        });
        await steer.dispatched;

        const written = child.stdin.write.mock.calls[0]?.[0] as string;
        const payload = JSON.parse(written);
        expect(payload).toEqual(expect.objectContaining({
            method: 'turn/steer',
            params: expect.objectContaining({ clientUserMessageId: 'local-1' })
        }));

        // App-server completes the turn after the inject.
        child.stdout.emit('data', Buffer.from(JSON.stringify({ id: payload.id, result: { turnId: 'turn-1' } }) + '\n'));
        await expect(steer.completed).resolves.toEqual({ turnId: 'turn-1' });
        await client.disconnect();
    });

    it('times out a stalled stdin dispatch instead of leaving it pending', async () => {
        vi.useFakeTimers();
        try {
            const child = fakeChild();
            child.stdin.write = vi.fn(() => true);
            spawnMock.mockReturnValue(child);
            const client = new CodexAppServerClient({ cwd: '/neutral-home' });

            await client.connect();
            const steer = await client.steerTurn({
                threadId: 'thread-1',
                input: [{ type: 'text', text: 'x' }],
                expectedTurnId: 'turn-1'
            });
            const dispatched = expect(steer.dispatched).rejects.toThrow("timed out after 20000ms");
            const completed = expect(steer.completed).rejects.toThrow("timed out after 20000ms");
            await vi.advanceTimersByTimeAsync(20_000);
            await dispatched;
            await completed;
            await client.disconnect();
        } finally {
            vi.useRealTimers();
        }
    });

    it('steerTurn rejects dispatch when stdin write fails', async () => {
        const child = fakeChild();
        child.stdin.write = vi.fn((_data: unknown, cb?: (error?: Error | null) => void) => {
            cb?.(new Error('stdin closed'));
            return true;
        });
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient({ cwd: '/neutral-home' });

        await client.connect();
        const steer = await client.steerTurn({
            threadId: 'thread-1',
            input: [{ type: 'text', text: 'x' }],
            expectedTurnId: 'turn-1'
        });
        let dispatchedError: unknown;
        try {
            await steer.dispatched;
        } catch (error) {
            dispatchedError = error;
        }
        expect(dispatchedError).toBeInstanceOf(Error);
        expect(isIndeterminateError(dispatchedError)).toBe(true);
        await expect(steer.completed).rejects.toThrow('stdin closed');
        await client.disconnect();
    });

    it('drops an incoming response when stdin closes while its handler is pending', async () => {
        const child = fakeChild();
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient({ cwd: '/neutral-home' });
        const handlerStarted = deferred<void>();
        const handlerFinished = deferred<void>();

        client.registerRequestHandler('slow/request', async () => {
            handlerStarted.resolve();
            await handlerFinished.promise;
            return { ok: true };
        });

        await client.connect();
        child.stdout.emit('data', Buffer.from(JSON.stringify({
            id: 1,
            method: 'slow/request',
            params: {}
        }) + '\n'));
        await handlerStarted.promise;

        child.stdin.destroyed = true;
        child.stdin.writable = false;
        handlerFinished.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(child.stdin.write).not.toHaveBeenCalled();
        await client.disconnect();
    });

    it('does not leak late incoming handler failures as unhandled rejections', async () => {
        const child = fakeChild();
        child.stdin.write = vi.fn(() => {
            throw new Error('Cannot call write after a stream was destroyed');
        });
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient({ cwd: '/neutral-home' });
        const handlerFinished = deferred<void>();
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => {
            unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);

        client.registerRequestHandler('slow/request', async () => {
            await handlerFinished.promise;
            return { ok: true };
        });

        try {
            await client.connect();
            child.stdout.emit('data', Buffer.from(JSON.stringify({
                id: 1,
                method: 'slow/request',
                params: {}
            }) + '\n'));
            await Promise.resolve();
            handlerFinished.resolve();
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
            await client.disconnect();
        }
    });

    it('handles an asynchronous stdin error after a writable response', async () => {
        const child = fakeChild();
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient({ cwd: '/neutral-home' });

        client.registerRequestHandler('ping', () => ({ ok: true }));
        await client.connect();
        child.stdout.emit('data', Buffer.from(JSON.stringify({
            id: 1,
            method: 'ping',
            params: {}
        }) + '\n'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(child.stdin.write).toHaveBeenCalledTimes(1);

        await new Promise<void>((resolve) => {
            setTimeout(() => {
                child.stdin.emit('error', new Error('EPIPE'));
                resolve();
            }, 0);
        });

        expect(client.isConnected()).toBe(true);
        await client.disconnect();
    });

    it('drops a late response from an old app-server after reconnecting', async () => {
        const oldChild = fakeChild();
        const newChild = fakeChild();
        spawnMock.mockReturnValueOnce(oldChild).mockReturnValueOnce(newChild);
        const client = new CodexAppServerClient({ cwd: '/neutral-home' });
        const handlerStarted = deferred<void>();
        const handlerFinished = deferred<void>();

        client.registerRequestHandler('slow/request', async () => {
            handlerStarted.resolve();
            await handlerFinished.promise;
            return { ok: true };
        });

        await client.connect();
        oldChild.stdout.emit('data', Buffer.from(JSON.stringify({
            id: 1,
            method: 'slow/request',
            params: {}
        }) + '\n'));
        await handlerStarted.promise;

        await client.disconnect();
        await client.connect();
        handlerFinished.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(oldChild.stdin.write).not.toHaveBeenCalled();
        expect(newChild.stdin.write).not.toHaveBeenCalled();
        await client.disconnect();
    });
});
