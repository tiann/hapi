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

import { CodexAppServerClient, isIndeterminateError } from './codexAppServerClient';

function fakeStream(): EventEmitter & { setEncoding: ReturnType<typeof vi.fn> } {
    return Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
}

function fakeChild() {
    return Object.assign(new EventEmitter(), {
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
