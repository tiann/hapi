import { logger } from '@/ui/logger';

export type MessageQueueMessageOrigin = 'push' | 'pushImmediate' | 'pushIsolateAndClear' | 'unshift';
export type MessageQueueItemState = 'queued' | 'reserved' | 'committed' | 'invalidated';

interface QueueItem<T> {
    id: number;
    messageId?: string;
    seq?: number;
    generation?: number;
    state?: MessageQueueItemState;
    reservationId?: string;
    message: string;
    mode: T;
    modeHash: string;
    isolate?: boolean;
    origin: MessageQueueMessageOrigin;
}

export interface MessageQueueItemSnapshot<T> {
    id: number;
    messageId: string;
    seq: number;
    generation: number;
    state: MessageQueueItemState;
    message: string;
    mode: T;
    hash: string;
    isolate: boolean;
    origin: MessageQueueMessageOrigin;
}

export interface MessageQueueReservation<T> {
    reservationId: string;
    generation: number;
    itemIds: number[];
    items: MessageQueueItemSnapshot<T>[];
    message: string;
    mode: T;
    hash: string;
    isolate: boolean;
}

type QueueIdentity = { messageId?: string; seq?: number };

export class MessageQueue2<T> {
    public queue: QueueItem<T>[] = [];
    private waiter: ((reservation: MessageQueueReservation<T> | null) => void) | null = null;
    private waiterAbortCleanup: (() => void) | null = null;
    private closed = false;
    private onMessageHandler: ((message: string, mode: T, item: MessageQueueItemSnapshot<T>) => void) | null;
    private nextItemId = 1;
    private nextReservationId = 1;
    private generation = 1;
    private readonly reservations = new Map<string, MessageQueueReservation<T>>();
    modeHasher: (mode: T) => string;

    constructor(
        modeHasher: (mode: T) => string,
        onMessageHandler: ((message: string, mode: T, item: MessageQueueItemSnapshot<T>) => void) | null = null
    ) {
        this.modeHasher = modeHasher;
        this.onMessageHandler = onMessageHandler;
        logger.debug('[MessageQueue2] Initialized');
    }

    setOnMessage(handler: ((message: string, mode: T, item: MessageQueueItemSnapshot<T>) => void) | null): void {
        this.onMessageHandler = handler;
    }

    push(message: string, mode: T, identity: QueueIdentity = {}): void {
        this.enqueue(message, mode, false, 'push', false, identity);
    }

    pushImmediate(message: string, mode: T, identity: QueueIdentity = {}): void {
        this.enqueue(message, mode, false, 'pushImmediate', false, identity);
    }

    pushIsolateAndClear(message: string, mode: T, identity: QueueIdentity = {}): void {
        this.invalidateSynchronously();
        this.enqueue(message, mode, true, 'pushIsolateAndClear', false, identity);
    }

    unshift(message: string, mode: T, identity: QueueIdentity = {}): void {
        this.enqueue(message, mode, false, 'unshift', true, identity);
    }

    reset(): void {
        this.invalidateSynchronously();
        this.closed = false;
    }

    close(): void {
        this.closed = true;
        if (this.waiter) this.finishWaiter(null);
    }

    isClosed(): boolean {
        return this.closed;
    }

    size(): number {
        return this.queue.filter((item) => this.normalize(item).state !== 'invalidated').length;
    }

    snapshotAll(): MessageQueueItemSnapshot<T>[] {
        return this.queue
            .filter((item) => this.normalize(item).state !== 'invalidated')
            .map((item) => this.snapshot(item));
    }

    clearIfSnapshotMatches(expected: MessageQueueItemSnapshot<T>[]): boolean {
        const current = this.snapshotAll();
        if (current.length !== expected.length) return false;
        for (let index = 0; index < current.length; index += 1) {
            const actual = current[index];
            const wanted = expected[index];
            if (actual.id !== wanted.id
                || actual.generation !== wanted.generation
                || actual.messageId !== wanted.messageId
                || actual.seq !== wanted.seq) return false;
        }
        for (const item of this.queue) item.state = 'invalidated';
        this.queue = [];
        this.reservations.clear();
        this.generation += 1;
        return true;
    }

    reserve(id: number): MessageQueueReservation<T> | null {
        const item = this.queue.find((entry) => entry.id === id);
        if (!item || this.normalize(item).state !== 'queued') return null;
        return this.reserveItems([item], false);
    }

    async waitForMessagesAndReserve(abortSignal?: AbortSignal): Promise<MessageQueueReservation<T> | null> {
        if (abortSignal?.aborted) return null;
        const immediate = this.reserveNextBatch();
        if (immediate) return immediate;
        if (this.closed || abortSignal?.aborted) return null;
        if (this.waiter) throw new Error('MessageQueue2 supports only one pending waiter');

        return await new Promise<MessageQueueReservation<T> | null>((resolve) => {
            const finish = (reservation: MessageQueueReservation<T> | null) => resolve(reservation);
            this.waiter = finish;
            if (abortSignal) {
                const abort = () => {
                    if (this.waiter === finish) this.finishWaiter(null);
                };
                abortSignal.addEventListener('abort', abort, { once: true });
                this.waiterAbortCleanup = () => abortSignal.removeEventListener('abort', abort);
            }
            if (abortSignal?.aborted) {
                this.finishWaiter(null);
                return;
            }
            const raced = this.reserveNextBatch();
            if (raced) this.finishWaiter(raced);
            else if (this.closed) this.finishWaiter(null);
        });
    }

    commit(reservation: MessageQueueReservation<T>): boolean {
        const active = this.reservations.get(reservation.reservationId);
        if (!active || active.generation !== this.generation || active.generation !== reservation.generation) return false;
        const ids = new Set(active.itemIds);
        for (const item of this.queue) {
            if (ids.has(item.id) && (item.reservationId !== active.reservationId || this.normalize(item).state !== 'reserved')) return false;
        }
        this.queue = this.queue.filter((item) => {
            if (!ids.has(item.id)) return true;
            item.state = 'committed';
            return false;
        });
        this.reservations.delete(active.reservationId);
        this.notifyWaiter();
        return true;
    }

    seal(reservation: MessageQueueReservation<T>): boolean {
        const active = this.reservations.get(reservation.reservationId);
        if (!active || active.generation !== this.generation || active.generation !== reservation.generation) return false;
        (active as MessageQueueReservation<T> & { extendable?: boolean }).extendable = false;
        return true;
    }

    restore(reservation: MessageQueueReservation<T>): boolean {
        const active = this.reservations.get(reservation.reservationId);
        if (!active || active.generation !== this.generation) return false;
        for (const item of this.queue) {
            if (item.reservationId === active.reservationId && this.normalize(item).state === 'reserved') {
                item.state = 'queued';
                delete item.reservationId;
            }
        }
        this.reservations.delete(active.reservationId);
        this.notifyWaiter();
        return true;
    }

    async invalidateAll(
        reason: string,
        terminalize: (item: MessageQueueItemSnapshot<T>, reason: string) => Promise<void> | void
    ): Promise<void> {
        const items = this.queue.map((item) => this.snapshot(item));
        for (const item of items) await terminalize(item, reason);
        for (const item of this.queue) item.state = 'invalidated';
        this.queue = [];
        this.reservations.clear();
        this.generation += 1;
    }

    takeFirstMatching(predicate: (item: MessageQueueItemSnapshot<T>) => boolean): MessageQueueItemSnapshot<T> | null {
        const index = this.queue.findIndex((item) => this.normalize(item).state === 'queued' && predicate(this.snapshot(item)));
        if (index < 0) return null;
        const [item] = this.queue.splice(index, 1);
        item.state = 'committed';
        return this.snapshot(item);
    }

    async waitForMessagesAndGetAsString(abortSignal?: AbortSignal): Promise<{ message: string; mode: T; isolate: boolean; hash: string } | null> {
        const reservation = await this.waitForMessagesAndReserve(abortSignal);
        if (!reservation) return null;
        if (abortSignal?.aborted) {
            this.restore(reservation);
            return null;
        }
        if (!this.commit(reservation)) return null;
        return { message: reservation.message, mode: reservation.mode, isolate: reservation.isolate, hash: reservation.hash };
    }

    private enqueue(message: string, mode: T, isolate: boolean, origin: MessageQueueMessageOrigin, atFront: boolean, identity: QueueIdentity): void {
        if (this.closed) throw new Error(`Cannot ${atFront ? 'unshift' : 'push'} to closed queue`);
        const id = this.nextItemId++;
        const item: QueueItem<T> = {
            id,
            messageId: identity.messageId ?? `queue-${this.generation}-${id}`,
            seq: identity.seq ?? id,
            generation: this.generation,
            state: 'queued',
            message,
            mode,
            modeHash: this.modeHasher(mode),
            isolate,
            origin
        };
        if (atFront) this.queue.unshift(item);
        else this.queue.push(item);

        if (!atFront) this.extendTailReservation(item);
        this.onMessageHandler?.(message, mode, this.snapshot(item));
        this.notifyWaiter();
    }

    private normalize(item: QueueItem<T>): QueueItem<T> & Required<Pick<QueueItem<T>, 'messageId' | 'seq' | 'generation' | 'state'>> {
        item.messageId ??= `queue-${this.generation}-${item.id}`;
        item.seq ??= item.id;
        item.generation ??= this.generation;
        item.state ??= 'queued';
        return item as QueueItem<T> & Required<Pick<QueueItem<T>, 'messageId' | 'seq' | 'generation' | 'state'>>;
    }

    private snapshot(item: QueueItem<T>): MessageQueueItemSnapshot<T> {
        const normalized = this.normalize(item);
        return {
            id: normalized.id,
            messageId: normalized.messageId,
            seq: normalized.seq,
            generation: normalized.generation,
            state: normalized.state,
            message: normalized.message,
            mode: normalized.mode,
            hash: normalized.modeHash,
            isolate: normalized.isolate ?? false,
            origin: normalized.origin
        };
    }

    private reserveNextBatch(): MessageQueueReservation<T> | null {
        const first = this.queue[0];
        if (!first || this.normalize(first).state !== 'queued') return null;
        const items: QueueItem<T>[] = [first];
        if (!first.isolate) {
            for (let index = 1; index < this.queue.length; index += 1) {
                const item = this.queue[index];
                if (this.normalize(item).state !== 'queued' || item.modeHash !== first.modeHash || item.isolate) break;
                items.push(item);
            }
        }
        return this.reserveItems(items, true);
    }

    private reserveItems(items: QueueItem<T>[], extendable: boolean): MessageQueueReservation<T> {
        const reservationId = `${this.generation}:${this.nextReservationId++}`;
        for (const item of items) {
            item.state = 'reserved';
            item.reservationId = reservationId;
        }
        const first = items[0];
        const reservation: MessageQueueReservation<T> = {
            reservationId,
            generation: this.generation,
            itemIds: items.map((item) => item.id),
            items: items.map((item) => this.snapshot(item)),
            message: items.map((item) => item.message).join('\n'),
            mode: first.mode,
            hash: first.modeHash,
            isolate: first.isolate ?? false
        };
        (reservation as MessageQueueReservation<T> & { extendable?: boolean }).extendable = extendable;
        this.reservations.set(reservationId, reservation);
        return reservation;
    }

    private extendTailReservation(item: QueueItem<T>): void {
        if (item.isolate || this.queue.length < 2) return;
        const previous = this.queue[this.queue.length - 2];
        const normalized = this.normalize(previous);
        if (normalized.state !== 'reserved' || previous.modeHash !== item.modeHash || previous.isolate || !previous.reservationId) return;
        const reservation = this.reservations.get(previous.reservationId);
        if (!reservation || !(reservation as MessageQueueReservation<T> & { extendable?: boolean }).extendable) return;
        item.state = 'reserved';
        item.reservationId = reservation.reservationId;
        reservation.itemIds.push(item.id);
        reservation.items.push(this.snapshot(item));
        reservation.message = reservation.items.map((entry) => entry.message).join('\n');
    }

    private notifyWaiter(): void {
        if (!this.waiter) return;
        const reservation = this.reserveNextBatch();
        if (reservation) this.finishWaiter(reservation);
        else if (this.closed) this.finishWaiter(null);
    }

    private finishWaiter(reservation: MessageQueueReservation<T> | null): void {
        const waiter = this.waiter;
        this.waiter = null;
        this.waiterAbortCleanup?.();
        this.waiterAbortCleanup = null;
        waiter?.(reservation);
    }

    private invalidateSynchronously(): void {
        const reserved = this.queue.filter((item) => this.normalize(item).state === 'reserved');
        if (reserved.length > 0) {
            for (const item of this.queue) {
                if (this.normalize(item).state !== 'reserved') item.state = 'invalidated';
            }
            this.queue = reserved;
            return;
        }
        for (const item of this.queue) item.state = 'invalidated';
        this.queue = [];
        this.reservations.clear();
        this.generation += 1;
    }
}
