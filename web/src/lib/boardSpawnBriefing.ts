import { randomId } from '@/lib/randomId'

const STORAGE_PREFIX = 'hapi:board-spawn-briefing:'

export type BoardSpawnBriefing = {
    message: string
    linkIssueUrl?: string
    /** The board card's own title — renames the spawned session to it so it
     *  reflects the actual work instead of staying on the generic "you've
     *  been spawned from a Boards card" briefing text. */
    title: string
}

type StoredBoardSpawnBriefing = BoardSpawnBriefing & {
    /** `ApiClient.getReadStateScope()` at stash time — review finding,
     *  tiann/hapi#2147, follow-up: sessionStorage survives an in-tab
     *  re-authentication into a different namespace, but a board card's
     *  title/issue URL is private to whichever identity opened it. If the
     *  owner's auth is rejected mid-spawn and the same tab re-authenticates
     *  as a different namespace before the briefing is read, that new
     *  identity must not see it. `peekBoardSpawnBriefing` refuses to return
     *  a briefing whose stashed scope doesn't match the caller's current one.
     */
    scope: string | null
}

/**
 * The board item's briefing — the instruction message delivered to the
 * spawned session (buildBoardItemSpawnMessage) plus the issue URL to
 * auto-link — used to travel as `/sessions/new` search params — browser
 * history, same-origin referrer/access logs, and the URL bar itself then
 * carried private board content (hapi#238 Codex review). Stashed in
 * sessionStorage instead, keyed by an opaque transfer id that's the only
 * thing placed in the URL — same shape as `shareTransferId`, but local-only
 * (no hub round trip needed).
 *
 * Deliberately a peek/clear pair, not a delete-on-read "take": the spawn flow
 * can detour through /browse and back to `/sessions/new` with the same id
 * (same pattern as `shareTransferId`) before the session is actually
 * created, so `NewSessionPage` must be able to re-read it on each mount.
 * Call `clearBoardSpawnBriefing` once the flow actually completes or is
 * cancelled, so the stash doesn't accumulate across spawns.
 */
export function stashBoardSpawnBriefing(briefing: BoardSpawnBriefing, scope: string | null): string {
    const id = randomId()
    if (typeof window !== 'undefined') {
        try {
            const stored: StoredBoardSpawnBriefing = { ...briefing, scope }
            sessionStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(stored))
        } catch {
            // sessionStorage unavailable (private mode, quota) — the id is
            // still returned so the flow degrades to "spawn with no briefing"
            // rather than throwing.
        }
    }
    return id
}

// `title` is optional on the *read* side even though `stashBoardSpawnBriefing`
// always provides one — a stash written by a pre-rename-fix build (deploy
// mid-flight, stale tab) won't have it, and the message/issue-link are still
// perfectly deliverable without a rename. Treating `title` as part of the
// same all-or-nothing validation as `message` (an earlier version of this
// function did) drops the ENTIRE briefing — message and issue-link included
// — over a missing rename, which is a strictly worse failure than just
// skipping the rename (operator-reported, hapi#247: spawned with no
// instruction or issue link at all).
export function peekBoardSpawnBriefing(
    id: string, currentScope: string | null
): (Omit<BoardSpawnBriefing, 'title'> & { title?: string }) | null {
    if (typeof window === 'undefined') return null
    try {
        const raw = sessionStorage.getItem(STORAGE_PREFIX + id)
        if (!raw) return null
        const parsed = JSON.parse(raw) as unknown
        if (!parsed || typeof parsed !== 'object') return null
        const { message, linkIssueUrl, title, scope } = parsed as Record<string, unknown>
        if (typeof message !== 'string') return null
        // Fail closed on anything but an exact match — including a stash
        // from before this field existed (`scope` missing entirely), which
        // must not be treated as "no identity to check." A rare dropped
        // briefing across a deploy boundary is an acceptable cost; leaking
        // a private card's title/issue URL into a different identity's new
        // session is not.
        if (scope !== currentScope) return null
        return {
            message,
            title: typeof title === 'string' ? title : undefined,
            linkIssueUrl: typeof linkIssueUrl === 'string' ? linkIssueUrl : undefined
        }
    } catch {
        return null
    }
}

export function clearBoardSpawnBriefing(id: string): void {
    if (typeof window === 'undefined') return
    try {
        sessionStorage.removeItem(STORAGE_PREFIX + id)
    } catch {
        // Best-effort cleanup only.
    }
}
