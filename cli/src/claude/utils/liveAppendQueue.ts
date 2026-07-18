import type { MessageQueue2, MessageQueueMessageOrigin } from '@/utils/MessageQueue2';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import type { EnhancedMode } from '../loop';
import type { ClaudeLiveAppend } from '../claudeRemote';

export function tryLiveAppendQueuedMessage(opts: {
    queue: MessageQueue2<EnhancedMode>;
    message: string;
    mode: EnhancedMode;
    activeModeHash: string | null;
    thinking: boolean;
    hasPendingPermission: boolean;
    append: ClaudeLiveAppend | null;
    queueItemId?: number;
    origin?: MessageQueueMessageOrigin;
    log?: (message: string) => void;
}): boolean {
    const {
        queue,
        message,
        mode,
        activeModeHash,
        thinking,
        hasPendingPermission,
        append,
        queueItemId,
        origin,
        log
    } = opts;

    if (origin !== undefined && origin !== 'push') {
        return false;
    }

    if (!append || !thinking || !activeModeHash || hasPendingPermission) {
        return false;
    }

    if (parseSpecialCommand(message).type !== null) {
        return false;
    }

    const hash = queue.modeHasher(mode);
    if (hash !== activeModeHash) {
        return false;
    }

    if (!append({ message, mode })) {
        return false;
    }

    const removed = queue.takeFirstMatching((item) => {
        if (queueItemId !== undefined) {
            return item.id === queueItemId;
        }

        return item.message === message
            && item.hash === hash
            && item.isolate === false;
    });

    if (!removed) {
        log?.('[claudeRemoteLauncher] live append accepted but queued item was not removed');
    }

    return true;
}

export function createClaudeLiveAppendQueueHandler(opts: {
    queue: MessageQueue2<EnhancedMode>;
    getActiveModeHash: () => string | null;
    isThinking: () => boolean;
    hasPendingPermission: () => boolean;
    getAppend: () => ClaudeLiveAppend | null;
    log?: (message: string) => void;
    onAccepted?: (next: { message: string; mode: EnhancedMode }) => void;
}): (message: string, mode: EnhancedMode, item?: { id: number; origin: MessageQueueMessageOrigin }) => void {
    return (message, mode, item) => {
        const appended = tryLiveAppendQueuedMessage({
            queue: opts.queue,
            message,
            mode,
            activeModeHash: opts.getActiveModeHash(),
            thinking: opts.isThinking(),
            hasPendingPermission: opts.hasPendingPermission(),
            append: opts.getAppend(),
            queueItemId: item?.id,
            origin: item?.origin,
            log: opts.log
        });

        if (appended) {
            opts.onAccepted?.({ message, mode });
        }
    };
}
