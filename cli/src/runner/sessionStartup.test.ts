import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupFailedStartupAfterExit, sessionStartupTimeout, waitForRecoverableStartup } from './sessionStartup';
import { EventEmitter } from 'node:events';
import { createSpawnDeduplicator } from './run';

afterEach(() => vi.useRealTimers());
describe('failed startup worktree cleanup', () => {
    const child = () => Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as NodeJS.Signals | null });
    it('waits for confirmed exit after an unconfirmed startup failure and cleans only once', async () => {
        vi.useFakeTimers();
        const process = child(); const cleanup = vi.fn();
        const startup = waitForRecoverableStartup<string>({ timeoutMs: 30_000, timeoutMessage: 'Still starting', sessionId: id => id, onLateReady: vi.fn(),
            onLateFailure: () => cleanupFailedStartupAfterExit(process, () => true, cleanup) });
        await vi.advanceTimersByTimeAsync(30_000); await startup.result;
        startup.fail('Process error'); startup.fail('Duplicate error');
        expect(cleanup).not.toHaveBeenCalled();
        process.exitCode = 1; process.emit('exit', 1); process.emit('exit', 1);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });
    it.each(['exit', 'signal'])('cleans immediately when %s already proved the child dead', proof => {
        const process = child(); const cleanup = vi.fn();
        if (proof === 'exit') process.exitCode = 1; else process.signalCode = 'SIGTERM';
        cleanupFailedStartupAfterExit(process, () => true, cleanup);
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(process.listenerCount('exit')).toBe(0);
    });
    it('preserves the worktree if the process later reports a successful startup before exit', () => {
        const process = child(); const cleanup = vi.fn(); let confirmed = false;
        cleanupFailedStartupAfterExit(process, () => !confirmed, cleanup);
        confirmed = true; process.emit('exit', 0);
        expect(cleanup).not.toHaveBeenCalled();
    });
});
describe('recoverable Codex startup', () => {
    const setup = () => {
        vi.useFakeTimers();
        const onLateReady = vi.fn();
        return { onLateReady, startup: waitForRecoverableStartup<string>({ timeoutMs: 30_000, timeoutMessage: 'Still starting', sessionId: id => id, onLateReady }) };
    };
    it('accepts fresh Codex startup after the former 15 second cutoff', async () => {
        const { startup, onLateReady } = setup();
        await vi.advanceTimersByTimeAsync(23_324);
        startup.confirm('requested');
        await expect(startup.result).resolves.toEqual({ type: 'success', sessionId: 'requested' });
        expect(onLateReady).not.toHaveBeenCalled();
    });
    it('returns an unconfirmed result at the deadline and accepts exactly one late confirmation', async () => {
        const { startup, onLateReady } = setup();
        await vi.advanceTimersByTimeAsync(30_000);
        await expect(startup.result).resolves.toEqual({ type: 'error', errorMessage: 'Still starting' });
        startup.confirm('requested'); startup.confirm('duplicate'); startup.fail('later close');
        expect(onLateReady).toHaveBeenCalledExactlyOnceWith('requested');
    });
    it.each([false, true])('does not recover a child that exited, including after timeout=%s', async expired => {
        const { startup, onLateReady } = setup();
        if (expired) await vi.advanceTimersByTimeAsync(30_000);
        startup.fail('Child exited'); startup.confirm('late');
        if (!expired) await expect(startup.result).resolves.toEqual({ type: 'error', errorMessage: 'Child exited' });
        expect(onLateReady).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('replaces an unconfirmed diagnostic with the eventual process failure exactly once', async () => {
        vi.useFakeTimers();
        const onLateFailure = vi.fn();
        const startup = waitForRecoverableStartup<string>({ timeoutMs: 30_000, timeoutMessage: 'Still starting', sessionId: id => id, onLateReady: vi.fn(), onLateFailure });
        await vi.advanceTimersByTimeAsync(30_000); await startup.result;
        startup.fail('Process exited with code 1'); startup.fail('Duplicate exit');
        expect(onLateFailure).toHaveBeenCalledExactlyOnceWith('Process exited with code 1');
    });
    it('keeps the live-child dedupe until late readiness, then permits a new child only after exit', async () => {
        vi.useFakeTimers();
        let calls = 0;
        let startup!: ReturnType<typeof waitForRecoverableStartup<string>>;
        const dedupe = createSpawnDeduplicator(async options => {
            calls++; dedupe.markChildAlive(options.existingSessionId!);
            startup = waitForRecoverableStartup<string>({ timeoutMs: 30_000, timeoutMessage: 'Still starting', sessionId: id => id,
                onLateReady: id => dedupe.recoverChild(id, { type: 'success', sessionId: id }) });
            return startup.result;
        });
        const input = { directory: '/tmp', existingSessionId: 'requested' };
        const first = dedupe(input);
        await vi.advanceTimersByTimeAsync(30_000);
        expect((await first).type).toBe('error');
        expect((await dedupe(input)).type).toBe('error'); expect(calls).toBe(1);
        startup.confirm('requested');
        await expect(dedupe(input)).resolves.toEqual({ type: 'success', sessionId: 'requested' });
        dedupe.onChildExited('requested');
        const second = dedupe(input); startup.fail('exit'); await second;
        expect(calls).toBe(2);
    });
});
describe('startup deadlines', () => {
    it('deduplicates a reserved fresh row against a concurrent existing-row retry', async () => {
        let complete!: (value: { type: 'success'; sessionId: string }) => void;
        const spawn = vi.fn(() => new Promise<{ type: 'success'; sessionId: string }>(resolve => { complete = resolve; }));
        const dedupe = createSpawnDeduplicator(spawn);
        const fresh = dedupe({ directory: '/tmp', reservedSessionId: 'reserved' });
        const retry = dedupe({ directory: '/tmp', existingSessionId: 'reserved' });
        expect(spawn).toHaveBeenCalledTimes(1);
        complete({ type: 'success', sessionId: 'reserved' });
        await expect(fresh).resolves.toEqual(await retry);
    });
    it('gives fresh and resumed Codex the same 30 second budget and other agents 15 seconds', () => {
        expect(sessionStartupTimeout('codex')).toBe(30_000);
        expect(sessionStartupTimeout('claude')).toBe(15_000);
        expect(sessionStartupTimeout(undefined)).toBe(15_000);
    });
    it.each(['', 'bad', '0', '-1', 'Infinity'])('ignores invalid override %s', value => {
        expect(sessionStartupTimeout('codex', value)).toBe(30_000);
    });
    it('honors a positive configured deadline for either agent', () => {
        expect(sessionStartupTimeout('codex', '1234')).toBe(1234);
        expect(sessionStartupTimeout('claude', '1234')).toBe(1234);
    });
});
