import { describe, expect, it } from 'bun:test'
import {
    INSPECT_PEER_TOOL_DESCRIPTION,
    LIST_PEERS_TOOL_DESCRIPTION,
    PEER_CONTACT_RULE,
    PEER_CONTACT_SUMMARY,
    PEER_WAKE_PARAM_DESCRIPTION,
    SESSION_CITATION_DISABLED_STEER,
    SESSION_REFERENCE_STEER_SUFFIX,
    SPAWN_PEER_TOOL_DESCRIPTION,
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
    const text = buildSessionCitationSteerInstruction({ inspectTool: 'mcp__hapi__inspect_peer' })

    it('explains citations, names the inspect tool, and limits who may be messaged', () => {
        expect(text).toContain('/sessions/<id>')
        expect(text).toContain('not a file')
        expect(text).toContain('mcp__hapi__inspect_peer')
        expect(text).toContain(PEER_CONTACT_SUMMARY)
    })

    it('leaves usage rules to the tool descriptions', () => {
        expect(text.length).toBeLessThanOrEqual(300)
        expect(SESSION_CITATION_DISABLED_STEER.length).toBeLessThanOrEqual(300)
        expect(text).not.toContain(PEER_CONTACT_RULE)
        expect(text).not.toContain('deliveryMode')
        expect(text).not.toContain('wake')
    })

    it('keeps the not-a-file guard when peer tools are disabled', () => {
        expect(SESSION_CITATION_DISABLED_STEER).toContain('not a file')
        expect(SESSION_CITATION_DISABLED_STEER).toContain('are disabled on this machine')
        expect(SESSION_CITATION_DISABLED_STEER).not.toContain(PEER_CONTACT_SUMMARY)
    })
})

describe('peer tool contracts', () => {
    it('carries every rule the system prompt no longer repeats', () => {
        for (const form of ['[title](/sessions/<id>)', 'See session', 'bare /sessions/<id>']) {
            expect(INSPECT_PEER_TOOL_DESCRIPTION).toContain(form)
            expect(PING_PEER_TOOL_DESCRIPTION).toContain(form)
        }
        expect(INSPECT_PEER_TOOL_DESCRIPTION).toContain('do NOT Grep, Glob, or Read')
        for (const description of [PING_PEER_TOOL_DESCRIPTION, LIST_PEERS_TOOL_DESCRIPTION]) {
            expect(description).toContain(PEER_CONTACT_RULE)
        }
        expect(PEER_CONTACT_RULE).toContain(PEER_CONTACT_SUMMARY)
        expect(PEER_CONTACT_RULE).toContain('Never broadcast')
        expect(PING_PEER_TOOL_DESCRIPTION).toContain('refused unless wake=true')
        expect(PEER_WAKE_PARAM_DESCRIPTION).toContain('Set true only when the user asked')
        expect(SPAWN_PEER_TOOL_DESCRIPTION).toContain('POST /api/machines/.../spawn')
        expect(INSPECT_PEER_TOOL_DESCRIPTION).toContain('hapi inspect-peer')
        expect(PING_PEER_TOOL_DESCRIPTION).toContain('hapi ping-peer')
        expect(SPAWN_PEER_TOOL_DESCRIPTION).toContain('hapi spawn-peer')
        expect(LIST_PEERS_TOOL_DESCRIPTION).toContain('hapi ping-peer --list')
    })

    it('keeps delivery guidance on the deliveryMode parameter only', () => {
        const text = PEER_DELIVERY_MODE_DESCRIPTION
        expect(PING_PEER_TOOL_DESCRIPTION).not.toContain(text)
        expect(text).toContain('auto (default)')
        expect(text).toContain('active turn when the target supports steering and is ready')
        expect(text).toContain('auto retains the same single accepted message without resending')
        expect(text).not.toContain('Auto currently queues for other agent flavors')
        expect(text).toContain('Prefer auto for routine collaboration when queueing is an acceptable fallback')
        expect(text).toContain('queue: explicitly defer non-urgent updates')
        expect(text).toContain('steer: use for important, time-sensitive findings the peer needs to know now')
        expect(text).toContain('not after finishing its current turn')
        expect(text).toContain('State why the finding matters now and what the peer should adjust')
        expect(text).toContain('Steer requires insertion')
        expect(text).toContain('does not abort the current turn or guarantee an immediate response')
        expect(text).toContain('do not resend automatically')
    })
})

describe('SPAWN_PEER_TOOL_DESCRIPTION', () => {
    it('tells agents the hub rejects a spawn-body remit instead of stripping it', () => {
        expect(SPAWN_PEER_TOOL_DESCRIPTION.toLowerCase()).toMatch(/reject/)
        expect(SPAWN_PEER_TOOL_DESCRIPTION.toLowerCase()).not.toMatch(/strip/)
    })

    it('teaches omit permissionMode = yolo default, not approval-gated default', () => {
        expect(SPAWN_PEER_TOOL_DESCRIPTION.toLowerCase()).toMatch(/yolo/)
        expect(SPAWN_PEER_TOOL_DESCRIPTION.toLowerCase()).toMatch(/omit/)
        expect(SPAWN_PEER_TOOL_DESCRIPTION.toLowerCase()).not.toMatch(
            /pass permissionmode only when the operator asked/
        )
    })

    it('forbids inventing peer titles and teaches Parent UUID stamp', () => {
        expect(SPAWN_PEER_TOOL_DESCRIPTION.toLowerCase()).toMatch(/never invent/)
        expect(SPAWN_PEER_TOOL_DESCRIPTION.toLowerCase()).toMatch(/parent/)
        expect(SPAWN_PEER_TOOL_DESCRIPTION.toLowerCase()).toMatch(/uuid/)
    })

    it('documents optional machine targeting beyond this host only', () => {
        expect(SPAWN_PEER_TOOL_DESCRIPTION.toLowerCase()).toMatch(/machine/)
        expect(SPAWN_PEER_TOOL_DESCRIPTION.toLowerCase()).toMatch(/hostname|uuid/)
        expect(SPAWN_PEER_TOOL_DESCRIPTION.toLowerCase()).not.toMatch(
            /spawn a new hapi session on this machine and/
        )
    })
})

describe('PING_PEER_TOOL_DESCRIPTION identity rule', () => {
    it('forbids inventing peer titles', async () => {
        const { PING_PEER_TOOL_DESCRIPTION } = await import('./sessionCitation')
        expect(PING_PEER_TOOL_DESCRIPTION.toLowerCase()).toMatch(/never invent/)
    })
})
