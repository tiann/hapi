import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Create a fake child process emitter for each test
let childEmitter: EventEmitter & { exitCode: number | null; killed: boolean; pid: number };

vi.mock('node:child_process', () => ({
    spawn: vi.fn(() => {
        childEmitter = Object.assign(new EventEmitter(), {
            exitCode: null,
            killed: false,
            pid: 12345,
        });
        return childEmitter;
    }),
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/utils/process', () => ({
    killProcessByChildProcess: vi.fn(),
}));

import { spawnWithAbort } from './spawnWithAbort';

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

    describe('normal exit (no abort)', () => {
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
