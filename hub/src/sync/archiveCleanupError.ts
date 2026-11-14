/** Cleanup is unconfirmed; an inactive realtime update does not prove success. */
export class ArchiveCleanupError extends Error {
    readonly status: 409 | 503
    readonly code: 'archive-cleanup-unconfirmed' | 'archive-cleanup-unavailable' | 'archive-cleanup-timeout'

    constructor(reason: 'unconfirmed' | 'unavailable' | 'timeout', cause?: unknown) {
        super(reason === 'timeout'
            ? 'Timed out waiting for Runner to confirm session cleanup. Cleanup may still be running; retry to verify its result.'
            : reason === 'unavailable'
                ? 'Runner did not confirm session cleanup. Reconnect the Runner and retry to verify its result.'
                : 'Session cleanup is not yet confirmed. Retry after the remaining processes have stopped.', { cause })
        this.name = 'ArchiveCleanupError'
        // tiann/hapi#2422: not 504 — Cloudflare Tunnel replaces 502/504 bodies; `code` tells timeout apart.
        this.status = reason === 'unconfirmed' ? 409 : 503
        this.code = `archive-cleanup-${reason}`
    }
}
