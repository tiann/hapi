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

    it('lets the new row win when it explicitly sets externalRefs', () => {
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

        expect(merged.externalRefs).toEqual(replacement)
    })

    it('lets an explicit empty externalRefs array clear the old refs', () => {
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
})
