import type { Metadata } from '@/api/types';
import type { SessionStopPreparationLease } from '@hapi/protocol/rpcMethods';
import { monotonicTimeMs } from '@/utils/time';

type LocalPublicationClient = {
    updateMetadata(handler: (metadata: Metadata) => Metadata): void;
    materialize(): Promise<boolean>;
    flushMetadata(): Promise<boolean>;
    flush(): Promise<boolean>;
    on?(event: 'connected', handler: () => void): unknown;
    off?(event: 'connected', handler: () => void): unknown;
};

// Local hooks/scanners append Hub rows even when native undo later removes
// them. Keep identities of published local messages until remote validation.
export function observeLocalHistory(
    metadata: Metadata,
    nativeSessionId: string | null,
    nativeMessageId: string | null
): Metadata {
    if (metadata.conversationHistoryDiverged) return metadata;
    const checkpoint = metadata.opencodeHistoryCheckpoint;
    if (!nativeSessionId || !nativeMessageId || (checkpoint && (checkpoint.sessionId !== nativeSessionId || checkpoint.localMessageIds === undefined))) {
        const capabilities = { ...metadata.capabilities };
        delete capabilities.conversationHistory;
        return { ...metadata, capabilities, conversationHistoryDiverged: true,
            conversationHistoryPoints: undefined, conversationHistoryIndexes: undefined, opencodeHistoryCheckpoint: undefined };
    }
    return { ...metadata, opencodeHistoryCheckpoint: {
        ...(checkpoint ?? { sessionId: nativeSessionId, messageIds: [], userMessageIds: [] }),
        localMessageIds: [...new Set([...(checkpoint?.localMessageIds ?? []), nativeMessageId])]
    } };
}

// Journal each local publication before sending content, and leave the guard
// set until the Hub has acknowledged both the content and the final metadata.
export function createLocalHistoryPublisher(client: LocalPublicationClient, onError: (error: unknown) => void) {
    const queue: Array<{ sessionId: string | null; messageId: string | null; send: () => void; sent: boolean }> = [];
    let running: Promise<void> | null = null;
    let uncertain = false;
    let divergenceQueued = false;
    let reported = false;
    let stopped = false;
    let closing = false;
    let finishing: Promise<boolean> | null = null;
    let preparation: Promise<boolean> | null = null;
    let preparing = false;
    let finalizing = false;
    let preparationLease: SessionStopPreparationLease | undefined;
    let leaseTimer: ReturnType<typeof setTimeout> | undefined;
    const held: typeof queue = [];
    let retryRequested = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearRetry = () => { if (timer) clearTimeout(timer); timer = undefined; };
    const retry = () => { if (!closing && !preparing) void pump(true); };
    const scheduleRetry = () => {
        if (stopped || closing || preparing || timer || queue.length === 0) return;
        // Match ApiSessionClient's initial Socket.IO reconnect cadence.
        timer = setTimeout(() => { timer = undefined; retry(); }, 1000);
        timer.unref();
    };
    const markUncertain = (sessionId: string | null, error: unknown) => {
        uncertain = true;
        if (!divergenceQueued) {
            try {
                client.updateMetadata((metadata) => observeLocalHistory(metadata, sessionId, null));
                divergenceQueued = true;
            } catch {}
        }
        if (!reported) { reported = true; try { onError(error); } catch {} }
    };
    const materialize = async (): Promise<boolean> => {
        // Match the SDK flush budget, including lazy offline materialization.
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([client.materialize(), new Promise<boolean>((resolve) => {
                deadline = setTimeout(() => resolve(false), 5_000);
            })]);
        } finally { if (deadline) clearTimeout(deadline); }
    };
    const drain = async () => {
        while (!stopped && queue.length > 0) {
            const entry = queue[0]!;
            try {
                const uncertainAtStart = uncertain;
                if (!uncertain) {
                    client.updateMetadata((metadata) => {
                        const observed = observeLocalHistory(metadata, entry.sessionId, entry.messageId);
                        return observed.opencodeHistoryCheckpoint ? { ...observed, opencodeHistoryCheckpoint: {
                            ...observed.opencodeHistoryCheckpoint, localPublicationPending: true
                        } } : observed;
                    });
                } else if (!divergenceQueued) {
                    markUncertain(entry.sessionId, new Error('Local history correspondence is uncertain'));
                }
                if (uncertain && !divergenceQueued) throw new Error('Local history uncertainty could not be queued');
                if (!await materialize() || !await client.flushMetadata()) {
                    throw new Error('Local history observation could not be persisted');
                }
                if (uncertain && !uncertainAtStart) {
                    // A mode-handoff drain may have timed out while this guard
                    // was waiting. Persist divergence before any late content.
                    if (!divergenceQueued) markUncertain(entry.sessionId, new Error('Local history correspondence is uncertain'));
                    if (!divergenceQueued) throw new Error('Local history uncertainty could not be queued');
                    if (!await client.flushMetadata()) throw new Error('Local history uncertainty was not persisted');
                }
                if (stopped) return;
                // A prior send with an uncertain ACK may already be in the
                // socket buffer or Hub. Do not duplicate it on reconnect.
                if (!entry.sent) { entry.send(); entry.sent = true; }
                if (!await client.flush()) throw new Error('Local history content was not acknowledged');
                if (stopped) return;
                if (!uncertain) {
                    client.updateMetadata((metadata) => metadata.opencodeHistoryCheckpoint ? { ...metadata,
                        opencodeHistoryCheckpoint: { ...metadata.opencodeHistoryCheckpoint, localPublicationPending: undefined }
                    } : metadata);
                    if (!await client.flushMetadata()) throw new Error('Local history publication could not be committed');
                }
                queue.shift();
                reported = false;
            } catch (error) {
                markUncertain(entry.sessionId, error);
                scheduleRetry();
                return;
            }
        }
    };
    function pump(requestRetry = false): Promise<void> {
        if (stopped || queue.length === 0) return running ?? Promise.resolve();
        if (running) { retryRequested ||= requestRetry; return running; }
        clearRetry();
        running = Promise.resolve().then(drain).finally(() => {
            running = null;
            if ((retryRequested || (!timer && queue.length > 0)) && !stopped && !closing && !preparing) {
                retryRequested = false;
                retry();
            }
        });
        return running;
    }
    const clearLeaseTimer = () => { if (leaseTimer) clearTimeout(leaseTimer); leaseTimer = undefined; };
    const stop = () => { stopped = true; clearRetry(); clearLeaseTimer(); held.length = 0; client.off?.('connected', retry); };
    const releaseLease = (id: string) => {
        if (preparationLease?.id !== id) return;
        preparationLease = undefined;
        clearLeaseTimer();
        if (!stopped && !finalizing) {
            closing = false;
            queue.push(...held.splice(0));
            if (!preparing) { preparation = null; void pump(); }
        }
    };
    const drainQueue = async (): Promise<boolean> => {
        if (running) await running;
        await pump();
        return queue.length === 0;
    };
    const prepare = (lease?: SessionStopPreparationLease): Promise<boolean> => {
        if (stopped) return Promise.resolve(queue.length === 0);
        if (finalizing || (lease && lease.expiresAt <= monotonicTimeMs())) return Promise.resolve(false);
        if (preparation && (preparationLease?.id !== lease?.id || preparationLease?.expiresAt !== lease?.expiresAt)) {
            return Promise.resolve(false);
        }
        if (!preparation) {
            preparing = true;
            clearRetry();
            preparationLease = lease ? { ...lease } : undefined;
            if (lease) {
                leaseTimer = setTimeout(() => releaseLease(lease.id), Math.max(0, lease.expiresAt - monotonicTimeMs()));
                leaseTimer.unref();
            }
            preparation = (async () => {
                const drained = await drainQueue();
                const confirmed = drained && !finalizing && (!lease || (
                    preparationLease?.id === lease.id && lease.expiresAt > monotonicTimeMs()
                ));
                preparing = false;
                if (confirmed) closing = true;
                if (!confirmed) {
                    // A rejected cooperative stop leaves ownership here. Keep
                    // ordinary forwarding recoverable for the next attempt.
                    preparation = null;
                    if (lease) releaseLease(lease.id);
                    scheduleRetry();
                }
                return confirmed;
            })();
        }
        return preparation;
    };
    client.on?.('connected', retry);
    return {
        publish(sessionId: string | null, messageId: string | null, send: () => void): void {
            if (stopped) return;
            if (preparationLease && monotonicTimeMs() >= preparationLease.expiresAt) releaseLease(preparationLease.id);
            if (closing) {
                if (preparationLease && !finalizing) {
                    held.push({ sessionId, messageId, send, sent: false });
                    markUncertain(sessionId, new Error('Local publication is pending a shutdown preparation lease'));
                }
                return;
            }
            queue.push({ sessionId, messageId, send, sent: false });
            void pump();
        },
        async flush(): Promise<void> {
            // Use the client's default flush budget for mode handoff; an
            // offline lazy materialization must not hold the mode forever.
            let deadline: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([pump(), new Promise<void>((resolve) => {
                    deadline = setTimeout(() => {
                        if (!stopped && !closing && queue.length) markUncertain(queue[0]!.sessionId, new Error('Local history drain is still pending'));
                        resolve();
                    }, 5_000);
                })]);
            } finally { if (deadline) clearTimeout(deadline); }
        },
        finish(): Promise<boolean> {
            if (!finishing) {
                // Final process teardown commits the admission cutoff. A
                // reversible prepare keeps accepting local completions until
                // the full queue has actually drained.
                closing = true;
                finalizing = true;
                clearLeaseTimer();
                preparationLease = undefined;
                held.length = 0;
                finishing = (async () => {
                    try {
                        if (preparation) await preparation;
                        return await drainQueue();
                    }
                    finally { stop(); }
                })();
            }
            return finishing;
        },
        prepare,
        stop
    };
}

export type LocalHistoryPublisher = ReturnType<typeof createLocalHistoryPublisher>;
