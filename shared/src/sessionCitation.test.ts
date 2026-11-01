import { describe, expect, it } from 'bun:test'
import {
    SESSION_REFERENCE_STEER_SUFFIX,
    PEER_DELIVERY_MODE_DESCRIPTION,
    PING_PEER_TOOL_DESCRIPTION,
    buildSessionCitationSteerInstruction,
    extractSessionCitationIds,
    normalizeSessionIdPrefix,
} from './sessionCitation'

const UUID = '7ee03698-0fe7-4f76-b8a8-d84f4eddbf5c'

describe('extractSessionCitationIds', () => {
    it('extracts id from Copy-reference prose (tiann/hapi#1144)', () => {
        const text = `See session "Coding" (/sessions/${UUID}) for context`
        expect(extractSessionCitationIds(text)).toEqual([UUID])
    })

    it('extracts id from Copy-reference prose with steer suffix', () => {
        const text =
            `See session "Coding" (/sessions/${UUID}) for context.${SESSION_REFERENCE_STEER_SUFFIX}`
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
            `See session ${JSON.stringify(`Review /sessions/${other}`)} (/sessions/${UUID}) for context.${SESSION_REFERENCE_STEER_SUFFIX}`
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

describe('buildSessionCitationSteerInstruction', () => {
    it('guides collaboration toward auto and preserves explicit modes and retry safety', () => {
        const text = buildSessionCitationSteerInstruction({ inspectTool: 'inspect_peer', pingTool: 'ping_peer' })
        expect(text).toContain(PEER_DELIVERY_MODE_DESCRIPTION)
        expect(PING_PEER_TOOL_DESCRIPTION).toContain(PEER_DELIVERY_MODE_DESCRIPTION)
        expect(text).toContain('auto (default)')
        expect(text).toContain('active Codex turn')
        expect(text).toContain('Auto currently queues for other agent flavors')
        expect(text).toContain('Prefer auto for routine collaboration when queueing is an acceptable fallback')
        expect(text).toContain('queue: explicitly defer non-urgent updates')
        expect(text).toContain('steer: use for important, time-sensitive findings the peer needs to know now')
        expect(text).toContain('not after finishing its current turn')
        expect(text).toContain('State why the finding matters now and what the peer should adjust')
        expect(text).toContain('Steer requires insertion')
        expect(text).toContain('does not abort the current turn or guarantee an immediate response')
        expect(text).toContain('do not resend automatically')
        expect(text).toContain('hapi ping-peer <id> <message> --delivery-mode auto')
    })

    it('mentions both citation forms and forbids local FS search', () => {
        const text = buildSessionCitationSteerInstruction({
            inspectTool: 'mcp__hapi__inspect_peer',
            pingTool: 'mcp__hapi__ping_peer',
            listPeersTool: 'mcp__hapi__list_peers',
        })
        expect(text).toContain('[title](/sessions/<id>)')
        expect(text).toContain('See session')
        expect(text).toContain('/sessions/<id>')
        expect(text).toContain('mcp__hapi__inspect_peer')
        expect(text).toContain('mcp__hapi__ping_peer')
        expect(text).toContain('mcp__hapi__list_peers')
        expect(text.toLowerCase()).toMatch(/not.*(grep|glob|filesystem|local file)/i)
    })
})
