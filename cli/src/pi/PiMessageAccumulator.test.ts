import { describe, it, expect } from 'vitest';
import { PiMessageAccumulator } from './PiMessageAccumulator';

describe('PiMessageAccumulator', () => {
    function makeEvent(type: string, extra: Record<string, unknown> = {}): any {
        return { type, ...extra };
    }

    it('returns empty for events that are not handled', () => {
        const acc = new PiMessageAccumulator();
        expect(acc.handleEvent(makeEvent('agent_start'))).toEqual([]);
        expect(acc.handleEvent(makeEvent('turn_start'))).toEqual([]);
        expect(acc.handleEvent(makeEvent('turn_end'))).toEqual([]);
        expect(acc.handleEvent(makeEvent('agent_end'))).toEqual([]);
    });

    it('accumulates text deltas and flushes one text message on message_end', () => {
        const acc = new PiMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        expect(acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'hello ' }
        }))).toEqual([]);
        expect(acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'world' }
        }))).toEqual([]);

        const flushed = acc.handleEvent(makeEvent('message_end', { message: {} }));
        expect(flushed).toEqual([
            { type: 'text', text: 'hello world', id: 'pi-stream' }
        ]);
    });

    it('accumulates thinking deltas and flushes one reasoning message on message_end', () => {
        const acc = new PiMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'thinking_delta', delta: 'let me ' }
        }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'thinking_delta', delta: 'think...' }
        }));

        const flushed = acc.handleEvent(makeEvent('message_end', { message: {} }));
        expect(flushed).toEqual([
            { type: 'reasoning', text: 'let me think...', id: 'pi-stream' }
        ]);
    });

    it('flushes both reasoning and text in order on message_end', () => {
        const acc = new PiMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' }
        }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'reply' }
        }));

        const flushed = acc.handleEvent(makeEvent('message_end', { message: {} }));
        expect(flushed).toEqual([
            { type: 'reasoning', text: 'thinking', id: 'pi-stream' },
            { type: 'text', text: 'reply', id: 'pi-stream' }
        ]);
    });

    it('skips empty content on flush', () => {
        const acc = new PiMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'only text' }
        }));

        const flushed = acc.handleEvent(makeEvent('message_end', { message: {} }));
        expect(flushed).toEqual([
            { type: 'text', text: 'only text', id: 'pi-stream' }
        ]);
    });

    it('drops empty/missing deltas silently', () => {
        const acc = new PiMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta' }
        }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: '' }
        }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'thinking_delta' }
        }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'thinking_delta', delta: '   ' }
        }));
        const flushed = acc.handleEvent(makeEvent('message_end', { message: {} }));
        expect(flushed).toEqual([
            { type: 'reasoning', text: '   ', id: 'pi-stream' }
        ]);
    });

    it('uses contentIndex as streamId when provided', () => {
        const acc = new PiMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'x', contentIndex: 2 }
        }));
        const flushed = acc.handleEvent(makeEvent('message_end', { message: {} }));
        expect(flushed).toEqual([
            { type: 'text', text: 'x', id: '2' }
        ]);
    });

    it('updates streamId from later deltas', () => {
        const acc = new PiMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'a' }
        }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'b', contentIndex: 7 }
        }));
        const flushed = acc.handleEvent(makeEvent('message_end', { message: {} }));
        expect(flushed).toEqual([
            { type: 'text', text: 'ab', id: '7' }
        ]);
    });

    it('resets state on the next message_start', () => {
        const acc = new PiMessageAccumulator();
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
        expect(flushed).toEqual([
            { type: 'text', text: 'second', id: 'pi-stream' }
        ]);
    });

    it('flushes on turn_end as a safety net (no message_end received)', () => {
        const acc = new PiMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'incomplete' }
        }));
        // No message_end — older Pi builds, partial streams, etc.
        const flushed = acc.handleEvent(makeEvent('turn_end', {
            message: { usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 } }
        }));
        expect(flushed).toEqual([
            { type: 'text', text: 'incomplete', id: 'pi-stream' }
        ]);
    });

    it('does not flush on turn_end if no message_start was seen', () => {
        const acc = new PiMessageAccumulator();
        const flushed = acc.handleEvent(makeEvent('turn_end', { message: {} }));
        expect(flushed).toEqual([]);
    });

    it('does not flush twice on message_end', () => {
        const acc = new PiMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'once' }
        }));
        expect(acc.handleEvent(makeEvent('message_end', { message: {} }))).toEqual([
            { type: 'text', text: 'once', id: 'pi-stream' }
        ]);
        // Second message_end with no content buffered — must be empty,
        // not a duplicate.
        expect(acc.handleEvent(makeEvent('message_end', { message: {} }))).toEqual([]);
    });

    it('ignores text_start / thinking_start / text_end / thinking_end (full snapshots cause duplicates)', () => {
        const acc = new PiMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_start' }
        }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'thinking_start' }
        }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_end' }
        }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'thinking_end' }
        }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'real content' }
        }));
        const flushed = acc.handleEvent(makeEvent('message_end', { message: {} }));
        expect(flushed).toEqual([
            { type: 'text', text: 'real content', id: 'pi-stream' }
        ]);
    });

    it('handles message_update without assistantMessageEvent', () => {
        const acc = new PiMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        expect(() => acc.handleEvent(makeEvent('message_update'))).not.toThrow();
        const flushed = acc.handleEvent(makeEvent('message_end', { message: {} }));
        expect(flushed).toEqual([]);
    });

    it('flushIfActive returns empty when not active', () => {
        const acc = new PiMessageAccumulator();
        expect(acc.flushIfActive()).toEqual([]);
    });

    it('flushIfActive returns content and deactivates', () => {
        const acc = new PiMessageAccumulator();
        acc.handleEvent(makeEvent('message_start', { message: {} }));
        acc.handleEvent(makeEvent('message_update', {
            assistantMessageEvent: { type: 'text_delta', delta: 'leak' }
        }));
        expect(acc.flushIfActive()).toEqual([
            { type: 'text', text: 'leak', id: 'pi-stream' }
        ]);
        // Second call must be empty.
        expect(acc.flushIfActive()).toEqual([]);
    });
});
