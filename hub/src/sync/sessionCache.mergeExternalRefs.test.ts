import { describe, expect, it } from 'bun:test'
import { mergeSessionMetadataForSessionMerge } from './sessionCache'

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
})
