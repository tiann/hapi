import type { PiImageContent } from './types';
import type { PiSpecialCommand } from './specialCommands';

export type PiPreparedPrompt = {
    message: string;
    images: PiImageContent[];
    /** Monotonic arrival reservation assigned before asynchronous preparation. */
    outboundSequence: number;
    localId?: string;
};

/**
 * A Pi built-in slash command queued through the same FIFO as prompts so
 * dispatch order matches message arrival order (a /compact typed after a
 * prompt never jumps the queue).
 */
export type PiSpecialQueued = {
    kind: 'special';
    command: PiSpecialCommand;
    outboundSequence: number;
    localId?: string;
};

export type PiPromptQueueEntry = PiPreparedPrompt | PiSpecialQueued;

export function isPiSpecialQueued(entry: PiPromptQueueEntry): entry is PiSpecialQueued {
    return 'kind' in entry && entry.kind === 'special';
}

/**
 * Small cancellable FIFO: HAPI owns queueing, Pi receives only real turns.
 *
 * A native steer can asynchronously degrade to a prompt after a later ordinary
 * prompt was prepared. Arrival reservations preserve original message order at
 * that boundary instead of using completion order.
 */
export class PiPromptQueue {
    private readonly entries: PiPromptQueueEntry[] = [];

    enqueue(entry: PiPromptQueueEntry): void {
        const index = this.entries.findIndex((item) => item.outboundSequence > entry.outboundSequence);
        if (index === -1) this.entries.push(entry);
        else this.entries.splice(index, 0, entry);
    }

    dequeue(): PiPromptQueueEntry | undefined {
        return this.entries.shift();
    }

    peek(): PiPromptQueueEntry | undefined {
        return this.entries[0];
    }

    /** True while an entry with this localId sits in the FIFO (not yet dispatched). */
    hasLocalId(localId: string): boolean {
        if (!localId) return false
        return this.entries.some((entry) => entry.localId === localId)
    }

    cancelByLocalId(localId: string): boolean {
        if (!localId) return false;
        const index = this.entries.findIndex((entry) => entry.localId === localId);
        if (index === -1) return false;
        this.entries.splice(index, 1);
        return true;
    }

    /**
     * Remove and return a queued entry by localId — used to promote a message
     * into the active turn (explicit steer). Returns undefined when the entry
     * is absent (already dispatched, cancelled, or still preparing).
     */
    removeByLocalId(localId: string): PiPromptQueueEntry | undefined {
        if (!localId) return undefined;
        const index = this.entries.findIndex((entry) => entry.localId === localId);
        if (index === -1) return undefined;
        const [entry] = this.entries.splice(index, 1);
        return entry;
    }

    get size(): number {
        return this.entries.length;
    }
}
