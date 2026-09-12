import { logger } from "@/ui/logger";

export interface QueueItem<T> {
    message: string;
    mode: T;
    modeHash: string;
    localId?: string;
    isolate?: boolean; // If true, this message must be processed alone
    /** Stable FIFO key used when an async reservation is restored later. */
    enqueueOrder?: number;
}

export type QueueReservation<T> = {
    item: QueueItem<T>;
    index: number;
    previousItem: QueueItem<T> | null;
    nextItem: QueueItem<T> | null;
    /** Once ambiguous, retries must remain held unless explicitly committed. */
    originIndeterminate: boolean;
    cancelReason?: 'explicit' | 'queue-reset';
    state: 'reserved' | 'dispatching' | 'indeterminate' | 'cancelled';
};

/**
 * A mode-aware message queue that stores messages with their modes.
 * Returns consistent batches of messages with the same mode.
 */
export class MessageQueue2<T> {
    public queue: QueueItem<T>[] = []; // Made public for testing
    private waiter: ((hasMessages: boolean) => void) | null = null;
    private closed = false;
    private onMessageHandler: ((message: string, mode: T) => void) | null = null;
    onBatchConsumed: ((localIds: string[]) => void) | null = null;
    modeHasher: (mode: T) => string;
    private readonly reservations = new Map<string, QueueReservation<T>>();
    private readonly consumedReservations = new Set<string>();
    private nextEnqueueOrder = 0;
    private previousEnqueueOrder = -1;

    constructor(
        modeHasher: (mode: T) => string,
        onMessageHandler: ((message: string, mode: T) => void) | null = null
    ) {
        this.modeHasher = modeHasher;
        this.onMessageHandler = onMessageHandler;
        logger.debug(`[MessageQueue2] Initialized`);
    }

    /**
     * Set a handler that will be called when a message arrives
     */
    setOnMessage(handler: ((message: string, mode: T) => void) | null): void {
        this.onMessageHandler = handler;
    }

    /**
     * Push a message to the queue with a mode.
     */
    push(message: string, mode: T, localId?: string): void {
        if (this.closed) {
            throw new Error('Cannot push to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] push() called with mode hash: ${modeHash}`);

        const item = {
            message,
            mode,
            modeHash,
            localId,
            isolate: false,
            enqueueOrder: this.nextEnqueueOrder++
        };
        Object.defineProperty(item, 'enqueueOrder', { value: item.enqueueOrder, enumerable: false, writable: true });
        this.queue.push(item);

        // Trigger message handler if set
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode);
        }

        // Notify waiter if any
        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }

        logger.debug(`[MessageQueue2] push() completed. Queue size: ${this.queue.length}`);
    }

    /**
     * Push a message immediately without batching delay.
     * Does not clear the queue or enforce isolation.
     */
    pushImmediate(message: string, mode: T, localId?: string): void {
        if (this.closed) {
            throw new Error('Cannot push to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] pushImmediate() called with mode hash: ${modeHash}`);

        const item = {
            message,
            mode,
            modeHash,
            localId,
            isolate: false,
            enqueueOrder: this.nextEnqueueOrder++
        };
        Object.defineProperty(item, 'enqueueOrder', { value: item.enqueueOrder, enumerable: false, writable: true });
        this.queue.push(item);

        // Trigger message handler if set
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode);
        }

        // Notify waiter if any
        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter for immediate message`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }

        logger.debug(`[MessageQueue2] pushImmediate() completed. Queue size: ${this.queue.length}`);
    }

    /**
     * Push a message that must be processed in isolation, preserving any
     * messages already queued ahead of it. The new message is never batched
     * with siblings (neither the ones before it, nor any that arrive after).
     * Use this when a slash command must run alone but earlier prompts must
     * still be delivered in order.
     */
    pushIsolated(message: string, mode: T, localId?: string): void {
        if (this.closed) {
            throw new Error('Cannot push to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] pushIsolated() called with mode hash: ${modeHash} - preserving ${this.queue.length} pending messages`);

        const item = {
            message,
            mode,
            modeHash,
            localId,
            isolate: true,
            enqueueOrder: this.nextEnqueueOrder++
        };
        Object.defineProperty(item, 'enqueueOrder', { value: item.enqueueOrder, enumerable: false, writable: true });
        this.queue.push(item);

        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode);
        }

        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter for isolated message`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }

        logger.debug(`[MessageQueue2] pushIsolated() completed. Queue size: ${this.queue.length}`);
    }

    /**
     * Push a message that must be processed in complete isolation.
     * Clears any pending messages and ensures this message is never batched with others.
     * Used for special commands that require dedicated processing.
     */
    pushIsolateAndClear(message: string, mode: T, localId?: string): void {
        if (this.closed) {
            throw new Error('Cannot push to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] pushIsolateAndClear() called with mode hash: ${modeHash} - clearing ${this.queue.length} pending messages`);

        // Clear any pending messages to ensure this message is processed in complete isolation
        this.queue = [];
        // Reservations live outside this.queue; a steer awaiting an explicit
        // rejection must not restore a prompt the clear command discarded.
        this.cancelReservations();

        const item = {
            message,
            mode,
            modeHash,
            localId,
            isolate: true,
            enqueueOrder: this.nextEnqueueOrder++
        };
        Object.defineProperty(item, 'enqueueOrder', { value: item.enqueueOrder, enumerable: false, writable: true });
        this.queue.push(item);

        // Trigger message handler if set
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode);
        }

        // Notify waiter if any
        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter for isolated message`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }

        logger.debug(`[MessageQueue2] pushIsolateAndClear() completed. Queue size: ${this.queue.length}`);
    }

    /**
     * Push a message to the beginning of the queue with a mode.
     */
    unshift(message: string, mode: T, localId?: string): void {
        if (this.closed) {
            throw new Error('Cannot unshift to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] unshift() called with mode hash: ${modeHash}`);

        const item = {
            message,
            mode,
            modeHash,
            localId,
            isolate: false,
            enqueueOrder: this.previousEnqueueOrder--
        };
        Object.defineProperty(item, 'enqueueOrder', { value: item.enqueueOrder, enumerable: false, writable: true });
        this.queue.unshift(item);

        // Trigger message handler if set
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode);
        }

        // Notify waiter if any
        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }

        logger.debug(`[MessageQueue2] unshift() completed. Queue size: ${this.queue.length}`);
    }

    /**
     * Push a message to the beginning of the queue with isolation preserved.
     * Mirrors `pushIsolated` but inserts at the head. Use this when requeueing a
     * batch that was originally collected under isolation (e.g. a slash command
     * that failed transiently and must retry without batching against sibling
     * prompts).
     */
    unshiftIsolated(message: string, mode: T, localId?: string): void {
        if (this.closed) {
            throw new Error('Cannot unshift to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] unshiftIsolated() called with mode hash: ${modeHash}`);

        const item = {
            message,
            mode,
            modeHash,
            localId,
            isolate: true,
            enqueueOrder: this.previousEnqueueOrder--
        };
        Object.defineProperty(item, 'enqueueOrder', { value: item.enqueueOrder, enumerable: false, writable: true });
        this.queue.unshift(item);

        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode);
        }

        if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }

        logger.debug(`[MessageQueue2] unshiftIsolated() completed. Queue size: ${this.queue.length}`);
    }

    /**
     * Remove the first queued message that matches the given localId.
     * Returns true if a message was removed, false if not found.
     * Best-effort: if the CLI is offline when cancel is issued, the message
     * may already have been collected for invocation and won't be found here.
     */
    cancelByLocalId(localId: string): boolean | 'in-flight' | 'indeterminate' | 'consumed' {
        if (!localId) return false;
        const idx = this.queue.findIndex(item => item.localId === localId);
        if (idx !== -1) {
            this.queue.splice(idx, 1);
            return true;
        }
        const reservation = this.reservations.get(localId);
        if (!reservation) {
            return this.consumedReservations.has(localId) ? 'consumed' : false;
        }
        if (reservation.state === 'dispatching') {
            // The row is inside an async steer: it cannot be removed, but it is
            // also NOT already consumed — the hub must not stamp invoked_at.
            return 'in-flight';
        }
        if (reservation.state === 'indeterminate') {
            // Explicit Cancel/ Edit is the user's resolution of an unknown
            // outcome; release the held reservation so it cannot settle later.
            reservation.cancelReason = 'explicit';
            reservation.state = 'cancelled';
            this.reservations.delete(localId);
            return true;
        }
        reservation.cancelReason = 'explicit';
        reservation.state = 'cancelled';
        this.reservations.delete(localId);
        return true;
    }

    /**
     * Look up a queued item by localId without removing it.
     */
    peekByLocalId(localId: string): QueueItem<T> | null {
        if (!localId) return null;
        return this.queue.find(item => item.localId === localId) ?? null;
    }

    /**
     * Remove and return a queued item by localId (with its original index),
     * or null if not found. Pair with {@link restoreTakenItem} when an async
     * operation may need to put the item back in order.
     */
    takeByLocalId(localId: string): QueueReservation<T> | null {
        if (!localId) return null;

        // An indeterminate steer is deliberately held outside the normal queue.
        // A later explicit Steer retries that same reservation; automatic queue
        // drains never see it.
        const existing = this.reservations.get(localId);
        if (existing) {
            if (existing.state !== 'indeterminate') return null;
            existing.state = 'reserved';
            return existing;
        }

        const idx = this.queue.findIndex(item => item.localId === localId);
        if (idx === -1) return null;
        const [item] = this.queue.splice(idx, 1);
        if (!item) return null;
        const reservation: QueueReservation<T> = {
            item,
            index: idx,
            previousItem: this.queue[idx - 1] ?? null,
            nextItem: this.queue[idx] ?? null,
            originIndeterminate: false,
            state: 'reserved'
        };
        if (item.localId) {
            this.reservations.set(item.localId, reservation);
        }
        return reservation;
    }

    /**
     * Re-insert an item previously removed by {@link takeByLocalId} at its
     * original index (clamped if the queue shrank).
     */
    restoreReservation(reservation: QueueReservation<T>): boolean {
        if (reservation.state === 'cancelled') {
            return false;
        }
        if (reservation.originIndeterminate) {
            reservation.state = 'indeterminate';
            return true;
        }
        if (this.closed) {
            throw new Error('Cannot restore into closed queue');
        }
        if (reservation.item.localId) {
            if (this.reservations.get(reservation.item.localId) !== reservation) {
                return false;
            }
            this.reservations.delete(reservation.item.localId);
        }
        const order = reservation.item.enqueueOrder;
        const orderedIndex = order === undefined
            ? -1
            : this.queue.findIndex((item) => item.enqueueOrder !== undefined && item.enqueueOrder > order);
        const nextIndex = reservation.nextItem
            ? this.queue.indexOf(reservation.nextItem)
            : -1;
        const previousIndex = reservation.previousItem
            ? this.queue.indexOf(reservation.previousItem)
            : -1;
        const idx = orderedIndex >= 0
            ? orderedIndex
            : nextIndex >= 0
                ? nextIndex
                : previousIndex >= 0
                    ? previousIndex + 1
                    : this.queue.length;
        this.queue.splice(idx, 0, reservation.item);
        if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }
        return true;
    }

    commitReservation(reservation: QueueReservation<T>): boolean {
        if (reservation.state === 'cancelled' && reservation.cancelReason !== 'queue-reset') {
            return false;
        }
        if (reservation.item.localId) {
            const active = this.reservations.get(reservation.item.localId);
            if (active === reservation) {
                this.reservations.delete(reservation.item.localId);
            } else if (reservation.cancelReason !== 'queue-reset') {
                return false;
            }
            this.rememberConsumedReservation(reservation.item.localId);
        }
        return true;
    }

    beginReservationDispatch(reservation: QueueReservation<T>): boolean {
        if (reservation.state !== 'reserved') {
            return false;
        }
        if (reservation.item.localId && this.reservations.get(reservation.item.localId) !== reservation) {
            return false;
        }
        reservation.state = 'dispatching';
        return true;
    }

    restoreTakenItem(taken: QueueReservation<T>): void {
        this.restoreReservation(taken);
    }

    /** Release a held reservation only for the explicit retry path. */
    releaseIndeterminateReservation(localId: string): boolean {
        const reservation = this.reservations.get(localId);
        if (!reservation || reservation.state !== 'indeterminate') return false;
        reservation.cancelReason = 'explicit';
        reservation.state = 'cancelled';
        this.reservations.delete(localId);
        return true;
    }

    /** Hold a dispatched steer for explicit retry/cancel without replaying it. */
    markReservationIndeterminate(reservation: QueueReservation<T>): boolean {
        if (reservation.state !== 'dispatching') return false;
        if (reservation.item.localId && this.reservations.get(reservation.item.localId) !== reservation) {
            return false;
        }
        reservation.originIndeterminate = true;
        reservation.state = 'indeterminate';
        return true;
    }

    private rememberConsumedReservation(localId: string): void {
        this.consumedReservations.delete(localId);
        this.consumedReservations.add(localId);
        while (this.consumedReservations.size > 256) {
            const oldest = this.consumedReservations.values().next().value;
            if (oldest === undefined) break;
            this.consumedReservations.delete(oldest);
        }
    }

    private cancelReservations(preserveDispatching = false): void {
        for (const [localId, reservation] of this.reservations) {
            if (preserveDispatching && (reservation.state === 'dispatching' || reservation.state === 'indeterminate')) {
                continue;
            }
            reservation.cancelReason = 'queue-reset';
            reservation.state = 'cancelled';
            this.reservations.delete(localId);
        }
    }

    /**
     * Reset the queue - clears all messages and resets to empty state
     */
    reset(options?: { preserveDispatchingReservations?: boolean }): void {
        logger.debug(`[MessageQueue2] reset() called. Clearing ${this.queue.length} messages`);
        this.queue = [];
        this.cancelReservations(options?.preserveDispatchingReservations === true);
        this.closed = false;

        // Clear waiter without calling it since we're not closing
        this.waiter = null;
    }

    /**
     * localIds of messages still pending in the queue (enqueued but not yet
     * consumed/acked). Lets a caller reconcile them with the hub before a
     * reset() that would otherwise drop them without an ack.
     */
    pendingLocalIds(): string[] {
        return this.queue
            .map((item) => item.localId)
            .filter((id): id is string => typeof id === 'string');
    }

    /**
     * Close the queue - no more messages can be pushed
     */
    close(): void {
        logger.debug(`[MessageQueue2] close() called`);
        this.closed = true;
        this.cancelReservations();

        // Notify any waiting caller
        if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = null;
            waiter(false);
        }
    }

    /**
     * Check if the queue is closed
     */
    isClosed(): boolean {
        return this.closed;
    }

    /**
     * Get the current queue size
     */
    size(): number {
        return this.queue.length;
    }

    /**
     * Wait for messages and return all messages with the same mode as a single string
     * Returns { message: string, mode: T } or null if aborted/closed
     */
    async waitForMessagesAndGetAsString(abortSignal?: AbortSignal): Promise<{ message: string, mode: T, isolate: boolean, hash: string, items: Array<{ message: string, localId?: string }> } | null> {
        // If we have messages, return them immediately
        if (this.queue.length > 0) {
            return this.collectBatch();
        }

        // If closed or already aborted, return null
        if (this.closed || abortSignal?.aborted) {
            return null;
        }

        // Wait for messages to arrive
        const hasMessages = await this.waitForMessages(abortSignal);

        if (!hasMessages) {
            return null;
        }

        return this.collectBatch();
    }

    /**
     * Collect a batch of messages with the same mode, respecting isolation requirements
     */
    private collectBatch(): { message: string, mode: T, hash: string, isolate: boolean, items: Array<{ message: string, localId?: string }> } | null {
        if (this.queue.length === 0) {
            return null;
        }

        const firstItem = this.queue[0];
        const sameModeMessages: string[] = [];
        const consumedLocalIds: string[] = [];
        // Per-item breakdown of this batch, preserved alongside the joined
        // `message` string below so callers that need to requeue individual
        // messages (e.g. restoring a failed batch with each item's own
        // localId intact) don't have to re-split an already-joined string.
        const items: Array<{ message: string, localId?: string }> = [];
        let mode = firstItem.mode;
        let isolate = firstItem.isolate ?? false;
        const targetModeHash = firstItem.modeHash;

        // If the first message requires isolation, only process it alone
        if (firstItem.isolate) {
            const item = this.queue.shift()!;
            sameModeMessages.push(item.message);
            items.push({ message: item.message, localId: item.localId });
            if (item.localId) consumedLocalIds.push(item.localId);
            logger.debug(`[MessageQueue2] Collected isolated message with mode hash: ${targetModeHash}`);
        } else {
            // Collect all messages with the same mode until we hit an isolated message
            while (this.queue.length > 0 &&
                this.queue[0].modeHash === targetModeHash &&
                !this.queue[0].isolate) {
                const item = this.queue.shift()!;
                sameModeMessages.push(item.message);
                items.push({ message: item.message, localId: item.localId });
                if (item.localId) consumedLocalIds.push(item.localId);
            }
            logger.debug(`[MessageQueue2] Collected batch of ${sameModeMessages.length} messages with mode hash: ${targetModeHash}`);
        }

        // Join all messages with newlines
        const combinedMessage = sameModeMessages.join('\n');

        if (consumedLocalIds.length > 0) {
            this.onBatchConsumed?.(consumedLocalIds);
        }

        return {
            message: combinedMessage,
            mode,
            hash: targetModeHash,
            isolate,
            items
        };
    }

    /**
     * Wait for messages to arrive
     */
    private waitForMessages(abortSignal?: AbortSignal): Promise<boolean> {
        return new Promise((resolve) => {
            let settled = false;
            let abortHandler: (() => void) | null = null;
            let waiterFunc: (hasMessages: boolean) => void;

            const finish = (hasMessages: boolean) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (this.waiter === waiterFunc) {
                    this.waiter = null;
                }
                // Clean up abort handler
                if (abortHandler && abortSignal) {
                    abortSignal.removeEventListener('abort', abortHandler);
                }
                resolve(hasMessages);
            };

            waiterFunc = (hasMessages: boolean) => {
                finish(hasMessages);
            };

            // Set up abort handler
            if (abortSignal) {
                abortHandler = () => {
                    logger.debug('[MessageQueue2] Wait aborted');
                    finish(false);
                };
                abortSignal.addEventListener('abort', abortHandler);
            }

            // Set the waiter before checking the queue to avoid missed notifications
            this.waiter = waiterFunc;

            // Check again in case messages arrived or queue closed while setting up
            if (this.queue.length > 0) {
                finish(true);
                return;
            }

            if (this.closed || abortSignal?.aborted) {
                finish(false);
                return;
            }

            logger.debug('[MessageQueue2] Waiting for messages...');
        });
    }
}
