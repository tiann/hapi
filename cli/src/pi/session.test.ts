import { describe, it, expect, vi } from 'vitest';
import { PiSession } from './session';

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
    },
}));

function createMockSession(): PiSession {
    return new PiSession({
        api: {} as any,
        client: {
            keepAlive: vi.fn(),
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            emitMessagesConsumed: vi.fn(),
            sendSessionEvent: vi.fn(),
            emitSessionReady: vi.fn(),
        } as any,
        path: '/tmp/test',
        logPath: '/tmp/test.log',
        startedBy: 'terminal',
        startingMode: 'local',
    });
}

// --- Ready gate + outbound buffer (Pi RPC ready-race, issue #1143) ---
//
// A prompt POSTed immediately after spawn used to be sent to Pi before
// Pi returned its initial `get_state`, wedging the turn (agent_start then
// silence). runWhenReady buffers such sends until markReady() (fired when Pi's
// get_state response lands), then drains them FIFO.

describe('PiSession ready gate', () => {
    it('starts not ready', () => {
        const session = createMockSession();
        expect(session.isReady).toBe(false);
    });

    it('buffers work until markReady, then drains FIFO', () => {
        const session = createMockSession();
        const order: number[] = [];

        session.runWhenReady(() => order.push(1));
        session.runWhenReady(() => order.push(2));
        session.runWhenReady(() => order.push(3));

        // Nothing runs before ready.
        expect(order).toEqual([]);

        session.markReady();

        // Drained in the order they were enqueued.
        expect(order).toEqual([1, 2, 3]);
        expect(session.isReady).toBe(true);
    });

    it('runs work immediately once ready', () => {
        const session = createMockSession();
        session.markReady();

        const fn = vi.fn();
        session.runWhenReady(fn);

        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('markReady is idempotent — does not re-run drained work', () => {
        const session = createMockSession();
        const fn = vi.fn();
        session.runWhenReady(fn);

        session.markReady();
        session.markReady();

        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('only announces native-ready after successful get_state, not fallback readiness', () => {
        const session = createMockSession();

        session.markReady();
        expect(session.client.emitSessionReady).not.toHaveBeenCalled();

        session.markNativeReady();
        expect(session.client.emitSessionReady).toHaveBeenCalledTimes(1);

        const nativeSession = createMockSession();
        nativeSession.markNativeReady();
        nativeSession.markNativeReady();

        expect(nativeSession.client.emitSessionReady).toHaveBeenCalledTimes(1);
    });

    it('announces native-ready before async history baseline drains prompts', async () => {
        const session = createMockSession();
        let finishBaseline!: () => void;
        session.setNativeReadyPreparation(() => new Promise<void>((resolve) => { finishBaseline = resolve; }));
        const sent = vi.fn();
        session.runWhenReady(sent);

        session.markNativeReady();

        expect(session.client.emitSessionReady).toHaveBeenCalledTimes(1);
        expect(session.isReady).toBe(false);
        expect(sent).not.toHaveBeenCalled();

        finishBaseline();
        await Promise.resolve();
        await Promise.resolve();
        expect(session.isReady).toBe(true);
        expect(sent).toHaveBeenCalledTimes(1);
    });

    it('does not drain buffered work when cleanup cancels an in-flight ready preparation', async () => {
        const session = createMockSession();
        let finishBaseline!: () => void;
        session.setNativeReadyPreparation(() => new Promise<void>((resolve) => { finishBaseline = resolve; }));
        const sent = vi.fn();
        session.runWhenReady(sent);

        session.markNativeReady();
        session.cancelReadyGate();
        finishBaseline();
        await Promise.resolve();
        await Promise.resolve();
        session.runWhenReady(sent);

        expect(session.isReady).toBe(false);
        expect(sent).not.toHaveBeenCalled();
    });

    it('preserves FIFO across mixed buffered + post-ready enqueues', () => {
        const session = createMockSession();
        const order: string[] = [];

        session.runWhenReady(() => order.push('buffered-1'));
        session.runWhenReady(() => order.push('buffered-2'));
        session.markReady();
        session.runWhenReady(() => order.push('live-3'));

        expect(order).toEqual(['buffered-1', 'buffered-2', 'live-3']);
    });
});

// --- cancel-queued-message contract (issue #1143 review — MAJOR) ---
//
// A prompt buffered during the startup window can be cancelled by the hub
// before it drains. cancelBufferedMessage must drop it (so it never fires) and
// report removed:true; anything already drained or unknown reports false so the
// hub keeps the row as invoked (best-effort, like the other agents).

describe('PiSession cancelBufferedMessage', () => {
    it('drops a buffered send by localId so it never drains', () => {
        const session = createMockSession();
        const fired: string[] = [];

        session.runWhenReady(() => fired.push('keep-1'), 'id-1');
        session.runWhenReady(() => fired.push('cancel-2'), 'id-2');
        session.runWhenReady(() => fired.push('keep-3'), 'id-3');

        expect(session.cancelBufferedMessage('id-2')).toBe(true);

        session.markReady();

        // Cancelled prompt never fired; FIFO preserved for survivors.
        expect(fired).toEqual(['keep-1', 'keep-3']);
    });

    it('returns false when the localId is not buffered', () => {
        const session = createMockSession();
        session.runWhenReady(() => {}, 'id-1');

        expect(session.cancelBufferedMessage('unknown')).toBe(false);
    });

    it('returns false after the message has already drained', () => {
        const session = createMockSession();
        session.runWhenReady(() => {}, 'id-1');
        session.markReady();

        // Already sent to Pi — cannot be recalled.
        expect(session.cancelBufferedMessage('id-1')).toBe(false);
    });
});

describe('PiSession history transaction gate', () => {
    it('defers a prompt during clone/restore and drains it FIFO after source restoration', () => {
        const session = createMockSession();
        const sent: string[] = [];
        const release = session.beginHistoryTransaction();
        session.runWhenHistoryIdle(() => sent.push('first'), 'first');
        session.runWhenHistoryIdle(() => sent.push('second'), 'second');

        expect(sent).toEqual([]);
        expect(session.cancelBufferedMessage('second')).toBe(true);
        release();

        expect(sent).toEqual(['first']);
        expect(session.isHistoryTransactionActive).toBe(false);
    });
});

describe('PiSession runtime mutation mutex', () => {
    it('serializes config-like mutations FIFO and releases after the active mutation settles', async () => {
        const session = createMockSession();
        const order: string[] = [];
        let finishFirst!: () => void;

        const first = session.runRuntimeMutation(async () => {
            order.push('first-start');
            await new Promise<void>((resolve) => { finishFirst = resolve; });
            order.push('first-end');
        });
        const second = session.runRuntimeMutation(async () => {
            order.push('second-start');
        });

        await vi.waitFor(() => expect(order).toEqual(['first-start']));
        expect(order).not.toContain('second-start');

        finishFirst();
        await Promise.all([first, second]);

        expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    });

    it('keeps the lease poisoned when a mutation outcome is indeterminate', async () => {
        const session = createMockSession();
        const timeout = new Error('timed out');
        let secondStarted = false;

        await expect(session.runRuntimeMutation(
            async () => { throw timeout; },
            { poisonOnError: (error) => error === timeout },
        )).rejects.toBe(timeout);
        void session.runRuntimeMutation(async () => { secondStarted = true; });
        await Promise.resolve();
        await Promise.resolve();

        expect(secondStarted).toBe(false);
    });
});

describe('PiSession streaming generation', () => {
    it('increments only on false-to-true transitions and is hidden while idle', () => {
        const session = createMockSession();

        expect(session.currentStreamingGeneration).toBeNull();
        session.updateThinkingState(true);
        const firstGeneration = session.currentStreamingGeneration;
        expect(firstGeneration).toBe(1);

        // Repeated lifecycle/get_state confirmations for the same turn do not
        // mint a new identity.
        session.updateThinkingState(true);
        expect(session.currentStreamingGeneration).toBe(firstGeneration);

        session.applyNativeRuntimeState({ isStreaming: false });
        expect(session.currentStreamingGeneration).toBeNull();
        session.applyNativeRuntimeState({ isStreaming: true });
        expect(session.currentStreamingGeneration).toBe(2);
    });

    it('invalidates a streaming generation when rewind commits a new native branch', () => {
        const session = createMockSession();
        session.updateThinkingState(true);
        const sourceGeneration = session.currentStreamingGeneration;

        session.commitNativeSessionState(
            { sessionId: 'rewound-session', sessionFile: '/tmp/rewound-session.jsonl' },
            { isStreaming: true },
        );

        expect(session.currentStreamingGeneration).not.toBe(sourceGeneration);
        expect(session.currentStreamingGeneration).toBe(2);
    });
});

describe('PiSession native runtime reconciliation', () => {
    it('preserves an omitted provider only when the reported model is unchanged', () => {
        const session = createMockSession();
        session.currentModel = 'same-model';
        session.currentProvider = 'known-provider';

        session.applyNativeRuntimeState({ model: 'same-model' });
        expect(session.currentProvider).toBe('known-provider');

        session.applyNativeRuntimeState({ model: 'different-model' });
        expect(session.currentProvider).toBeNull();
    });

    it('infers an omitted provider only from a unique available-model match', () => {
        const session = createMockSession();
        session.currentModel = 'old-model';
        session.currentProvider = 'old-provider';
        session.cachedPiModels = [
            { modelId: 'new-model', provider: 'new-provider' },
            { modelId: 'other-model', provider: 'other-provider' },
        ];

        session.applyNativeRuntimeState({ model: 'new-model' });

        expect(session.currentProvider).toBe('new-provider');
    });
});
