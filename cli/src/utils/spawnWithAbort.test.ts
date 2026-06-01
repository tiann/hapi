import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Create a fake child process emitter for each test
let childEmitter: EventEmitter & { exitCode: number | null; killed: boolean; pid: number };

const spawnMock = vi.hoisted(() => vi.fn(() => {
    childEmitter = Object.assign(new EventEmitter(), {
        exitCode: null,
        killed: false,
        pid: 12345,
    });
    return childEmitter;
}));

vi.mock('cross-spawn', () => ({
    default: spawnMock
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/utils/process', () => ({
    killProcessByChildProcess: vi.fn(),
}));

import { spawnWithAbort } from './spawnWithAbort';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(value: string) {
    Object.defineProperty(process, 'platform', {
        value,
        configurable: true
    });
}

function getSpawnOptions() {
    const firstCall = spawnMock.mock.calls[0] as unknown[] | undefined;
    const options = firstCall?.[2] as { windowsHide?: boolean; shell?: unknown } | undefined;
    if (!options) {
        throw new Error('Expected spawn options');
    }
    return options;
}

function makeOptions(overrides: Partial<Parameters<typeof spawnWithAbort>[0]> = {}) {
    const controller = new AbortController();
    return {
        opts: {
            command: 'echo',
            args: ['hello'],
            cwd: '/tmp',
            env: {},
            signal: controller.signal,
            logLabel: 'test',
            spawnName: 'echo',
            installHint: 'echo',
            logExit: true,
            ...overrides,
        } satisfies Parameters<typeof spawnWithAbort>[0],
        controller,
    };
}

async function waitForExitListener() {
    await vi.waitFor(() => expect(childEmitter.listenerCount('exit')).toBe(1));
}

describe('spawnWithAbort', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor);
        }
    });

    describe('normal exit (no abort)', () => {
        it('hides spawned console windows on Windows by default', async () => {
            setPlatform('win32');
            const { opts } = makeOptions();
            const p = spawnWithAbort(opts);
            await waitForExitListener();

            expect(getSpawnOptions().windowsHide).toBe(true);

            childEmitter.emit('exit', 0, null);
            await expect(p).resolves.toBeUndefined();
        });

        it('allows callers to explicitly keep Windows child windows visible', async () => {
            setPlatform('win32');
            const { opts } = makeOptions({ windowsHide: false });
            const p = spawnWithAbort(opts);
            await waitForExitListener();

            expect(getSpawnOptions().windowsHide).toBe(false);

            childEmitter.emit('exit', 0, null);
            await expect(p).resolves.toBeUndefined();
        });

        it('resolves when process exits with code 0', async () => {
            const { opts } = makeOptions();
            const p = spawnWithAbort(opts);
            await waitForExitListener();
            childEmitter.emit('exit', 0, null);
            await expect(p).resolves.toBeUndefined();
        });

        it('rejects when process exits with non-zero code', async () => {
            const { opts } = makeOptions();
            const p = spawnWithAbort(opts);
            await waitForExitListener();
            childEmitter.emit('exit', 1, null);
            await expect(p).rejects.toThrow('Process exited with code: 1');
        });

        it('rejects when process is terminated by signal', async () => {
            const { opts } = makeOptions();
            const p = spawnWithAbort(opts);
            await waitForExitListener();
            childEmitter.emit('exit', null, 'SIGKILL');
            await expect(p).rejects.toThrow('Process terminated with signal: SIGKILL');
        });

        it('resolves when process exits with null code and null signal', async () => {
            const { opts } = makeOptions();
            const p = spawnWithAbort(opts);
            await waitForExitListener();
            childEmitter.emit('exit', null, null);
            await expect(p).resolves.toBeUndefined();
        });
    });

    describe('abort handling', () => {
        it('resolves when process exits with code 1 after abort', async () => {
            const { opts, controller } = makeOptions();
            const p = spawnWithAbort(opts);
            await waitForExitListener();
            controller.abort();
            childEmitter.emit('exit', 1, null);
            await expect(p).resolves.toBeUndefined();
        });

        it('resolves when process exits with any non-zero code after abort', async () => {
            const { opts, controller } = makeOptions();
            const p = spawnWithAbort(opts);
            await waitForExitListener();
            controller.abort();
            childEmitter.emit('exit', 2, null);
            await expect(p).resolves.toBeUndefined();
        });

        it('resolves when process exits with known abort code (130) after abort', async () => {
            const { opts, controller } = makeOptions();
            const p = spawnWithAbort(opts);
            await waitForExitListener();
            controller.abort();
            childEmitter.emit('exit', 130, null);
            await expect(p).resolves.toBeUndefined();
        });

        it('resolves when process exits with SIGTERM after abort', async () => {
            const { opts, controller } = makeOptions();
            const p = spawnWithAbort(opts);
            await waitForExitListener();
            controller.abort();
            childEmitter.emit('exit', null, 'SIGTERM');
            await expect(p).resolves.toBeUndefined();
        });

        it('resolves when process exits with unexpected signal after abort', async () => {
            const { opts, controller } = makeOptions();
            const p = spawnWithAbort(opts);
            await waitForExitListener();
            controller.abort();
            childEmitter.emit('exit', null, 'SIGKILL');
            await expect(p).resolves.toBeUndefined();
        });

        it('resolves when process exits with code 0 after abort', async () => {
            const { opts, controller } = makeOptions();
            const p = spawnWithAbort(opts);
            await waitForExitListener();
            controller.abort();
            childEmitter.emit('exit', 0, null);
            await expect(p).resolves.toBeUndefined();
        });
    });

    describe('spawn error', () => {
        it('rejects with install hint when spawn fails', async () => {
            const { opts } = makeOptions();
            const p = spawnWithAbort(opts);
            await waitForExitListener();
            childEmitter.emit('error', new Error('ENOENT'));
            await expect(p).rejects.toThrow('Failed to spawn echo: ENOENT. Is echo installed and on PATH?');
        });

        it('resolves when spawn error occurs after abort', async () => {
            const { opts, controller } = makeOptions();
            const p = spawnWithAbort(opts);
            await waitForExitListener();
            controller.abort();
            childEmitter.emit('error', new Error('ENOENT'));
            await expect(p).resolves.toBeUndefined();
        });
    });
});
