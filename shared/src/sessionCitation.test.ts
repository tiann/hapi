import { describe, expect, it } from 'bun:test'
import {
    SPAWN_PEER_TOOL_DESCRIPTION,
    extractSessionCitationIds,
    normalizeSessionIdPrefix,
} from './sessionCitation'

const UUID = '7ee03698-0fe7-4f76-b8a8-d84f4eddbf5c'

describe('extractSessionCitationIds', () => {
    it('extracts id from Copy-reference prose (tiann/hapi#1144)', () => {
        const text = `See session "Coding" (/sessions/${UUID}) for context`
        expect(extractSessionCitationIds(text)).toEqual([UUID])
    })

    it('extracts id from empty-title Copy-reference form', () => {
        expect(extractSessionCitationIds(`See HAPI session /sessions/${UUID} for context`)).toEqual([
            UUID,
        ])
    })

    it('extracts id from markdown composer chip form', () => {
        expect(extractSessionCitationIds(`[Coding](/sessions/${UUID})`)).toEqual([UUID])
    })

    it('extracts id from bare /sessions/<id>', () => {
        expect(extractSessionCitationIds(`please read /sessions/${UUID}`)).toEqual([UUID])
    })

    it('strips trailing prose punctuation from bare citations', () => {
        expect(extractSessionCitationIds(`see /sessions/${UUID}.`)).toEqual([UUID])
        expect(extractSessionCitationIds(`see /sessions/${UUID}, then continue`)).toEqual([UUID])
    })

    it('rejects dotted tails that look like source paths', () => {
        expect(extractSessionCitationIds('see web/src/routes/sessions/chat.tsx')).toEqual([])
        expect(extractSessionCitationIds('/sessions/chat.tsx')).toEqual([])
    })

    it('dedupes while preserving first-seen order', () => {
        const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        const text = `[A](/sessions/${UUID}) and See session "B" (/sessions/${other}) then /sessions/${UUID}`
        expect(extractSessionCitationIds(text)).toEqual([UUID, other])
    })

    it('accepts BASE_URL-prefixed session paths', () => {
        expect(extractSessionCitationIds(`(/hapi/sessions/${UUID})`)).toEqual([UUID])
    })
})

describe('normalizeSessionIdPrefix', () => {
    it('returns a bare prefix unchanged', () => {
        expect(normalizeSessionIdPrefix('7ee03698')).toBe('7ee03698')
        expect(normalizeSessionIdPrefix(`  ${UUID}  `)).toBe(UUID)
    })

    it('pulls the id out of a pasted Copy-reference blob', () => {
        expect(
            normalizeSessionIdPrefix(`See session "Coding" (/sessions/${UUID}) for context`)
        ).toBe(UUID)
    })

    it('prefers the parenthesized Copy-reference path over /sessions/ inside the title', () => {
        const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        const text =
            `See session ${JSON.stringify(`Review /sessions/${other}`)} (/sessions/${UUID}) for context.`
        expect(normalizeSessionIdPrefix(text)).toBe(UUID)
    })

    it('pulls the id out of a markdown citation', () => {
        expect(normalizeSessionIdPrefix(`[Coding](/sessions/${UUID})`)).toBe(UUID)
    })

    it('fails closed on ambiguous multi-citation blobs', () => {
        const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        expect(
            normalizeSessionIdPrefix(
                `[A](/sessions/${UUID}) and See session "B" (/sessions/${other}) for context`
            )
        ).toBe('')
    })

    it('fails closed when a Copy-reference is followed by a second citation', () => {
        const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        expect(
            normalizeSessionIdPrefix(
                `See session "A" (/sessions/${UUID}) for context and [B](/sessions/${other})`
            )
        ).toBe('')
    })
})

describe('SPAWN_PEER_TOOL_DESCRIPTION', () => {
    it('describes a fresh atomic spawn without embedding workflow prose', () => {
        expect(SPAWN_PEER_TOOL_DESCRIPTION).toContain('fresh HAPI session')
        expect(SPAWN_PEER_TOOL_DESCRIPTION).toContain('atomically')
    })
})
