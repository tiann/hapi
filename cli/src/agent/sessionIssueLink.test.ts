import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyLinkIssue } from './sessionIssueLink'
import { LinkIssueError } from '@/modules/linkIssue/linkIssue'

const linkIssueMock = vi.fn()

vi.mock('@/modules/linkIssue/linkIssue', () => ({
    linkIssue: (...args: unknown[]) => linkIssueMock(...args),
    LinkIssueError: class LinkIssueError extends Error {
        code: string
        constructor(code: string, message: string) {
            super(message)
            this.name = 'LinkIssueError'
            this.code = code
        }
    }
}))

const sessionId = 'session-1'

describe('applyLinkIssue', () => {
    beforeEach(() => {
        linkIssueMock.mockReset()
    })

    it('writes the parsed ref from a full URL', async () => {
        linkIssueMock.mockResolvedValueOnce(undefined)

        const outcome = await applyLinkIssue(sessionId, 'https://github.com/heavygee/hapi/issues/235')

        expect(outcome).toEqual({
            ok: true,
            ref: expect.objectContaining({ kind: 'github_issue', repo: 'heavygee/hapi', number: 235 })
        })
        expect(linkIssueMock).toHaveBeenCalledWith(sessionId, 'https://github.com/heavygee/hapi/issues/235')
    })

    it('accepts the owner/repo#N shorthand', async () => {
        linkIssueMock.mockResolvedValueOnce(undefined)

        const outcome = await applyLinkIssue(sessionId, 'heavygee/hapi#235')

        expect(outcome.ok).toBe(true)
        if (outcome.ok) expect(outcome.ref).toMatchObject({ repo: 'heavygee/hapi', number: 235 })
    })

    it('returns an error without calling the hub for an unparsable url', async () => {
        const outcome = await applyLinkIssue(sessionId, 'not an issue url')

        expect(outcome.ok).toBe(false)
        expect(linkIssueMock).not.toHaveBeenCalled()
    })

    it('surfaces a hub rejection as a clean error, not a retry', async () => {
        linkIssueMock.mockRejectedValueOnce(new LinkIssueError('request_failed', 'at most 32 external refs are allowed'))

        const outcome = await applyLinkIssue(sessionId, 'heavygee/hapi#235')

        expect(outcome).toEqual({ ok: false, error: 'at most 32 external refs are allowed' })
        expect(linkIssueMock).toHaveBeenCalledTimes(1)
    })

    // Review finding (hapi#2147): the previous socket-based implementation
    // went through the hub's generic sparse-write metadata merge, which has
    // no terminal-error concept for an over-cap write — it fell back to
    // what's already persisted and acked success, leaving updateMetadata's
    // backoff loop with nothing useful to retry but nothing clean to report
    // either. Delegating to the same REST route the standalone `hapi
    // link-issue` command uses puts every outcome through a single awaited
    // HTTP call with no retry loop in the path at all — confirmed directly
    // against SessionCache.linkIssue (hub/src/sync/sessionCache.ts): at 32
    // existing refs, it throws InvalidExternalRefsError immediately and
    // persists nothing extra, which this test's rejected mock mirrors.
    it('calls the hub exactly once even when it rejects (no retry loop anywhere in this path)', async () => {
        linkIssueMock.mockRejectedValueOnce(new LinkIssueError('request_failed', 'at most 32 external refs are allowed'))

        await applyLinkIssue(sessionId, 'heavygee/hapi#235')

        expect(linkIssueMock).toHaveBeenCalledTimes(1)
    })
})
