import type { MessageQueue2, MessageQueueMessageOrigin, MessageQueueReservation } from '@/utils/MessageQueue2';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import type { EnhancedMode } from '../loop';
import { CodexAppServerError } from '../codexAppServerClient';

export type CodexLiveSteer = (next: {
    threadId: string;
    expectedTurnId: string;
    message: string;
    mode: EnhancedMode;
}) => Promise<boolean> | boolean;

export async function tryLiveAppendQueuedMessage(opts: {
    queue: MessageQueue2<EnhancedMode>;
    message: string;
    mode: EnhancedMode;
    activeModeHash: string | null;
    threadId: string | null;
    turnId: string | null;
    turnInFlight: boolean;
    hasPendingPermission: boolean;
    manualCompactionInFlight: boolean;
    goalCommandInFlight: boolean;
    steer: CodexLiveSteer | null;
    queueItemId?: number;
    origin?: MessageQueueMessageOrigin;
    log?: (message: string) => void;
    reservation?: MessageQueueReservation<EnhancedMode>;
    onAmbiguous?: (reason: string) => void;
}): Promise<boolean> {
    const {
        queue,
        message,
        mode,
        activeModeHash,
        threadId,
        turnId,
        turnInFlight,
        hasPendingPermission,
        manualCompactionInFlight,
        goalCommandInFlight,
        steer,
        queueItemId,
        origin,
        log,
        onAmbiguous
    } = opts;
    const rejectBeforeSteer = (): false => {
        if (opts.reservation) queue.restore(opts.reservation);
        return false;
    };

    if (origin !== undefined && origin !== 'push') {
        return rejectBeforeSteer();
    }

    if (
        !steer ||
        !threadId ||
        !turnId ||
        !turnInFlight ||
        !activeModeHash ||
        hasPendingPermission ||
        manualCompactionInFlight ||
        goalCommandInFlight
    ) {
        return rejectBeforeSteer();
    }

    if (parseSpecialCommand(message).type !== null) {
        return rejectBeforeSteer();
    }

    const hash = queue.modeHasher(mode);
    if (hash !== activeModeHash) {
        return rejectBeforeSteer();
    }

    const reservation = opts.reservation ?? (() => {
        if (queueItemId !== undefined) return queue.reserve(queueItemId);
        const item = queue.queue.find((candidate) => candidate.message === message && candidate.modeHash === hash);
        return item ? queue.reserve(item.id) : null;
    })();
    if (!reservation) return false;

    let accepted = false;
    try {
        accepted = await new Promise<boolean>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new CodexAppServerError({
                    method: 'turn/steer', message: 'live append timed out', writeState: 'written'
                })), 15_000);
            timeout.unref?.();
            Promise.resolve(steer({ threadId, expectedTurnId: turnId, message, mode }))
                .then(resolve, reject)
                .finally(() => clearTimeout(timeout));
        });
    } catch (error) {
        log?.(`[codexRemoteLauncher] live append turn/steer rejected: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof CodexAppServerError && error.writeState === 'written') {
            queue.commit(reservation);
            onAmbiguous?.(error.message);
        } else {
            queue.restore(reservation);
        }
        return false;
    }

    if (!accepted) {
        queue.commit(reservation);
        onAmbiguous?.('live append returned an unverified response after transport write');
        return false;
    }

    if (!queue.commit(reservation)) {
        log?.('[codexRemoteLauncher] live append accepted but reservation generation was stale');
        onAmbiguous?.('live append accepted after queue invalidation');
        return false;
    }

    return true;
}

export function createCodexLiveAppendQueueHandler(opts: {
    queue: MessageQueue2<EnhancedMode>;
    getActiveModeHash: () => string | null;
    getThreadId: () => string | null;
    getTurnId: () => string | null;
    isTurnInFlight: () => boolean;
    hasPendingPermission: () => boolean;
    isManualCompactionInFlight: () => boolean;
    isGoalCommandInFlight: () => boolean;
    getSteer: () => CodexLiveSteer | null;
    log?: (message: string) => void;
    onAccepted?: (next: { message: string; mode: EnhancedMode }) => void;
    onAmbiguous?: (reason: string) => void;
}): (message: string, mode: EnhancedMode, item?: { id: number; origin: MessageQueueMessageOrigin }) => void {
    let steerChain: Promise<boolean> = Promise.resolve(true);
    return (message, mode, item) => {
        if (!item || item.origin !== 'push') return;
        if (!opts.getSteer() || !opts.getThreadId() || !opts.getTurnId() || !opts.isTurnInFlight()
            || !opts.getActiveModeHash() || opts.hasPendingPermission() || opts.isManualCompactionInFlight()
            || opts.isGoalCommandInFlight() || parseSpecialCommand(message).type !== null
            || opts.queue.modeHasher(mode) !== opts.getActiveModeHash()) return;
        const reservation = opts.queue.reserve(item.id);
        if (!reservation) return;

        steerChain = steerChain.then(async (previousAccepted) => {
            if (!previousAccepted) {
                opts.queue.restore(reservation);
                return false;
            }
            const appended = await tryLiveAppendQueuedMessage({
            queue: opts.queue,
            message,
            mode,
            activeModeHash: opts.getActiveModeHash(),
            threadId: opts.getThreadId(),
            turnId: opts.getTurnId(),
            turnInFlight: opts.isTurnInFlight(),
            hasPendingPermission: opts.hasPendingPermission(),
            manualCompactionInFlight: opts.isManualCompactionInFlight(),
            goalCommandInFlight: opts.isGoalCommandInFlight(),
            steer: opts.getSteer(),
            queueItemId: item?.id,
            origin: item?.origin,
            log: opts.log,
            reservation,
            onAmbiguous: opts.onAmbiguous
            });
            if (appended) {
                opts.onAccepted?.({ message, mode });
            }
            return appended;
        });
    };
}
