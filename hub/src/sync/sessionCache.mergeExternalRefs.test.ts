import { describe, expect, it } from 'bun:test'
import { mergeSessionMetadataForSessionMerge } from './sessionCache'
import { ExternalRefsMergeCapExceededError } from './externalRefErrors'

const prRef = {
    kind: 'github_pr' as const,
    repo: 'tiann/hapi',
    number: 1160,
    url: 'https://github.com/tiann/hapi/pull/1160',
    role: 'primary' as const
}

describe('mergeSessionMetadataForSessionMerge externalRefs', () => {
    it('preserves externalRefs from the old row when the new row omits them', () => {
        const oldMetadata = {
            path: '/old',
            host: 'old-host',
            name: 'PR session',
            externalRefs: [prRef]
        }
        const newMetadata = {
            path: '/new',
            host: 'new-host',
            flavor: 'cursor'
        }

        const merged = mergeSessionMetadataForSessionMerge(oldMetadata, newMetadata) as Record<string, unknown>

        expect(merged.externalRefs).toEqual([prRef])
        expect(merged.path).toBe('/new')
        expect(merged.flavor).toBe('cursor')
        expect(merged.name).toBe('PR session')
    })

    // The new row's own primary PR wins the one-true-primary slot over the
    // old row's different primary PR, but (round 13 fix) the old row's
    // link is demoted to secondary rather than dropped — "the new row's
    // explicit set wins" means it wins the PRIMARY role, not that old's
    // independent link disappears entirely.
    it('lets the new row\'s explicit primary win the role, demoting the old row\'s primary to secondary', () => {
        const oldMetadata = {
            path: '/old',
            host: 'old-host',
            externalRefs: [prRef]
        }
        const replacement = [{
            kind: 'github_pr' as const,
            repo: 'owner/other',
            number: 42,
            url: 'https://github.com/owner/other/pull/42',
            role: 'primary' as const
        }]
        const newMetadata = {
            path: '/new',
            host: 'new-host',
            externalRefs: replacement
        }

        const merged = mergeSessionMetadataForSessionMerge(oldMetadata, newMetadata) as Record<string, unknown>

        expect(merged.externalRefs).toEqual([
            replacement[0],
            { ...prRef, role: 'secondary' }
        ])
    })

    // Review finding (hapi#2147, follow-up): an explicit `externalRefs: []`
    // on the surviving row only records that row unlinking its *own* prior
    // ref — it says nothing about a different, about-to-be-deleted session's
    // independent links. Treating it as "nothing to preserve" used to drop
    // the old row's refs for good the instant mergeSessions deletes it.
    it('unions in the old row\'s refs even when the new row explicitly cleared its own', () => {
        const oldMetadata = {
            path: '/old',
            host: 'old-host',
            externalRefs: [prRef]
        }
        const newMetadata = {
            path: '/new',
            host: 'new-host',
            externalRefs: []
        }

        const merged = mergeSessionMetadataForSessionMerge(oldMetadata, newMetadata) as Record<string, unknown>

        expect(merged.externalRefs).toEqual([prRef])
    })

    it('preserves the old row\'s issue link when the target just removed its only PR', () => {
        const issueRef = {
            kind: 'github_issue' as const,
            repo: 'tiann/hapi',
            number: 42,
            url: 'https://github.com/tiann/hapi/issues/42',
            linkedAt: 1
        }
        // The surviving row had a primary PR and just unlinked it via the
        // dedicated remove-primary mutation, persisting `externalRefs: []`.
        const newMetadata = {
            path: '/new',
            host: 'new-host',
            externalRefs: []
        }
        // A later deleting merge brings in an unrelated old session that
        // independently linked its own issue — that link must survive even
        // though the target's own array is empty.
        const oldMetadata = {
            path: '/old',
            host: 'old-host',
            externalRefs: [issueRef]
        }

        const merged = mergeSessionMetadataForSessionMerge(oldMetadata, newMetadata) as Record<string, unknown>

        expect(merged.externalRefs).toEqual([issueRef])
    })

    it('still keeps both sides empty when neither has anything to preserve', () => {
        const oldMetadata = { path: '/old', host: 'old-host', externalRefs: [] }
        const newMetadata = { path: '/new', host: 'new-host', externalRefs: [] }

        const merged = mergeSessionMetadataForSessionMerge(oldMetadata, newMetadata) as Record<string, unknown>

        expect(merged.externalRefs).toEqual([])
    })

    // Review finding (hapi#2147): two valid sessions can each independently
    // sit at or near MAX_EXTERNAL_REFS; their union has no cap of its own.
    // Persisting an over-limit array doesn't just lose the extra refs — it
    // fails MetadataSchema validation on the *next* read, nulling out the
    // whole merged metadata object. Worse, this function is reached from
    // mergeSessions, which deletes the old row right after this merge
    // "succeeds" — silently falling back to the surviving row's own refs
    // would mean the old row's 17 links are gone the instant it's deleted,
    // with nothing surfaced anywhere. Throws instead, so the caller
    // (mergeSessionMetadataForTransfer) can abort the whole merge rather
    // than quietly losing data.
    it('throws instead of silently dropping the losing side\'s refs when the union would exceed MAX_EXTERNAL_REFS', () => {
        const makeRef = (repo: string, number: number) => ({
            kind: 'github_issue' as const,
            repo,
            number,
            url: `https://github.com/${repo}/issues/${number}`,
            linkedAt: number
        })
        const oldRefs = Array.from({ length: 17 }, (_, i) => makeRef('acme/old', i + 1))
        const newRefs = Array.from({ length: 17 }, (_, i) => makeRef('acme/new', i + 1))
        const oldMetadata = { path: '/old', host: 'old-host', externalRefs: oldRefs }
        const newMetadata = { path: '/new', host: 'new-host', externalRefs: newRefs }

        // Union of 34 distinct refs exceeds the 32 cap.
        expect(() => mergeSessionMetadataForSessionMerge(oldMetadata, newMetadata))
            .toThrow(ExternalRefsMergeCapExceededError)
    })

    // Review finding (tiann/hapi#2147, round 13): the surviving row has PR
    // A as primary and PR B as secondary; the about-to-be-deleted old row
    // has a NEWER primary link to that same PR B. Reconciliation correctly
    // picks old's fresher entry for PR B's identity, which leaves two
    // refs both marked primary (A from new, B from old) — a genuine
    // one-true-primary conflict, but the fix used to resolve it by
    // dropping every primary that wasn't the chosen one outright, losing
    // PR B's link entirely rather than just demoting it back to the
    // secondary role it already held. Demoting, not dropping, keeps both
    // real links alive with the invariant satisfied.
    it('demotes a losing primary conflict to secondary instead of dropping the ref entirely', () => {
        const prA = {
            kind: 'github_pr' as const,
            repo: 'tiann/hapi',
            number: 1,
            url: 'https://github.com/tiann/hapi/pull/1',
            role: 'primary' as const,
            linkedAt: 1
        }
        const prBAsSecondary = {
            kind: 'github_pr' as const,
            repo: 'tiann/hapi',
            number: 2,
            url: 'https://github.com/tiann/hapi/pull/2',
            role: 'secondary' as const,
            linkedAt: 1
        }
        const prBAsNewerPrimary = {
            ...prBAsSecondary,
            role: 'primary' as const,
            linkedAt: 2
        }
        const newMetadata = {
            path: '/new',
            host: 'new-host',
            externalRefs: [prA, prBAsSecondary]
        }
        const oldMetadata = {
            path: '/old',
            host: 'old-host',
            externalRefs: [prBAsNewerPrimary]
        }

        const merged = mergeSessionMetadataForSessionMerge(oldMetadata, newMetadata) as Record<string, unknown>

        const refs = merged.externalRefs as Array<{ number: number; role: string }>
        expect(refs).toHaveLength(2)
        expect(refs.find(r => r.number === 1)).toMatchObject({ role: 'primary' })
        expect(refs.find(r => r.number === 2)).toMatchObject({ role: 'secondary' })
    })
})
