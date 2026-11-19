import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AcpRecoveryAttempt, AcpRecoveryBatch, runWithAcpChildRecovery, type AcpRecoveryHooks } from './acpChildRecovery';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function runGenerations(launch: (generation: number, hooks: AcpRecoveryHooks) => Promise<void>, completed = false) {
    const queueClosed = new AbortController();
    const starts: number[] = [];
    let cancel!: (reason: 'switch' | 'exit') => void;
    const run = runWithAcpChildRecovery({}, {
        queueClosed: queueClosed.signal,
        create: hooks => {
            starts.push(performance.now());
            const generation = starts.length;
            return {
                launch: async () => {
                    await launch(generation, hooks);
                    return 'exit';
                },
                shouldRecoverUnexpectedChildExit: true,
                hasCompletedPrompt: completed,
                hasCleanupFailure: false
            };
        },
        installHandlers: handler => { cancel = handler; },
        exhausted: () => new Error('window exhausted')
    });
    return { run, starts, queueClosed, cancel: (reason: 'switch' | 'exit') => cancel(reason) };
}

it('retains the 1/5/15 second backoff after an idle replacement and a failed startup', async () => {
    const { starts, run } = runGenerations(async (generation, hooks) => {
        if (generation === 3) throw new Error('spawn failed');
        hooks.onRecoveryReady();
        if (generation === 2) await new Promise(resolve => setTimeout(resolve, 31_000));
        hooks.onRecoveryStart();
    });
    const exhausted = expect(run).rejects.toThrow('window exhausted');
    await vi.advanceTimersByTimeAsync(52_000);
    await exhausted;
    expect(starts.map(t => t - starts[0]!)).toEqual([0, 1_000, 37_000, 52_000]);
});

it('resets backoff on completed prompts but permits only three replacements per rolling five minutes', async () => {
    const { starts, run } = runGenerations(async (generation, hooks) => {
        hooks.onRecoveryReady();
        if (generation === 4) await new Promise(resolve => setTimeout(resolve, 300_000));
        hooks.onRecoveryStart();
    }, true);
    const exhausted = expect(run).rejects.toThrow('window exhausted');
    await vi.advanceTimersByTimeAsync(306_000);
    await exhausted;
    expect(starts.map(t => t - starts[0]!)).toEqual([0, 1_000, 2_000, 3_000, 304_000, 305_000, 306_000]);
});

it.each(['switch', 'exit', 'close'] as const)('cancels backoff on %s before another generation acquires the queue', async action => {
    const { run, starts, queueClosed, cancel } = runGenerations(async () => {});
    await vi.advanceTimersByTimeAsync(500);
    if (action === 'close') {
        queueClosed.abort();
    } else {
        cancel(action);
    }
    await expect(run).resolves.toBe(action === 'switch' ? 'switch' : 'exit');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(starts).toHaveLength(1);
});

it('disposes a replacement resource that arrives after startup was cancelled', async () => {
    const created = Promise.withResolvers<string>();
    const dispose = vi.fn();
    const { run, starts, cancel } = runGenerations(async (generation, hooks) => {
        if (generation === 1) return;
        const attempt = new AcpRecoveryAttempt(hooks.recoverySignal);
        await attempt.startup(() => created.promise, dispose);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    cancel('exit');
    await expect(run).resolves.toBe('exit');
    created.resolve('late backend');
    await vi.advanceTimersByTimeAsync(0);
    expect(dispose).toHaveBeenCalledExactlyOnceWith('late backend');
    expect(starts).toHaveLength(2);
});

it.each([true, false])('settles a lost batch once when dispatch started is %s', dispatched => {
    const callbacks = { commit: vi.fn(), requeue: vi.fn(() => true), release: vi.fn() };
    const batch = new AcpRecoveryBatch(callbacks);
    if (dispatched) batch.commit();
    batch.finish(true);
    batch.finish(true);
    expect(callbacks.commit).toHaveBeenCalledTimes(dispatched ? 1 : 0);
    expect(callbacks.requeue).toHaveBeenCalledTimes(dispatched ? 0 : 1);
    expect(callbacks.release).not.toHaveBeenCalled();
});
