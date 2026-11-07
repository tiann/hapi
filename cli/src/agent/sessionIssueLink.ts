import { parseIssueUrl, type ExternalRef } from '@hapi/protocol/schemas'
import { linkIssue as linkIssueViaHub } from '@/modules/linkIssue/linkIssue'

export type LinkIssueOutcome =
    | { ok: true; ref: ExternalRef }
    | { ok: false; error: string }

/**
 * MCP `link_issue` tool's write path. Delegates to the same hub REST route
 * (`PATCH /api/sessions/:id/link-issue`) as the standalone `hapi link-issue`
 * CLI command (`cli/src/modules/linkIssue`) rather than the socket-based
 * `client.updateMetadata`/`flushMetadata` dance this used previously.
 *
 * That socket path went through the hub's generic sparse-write metadata
 * merge, which has no terminal-error concept — an over-cap write (review
 * finding, hapi#2147) doesn't reject, it falls back to what's already
 * persisted and acks success, leaving nothing for `updateMetadata`'s own
 * backoff loop to usefully retry but also nothing clean to report back
 * either. `engine.linkIssue` behind this REST route instead goes through
 * `mutateSessionExternalRefs` with `replaceExternalRefs: true` and
 * `ExternalRefsSchema`'s own cap, which rejects an over-cap array outright
 * with `InvalidExternalRefsError` — a single HTTP round trip, no retry loop
 * anywhere in the path, confirmed by direct test (32 existing refs + 1 new:
 * throws immediately, 32 refs still persisted unchanged).
 */
export async function applyLinkIssue(sessionId: string, url: string): Promise<LinkIssueOutcome> {
    const target = parseIssueUrl(url)
    if (!target) {
        return { ok: false, error: 'Could not parse a GitHub issue URL (expected e.g. https://github.com/<owner>/<repo>/issues/<n> or [host:]<owner>/<repo>#<n>)' }
    }

    try {
        await linkIssueViaHub(sessionId, url)
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Failed to link issue' }
    }

    return {
        ok: true,
        ref: {
            kind: 'github_issue',
            url: target.url,
            repo: target.repo,
            number: target.number,
            linkedAt: Date.now()
        }
    }
}
