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

    beforeEach(() => {
        vi.clearAllMocks();
        stdinPauseSpy = vi.spyOn(process.stdin, 'pause').mockImplementation(() => process.stdin);
        stdinResumeSpy = vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
    });

    afterEach(() => {
        stdinPauseSpy.mockRestore();
        stdinResumeSpy.mockRestore();
    });

    it('pauses stdin before spawn and resumes after success', async () => {
        mockSpawnWithAbort.mockResolvedValue();

        await spawnWithTerminalGuard(dummyOptions);

        expect(stdinPauseSpy).toHaveBeenCalledOnce();
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

    it('propagates the original error from spawnWithAbort', async () => {
        const error = new Error('process exited with code 1');
        mockSpawnWithAbort.mockRejectedValue(error);

        await expect(spawnWithTerminalGuard(dummyOptions)).rejects.toThrow(error);
    });

    // Once the controlling terminal is gone, process.stdin.resume() (or
    // restoreTerminalState()'s own writes to the dead tty) can itself
    // throw/reject. Each cleanup step runs in its own try/catch, isolated
    // from the others and from the spawn result, so a teardown failure can
    // neither turn a clean spawn into a crash nor mask the real spawn
    // failure with an unrelated terminal-teardown error.
    it('a stdin.resume() failure during cleanup does not mask a successful spawn or crash the caller', async () => {
        mockSpawnWithAbort.mockResolvedValue();
        stdinResumeSpy.mockImplementationOnce(() => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); });

        await expect(spawnWithTerminalGuard(dummyOptions)).resolves.toBeUndefined();
    });

    it('a stdin.resume() failure during cleanup does not replace the original spawn error', async () => {
        const spawnError = new Error('process exited with code 1');
        mockSpawnWithAbort.mockRejectedValue(spawnError);
        stdinResumeSpy.mockImplementationOnce(() => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); });

        await expect(spawnWithTerminalGuard(dummyOptions)).rejects.toThrow(spawnError);
    });

    it('a restoreTerminalState() failure during cleanup does not mask a successful spawn or crash the caller', async () => {
        mockSpawnWithAbort.mockResolvedValue();
        mockRestoreTerminalState.mockImplementationOnce(() => { throw new Error('write EIO'); });

        await expect(spawnWithTerminalGuard(dummyOptions)).resolves.toBeUndefined();
    });

    it('calls pause before spawn, and resume after spawn', async () => {
        mockSpawnWithAbort.mockResolvedValue();

        await spawnWithTerminalGuard(dummyOptions);

        expect(stdinPauseSpy.mock.invocationCallOrder[0])
            .toBeLessThan(mockSpawnWithAbort.mock.invocationCallOrder[0]);
        expect(mockSpawnWithAbort.mock.invocationCallOrder[0])
            .toBeLessThan(stdinResumeSpy.mock.invocationCallOrder[0]);
    });
});
