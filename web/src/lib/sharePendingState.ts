/**
 * sessionStorage hand-off between the share picker (`/share`) and the
 * session mount (`SessionChat`).
 *
 * The picker stores the IDB transfer id under this key, navigates to
 * `/sessions/:id` (or `/sessions/new`), and the session mounter reads + clears
 * the key once that session is active. sessionStorage rather than router
 * state because:
 *
 *   - it survives the `/sessions/new` -> `/sessions/:id` navigation that
 *     `NewSessionPage` performs internally with `replace: true`, which
 *     would drop router history state.
 *   - it scopes to the PWA window/tab — Android Chrome opens the share
 *     target in the installed PWA's own window, so collisions with other
 *     tabs are not a concern.
 *
 * The payload is bound to a **target session id**:
 *   - Consume only succeeds when the mounting SessionChat's id matches.
 *   - That prevents an unrelated active chat from stealing a pending
 *     share that was armed for an inactive target.
 *   - When reopen/spawn swaps A → B, call `retargetSharePendingTransfer(A, B)`
 *     before navigating so B can still seed.
 */

export const SHARE_PENDING_TRANSFER_KEY = 'hapi.share.pendingTransferId'

type SharePendingRecord = {
    transferId: string
    sessionId: string
}

function readRecord(): SharePendingRecord | null {
    try {
        const raw = window.sessionStorage.getItem(SHARE_PENDING_TRANSFER_KEY)
        if (!raw) return null
        // Legacy: bare transfer id string (pre-session-binding). Treat as
        // unbound — any active consumer may claim it (restore old behavior
        // for in-flight shares during deploy). Prefer writing the object form.
        if (raw[0] !== '{') {
            return { transferId: raw, sessionId: '' }
        }
        const parsed = JSON.parse(raw) as Partial<SharePendingRecord>
        if (typeof parsed.transferId !== 'string' || typeof parsed.sessionId !== 'string') {
            return null
        }
        return { transferId: parsed.transferId, sessionId: parsed.sessionId }
    } catch {
        return null
    }
}

function writeRecord(record: SharePendingRecord): void {
    window.sessionStorage.setItem(SHARE_PENDING_TRANSFER_KEY, JSON.stringify(record))
}

export function setSharePendingTransfer(transferId: string, sessionId: string): void {
    try {
        writeRecord({ transferId, sessionId })
    } catch {
        // Quota errors / disabled storage — caller proceeds without seed.
    }
}

/**
 * Claim the pending transfer for `sessionId`. Returns null (and leaves the
 * slot alone) when the pending target is a different session — so another
 * active chat cannot steal a share armed for an inactive pick.
 *
 * Legacy unbound records (`sessionId === ''`) are claimed by the first caller.
 */
export function consumeSharePendingTransfer(sessionId: string): string | null {
    try {
        const record = readRecord()
        if (!record) return null
        if (record.sessionId !== '' && record.sessionId !== sessionId) {
            return null
        }
        window.sessionStorage.removeItem(SHARE_PENDING_TRANSFER_KEY)
        return record.transferId
    } catch {
        return null
    }
}

/**
 * When resume/reopen merges session `fromSessionId` into a new live id
 * `toSessionId`, rewrite the pending target so the remounted chat can seed.
 */
export function retargetSharePendingTransfer(fromSessionId: string, toSessionId: string): void {
    if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return
    try {
        const record = readRecord()
        if (!record) return
        if (record.sessionId !== fromSessionId) return
        writeRecord({ transferId: record.transferId, sessionId: toSessionId })
    } catch {
        // Ignore storage failures — seed is best-effort.
    }
}

export function peekSharePendingTransfer(): SharePendingRecord | null {
    return readRecord()
}
