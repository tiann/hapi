import { describe, expect, it } from 'vitest';
import { PiPromptQueue } from './promptQueue';

describe('PiPromptQueue', () => {
    it('preserves FIFO and permits cancellation before a Pi turn starts', () => {
        const queue = new PiPromptQueue();
        queue.enqueue({ message: 'first', images: [], outboundSequence: 1, localId: 'one' });
        queue.enqueue({ message: 'cancel', images: [], outboundSequence: 2, localId: 'two' });
        queue.enqueue({ message: 'third', images: [], outboundSequence: 3, localId: 'three' });
        expect(queue.cancelByLocalId('two')).toBe(true);
        expect(queue.dequeue()?.message).toBe('first');
        expect(queue.dequeue()?.message).toBe('third');
        expect(queue.dequeue()).toBeUndefined();
    });

    it('inserts a delayed steer fallback ahead of a later ordinary prompt', () => {
        const queue = new PiPromptQueue();
        queue.enqueue({ message: 'later ordinary', images: [], outboundSequence: 2, localId: 'two' });
        queue.enqueue({ message: 'earlier steer fallback', images: [], outboundSequence: 1, localId: 'one' });

        expect(queue.dequeue()?.message).toBe('earlier steer fallback');
        expect(queue.dequeue()?.message).toBe('later ordinary');
    });
});
