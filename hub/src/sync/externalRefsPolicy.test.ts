import { describe, expect, it } from 'bun:test'
import { externalRefsInMetadataValid } from './externalRefsPolicy'

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
