import { MessageQueue2 } from '@/utils/MessageQueue2';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AcpRecoveryAttempt, AcpRecoveryBatch, UnverifiedAcpWriter, runWithAcpChildRecovery, type AcpRecoveryHooks } from './acpChildRecovery';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function runGenerations(launch: (generation: number, hooks: AcpRecoveryHooks) => Promise<void>, completed = false) {
    const queueClosed = new AbortController();
    const starts: number[] = [];
    const queue = new MessageQueue2<string>(mode => mode);
    const exit = new AbortController();
    let stop!: () => void;
    const run = runWithAcpChildRecovery({}, {
        queueClosed: queueClosed.signal,
        sessionExit: exit.signal,
        hasInput: () => queue.hasInputDemand(),
        waitForInput: signal => queue.waitForInputDemand(signal),
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
        installHandlers: handler => { stop = handler; },
        exhausted: () => new Error('window exhausted')
    });
    return { run, starts, queue, queueClosed, cancel: (reason: 'exit' | 'stop') => reason === 'exit' ? exit.abort() : stop() };
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

it('honors session Exit before another generation acquires the queue', async () => {
    const { run, starts, cancel } = runGenerations(async () => {});
    await vi.advanceTimersByTimeAsync(500);
    cancel('exit');
    await expect(run).resolves.toBe('exit');
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

it.each(['backoff', 'startup'] as const)('keeps remote input available after Stop during %s', async phase => {
    const pendingStartup = Promise.withResolvers<void>();
    const dispose = vi.fn();
    const { run, starts, queue, cancel } = runGenerations(async (generation, hooks) => {
        if (generation === 1) return;
        if (phase === 'startup' && generation === 2) {
            await new AcpRecoveryAttempt(hooks.recoverySignal).startup(() => pendingStartup.promise, dispose);
        }
    });
    const ack = vi.fn();
    queue.onBatchConsumed = ack;
    await vi.advanceTimersByTimeAsync(phase === 'startup' ? 1_000 : 500);
    if (phase === 'startup') queue.push('first', 'mode', 'one');
    cancel('stop');
    const previous = starts.length;
    await vi.advanceTimersByTimeAsync(0);
    if (phase === 'backoff') {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(starts).toHaveLength(previous);
        queue.push('first', 'mode', 'one');
    }
    queue.push('second', 'mode', 'two');
    pendingStartup.resolve();
    await vi.advanceTimersByTimeAsync(phase === 'startup' ? 5_000 : 1_000);
    expect(dispose).toHaveBeenCalledTimes(phase === 'startup' ? 1 : 0);
    expect(starts).toHaveLength(previous + 1);
    expect(ack).not.toHaveBeenCalled();
    expect((await queue.waitForMessagesAndGetAsString())?.items.map(item => item.localId)).toEqual(['one', 'two']);
    expect(ack).toHaveBeenCalledExactlyOnceWith(['one', 'two']);
    cancel('exit');
    await expect(run).resolves.toBe('exit');
});

it('charges neither backoff nor rolling budget for three Stop-cancelled startups', async () => {
    const { run, starts, queue, cancel } = runGenerations(async (generation, hooks) => {
        if (generation === 1) return;
        if (generation <= 4) {
            await new Promise<void>(resolve => hooks.recoverySignal.addEventListener('abort', () => resolve(), { once: true }));
            return;
        }
        hooks.onRecoveryReady();
        const batch = await queue.waitForMessagesAndGetAsString();
        expect(batch?.items.map(item => item.localId)).toEqual(['pending']);
        hooks.onRecoveryStart();
        cancel('exit');
    });
    const ack = vi.fn();
    queue.onBatchConsumed = ack;
    queue.push('pending', 'mode', 'pending');
    for (let generation = 2; generation <= 4; generation++) {
        await vi.advanceTimersByTimeAsync(1_000);
        expect(starts).toHaveLength(generation);
        cancel('stop');
    }
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(run).resolves.toBe('exit');
    expect(starts).toHaveLength(5);
    expect(ack).toHaveBeenCalledExactlyOnceWith(['pending']);
});

it('a replacement reaching ready after Stop recovers its next loss without input', async () => {
    const { run, starts, cancel } = runGenerations(async (generation, hooks) => {
        if (generation === 1) return;
        if (generation === 2) {
            cancel('stop');
            hooks.onRecoveryReady();
            hooks.onRecoveryStart();
            return;
        }
        expect(hooks.recoverySignal.aborted).toBe(false);
        hooks.onRecoveryReady();
        hooks.onRecoveryStart();
        cancel('exit');
    });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(starts).toHaveLength(3);
    await expect(run).resolves.toBe('exit');
});

it.each(['failure first', 'Stop first'] as const)('charges the startup according to evidence order: %s', async order => {
    const { run, starts, queue, cancel } = runGenerations(async (generation, hooks) => {
        if (generation === 1) return;
        if (generation === 3) {
            cancel('exit');
            return;
        }
        if (order === 'failure first') hooks.onRecoveryStartupFailure();
        cancel('stop');
        if (order === 'Stop first') hooks.onRecoveryStartupFailure();
        throw new Error('replacement exited');
    });
    queue.push('pending', 'mode', 'pending');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(starts.map(start => start - starts[0]!)).toEqual([0, 1_000, order === 'failure first' ? 6_000 : 2_000]);
    await expect(run).resolves.toBe('exit');
});

it('discards a writer check crossed by Stop before probing the same owner again', async () => {
    const first = Promise.withResolvers<boolean>();
    const second = Promise.withResolvers<boolean>();
    const verify = vi.fn(() => first.promise).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const parked = vi.fn();
    const cleanup = Promise.withResolvers<void>();
    const { run, starts, queue, cancel } = runGenerations(async (generation, hooks) => {
        if (generation > 1) return;
        hooks.onRecoveryStart();
        await cleanup.promise;
        throw new UnverifiedAcpWriter('writer alive', false, verify, parked);
    });
    cancel('stop');
    queue.push('pending', 'mode', 'one');
    cleanup.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(verify).toHaveBeenCalledTimes(1);
    cancel('stop');
    await vi.advanceTimersByTimeAsync(500);
    expect(verify).toHaveBeenCalledTimes(1);
    first.resolve(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(starts).toHaveLength(1);
    expect(queue.size()).toBe(1);
    cancel('exit');
    await expect(run).resolves.toBe('exit');
    second.resolve(true);
});
