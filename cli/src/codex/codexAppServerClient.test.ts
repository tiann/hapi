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

import { CodexAppServerClient, isCodexAppServerIndeterminateError } from './codexAppServerClient';

function fakeStream(): EventEmitter & { setEncoding: ReturnType<typeof vi.fn> } {
    return Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
}

function fakeChild() {
    return Object.assign(new EventEmitter(), {
        stdin: { end: vi.fn(), write: vi.fn() },
        stdout: fakeStream(),
        stderr: fakeStream()
    });
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
});

describe('CodexAppServerClient process generations', () => {
    it('ignores lifecycle events from a replaced app-server child', async () => {
        const first = fakeChild();
        const second = fakeChild();
        spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
        const client = new CodexAppServerClient({ cwd: '/neutral-home' });
        const onTransportAbandoned = vi.fn();
        client.setTransportAbandonedHandler(onTransportAbandoned);

        await client.connect();
        first.emit('exit', 1, null);
        expect(onTransportAbandoned).toHaveBeenCalledTimes(1);
        await client.connect();

        // Late lifecycle events from the old child must not tear down the replacement.
        first.emit('exit', 2, null);
        first.emit('error', new Error('stale child error'));
        expect(onTransportAbandoned).toHaveBeenCalledTimes(1);
        expect(client.isConnected()).toBe(true);

        await client.disconnect();
    });

    it('classifies an asynchronous stdin write failure as indeterminate', async () => {
        vi.useFakeTimers();
        try {
            const child = fakeChild();
            child.stdin.write = vi.fn((_chunk: string, callback?: (error?: Error | null) => void) => {
                callback?.(new Error('EPIPE'));
                return true;
            });
            spawnMock.mockReturnValue(child);
            const client = new CodexAppServerClient({ cwd: '/neutral-home' });
            await client.connect();

            const resultPromise = client.steerTurn({
                threadId: 'thread-1',
                input: [{ type: 'text', text: 'pivot now' }],
                expectedTurnId: 'turn-1'
            }).then(
                () => null,
                (error: unknown) => error
            );
            await vi.advanceTimersByTimeAsync(25_001);
            const error = await resultPromise;

            expect(error).toMatchObject({ message: 'EPIPE' });
            expect(isCodexAppServerIndeterminateError(error)).toBe(true);
            expect(client.isConnected()).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('CodexAppServerClient turn/steer', () => {
    beforeEach(() => {
        spawnMock.mockReset();
    });

    it('sends turn/steer with thread, input, and expectedTurnId', async () => {
        const child = fakeChild();
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient({ cwd: '/neutral-home' });

        await client.connect();
        const writes: string[] = [];
        (child.stdin.write as ReturnType<typeof vi.fn>).mockImplementation((chunk: string) => {
            const line = String(chunk).trim();
            writes.push(line);
            let request: { id?: number; method?: string } | null = null;
            try {
                request = JSON.parse(line);
            } catch {
                return true;
            }
            if (request?.method === 'initialize') {
                setTimeout(() => {
                    (child.stdout as EventEmitter).emit('data', Buffer.from(
                        JSON.stringify({ jsonrpc: '2.0', id: request!.id, result: { protocolVersion: 1 } }) + '\n'
                    ));
                }, 0);
            }
            if (request?.method === 'turn/steer') {
                setTimeout(() => {
                    (child.stdout as EventEmitter).emit('data', Buffer.from(
                        JSON.stringify({ jsonrpc: '2.0', id: request!.id, result: { turnId: 'turn-9' } }) + '\n'
                    ));
                }, 0);
            }
            return true;
        });

        const result = await client.steerTurn({
            threadId: 'thread-1',
            input: [{ type: 'text', text: 'pivot now' }],
            expectedTurnId: 'turn-9',
            clientUserMessageId: 'local-9'
        });

        expect(result).toEqual({ turnId: 'turn-9' });
        const steerWrite = writes.find((w) => w.includes('turn/steer'));
        expect(steerWrite).toBeDefined();
        expect(JSON.parse(steerWrite!)).toMatchObject({
            method: 'turn/steer',
            params: {
                threadId: 'thread-1',
                input: [{ type: 'text', text: 'pivot now' }],
                expectedTurnId: 'turn-9',
                clientUserMessageId: 'local-9'
            }
        });
        await client.disconnect();
    });

    it('keeps synchronous stdin write failures determinate', async () => {
        const child = fakeChild();
        child.stdin.write = vi.fn(() => {
            throw new Error('stdin closed before write');
        });
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient({ cwd: '/neutral-home' });
        await client.connect();

        const error = await client.steerTurn({
            threadId: 'thread-1',
            input: [{ type: 'text', text: 'pivot now' }],
            expectedTurnId: 'turn-1'
        }).then(() => null, (reason: unknown) => reason);

        expect(error).toMatchObject({ message: 'stdin closed before write' });
        expect(isCodexAppServerIndeterminateError(error)).toBe(false);
        await client.disconnect();
    });

    it('bounds a lost steer response below the hub RPC timeout', async () => {
        vi.useFakeTimers();
        try {
            const child = fakeChild();
            spawnMock.mockReturnValue(child);
            const client = new CodexAppServerClient({ cwd: '/neutral-home' });
            await client.connect();

            const steerPromise = client.steerTurn({
                threadId: 'thread-1',
                input: [{ type: 'text', text: 'pivot now' }],
                expectedTurnId: 'turn-1'
            });
            const result = expect(steerPromise).rejects.toThrow("timed out after 20000ms");
            await vi.advanceTimersByTimeAsync(20_001);
            await result;
            await client.disconnect();
        } finally {
            vi.useRealTimers();
        }
    });
});
