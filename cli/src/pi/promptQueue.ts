import type { PiImageContent } from './types';

export type PiPreparedPrompt = {
    message: string;
    images: PiImageContent[];
    /** Monotonic arrival reservation assigned before asynchronous preparation. */
    outboundSequence: number;
    localId?: string;
};

/**
 * Small cancellable FIFO: HAPI owns queueing, Pi receives only real turns.
 *
 * A native steer can asynchronously degrade to a prompt after a later ordinary
 * prompt was prepared. Arrival reservations preserve original message order at
 * that boundary instead of using completion order.
 */
export class PiPromptQueue {
    private readonly entries: PiPreparedPrompt[] = [];

    enqueue(prompt: PiPreparedPrompt): void {
        const index = this.entries.findIndex((entry) => entry.outboundSequence > prompt.outboundSequence);
        if (index === -1) this.entries.push(prompt);
        else this.entries.splice(index, 0, prompt);
    }

    dequeue(): PiPreparedPrompt | undefined {
        return this.entries.shift();
    }

    cancelByLocalId(localId: string): boolean {
        if (!localId) return false;
        const index = this.entries.findIndex((entry) => entry.localId === localId);
        if (index === -1) return false;
        this.entries.splice(index, 1);
        return true;
    }

    get size(): number {
        return this.entries.length;
    }
}
