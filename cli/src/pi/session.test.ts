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
// `new_session`/`get_state` finished, wedging the turn (agent_start then
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
