import { PiRpcTimeoutError, sendPiRpcAndWait } from './loop';
import type { PiConversationHistory } from './conversationHistory';
import type { PiSession } from './session';
import type { PiTransport } from './piTransport';
import type { PiPreparedPrompt } from './promptQueue';

export type PiPreparedSteer = PiPreparedPrompt & {
    /** Active Pi generation observed when this message arrived at HAPI. */
    targetStreamingGeneration: number | null;
};

type ActiveSteer = {
    entry: PiPreparedSteer;
    cancelled: boolean;
    nativeSent: boolean;
};

/**
 * Serializes explicit native Pi steers by their RPC responses. Pi lifecycle
 * events intentionally do not affect this dispatcher: a steer can be accepted
 * while the main prompt continues streaming, and Pi's steeringMode is only a
 * native policy, not a HAPI ordering signal.
 */
export class PiSteerDispatcher {
    private readonly entries: PiPreparedSteer[] = [];
    private active: ActiveSteer | null = null;
    private stopped = false;

    constructor(private readonly options: {
        session: PiSession;
        transport: PiTransport;
        conversationHistory: PiConversationHistory;
        enqueuePrompt: (prompt: PiPreparedPrompt) => void;
        onIndeterminateTimeout: (error: PiRpcTimeoutError) => void;
        /** Re-attempt normal prompt pumping after local steer work drains. */
        onPendingStateChange?: () => void;
    }) {}

    /** A prompt must wait while any earlier steer can still fall back ahead of it. */
    get hasPending(): boolean {
        // A locally cancelled active entry cannot reach Pi or fall back, so it
        // must release the normal prompt pump even if it is still awaiting the
        // runtime lock merely to finish its own cancellation path.
        return !this.stopped && ((this.active !== null && !this.active.cancelled) || this.entries.length > 0);
    }

    enqueue(entry: PiPreparedSteer): void {
        if (this.stopped) return;
        this.entries.push(entry);
        this.pump();
        this.options.onPendingStateChange?.();
    }

    /** True only while the entry is still local and has not reached Pi stdin. */
    cancelByLocalId(localId: string): boolean {
        const index = this.entries.findIndex((entry) => entry.localId === localId);
        if (index !== -1) {
            this.entries.splice(index, 1);
            this.options.onPendingStateChange?.();
            return true;
        }
        if (this.active?.entry.localId === localId && !this.active.nativeSent) {
            this.active.cancelled = true;
            this.options.onPendingStateChange?.();
            return true;
        }
        return false;
    }

    /** Stop all local work; never turn a shutdown race into a queued prompt. */
    stop(): void {
        this.stopped = true;
        this.entries.length = 0;
        if (this.active && !this.active.nativeSent) this.active.cancelled = true;
        // Shutdown must never wake the ordinary prompt pump: transport error
        // handlers call stop() before cleanup marks the runner terminal.
    }

    private pump(): void {
        if (this.stopped || this.active || this.entries.length === 0) return;
        const entry = this.entries.shift()!;
        const active: ActiveSteer = { entry, cancelled: false, nativeSent: false };
        this.active = active;
        void this.dispatch(active).finally(() => {
            if (this.active !== active) return;
            this.active = null;
            this.pump();
            this.options.onPendingStateChange?.();
        });
    }

    private async dispatch(active: ActiveSteer): Promise<void> {
        try {
            await this.options.session.runRuntimeMutation(async () => {
                if (this.stopped || active.cancelled) return;

                // A steer held behind config/history work may only reach this
                // point after the original Pi turn ended. At that boundary,
                // preserve normal prompt FIFO semantics instead of issuing an
                // invalid/meaningless native steer.
                const currentGeneration = this.options.session.currentStreamingGeneration;
                if (
                    !this.options.session.isReady
                    || currentGeneration === null
                    || currentGeneration !== active.entry.targetStreamingGeneration
                ) {
                    this.options.enqueuePrompt({
                        message: active.entry.message,
                        images: active.entry.images,
                        outboundSequence: active.entry.outboundSequence,
                        ...(active.entry.localId ? { localId: active.entry.localId } : {}),
                    });
                    return;
                }

                // Pi appends a user entry for both prompt and steer. Record it
                // immediately before sending so native entry arrival remains
                // FIFO-correlated even with identical message text.
                this.options.conversationHistory.registerUserEntry(active.entry.localId);
                active.nativeSent = true;
                await sendPiRpcAndWait(this.options.session, this.options.transport, {
                    type: 'steer',
                    message: active.entry.message,
                    ...(active.entry.images.length > 0 ? { images: active.entry.images } : {}),
                });

                if (this.stopped) return;
                if (active.entry.localId) this.options.session.emitMessagesConsumed([active.entry.localId]);
            }, { poisonOnError: (error) => error instanceof PiRpcTimeoutError });
        } catch (error) {
            // Transport teardown rejects outstanding RPCs. Its cleanup owns the
            // session terminal state, so do not emit an error/consume event or
            // degrade this steer into the prompt queue afterwards.
            if (this.stopped || active.cancelled || !active.nativeSent) return;

            const detail = error instanceof Error ? error.message : String(error);
            this.options.conversationHistory.rejectPendingEntry(active.entry.localId);
            if (active.entry.localId) {
                this.options.session.emitMessagesConsumed(
                    [active.entry.localId],
                    { clearQueuedThinkingGrace: true },
                );
            }
            this.options.session.sendSessionEvent({ type: 'message', message: `Pi steer failed: ${detail}` });
            if (error instanceof PiRpcTimeoutError) this.options.onIndeterminateTimeout(error);
        }
    }
}
