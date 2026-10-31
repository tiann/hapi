/** Cleanup is unconfirmed; an inactive realtime update does not prove success. */
export class ArchiveCleanupError extends Error {
    readonly status: 409 | 503 | 504
    readonly code: 'archive-cleanup-unconfirmed' | 'archive-cleanup-unavailable' | 'archive-cleanup-timeout'

    constructor(reason: 'unconfirmed' | 'unavailable' | 'timeout', cause?: unknown) {
        super(reason === 'timeout'
            ? 'Timed out waiting for Runner to confirm session cleanup. Cleanup may still be running; retry to verify its result.'
            : reason === 'unavailable'
                ? 'Runner did not confirm session cleanup. Reconnect the Runner and retry to verify its result.'
                : 'Session cleanup is not yet confirmed. Retry after the remaining processes have stopped.', { cause })
        this.name = 'ArchiveCleanupError'
        this.status = reason === 'timeout' ? 504 : reason === 'unavailable' ? 503 : 409
        this.code = `archive-cleanup-${reason}`
    }
}
