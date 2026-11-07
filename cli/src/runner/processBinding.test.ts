import { describe, expect, it, vi } from 'vitest';
import { captureProcessBinding, captureStopSignalBinding, sharedStopBinding, terminateCapturedBinding } from './processBinding';

describe('asynchronous process binding guard', () => {
    it('allows empty post-exit bindings only for captured descendants, never a replacement or sibling', () => {
        let bindings: unknown[] = [{}, 'old', 'old', {}, 'old'];
        let sibling = false;
        const canSignal = captureStopSignalBinding(() => bindings, () => sibling);
        expect(canSignal()).toBe(true);
        bindings = [undefined, undefined, undefined, undefined, undefined];
        expect(canSignal()).toBe(false);
        expect(canSignal('descendant')).toBe(true);
        bindings[0] = {};
        expect(canSignal('descendant')).toBe(false);
        bindings[0] = undefined; sibling = true;
        expect(canSignal('descendant')).toBe(false);
    });
    it('allows the target archive webhook while rejecting a newly reported sibling', () => {
        const session: { sharedSessions?: Record<string, unknown> } = { sharedSessions: { target: {} } };
        const unchanged = captureProcessBinding(() => [session, sharedStopBinding(session, 'target')]);
        delete session.sharedSessions?.target;
        expect(unchanged()).toBe(true);
        session.sharedSessions = { sibling: {} };
        expect(unchanged()).toBe(false);
    });
    it('preserves persisted-only replacement metadata, tombstones and dedupe after generation-aware termination', async () => {
        const state = { tracked: undefined as object | undefined, requested: 'old', confirmed: 'old', persisted: { generation: 'old' }, dedupe: 'old' };
        const unchanged = captureProcessBinding(() => Object.values(state));
        const cleanup = vi.fn();
        let finished!: (verified: boolean) => void;
        const pending = terminateCapturedBinding(unchanged, () => new Promise(resolve => { finished = resolve; }), cleanup);
        Object.assign(state, { tracked: {}, requested: 'replacement', confirmed: 'replacement', persisted: { generation: 'new' }, dedupe: 'replacement' });
        finished(true);
        expect(await pending).toBe('stopped');
        expect(cleanup).not.toHaveBeenCalled();
        expect(state.requested).toBe('replacement');
        expect(state.persisted.generation).toBe('new');
        expect(state.dedupe).toBe('replacement');
    });
    it('cleans an unchanged binding after verified termination', async () => {
        const cleanup = vi.fn();
        expect(await terminateCapturedBinding(() => true, async () => true, cleanup)).toBe('stopped');
        expect(cleanup).toHaveBeenCalledOnce();
    });
    it('keeps unknown or unverified bindings without cleanup or a false exit claim', async () => {
        const terminate = vi.fn(async () => false), cleanup = vi.fn();
        expect(await terminateCapturedBinding(() => false, terminate, cleanup)).toBe('unknown');
        expect(terminate).not.toHaveBeenCalled();
        expect(await terminateCapturedBinding(() => true, terminate, cleanup)).toBe('still_alive');
        expect(cleanup).not.toHaveBeenCalled();
    });
    it('preserves a replacement registered under the same PID while termination awaits descendants', async () => {
        const pid = 42;
        const original = { sessionId: 'old' };
        const replacement = { sessionId: 'new' };
        const tracked = new Map([[pid, original]]);
        const requested = new Map([[pid, 'old']]);
        const persisted = new Map([[pid, { generation: 'old' }]]);
        const unchanged = captureProcessBinding(() => [tracked.get(pid), requested.get(pid), persisted.get(pid)]);
        const mutateDedupe = vi.fn();
        let complete!: () => void;
        const stopped = (async () => {
            await new Promise<void>(resolve => { complete = resolve; });
            if (unchanged()) {
                mutateDedupe(); tracked.delete(pid); requested.delete(pid); persisted.delete(pid);
            }
            return 'stopped';
        })();
        tracked.delete(pid); requested.delete(pid); persisted.delete(pid);
        tracked.set(pid, replacement); requested.set(pid, 'new'); persisted.set(pid, { generation: 'new' });
        complete();
        expect(await stopped).toBe('stopped');
        expect(tracked.get(pid)).toBe(replacement);
        expect(requested.get(pid)).toBe('new');
        expect(persisted.get(pid)).toEqual({ generation: 'new' });
        expect(mutateDedupe).not.toHaveBeenCalled();
    });

    it('allows cleanup only while all captured bindings remain unchanged', () => {
        const values: unknown[] = [{}, 'requested', 'confirmed', {}, 'dedupe', 0];
        const unchanged = captureProcessBinding(() => [...values]);
        expect(unchanged()).toBe(true);
        for (let index = 0; index < values.length; index++) {
            const value = values[index]; values[index] = Symbol('replacement');
            expect(unchanged()).toBe(false); values[index] = value;
        }
        expect(unchanged()).toBe(true);
    });
});
