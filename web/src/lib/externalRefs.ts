import type { ExternalRef } from '@hapi/protocol/types'
import type { BoardItem, SessionSummary } from '@/types/api'

// Host-agnostic — boards aren't github.com-only (GHE hosts too). Separate
// from `@hapi/protocol/schemas`' parseIssueUrl (also host-aware now, but
// returns a reconstructed `url` rather than the parsed host) because this one
// needs host/repo/number as discrete fields to compare against an existing
// ref, not to build a storable URL.
const ISSUE_URL_PATH = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/

function parseHostRepoAndNumber(url: string): { host: string; repo: string; number: number } | null {
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        return null
    }
    const match = ISSUE_URL_PATH.exec(parsed.pathname)
    if (!match) return null
    const [, owner, repo, numberRaw] = match
    return { host: parsed.host.toLowerCase(), repo: `${owner}/${repo}`, number: Number(numberRaw) }
}

/**
 * Most recently linked GitHub issue ref, if any. Picked by `linkedAt`, not
 * array position (Codex review, hapi#238): every *live* writer
 * (`sessionCache.linkIssue`, `applyLinkIssue`) appends via
 * `upsertExternalRef`, so array order matches link order for them — but
 * `mergeExternalRefs` (duplicate-session/resume merges) appends
 * incoming-only refs onto the end regardless of their actual `linkedAt`, so
 * an older ref contributed by the merged-away session could land after a
 * newer one already on the surviving session. `linkedAt` is a required
 * field on every `github_issue` ref (unlike `github_pr`'s passthrough
 * shape), so comparing it directly is reliable here. `>=` (not `>`)
 * preserves the prior "last one wins" tie-break for equal timestamps.
 */
export function getLinkedGithubIssue(metadata: { externalRefs?: ExternalRef[] } | null | undefined): ExternalRef | null {
    const refs = metadata?.externalRefs
    if (!refs || refs.length === 0) return null
    let mostRecent: (ExternalRef & { kind: 'github_issue' }) | null = null
    for (const ref of refs) {
        if (ref.kind !== 'github_issue') continue
        if (!mostRecent || ref.linkedAt >= mostRecent.linkedAt) {
            mostRecent = ref
        }
    }
    return mostRecent
}

/**
 * The session (if any) already linked to a board item's issue URL — used to
 * offer "open the existing session" instead of "spawn another one" from the
 * board detail pane (hapi#238 Codex review: revisiting an item that was
 * already spawned-and-linked, including via this exact flow, unconditionally
 * offered another spawn, funneling the user toward duplicate work). First
 * match wins; a URL spawned twice some other way (outside this flow's own
 * dedup) is an edge case not worth picking a "best" session for.
 *
 * Scans every retained `github_issue` ref, not just `getLinkedGithubIssue`'s
 * most-recent one (Codex review, second pass): a session linked to issue A
 * and later also linked to issue B keeps BOTH refs (`upsertExternalRef` only
 * dedups same-issue re-links), so checking only the most-recent ref would
 * stop finding the session while viewing A, even though A is still linked.
 *
 * Matches by parsed host+repo+number, not raw URL string equality (Codex
 * review, third and fourth passes): GitHub repo paths are case-insensitive,
 * and a ref created via `hapi link-issue owner/repo#N` preserves whatever
 * casing the caller typed, which can differ from the board item's own
 * canonically-cased URL for the same issue — `upsertExternalRef` already
 * treats `repo` case-insensitively for its own dedup, so this mirrors that
 * convention. The host must also match: GHE boards are explicitly supported
 * alongside github.com, so `Owner/Repo#12` on github.com and on a GHE host
 * are different issues that happen to share a repo path and number — only
 * comparing repo+number would conflate them into a false "already linked".
 */
export function findSessionLinkedToIssue(sessions: SessionSummary[], issueUrl: string | null): SessionSummary | null {
    if (!issueUrl) return null
    const target = parseHostRepoAndNumber(issueUrl)
    if (!target) return null
    return sessions.find(session =>
        session.metadata?.externalRefs?.some(ref => {
            if (ref.kind !== 'github_issue' || ref.number !== target.number) return false
            const refParsed = parseHostRepoAndNumber(ref.url)
            return refParsed?.host === target.host && refParsed.repo.toLowerCase() === target.repo.toLowerCase()
        })
    ) ?? null
}

export type BoardItemMatch = { boardId: string; boardLabel: string; itemId: string }

/**
 * The board item (if any) that represents a session's linked GitHub issue —
 * the reverse of `findSessionLinkedToIssue` above. Boards -> session already
 * had a one-click jump (the "session linked" badge on a board card); a
 * session with a linked issue had no way back to say "this is tracked on a
 * board" at all (operator follow-up to hapi#238, via Fekko).
 *
 * Takes every configured board's already-fetched items (not just the
 * currently-selected board's — `useLinkedIssueBoardItems` fetches all of
 * them) since the same issue could be a member of more than one board (an
 * unfiltered project and one of its saved views), same reasoning
 * `queryKeys.boardItemsAll` already documents for write-side invalidation.
 * First match across boards wins, same "don't try to pick a best one"
 * stance `findSessionLinkedToIssue` takes for the reverse direction.
 */
export function findBoardItemForIssue(
    boardsWithItems: Array<{ boardId: string; boardLabel: string; items: BoardItem[] }>,
    issueUrl: string | null
): BoardItemMatch | null {
    if (!issueUrl) return null
    const target = parseHostRepoAndNumber(issueUrl)
    if (!target) return null
    for (const board of boardsWithItems) {
        const match = board.items.find(item => {
            if (!item.url) return false
            const parsed = parseHostRepoAndNumber(item.url)
            return parsed !== null && parsed.host === target.host && parsed.repo.toLowerCase() === target.repo.toLowerCase() && parsed.number === target.number
        })
        if (match) return { boardId: board.boardId, boardLabel: board.boardLabel, itemId: match.id }
    }
    return null
}
