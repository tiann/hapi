import type { ApiSessionClient } from '@/api/apiSession';

type ReadyEventSender = Pick<ApiSessionClient, 'sendSessionEvent'>;

/** Sends ready only after the caller confirms that no input remains to run. */
export function emitReadyIfIdle(session: ReadyEventSender, hasPendingInput: () => boolean): void {
    if (hasPendingInput()) return;
    session.sendSessionEvent({ type: 'ready' });
}
