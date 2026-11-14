import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/ui/terminalState', () => ({
    restoreTerminalState: vi.fn(),
}));

vi.mock('@/utils/spawnWithAbort', () => ({
    spawnWithAbort: vi.fn(),
}));

import { spawnWithTerminalGuard } from '@/utils/spawnWithTerminalGuard';
import { spawnWithAbort } from '@/utils/spawnWithAbort';
import { restoreTerminalState } from '@/ui/terminalState';

const mockSpawnWithAbort = vi.mocked(spawnWithAbort);
const mockRestoreTerminalState = vi.mocked(restoreTerminalState);

const dummyOptions = {
    command: 'test-agent',
    args: [],
    cwd: '/tmp',
    env: process.env,
    signal: new AbortController().signal,
    logLabel: 'Test',
    spawnName: 'test',
    installHint: 'Test CLI',
};

describe('spawnWithTerminalGuard', () => {
    let stdinPauseSpy: ReturnType<typeof vi.spyOn>;
    let stdinResumeSpy: ReturnType<typeof vi.spyOn>;
    let stdinDestroySpy: ReturnType<typeof vi.spyOn>;
    let destroyedDescriptor: PropertyDescriptor | undefined;
    let isTTYDescriptor: PropertyDescriptor | undefined;

    const setStdinDestroyed = (value: boolean) => {
        Object.defineProperty(process.stdin, 'destroyed', {
            configurable: true,
            get: () => value
        });
    };

    const setStdinIsTTY = (value: boolean | undefined) => {
        Object.defineProperty(process.stdin, 'isTTY', {
            configurable: true,
            get: () => value
        });
    };

    beforeEach(() => {
        vi.clearAllMocks();
        stdinPauseSpy = vi.spyOn(process.stdin, 'pause').mockImplementation(() => process.stdin);
        stdinResumeSpy = vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
        stdinDestroySpy = vi.spyOn(process.stdin, 'destroy').mockImplementation(() => process.stdin);
        destroyedDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'destroyed');
        isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
        setStdinDestroyed(false);
        setStdinIsTTY(true);
    });

    afterEach(() => {
        stdinPauseSpy.mockRestore();
        stdinResumeSpy.mockRestore();
        stdinDestroySpy.mockRestore();
        if (destroyedDescriptor) {
            Object.defineProperty(process.stdin, 'destroyed', destroyedDescriptor);
        } else {
            delete (process.stdin as unknown as { destroyed?: unknown }).destroyed;
        }
        if (isTTYDescriptor) {
            Object.defineProperty(process.stdin, 'isTTY', isTTYDescriptor);
        } else {
            delete (process.stdin as unknown as { isTTY?: unknown }).isTTY;
        }
    });

    it('releases (pauses and destroys) stdin before spawn and resumes after success', async () => {
        mockSpawnWithAbort.mockResolvedValue();

        await spawnWithTerminalGuard(dummyOptions);

        expect(stdinPauseSpy).toHaveBeenCalledOnce();
        expect(stdinDestroySpy).toHaveBeenCalledOnce();
        expect(stdinResumeSpy).toHaveBeenCalledOnce();
        expect(mockRestoreTerminalState).toHaveBeenCalledOnce();
    });

    it('passes options through to spawnWithAbort unchanged', async () => {
        mockSpawnWithAbort.mockResolvedValue();

        await spawnWithTerminalGuard(dummyOptions);

        expect(mockSpawnWithAbort).toHaveBeenCalledWith(dummyOptions);
    });

    it('resumes stdin and restores terminal state even when spawn rejects', async () => {
        mockSpawnWithAbort.mockRejectedValue(new Error('spawn failed'));

        await expect(spawnWithTerminalGuard(dummyOptions)).rejects.toThrow('spawn failed');

        expect(stdinResumeSpy).toHaveBeenCalledOnce();
        expect(mockRestoreTerminalState).toHaveBeenCalledOnce();
    });

    it('does not resume stdin when the stream was destroyed', async () => {
        mockSpawnWithAbort.mockImplementation(async () => {
            setStdinDestroyed(true);
        });

        await spawnWithTerminalGuard(dummyOptions);

        expect(stdinResumeSpy).not.toHaveBeenCalled();
        expect(mockRestoreTerminalState).toHaveBeenCalledOnce();
    });

    it('propagates the original error from spawnWithAbort', async () => {
        const error = new Error('process exited with code 1');
        mockSpawnWithAbort.mockRejectedValue(error);

        await expect(spawnWithTerminalGuard(dummyOptions)).rejects.toThrow(error);
    });

    it('preserves piped stdin: pauses without destroying, then resumes', async () => {
        setStdinIsTTY(undefined);
        mockSpawnWithAbort.mockResolvedValue();

        await spawnWithTerminalGuard(dummyOptions);

        expect(stdinPauseSpy).toHaveBeenCalledOnce();
        expect(stdinDestroySpy).not.toHaveBeenCalled();
        expect(stdinResumeSpy).toHaveBeenCalledOnce();
    });

    it('releases stdin before spawn, and resumes after spawn', async () => {
        mockSpawnWithAbort.mockResolvedValue();

        await spawnWithTerminalGuard(dummyOptions);

        expect(stdinDestroySpy.mock.invocationCallOrder[0])
            .toBeLessThan(mockSpawnWithAbort.mock.invocationCallOrder[0]);
        expect(mockSpawnWithAbort.mock.invocationCallOrder[0])
            .toBeLessThan(stdinResumeSpy.mock.invocationCallOrder[0]);
    });
});
