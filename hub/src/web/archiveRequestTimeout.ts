/**
 * Bun.serve's global idleTimeout is capped by Socket.IO's ping-derived value
 * (~50s). Archive waits up to 90s for Runner cleanup before writing a response,
 * so the connection would be reset mid-wait without a per-request override.
 *
 * `server.timeout(req, seconds)` — seconds, not milliseconds. 120 covers the
 * 90s cleanup budget plus response write headroom (Bun caps global idleTimeout
 * at 255; per-request may go higher, but 120 is enough and keeps the contract
 * legible next to the engine budget).
 */
export const ARCHIVE_REQUEST_IDLE_TIMEOUT_SEC = 120

const ARCHIVE_PATH_RE = /^\/api\/sessions\/[^/]+\/archive\/?$/

export type IdleTimeoutServer = {
    timeout?: (request: Request, seconds: number) => void
}

/** Return true when the archive idle override was applied. */
export function maybeExtendArchiveRequestTimeout(
    req: Request,
    server: IdleTimeoutServer,
    pathname: string = new URL(req.url).pathname,
): boolean {
    if (req.method !== 'POST' || !ARCHIVE_PATH_RE.test(pathname)) {
        return false
    }
    server.timeout?.(req, ARCHIVE_REQUEST_IDLE_TIMEOUT_SEC)
    return true
}
