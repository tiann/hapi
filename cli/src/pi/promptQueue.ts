import type { PiImageContent } from './types';

export type PiPreparedPrompt = {
    message: string;
    images: PiImageContent[];
    localId?: string;
};

/** Small cancellable FIFO: HAPI owns queueing, Pi receives only real turns. */
export class PiPromptQueue {
    private readonly entries: PiPreparedPrompt[] = [];

    enqueue(prompt: PiPreparedPrompt): void {
        this.entries.push(prompt);
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
