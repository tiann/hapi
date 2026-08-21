import { describe, expect, it } from 'vitest';
import { PiMessageAccumulator } from './piMessageAccumulator';

const event = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra });

describe('PiMessageAccumulator', () => {
    it('streams throttled cumulative text and reasoning snapshots with separate stable ids', () => {
        let now = 0;
        const accumulator = new PiMessageAccumulator({ now: () => now, streamNonceFactory: () => 'nonce' });
        accumulator.handleEvent(event('turn_start'));
        accumulator.handleEvent(event('message_start'));

        const first = accumulator.handleEvent(event('message_update', {
            assistantMessageEvent: { type: 'thinking_delta', delta: 'think ' },
        }));
        expect(first).toEqual([{
            type: 'reasoning', text: 'think ', id: 'pi-nonce-turn-1-message-1-reasoning-0', live: true,
        }]);

        now = 100;
        expect(accumulator.handleEvent(event('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'answer' },
        }))).toEqual([]);

        now = 250;
        expect(accumulator.handleEvent(event('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: '!' },
        }))).toEqual([{
            type: 'text', text: 'answer!', id: 'pi-nonce-turn-1-message-1-text-0', streamSnapshot: true, live: true,
        }]);
    });

    it('flushes the final changed snapshot once at message_end and close/error boundaries', () => {
        let now = 0;
        const accumulator = new PiMessageAccumulator({ now: () => now, streamNonceFactory: () => 'nonce' });
        accumulator.handleEvent(event('message_start'));
        accumulator.handleEvent(event('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'first' },
        }));
        now = 100;
        expect(accumulator.handleEvent(event('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: ' second' },
        }))).toEqual([]);
        expect(accumulator.handleEvent(event('message_end'))).toEqual([{
            type: 'text', text: 'first second', id: 'pi-nonce-turn-0-message-1-text-0', streamSnapshot: true,
        }]);
        expect(accumulator.handleEvent(event('message_end'))).toEqual([]);

        accumulator.handleEvent(event('message_start'));
        accumulator.handleEvent(event('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'partial' },
        }));
        now = 200;
        accumulator.handleEvent(event('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: ' answer' },
        }));
        expect(accumulator.flush()).toEqual([{
            type: 'text', text: 'partial answer', id: 'pi-nonce-turn-0-message-2-text-0', streamSnapshot: true,
        }]);
        expect(accumulator.flush()).toEqual([]);
    });

    it('emits a terminal text snapshot when the live snapshot already has the final text', () => {
        const accumulator = new PiMessageAccumulator({ now: () => 0, streamNonceFactory: () => 'nonce' });
        accumulator.handleEvent(event('message_start'));
        expect(accumulator.handleEvent(event('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'complete already' },
        }))).toEqual([{
            type: 'text', text: 'complete already', id: 'pi-nonce-turn-0-message-1-text-0',
            streamSnapshot: true, live: true,
        }]);

        expect(accumulator.handleEvent(event('message_end'))).toEqual([{
            type: 'text', text: 'complete already', id: 'pi-nonce-turn-0-message-1-text-0',
            streamSnapshot: true,
        }]);
    });

    it('keeps multiple content indexes separate instead of concatenating blocks', () => {
        let now = 0;
        const accumulator = new PiMessageAccumulator({ now: () => now, streamNonceFactory: () => 'nonce' });
        accumulator.handleEvent(event('message_start'));
        const first = accumulator.handleEvent(event('message_update', {
            assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'alpha' },
        }));
        expect(first).toHaveLength(1);
        now = 300;
        const second = accumulator.handleEvent(event('message_update', {
            assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'beta' },
        }));
        expect(second).toEqual([{
            type: 'text', text: 'beta', id: 'pi-nonce-turn-0-message-1-text-1', streamSnapshot: true, live: true,
        }]);
    });

    it('emits an error AgentMessage when message_end reports stopReason error, once across turn_end', () => {
        const accumulator = new PiMessageAccumulator({ now: () => 0, streamNonceFactory: () => 'nonce' });
        accumulator.handleEvent(event('turn_start'));
        accumulator.handleEvent(event('message_start'));
        expect(accumulator.handleEvent(event('message_end', {
            message: { role: 'assistant', stopReason: 'error', errorMessage: 'Provider 529: overloaded' },
        }))).toEqual([{ type: 'error', message: 'Provider 529: overloaded' }]);
        // Pi repeats the failed message on turn_end — must not duplicate.
        expect(accumulator.handleEvent(event('turn_end', {
            message: { stopReason: 'error', errorMessage: 'Provider 529: overloaded' },
        }))).toEqual([]);
    });

    it('appends the error after flushed partial text', () => {
        let now = 0;
        const accumulator = new PiMessageAccumulator({ now: () => now, streamNonceFactory: () => 'nonce' });
        accumulator.handleEvent(event('turn_start'));
        accumulator.handleEvent(event('message_start'));
        expect(accumulator.handleEvent(event('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'partial answer' },
        }))).toEqual([{
            type: 'text', text: 'partial answer', id: 'pi-nonce-turn-1-message-1-text-0', streamSnapshot: true, live: true,
        }]);
        expect(accumulator.handleEvent(event('message_end', {
            message: { stopReason: 'error', errorMessage: 'stream dropped' },
        }))).toEqual([{ type: 'error', message: 'stream dropped' }]);
    });

    it('falls back to turn_end when Pi skips message_end on stream failure', () => {
        const accumulator = new PiMessageAccumulator({ now: () => 0, streamNonceFactory: () => 'nonce' });
        accumulator.handleEvent(event('turn_start'));
        accumulator.handleEvent(event('message_start'));
        expect(accumulator.handleEvent(event('turn_end', {
            message: { stopReason: 'error', errorMessage: 'network dropped' },
        }))).toEqual([{ type: 'error', message: 'network dropped' }]);
    });

    it('does not emit an error for user-initiated aborts or healthy turns', () => {
        const accumulator = new PiMessageAccumulator({ now: () => 0, streamNonceFactory: () => 'nonce' });
        accumulator.handleEvent(event('message_start'));
        expect(accumulator.handleEvent(event('message_end', {
            message: { role: 'assistant', stopReason: 'aborted' },
        }))).toEqual([]);

        accumulator.handleEvent(event('message_start'));
        expect(accumulator.handleEvent(event('message_end', {
            message: { role: 'assistant', stopReason: 'stop' },
        }))).toEqual([]);
    });

    it('falls back to a generic message when stopReason error carries no errorMessage', () => {
        const accumulator = new PiMessageAccumulator({ now: () => 0, streamNonceFactory: () => 'nonce' });
        accumulator.handleEvent(event('message_start'));
        expect(accumulator.handleEvent(event('turn_end', {
            message: { stopReason: 'error' },
        }))).toEqual([{ type: 'error', message: 'Pi agent error' }]);
    });

    it('does not collide across accumulator instances after a session resume', () => {
        const first = new PiMessageAccumulator({ streamNonceFactory: () => 'before-restart' });
        const second = new PiMessageAccumulator({ streamNonceFactory: () => 'after-restart' });
        for (const accumulator of [first, second]) {
            accumulator.handleEvent(event('turn_start'));
            accumulator.handleEvent(event('message_start'));
        }
        const firstMessage = first.handleEvent(event('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'one' },
        }))[0]!;
        const secondMessage = second.handleEvent(event('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'two' },
        }))[0]!;
        expect(firstMessage.type).toBe('text');
        expect(secondMessage.type).toBe('text');
        if (firstMessage.type === 'text' && secondMessage.type === 'text') {
            expect(firstMessage.id).not.toBe(secondMessage.id);
        }
    });
});
