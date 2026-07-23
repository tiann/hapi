import { describe, it, expect } from 'vitest';
import { OmpMessageAccumulator } from './ompMessageAccumulator';

describe('OmpMessageAccumulator', () => {
    function makeEvent(type: string, extra: Record<string, unknown> = {}): any {
        return { type, ...extra };
    }

    it('returns empty for events that are not handled', () => {
        const acc = new OmpMessageAccumulator();
        expect(acc.handleEvent(makeEvent('agent_start'))).toEqual([]);
        expect(acc.handleEvent(makeEvent('turn_start'))).toEqual([]);
        expect(acc.handleEvent(makeEvent('turn_end'))).toEqual([]);
        expect(acc.handleEvent(makeEvent('agent_end'))).toEqual([]);
    });

    it('accumulates text deltas and flushes one text message on message_end', () => {
        const acc = new OmpMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        expect(acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'hello ' }
        }))).toEqual([]);
        expect(acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'world' }
        }))).toEqual([]);

        const flushed = acc.handleEvent(makeEvent('message_end', { message: {} }));
        expect(flushed).toEqual([{ type: 'text', text: 'hello world' }]);
    });

    it('accumulates thinking deltas and flushes one reasoning message on message_end', () => {
        const acc = new OmpMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'thinking_delta', delta: 'let me ' }
        }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'thinking_delta', delta: 'think...' }
        }));

        const flushed = acc.handleEvent(makeEvent('message_end', { message: {} }));
        expect(flushed).toEqual([{ type: 'reasoning', text: 'let me think...', id: 'omp-stream' }]);
    });

    it('flushes both reasoning and text in order on message_end', () => {
        const acc = new OmpMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' }
        }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'reply' }
        }));

        const flushed = acc.handleEvent(makeEvent('message_end', { message: {} }));
        expect(flushed).toEqual([
            { type: 'reasoning', text: 'thinking', id: 'omp-stream' },
            { type: 'text', text: 'reply' }
        ]);
    });

    it('skips empty content on flush', () => {
        const acc = new OmpMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'only text' }
        }));
        const flushed = acc.handleEvent(makeEvent('message_end', { message: {} }));
        expect(flushed).toEqual([{ type: 'text', text: 'only text' }]);
    });

    it('uses contentIndex as streamId when provided', () => {
        const acc = new OmpMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'x', contentIndex: 2 }
        }));
        const flushed = acc.handleEvent(makeEvent('message_end', { message: {} }));
        expect(flushed).toEqual([{ type: 'text', text: 'x' }]);
    });

    it('resets state on the next message_start', () => {
        const acc = new OmpMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'first' }
        }));
        acc.handleEvent(makeEvent('message_end', { message: {} }));

        acc.handleEvent(makeEvent('message_start', { message: {} }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'second' }
        }));
        const flushed = acc.handleEvent(makeEvent('message_end', { message: {} }));
        expect(flushed).toEqual([{ type: 'text', text: 'second' }]);
    });

    it('flushes on turn_end as a safety net (no message_end received)', () => {
        const acc = new OmpMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'incomplete' }
        }));
        const flushed = acc.handleEvent(makeEvent('turn_end', { message: {} }));
        expect(flushed).toEqual([{ type: 'text', text: 'incomplete' }]);
    });

    it('does not flush on turn_end if no message_start was seen', () => {
        const acc = new OmpMessageAccumulator();
        expect(acc.handleEvent(makeEvent('turn_end', { message: {} }))).toEqual([]);
    });

    it('does not flush twice on message_end', () => {
        const acc = new OmpMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'once' }
        }));
        expect(acc.handleEvent(makeEvent('message_end', { message: {} }))).toEqual([
            { type: 'text', text: 'once' }
        ]);
        expect(acc.handleEvent(makeEvent('message_end', { message: {} }))).toEqual([]);
    });

    it('ignores text_start/thinking_start/text_end/thinking_end (full snapshots cause duplicates)', () => {
        const acc = new OmpMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        acc.handleEvent(makeEvent('message_update', { assistantMessageEvent: { type: 'text_start' } }));
        acc.handleEvent(makeEvent('message_update', { assistantMessageEvent: { type: 'thinking_start' } }));
        acc.handleEvent(makeEvent('message_update', { assistantMessageEvent: { type: 'text_end' } }));
        acc.handleEvent(makeEvent('message_update', { assistantMessageEvent: { type: 'thinking_end' } }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'real content' }
        }));
        const flushed = acc.handleEvent(makeEvent('message_end', { message: {} }));
        expect(flushed).toEqual([{ type: 'text', text: 'real content' }]);
    });

    it('handles message_update without assistantMessageEvent', () => {
        const acc = new OmpMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        expect(() => acc.handleEvent(makeEvent('message_update'))).not.toThrow();
        expect(acc.handleEvent(makeEvent('message_end', { message: {} }))).toEqual([]);
    });
});
