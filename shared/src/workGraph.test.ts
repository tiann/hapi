import { describe, expect, it } from 'bun:test'
import {
    WorkGraphPrincipalSchema,
    isPrincipalAccountable,
    principalMatchesAuthenticatedOwner
} from './workGraph'

describe('WorkGraphPrincipalSchema', () => {
    it('accepts human principal without on_behalf_of', () => {
        const parsed = WorkGraphPrincipalSchema.safeParse({ kind: 'human', id: '42' })
        expect(parsed.success).toBe(true)
    })

    it('rejects agent without on_behalf_of', () => {
        const parsed = WorkGraphPrincipalSchema.safeParse({ kind: 'agent', id: 'session-1' })
        expect(parsed.success).toBe(false)
    })

    it('accepts agent with human owner', () => {
        const parsed = WorkGraphPrincipalSchema.safeParse({
            kind: 'agent',
            id: 'session-1',
            on_behalf_of: '42'
        })
        expect(parsed.success).toBe(true)
    })
})

describe('principal accountability helpers', () => {
    it('refuses non-human with empty owner', () => {
        expect(isPrincipalAccountable({
            kind: 'service',
            id: 'ci',
            on_behalf_of: '   '
        })).toBe(false)
    })

    it('requires human id to match authenticated owner', () => {
        expect(principalMatchesAuthenticatedOwner({ kind: 'human', id: '1' }, 1)).toBe(true)
        expect(principalMatchesAuthenticatedOwner({ kind: 'human', id: '2' }, 1)).toBe(false)
    })

    it('requires agent on_behalf_of to match authenticated owner', () => {
        expect(principalMatchesAuthenticatedOwner({
            kind: 'agent',
            id: 'worker',
            on_behalf_of: '1'
        }, 1)).toBe(true)
        expect(principalMatchesAuthenticatedOwner({
            kind: 'agent',
            id: 'worker',
            on_behalf_of: '99'
        }, 1)).toBe(false)
    })
})
