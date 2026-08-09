import { describe, expect, it } from 'bun:test'
import {
    WORK_GRAPH_MAX_PAYLOAD_JSON_BYTES,
    WorkGraphEventCreateSchema,
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

describe('WorkGraphEventCreateSchema bounds', () => {
    const base = {
        source_kind: 'session',
        source_ref: 'sess-1',
        event_type: 'work_ad',
        principal: { kind: 'human' as const, id: '1' }
    }

    it('rejects oversized payload_json', () => {
        const parsed = WorkGraphEventCreateSchema.safeParse({
            ...base,
            payload_json: { blob: 'x'.repeat(WORK_GRAPH_MAX_PAYLOAD_JSON_BYTES) }
        })
        expect(parsed.success).toBe(false)
    })

    it('rejects payload_json that fits UTF-16 length but exceeds UTF-8 bytes', () => {
        // CJK is 1 UTF-16 code unit / 3 UTF-8 bytes. ~12k chars stays under
        // string.length of 32 KiB but over UTF-8 byte budget.
        const cjk = '\u4e2d'.repeat(12_000)
        const json = JSON.stringify({ blob: cjk })
        expect(json.length).toBeLessThanOrEqual(WORK_GRAPH_MAX_PAYLOAD_JSON_BYTES)
        expect(new TextEncoder().encode(json).byteLength).toBeGreaterThan(WORK_GRAPH_MAX_PAYLOAD_JSON_BYTES)
        const parsed = WorkGraphEventCreateSchema.safeParse({
            ...base,
            payload_json: { blob: cjk }
        })
        expect(parsed.success).toBe(false)
    })

    it('rejects too many tags', () => {
        const parsed = WorkGraphEventCreateSchema.safeParse({
            ...base,
            tags: Array.from({ length: 33 }, (_, i) => `t${i}`)
        })
        expect(parsed.success).toBe(false)
    })
})
