import { describe, expect, it } from 'bun:test'
import type { ExternalRef, SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

const PR_REF: ExternalRef = {
    kind: 'github_pr',
    repo: 'tiann/hapi',
    number: 1163,
    url: 'https://github.com/tiann/hapi/pull/1163',
    role: 'primary',
    source: 'user',
    linkedAt: 1
}

const ISSUE_REF: ExternalRef = {
    kind: 'github_issue',
    repo: 'tiann/hapi',
    number: 238,
    url: 'https://github.com/tiann/hapi/issues/238',
    linkedAt: 2
}

// Review finding: mutateSessionExternalRefs (the shared write path behind
// link_issue, link_pr, and remove-primary) computes the full intended
// result from a freshly-read current state, but routed it through
// updateSessionMetadata's default union-with-prior merge — meant to guard
// against a *sparse/stale* snapshot write, not an authoritative one. An
// issue-only result (after removing a primary PR) looked exactly like a
// sparse write that merely didn't know about the PR yet, so the union
// silently resurrected it. `replaceExternalRefs: true` (sessionCache.ts's
// call into updateSessionMetadata) is what this test guards.
describe('SessionCache.mutateSessionExternalRefs — real Store, no resurrection', () => {
    it('actually removes a primary PR via remove-primary\'s own filter, preserving an unrelated issue ref', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const created = cache.getOrCreateSession(
            'remove-primary-keeps-issue',
            { path: '/tmp', host: 'h', externalRefs: [PR_REF, ISSUE_REF] },
            null,
            'default'
        )
        expect(cache.getSession(created.id)?.metadata?.externalRefs).toEqual([PR_REF, ISSUE_REF])

        // Exact transform /external-refs/remove-primary applies.
        const result = await cache.mutateSessionExternalRefs(created.id, (current) =>
            current.filter((candidate) => candidate.kind !== 'github_pr' || candidate.role !== 'primary')
        )

        expect(result).toEqual([ISSUE_REF])
        const persisted = cache.getSession(created.id)?.metadata?.externalRefs
        expect(persisted).toEqual([ISSUE_REF])
        expect(persisted?.some((ref) => ref.kind === 'github_pr')).toBe(false)
    })

    it('linkIssue upserting a new issue does not disturb an existing primary PR', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const created = cache.getOrCreateSession(
            'link-issue-keeps-pr',
            { path: '/tmp', host: 'h', externalRefs: [PR_REF] },
            null,
            'default'
        )

        const result = await cache.linkIssue(created.id, ISSUE_REF)

        expect(result).toEqual([PR_REF, ISSUE_REF])
        expect(cache.getSession(created.id)?.metadata?.externalRefs).toEqual([PR_REF, ISSUE_REF])
    })

    it('setSessionExternalRefs fully replaces, matching its own "authoritative set" contract', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const created = cache.getOrCreateSession(
            'set-refs-replaces',
            { path: '/tmp', host: 'h', externalRefs: [PR_REF, ISSUE_REF] },
            null,
            'default'
        )

        await cache.setSessionExternalRefs(created.id, [ISSUE_REF])

        expect(cache.getSession(created.id)?.metadata?.externalRefs).toEqual([ISSUE_REF])
    })
})
