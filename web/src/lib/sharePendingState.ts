/**
 * sessionStorage hand-off between the share picker (`/share`) and the
 * session mount (`SessionChat`).
 *
 * The picker stores the IDB transfer id under this key, navigates to
 * `/sessions/:id` (or `/sessions/new`), and the session mounter reads + clears
 * the key on first render. sessionStorage rather than router state because:
 *
 *   - it survives the `/sessions/new` -> `/sessions/:id` navigation that
 *     `NewSessionPage` performs internally with `replace: true`, which
 *     would drop router history state.
 *   - it scopes to the PWA window/tab — Android Chrome opens the share
 *     target in the installed PWA's own window, so collisions with other
 *     tabs are not a concern.
 *
 * The key is read **once** per mount; consume() returns the id and clears
 * the slot atomically so a refresh of /sessions/:id doesn't replay the
 * upload.
 */

export const SHARE_PENDING_TRANSFER_KEY = 'hapi.share.pendingTransferId'

export function setSharePendingTransfer(transferId: string): void {
    try {
        window.sessionStorage.setItem(SHARE_PENDING_TRANSFER_KEY, transferId)
    } catch {
        // Quota errors / disabled storage — caller proceeds without seed.
    }
}

export function consumeSharePendingTransfer(): string | null {
    try {
        const value = window.sessionStorage.getItem(SHARE_PENDING_TRANSFER_KEY)
        if (value) {
            window.sessionStorage.removeItem(SHARE_PENDING_TRANSFER_KEY)
        }
        return value
    } catch {
        return null
    }
}
