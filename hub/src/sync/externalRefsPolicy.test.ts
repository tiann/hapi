import { describe, expect, it } from 'bun:test'
import { externalRefsInMetadataValid, stripExternalRefsWhenAwarenessDisabled } from './externalRefsPolicy'

const PR_REF = { kind: 'github_pr', repo: 'tiann/hapi', number: 1, url: 'https://github.com/tiann/hapi/pull/1', role: 'primary' }
const ISSUE_REF = { kind: 'github_issue', repo: 'tiann/hapi', number: 2, url: 'https://github.com/tiann/hapi/issues/2', linkedAt: 1 }

describe('stripExternalRefsWhenAwarenessDisabled', () => {
    it('leaves metadata untouched when awareness is enabled', () => {
        const metadata = { path: '/tmp', externalRefs: [PR_REF, ISSUE_REF] }
        expect(stripExternalRefsWhenAwarenessDisabled(metadata, true)).toBe(metadata)
    })

    it('leaves metadata with no externalRefs key untouched', () => {
        const metadata = { path: '/tmp' }
        expect(stripExternalRefsWhenAwarenessDisabled(metadata, false)).toBe(metadata)
    })

    it('strips github_pr refs but keeps github_issue refs — link_issue is always-on, not gated by PR awareness', () => {
        const metadata = { path: '/tmp', externalRefs: [PR_REF, ISSUE_REF] }
        expect(stripExternalRefsWhenAwarenessDisabled(metadata, false)).toEqual({
            path: '/tmp',
            externalRefs: [ISSUE_REF]
        })
    })

    it('omits the key (not `[]`) when filtering leaves nothing — a stored PR link must survive, not read as an explicit clear', () => {
        // A routine write (e.g. a routine CLI metadata sync) that still
        // echoes a cached PR-only array, after awareness is disabled, has
        // nothing left to say about external refs — `[]` would read
        // downstream as "clear everything," wiping a PR link this specific
        // write never meant to touch (review finding).
        const metadata = { path: '/tmp', externalRefs: [PR_REF] }
        const result = stripExternalRefsWhenAwarenessDisabled(metadata, false) as Record<string, unknown>
        expect('externalRefs' in result).toBe(false)
    })

    it('passes a genuinely empty input array through as `[]` — a real deliberate clear is still honored', () => {
        const metadata = { path: '/tmp', externalRefs: [] }
        expect(stripExternalRefsWhenAwarenessDisabled(metadata, false)).toEqual({
            path: '/tmp',
            externalRefs: []
        })
    })

    it('deletes the whole key when externalRefs is not array-shaped, leaving rejection to externalRefsInMetadataValid', () => {
        const metadata = { path: '/tmp', externalRefs: 'not-an-array' }
        const result = stripExternalRefsWhenAwarenessDisabled(metadata, false) as Record<string, unknown>
        expect('externalRefs' in result).toBe(false)
    })

    it('returns non-object metadata unchanged', () => {
        expect(stripExternalRefsWhenAwarenessDisabled(null, false)).toBeNull()
        expect(stripExternalRefsWhenAwarenessDisabled('x', false)).toBe('x')
    })
})

describe('externalRefsInMetadataValid', () => {
    it('accepts metadata without externalRefs', () => {
        expect(externalRefsInMetadataValid({ path: '/tmp' })).toBe(true)
    })

    it('rejects two primary GitHub PRs', () => {
        expect(externalRefsInMetadataValid({
            path: '/tmp',
            externalRefs: [
                {
                    kind: 'github_pr',
                    repo: 'tiann/hapi',
                    number: 1,
                    url: 'https://github.com/tiann/hapi/pull/1',
                    role: 'primary'
                },
                {
                    kind: 'github_pr',
                    repo: 'tiann/hapi',
                    number: 2,
                    url: 'https://github.com/tiann/hapi/pull/2',
                    role: 'primary'
                }
            ]
        })).toBe(false)
    })
})
