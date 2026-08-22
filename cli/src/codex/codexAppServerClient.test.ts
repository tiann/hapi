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
    STRICT_PROCESS_OWNERSHIP_ENV: 'HAPI_STRICT_PROCESS_OWNERSHIP_TOKEN',
    getProcessStartMarker: vi.fn(() => 'spawn-marker'),
    killProcessByChildProcess: vi.fn(async () => true)
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() }
}));

import { CodexAppServerClient, isIndeterminateError } from './codexAppServerClient';
import { getProcessStartMarker, killProcessByChildProcess } from '@/utils/process';

const strictOwnershipEnv = 'HAPI_STRICT_PROCESS_OWNERSHIP_TOKEN';

function fakeStream(): EventEmitter & { setEncoding: ReturnType<typeof vi.fn> } {
    return Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
}

function fakeChild(options?: { pid?: number; stdinEnd?: () => void }) {
    return Object.assign(new EventEmitter(), {
        pid: options?.pid ?? 123,
        stdin: { destroy: vi.fn(), end: vi.fn(options?.stdinEnd), write: vi.fn() },
        stdout: fakeStream(),
        stderr: fakeStream()
    });
}

describe('CodexAppServerClient process cwd', () => {
    beforeEach(() => {
        execFileSyncMock.mockClear();
        spawnMock.mockReset();
        vi.mocked(getProcessStartMarker).mockReset();
        vi.mocked(getProcessStartMarker).mockReturnValue('spawn-marker');
        vi.mocked(killProcessByChildProcess).mockReset();
        vi.mocked(killProcessByChildProcess).mockResolvedValue(true);
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

    it('captures and forwards the immutable Windows process marker for a strict client', async () => {
        const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', {
            ...platformDescriptor,
            value: 'win32'
        });
        const child = fakeChild({ pid: 321 });
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient();

        try {
            await client.connect({ requireVerifiedProcessIdentity: true });
            expect(getProcessStartMarker).toHaveBeenNthCalledWith(1, process.pid);
            expect(getProcessStartMarker).toHaveBeenNthCalledWith(2, 321);
            vi.mocked(getProcessStartMarker).mockReturnValue('replacement-marker');

            await client.disconnect({ deadline: 12_345 });

            expect(killProcessByChildProcess).toHaveBeenCalledWith(
                child,
                false,
                'spawn-marker',
                12_345
            );
        } finally {
            Object.defineProperty(process, 'platform', platformDescriptor);
        }
    });

    it('uses legacy Windows teardown and reconnects when marker probing is unavailable', async () => {
        const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', {
            ...platformDescriptor,
            value: 'win32'
        });
        vi.mocked(getProcessStartMarker).mockImplementation(() => {
            throw new Error('marker probe unavailable');
        });
        const originalChild = fakeChild();
        const replacementChild = fakeChild({ pid: 456 });
        spawnMock
            .mockReturnValueOnce(originalChild)
            .mockReturnValueOnce(replacementChild);
        vi.mocked(killProcessByChildProcess)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const client = new CodexAppServerClient();

        try {
            await client.connect();
            await expect(client.disconnect()).rejects.toThrow('could not be terminated');
            await client.connect();
            await client.disconnect();

            expect(getProcessStartMarker).not.toHaveBeenCalled();
            expect(killProcessByChildProcess).toHaveBeenNthCalledWith(
                1,
                originalChild,
                false,
                undefined,
                undefined
            );
            expect(killProcessByChildProcess).toHaveBeenNthCalledWith(
                2,
                replacementChild,
                false,
                undefined,
                undefined
            );
            expect(spawnMock).toHaveBeenCalledTimes(2);
        } finally {
            Object.defineProperty(process, 'platform', platformDescriptor);
        }
    });

    it('rejects a strict Windows connection before spawn when marker preflight fails', async () => {
        const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', {
            ...platformDescriptor,
            value: 'win32'
        });
        vi.mocked(getProcessStartMarker).mockReturnValue(null);
        spawnMock.mockReturnValue(fakeChild());
        const client = new CodexAppServerClient();

        try {
            await expect(client.connect({
                requireVerifiedProcessIdentity: true
            })).rejects.toThrow('process identity could not be verified');
            expect(client.isConnected()).toBe(false);
            expect(getProcessStartMarker).toHaveBeenCalledWith(process.pid);
            expect(spawnMock).not.toHaveBeenCalled();
        } finally {
            Object.defineProperty(process, 'platform', platformDescriptor);
        }
    });

    it('fails closed with a null marker when disconnect races strict Windows marker capture', async () => {
        vi.useFakeTimers();
        const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', {
            ...platformDescriptor,
            value: 'win32'
        });
        const child = fakeChild({ pid: 321 });
        vi.mocked(getProcessStartMarker)
            .mockReturnValueOnce('node-marker')
            .mockReturnValue(null);
        vi.mocked(killProcessByChildProcess).mockResolvedValue(false);
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient();

        try {
            const connecting = client.connect({ requireVerifiedProcessIdentity: true });
            const connectionError = connecting.then(() => null, (error: unknown) => error);
            await Promise.resolve();

            await expect(client.disconnect()).rejects.toThrow('could not be terminated');
            expect(killProcessByChildProcess).toHaveBeenNthCalledWith(
                1,
                child,
                false,
                null,
                undefined
            );

            await vi.advanceTimersByTimeAsync(1_000);
            const error = await connectionError;

            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toContain('process identity could not be verified');
            expect(getProcessStartMarker).toHaveBeenNthCalledWith(1, process.pid);
            expect(vi.mocked(getProcessStartMarker).mock.calls.length).toBeGreaterThan(2);
            expect(client.isConnected()).toBe(false);
            expect(client.isInitialized()).toBe(false);
            expect(child.stdin.write).not.toHaveBeenCalled();
            expect(vi.mocked(killProcessByChildProcess).mock.calls.every((call) => (
                call[1] === false && call[2] === null
            ))).toBe(true);
            await expect(client.connect({
                requireVerifiedProcessIdentity: true
            })).rejects.toThrow('termination is unconfirmed');
            expect(spawnMock).toHaveBeenCalledOnce();
        } finally {
            Object.defineProperty(process, 'platform', platformDescriptor);
            vi.useRealTimers();
        }
    });

    it('rejects strict Windows connect when the child exits during marker capture', async () => {
        vi.useFakeTimers();
        const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', {
            ...platformDescriptor,
            value: 'win32'
        });
        const child = fakeChild({ pid: 321 });
        vi.mocked(getProcessStartMarker)
            .mockReturnValueOnce('node-marker')
            .mockReturnValueOnce(null)
            .mockReturnValueOnce('reused-marker');
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient();

        try {
            const connecting = client.connect({ requireVerifiedProcessIdentity: true });
            const connectionError = connecting.then(() => null, (error: unknown) => error);
            child.emit('exit', 0, null);

            await vi.advanceTimersByTimeAsync(20);
            const error = await connectionError;

            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toContain(
                'process identity could not be verified'
            );
            expect(getProcessStartMarker).toHaveBeenNthCalledWith(1, process.pid);
            expect(getProcessStartMarker).toHaveBeenNthCalledWith(2, 321);
            expect(getProcessStartMarker).toHaveBeenNthCalledWith(3, 321);
            expect(client.isConnected()).toBe(false);
            expect(client.isInitialized()).toBe(false);
            expect(killProcessByChildProcess).not.toHaveBeenCalled();
            await expect(client.connect({
                requireVerifiedProcessIdentity: true
            })).rejects.toThrow('termination is unconfirmed');
            expect(spawnMock).toHaveBeenCalledOnce();
        } finally {
            Object.defineProperty(process, 'platform', platformDescriptor);
            vi.useRealTimers();
        }
    });

    it('detaches and terminates the strict POSIX client as a process group', async () => {
        const child = fakeChild({ pid: 321 });
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient();

        await client.connect({ requireVerifiedProcessIdentity: true });
        const spawnOptions = spawnMock.mock.calls[0]?.[2] as {
            env: Record<string, string>;
        };
        const ownershipToken = spawnOptions.env[strictOwnershipEnv];
        await client.disconnect({ deadline: 12_345 });

        expect(ownershipToken).toEqual(expect.any(String));
        expect(spawnMock).toHaveBeenCalledWith(
            'codex',
            ['app-server'],
            expect.objectContaining({ detached: true })
        );
        expect(killProcessByChildProcess).toHaveBeenCalledWith(
            child,
            false,
            'spawn-marker',
            12_345,
            true,
            ownershipToken
        );
    });

    it('rejects a strict POSIX connection when the root marker cannot be captured', async () => {
        vi.mocked(getProcessStartMarker).mockReturnValue(null);
        const child = fakeChild({ pid: 321 });
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient();

        await expect(client.connect({
            requireVerifiedProcessIdentity: true
        })).rejects.toThrow('process identity could not be verified');

        expect(getProcessStartMarker).toHaveBeenCalledWith(321);
        expect(killProcessByChildProcess).toHaveBeenCalledWith(
            child,
            false,
            null,
            undefined,
            true,
            expect.any(String)
        );
        expect(client.isConnected()).toBe(false);
    });

    it('keeps the legacy process path off Windows', async () => {
        const child = fakeChild();
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient();

        await client.connect();
        await client.disconnect();

        expect(getProcessStartMarker).not.toHaveBeenCalled();
        expect(killProcessByChildProcess).toHaveBeenCalledWith(
            child,
            false,
            undefined,
            undefined
        );
    });

    it('invalidates a reconnect when shutdown joins its controlled disconnect', async () => {
        let finishTermination!: (terminated: boolean) => void;
        vi.mocked(killProcessByChildProcess).mockReturnValue(new Promise<boolean>((resolve) => {
            finishTermination = resolve;
        }));
        spawnMock.mockReturnValue(fakeChild());
        const client = new CodexAppServerClient();

        await client.connect();
        const teardown = client.disconnect();
        const reconnect = client.connect();
        const reconnectError = reconnect.then(() => null, (error: unknown) => error);
        await Promise.resolve();
        const shutdown = client.disconnect();
        finishTermination(true);

        await teardown;
        await shutdown;
        const error = await reconnectError;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('superseded');
        expect(spawnMock).toHaveBeenCalledOnce();
    });

    it('does not report a controlled disconnect as transport abandonment on child exit', async () => {
        let finishTermination!: (terminated: boolean) => void;
        vi.mocked(killProcessByChildProcess).mockReturnValue(new Promise<boolean>((resolve) => {
            finishTermination = resolve;
        }));
        const child = fakeChild();
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient();
        const transportAbandonedHandler = vi.fn();
        client.setTransportAbandonedHandler(transportAbandonedHandler);

        await client.connect();
        const disconnect = client.disconnect();
        child.emit('exit', 0, null);

        expect(transportAbandonedHandler).not.toHaveBeenCalled();
        finishTermination(true);
        await disconnect;
    });

    it('reports transport abandonment once when the child exits during abandoned teardown', async () => {
        let finishTermination!: (terminated: boolean) => void;
        vi.mocked(killProcessByChildProcess).mockReturnValue(new Promise<boolean>((resolve) => {
            finishTermination = resolve;
        }));
        const child = fakeChild();
        child.stdin.write = vi.fn(() => true);
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient();
        const transportAbandonedHandler = vi.fn();
        const abortController = new AbortController();
        client.setTransportAbandonedHandler(transportAbandonedHandler);

        await client.connect();
        const fork = client.forkThread(
            { threadId: 'thread-1' },
            { signal: abortController.signal }
        );
        await Promise.resolve();
        abortController.abort();
        await expect(fork).rejects.toThrow('Request aborted');
        child.emit('exit', 0, null);

        expect(transportAbandonedHandler).toHaveBeenCalledOnce();
        finishTermination(true);
        await client.disconnect();
    });

    it('allows the default client to reconnect after an unexpected process exit', async () => {
        const originalChild = fakeChild();
        const replacementChild = fakeChild({ pid: 456 });
        spawnMock
            .mockReturnValueOnce(originalChild)
            .mockReturnValueOnce(replacementChild);
        const client = new CodexAppServerClient();
        const transportAbandonedHandler = vi.fn();
        client.setTransportAbandonedHandler(transportAbandonedHandler);

        await client.connect();
        originalChild.emit('exit', 1, null);

        expect(transportAbandonedHandler).toHaveBeenCalledOnce();
        await client.connect();
        expect(spawnMock).toHaveBeenCalledTimes(2);
        await client.disconnect();
    });

    it('starts strict POSIX process-group cleanup immediately after leader exit', async () => {
        let finishTermination!: (terminated: boolean) => void;
        vi.mocked(killProcessByChildProcess).mockReturnValue(new Promise<boolean>((resolve) => {
            finishTermination = resolve;
        }));
        const child = fakeChild({ pid: 321 });
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient();

        await client.connect({ requireVerifiedProcessIdentity: true });
        const spawnOptions = spawnMock.mock.calls[0]?.[2] as {
            env: Record<string, string>;
        };
        const ownershipToken = spawnOptions.env[strictOwnershipEnv];
        child.emit('exit', 1, null);

        expect(killProcessByChildProcess).toHaveBeenCalledWith(
            child,
            false,
            'spawn-marker',
            undefined,
            true,
            ownershipToken
        );

        const disconnect = client.disconnect({ deadline: 12_345 });
        expect(killProcessByChildProcess).toHaveBeenCalledOnce();
        finishTermination(true);

        await disconnect;
        expect(killProcessByChildProcess).toHaveBeenCalledOnce();
        expect(client.isConnected()).toBe(false);
    });

    it('surfaces failed background POSIX cleanup and allows an explicit retry', async () => {
        let rejectTermination!: (error: Error) => void;
        vi.mocked(killProcessByChildProcess)
            .mockReturnValueOnce(new Promise<boolean>((_resolve, reject) => {
                rejectTermination = reject;
            }))
            .mockResolvedValueOnce(true);
        const child = fakeChild({ pid: 321 });
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient();
        const unhandledRejections: unknown[] = [];
        const onUnhandledRejection = (reason: unknown) => {
            unhandledRejections.push(reason);
        };
        process.on('unhandledRejection', onUnhandledRejection);

        try {
            await client.connect({ requireVerifiedProcessIdentity: true });
            const spawnOptions = spawnMock.mock.calls[0]?.[2] as {
                env: Record<string, string>;
            };
            const ownershipToken = spawnOptions.env[strictOwnershipEnv];
            child.emit('exit', 1, null);

            expect(killProcessByChildProcess).toHaveBeenCalledOnce();
            expect(killProcessByChildProcess).toHaveBeenNthCalledWith(
                1,
                child,
                false,
                'spawn-marker',
                undefined,
                true,
                ownershipToken
            );
            rejectTermination(new Error('tree kill failed'));
            await new Promise<void>((resolve) => setImmediate(resolve));

            expect(unhandledRejections).toEqual([]);
            await expect(client.disconnect()).rejects.toThrow('tree kill failed');

            await client.disconnect();
            expect(killProcessByChildProcess).toHaveBeenCalledTimes(2);
            expect(killProcessByChildProcess).toHaveBeenNthCalledWith(
                2,
                child,
                false,
                'spawn-marker',
                undefined,
                true,
                ownershipToken
            );
        } finally {
            process.off('unhandledRejection', onUnhandledRejection);
        }
    });

    it('keeps strict Windows teardown fail-closed after its leader exits', async () => {
        const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', {
            ...platformDescriptor,
            value: 'win32'
        });
        const child = fakeChild({ pid: 321 });
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient();

        try {
            await client.connect({ requireVerifiedProcessIdentity: true });
            child.emit('exit', 0, null);

            await expect(client.disconnect()).rejects.toThrow('termination is unconfirmed');

            expect(killProcessByChildProcess).not.toHaveBeenCalled();
        } finally {
            Object.defineProperty(process, 'platform', platformDescriptor);
        }
    });

    it('retains process ownership when process-tree termination is unconfirmed', async () => {
        const originalChild = fakeChild();
        const replacementChild = fakeChild({ pid: 456 });
        spawnMock
            .mockReturnValueOnce(originalChild)
            .mockReturnValueOnce(replacementChild);
        vi.mocked(killProcessByChildProcess).mockResolvedValue(false);
        const client = new CodexAppServerClient();

        await client.connect({ requireVerifiedProcessIdentity: true });
        const spawnOptions = spawnMock.mock.calls[0]?.[2] as {
            env: Record<string, string>;
        };
        const ownershipToken = spawnOptions.env[strictOwnershipEnv];

        await expect(client.disconnect()).rejects.toThrow('could not be terminated');
        expect(killProcessByChildProcess).toHaveBeenCalledOnce();

        await expect(client.connect({
            requireVerifiedProcessIdentity: true
        })).rejects.toThrow('termination is unconfirmed');
        expect(spawnMock).toHaveBeenCalledOnce();

        vi.mocked(killProcessByChildProcess).mockResolvedValue(true);
        await client.disconnect();
        expect(killProcessByChildProcess).toHaveBeenNthCalledWith(
            2,
            originalChild,
            false,
            'spawn-marker',
            undefined,
            true,
            ownershipToken
        );
        await client.connect({ requireVerifiedProcessIdentity: true });
        expect(spawnMock).toHaveBeenCalledTimes(2);
        await client.disconnect();
    });

    it('rejects disconnect when process-tree termination throws', async () => {
        spawnMock.mockReturnValue(fakeChild());
        vi.mocked(killProcessByChildProcess).mockRejectedValue(new Error('tree kill failed'));
        const client = new CodexAppServerClient();

        await client.connect({ requireVerifiedProcessIdentity: true });

        await expect(client.disconnect()).rejects.toThrow('tree kill failed');
        expect(killProcessByChildProcess).toHaveBeenCalledOnce();
        await expect(client.connect({
            requireVerifiedProcessIdentity: true
        })).rejects.toThrow('termination is unconfirmed');
        expect(spawnMock).toHaveBeenCalledOnce();

        vi.mocked(killProcessByChildProcess).mockResolvedValue(true);
        await client.disconnect();
    });

    it('does not treat root exit as confirmation that the process tree terminated', async () => {
        let finishTermination!: (terminated: boolean) => void;
        vi.mocked(killProcessByChildProcess).mockReturnValue(new Promise<boolean>((resolve) => {
            finishTermination = resolve;
        }));
        const child = fakeChild();
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient();

        await client.connect({ requireVerifiedProcessIdentity: true });
        const disconnect = client.disconnect();
        await Promise.resolve();
        child.emit('exit', 0, null);
        finishTermination(false);

        await expect(disconnect).rejects.toThrow('could not be terminated');
        await expect(client.connect({
            requireVerifiedProcessIdentity: true
        })).rejects.toThrow('termination is unconfirmed');
        expect(spawnMock).toHaveBeenCalledOnce();
    });

    it('does not treat a child-process error as confirmation that the process tree terminated', async () => {
        let finishTermination!: (terminated: boolean) => void;
        vi.mocked(killProcessByChildProcess).mockReturnValue(new Promise<boolean>((resolve) => {
            finishTermination = resolve;
        }));
        const child = fakeChild();
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient();

        await client.connect({ requireVerifiedProcessIdentity: true });
        const disconnect = client.disconnect();
        await Promise.resolve();
        child.emit('error', new Error('transport failed'));
        finishTermination(false);

        await expect(disconnect).rejects.toThrow('could not be terminated');
        await expect(client.connect({
            requireVerifiedProcessIdentity: true
        })).rejects.toThrow('termination is unconfirmed');
        expect(spawnMock).toHaveBeenCalledOnce();
    });

    it('ignores buffered stdout after process teardown starts', async () => {
        let finishTermination!: (terminated: boolean) => void;
        vi.mocked(killProcessByChildProcess).mockReturnValue(new Promise<boolean>((resolve) => {
            finishTermination = resolve;
        }));
        const child = fakeChild();
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient();
        const notificationHandler = vi.fn();
        client.setNotificationHandler(notificationHandler);

        await client.connect();
        const disconnect = client.disconnect();
        await Promise.resolve();
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
            method: 'thread/status/changed',
            params: { threadId: 'stale-thread' }
        })}\n`));

        expect(notificationHandler).not.toHaveBeenCalled();
        finishTermination(true);
        await disconnect;
    });

    it('allows reconnect when only stdin closing fails after confirmed termination', async () => {
        const originalChild = fakeChild({
            stdinEnd: () => {
                throw new Error('stdin close failed');
            }
        });
        const replacementChild = fakeChild({ pid: 456 });
        spawnMock
            .mockReturnValueOnce(originalChild)
            .mockReturnValueOnce(replacementChild);
        const client = new CodexAppServerClient();

        await client.connect();
        await expect(client.disconnect()).rejects.toThrow('stdin close failed');

        await client.connect();
        expect(spawnMock).toHaveBeenCalledTimes(2);
        await client.disconnect();
    });

    it('starts process-tree termination before closing stdin', async () => {
        const calls: string[] = [];
        vi.mocked(killProcessByChildProcess).mockImplementation(async () => {
            calls.push('terminate');
            return true;
        });
        spawnMock.mockReturnValue(fakeChild({
            stdinEnd: () => calls.push('stdin.end')
        }));
        const client = new CodexAppServerClient();

        await client.connect();
        await client.disconnect();

        expect(calls).toEqual(['terminate', 'stdin.end']);
    });

    it('awaits and propagates process-tree termination when closing stdin throws', async () => {
        let rejectTermination!: (error: Error) => void;
        vi.mocked(killProcessByChildProcess).mockReturnValue(new Promise<boolean>((_resolve, reject) => {
            rejectTermination = reject;
        }));
        spawnMock.mockReturnValue(fakeChild({
            stdinEnd: () => {
                throw new Error('stdin close failed');
            }
        }));
        const client = new CodexAppServerClient();

        await client.connect();

        let settled = false;
        const disconnect = client.disconnect().finally(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        rejectTermination(new Error('tree kill failed'));
        await expect(disconnect).rejects.toThrow('tree kill failed');
        expect(killProcessByChildProcess).toHaveBeenCalledOnce();
    });

    it('terminates the process tree when aborting an unconfirmed stdin dispatch', async () => {
        const child = fakeChild();
        child.stdin.write = vi.fn(() => true);
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient();
        const abortController = new AbortController();

        await client.connect();
        const fork = client.forkThread(
            { threadId: 'thread-1' },
            { signal: abortController.signal }
        );
        await Promise.resolve();
        abortController.abort();

        await expect(fork).rejects.toThrow('Request aborted');
        await client.disconnect();
        expect(killProcessByChildProcess).toHaveBeenCalledOnce();
    });

    it('propagates abandoned transport termination failure to disconnect', async () => {
        vi.mocked(killProcessByChildProcess).mockResolvedValue(false);
        const child = fakeChild();
        child.stdin.write = vi.fn(() => true);
        spawnMock.mockReturnValue(child);
        const client = new CodexAppServerClient();
        const abortController = new AbortController();

        await client.connect({ requireVerifiedProcessIdentity: true });
        const fork = client.forkThread(
            { threadId: 'thread-1' },
            { signal: abortController.signal }
        );
        await Promise.resolve();
        abortController.abort();

        await expect(fork).rejects.toThrow('Request aborted');
        await expect(client.disconnect()).rejects.toThrow('could not be terminated');
        await expect(client.connect({
            requireVerifiedProcessIdentity: true
        })).rejects.toThrow('termination is unconfirmed');
        expect(spawnMock).toHaveBeenCalledOnce();

        vi.mocked(killProcessByChildProcess).mockResolvedValue(true);
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
});
