import { describe, expect, it } from 'vitest';
import { PiPromptQueue, isPiSpecialQueued, type PiPreparedPrompt, type PiPromptQueueEntry } from './promptQueue';

/** Narrow a dequeued entry to the prompt variant for assertions. */
function promptOf(entry: PiPromptQueueEntry | undefined): PiPreparedPrompt {
    expect(entry).toBeDefined();
    if (!entry || isPiSpecialQueued(entry)) {
        throw new Error('expected a prompt entry');
    }
    return entry;
}

describe('PiPromptQueue', () => {
    it('preserves FIFO and permits cancellation before a Pi turn starts', () => {
        const queue = new PiPromptQueue();
        queue.enqueue({ message: 'first', images: [], outboundSequence: 1, localId: 'one' });
        queue.enqueue({ message: 'cancel', images: [], outboundSequence: 2, localId: 'two' });
        queue.enqueue({ message: 'third', images: [], outboundSequence: 3, localId: 'three' });
        expect(queue.cancelByLocalId('two')).toBe(true);
        expect(promptOf(queue.dequeue()).message).toBe('first');
        expect(promptOf(queue.dequeue()).message).toBe('third');
        expect(queue.dequeue()).toBeUndefined();
    });

    it('inserts a delayed steer fallback ahead of a later ordinary prompt', () => {
        const queue = new PiPromptQueue();
        queue.enqueue({ message: 'later ordinary', images: [], outboundSequence: 2, localId: 'two' });
        queue.enqueue({ message: 'earlier steer fallback', images: [], outboundSequence: 1, localId: 'one' });

        expect(promptOf(queue.dequeue()).message).toBe('earlier steer fallback');
        expect(promptOf(queue.dequeue()).message).toBe('later ordinary');
    });

    it('removes a queued entry by localId for explicit steer promotion', () => {
        const queue = new PiPromptQueue();
        queue.enqueue({ message: 'first', images: [], outboundSequence: 1, localId: 'one' });
        queue.enqueue({ message: 'steer me', images: [], outboundSequence: 2, localId: 'two' });
        queue.enqueue({ message: 'third', images: [], outboundSequence: 3, localId: 'three' });

        const removed = queue.removeByLocalId('two');
        expect(promptOf(removed).message).toBe('steer me');
        expect(promptOf(removed).localId).toBe('two');
        // Remaining order preserved.
        expect(promptOf(queue.dequeue()).message).toBe('first');
        expect(promptOf(queue.dequeue()).message).toBe('third');
        expect(queue.dequeue()).toBeUndefined();
    });

    it('returns undefined when removing an absent or already-dispatched localId', () => {
        const queue = new PiPromptQueue();
        queue.enqueue({ message: 'only', images: [], outboundSequence: 1, localId: 'one' });

        expect(queue.removeByLocalId('missing')).toBeUndefined();
        expect(queue.removeByLocalId('')).toBeUndefined();
        expect(promptOf(queue.removeByLocalId('one')).message).toBe('only');
        expect(queue.removeByLocalId('one')).toBeUndefined();
    });
});

describe('PiPromptQueue.hasLocalId', () => {
    it('reports whether the FIFO still holds an entry', () => {
        const q = new PiPromptQueue()
        expect(q.hasLocalId('l1')).toBe(false)
        q.enqueue({ kind: 'prompt', message: 'hi', images: [], outboundSequence: 1, localId: 'l1' })
        expect(q.hasLocalId('l1')).toBe(true)
        expect(q.hasLocalId('l2')).toBe(false)
        expect(q.dequeue()).toBeDefined()
        expect(q.hasLocalId('l1')).toBe(false)
    })
})
