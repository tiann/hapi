import { describe, expect, it } from 'vitest';
import { PiPromptQueue } from './promptQueue';

describe('PiPromptQueue', () => {
    it('preserves FIFO and permits cancellation before a Pi turn starts', () => {
        const queue = new PiPromptQueue();
        queue.enqueue({ message: 'first', images: [], localId: 'one' });
        queue.enqueue({ message: 'cancel', images: [], localId: 'two' });
        queue.enqueue({ message: 'third', images: [], localId: 'three' });
        expect(queue.cancelByLocalId('two')).toBe(true);
        expect(queue.dequeue()?.message).toBe('first');
        expect(queue.dequeue()?.message).toBe('third');
        expect(queue.dequeue()).toBeUndefined();
    });
});
