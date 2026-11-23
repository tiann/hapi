import { describe, expect, it } from 'bun:test'
import {
    ParentStampError,
    ensureParentStamp,
    extractParentSessionIdFromRemit,
    formatParentStampBlock,
    formatSessionChip,
    remitCitesSessionId,
} from './peerParentStamp'
import { extractSessionCitationIds, normalizeSessionIdPrefix } from './sessionCitation'

const PARENT_ID = '4bd4d2b9-e114-4e03-af4c-03e9e4f7439e'
const AGENT_SESSION_ID = 'cursor-agent-session-abc'

describe('formatSessionChip', () => {
    it('builds a durable [title](/sessions/<uuid>) chip', () => {
        expect(formatSessionChip({ sessionId: PARENT_ID, name: 'Producer to Infra' })).toBe(
            `[Producer to Infra](/sessions/${PARENT_ID})`
        )
    })

    it('falls back to a short id when name is missing (never invents a nickname)', () => {
        expect(formatSessionChip({ sessionId: PARENT_ID })).toBe(
            `[4bd4d2b9](/sessions/${PARENT_ID})`
        )
    })
})

describe('formatParentStampBlock', () => {
    it('stamps Parent with the full UUID chip and optional agentSessionId', () => {
        const block = formatParentStampBlock({
            sessionId: PARENT_ID,
            name: 'cursor - tooling/meta bot',
            agentSessionId: AGENT_SESSION_ID,
        })
        expect(block).toContain('## Parent')
        expect(block).toContain(`[cursor - tooling/meta bot](/sessions/${PARENT_ID})`)
        expect(block).toContain(`agentSessionId: \`${AGENT_SESSION_ID}\``)
        expect(block.toLowerCase()).toMatch(/uuid|decoration|rename/)
    })
})

describe('ensureParentStamp', () => {
    it('prepends a Parent block when the remit lacks the parent UUID', () => {
        const result = ensureParentStamp('## Your assignment\n- do the work', {
            sessionId: PARENT_ID,
            name: 'Orchestrator',
        })
        expect(result.stamped).toBe(true)
        expect(result.alreadyPresent).toBe(false)
        expect(result.message.startsWith('## Parent')).toBe(true)
        expect(result.message).toContain(`/sessions/${PARENT_ID}`)
        expect(result.message).toContain('## Your assignment')
    })

    it('is a no-op when the remit already has a ## Parent markdown chip for this UUID', () => {
        const body = `## Parent\n- Orchestrator chip: [Old Title](/sessions/${PARENT_ID})\n\nGo.`
        const result = ensureParentStamp(body, {
            sessionId: PARENT_ID,
            name: 'Renamed',
        })
        expect(result.stamped).toBe(false)
        expect(result.alreadyPresent).toBe(true)
        expect(result.message).toBe(body)
    })

    it('stays idempotent when the parent title contains brackets (escaped in the chip label)', () => {
        const identity = { sessionId: PARENT_ID, name: 'Team [Infra]' }
        const first = ensureParentStamp('Do the work.', identity)
        expect(first.stamped).toBe(true)
        expect(first.message).toContain(`[Team \\[Infra\\]](/sessions/${PARENT_ID})`)
        const second = ensureParentStamp(first.message, {
            sessionId: PARENT_ID,
            name: 'Renamed [Again]',
        })
        expect(second.stamped).toBe(false)
        expect(second.alreadyPresent).toBe(true)
        expect(second.message).toBe(first.message)
        expect(second.message.match(/## Parent/g)?.length).toBe(1)
    })

    it('does not hang on a long nonmatching backslash run under ## Parent', () => {
        const body = `## Parent\n- [${'\\'.repeat(40)}\n\nDo the work.`
        const started = Date.now()
        const result = ensureParentStamp(body, {
            sessionId: PARENT_ID,
            name: 'Parent',
        })
        expect(Date.now() - started).toBeLessThan(200)
        expect(result.stamped).toBe(true)
        expect(result.message).toContain(`[Parent](/sessions/${PARENT_ID})`)
    })

    it('still stamps when the remit only has a bare parent citation (no ## Parent block)', () => {
        // Bare /sessions/<uuid> must not suppress the Parent chip - chat UI only
        // promotes citations under ## Parent into the sender-style chip.
        const body = `See /sessions/${PARENT_ID} for context.\n\nDo the work.`
        const result = ensureParentStamp(body, {
            sessionId: PARENT_ID,
            name: 'Parent',
        })
        expect(result.stamped).toBe(true)
        expect(result.alreadyPresent).toBe(false)
        expect(result.message.startsWith('## Parent')).toBe(true)
        expect(result.message).toContain(body)
    })

    it('still stamps when ## Parent is empty and the UUID only appears under a later heading', () => {
        const body = `## Parent\n\n## Context\nSee [other](/sessions/${PARENT_ID}) for prior work.\n\nDo the work.`
        const result = ensureParentStamp(body, {
            sessionId: PARENT_ID,
            name: 'Parent',
        })
        expect(result.stamped).toBe(true)
        expect(result.alreadyPresent).toBe(false)
        expect(result.message.startsWith('## Parent')).toBe(true)
        expect(result.message).toContain(`[Parent](/sessions/${PARENT_ID})`)
    })

    it('still stamps when ## Parent only has a bare /sessions path (no markdown chip)', () => {
        const body = `## Parent\n- source: /sessions/${PARENT_ID}\n\nDo the work.`
        const result = ensureParentStamp(body, {
            sessionId: PARENT_ID,
            name: 'Parent',
        })
        expect(result.stamped).toBe(true)
        expect(result.alreadyPresent).toBe(false)
        expect(result.message).toContain(`[Parent](/sessions/${PARENT_ID})`)
    })

    it('fail-closes when requireParent and parent id is missing', () => {
        expect(() =>
            ensureParentStamp('brief', null, { requireParent: true })
        ).toThrow(ParentStampError)
        expect(() =>
            ensureParentStamp('brief', { sessionId: '  ' }, { requireParent: true })
        ).toThrow(/parent session id/i)
    })

    it('allows missing parent when requireParent is false (outside-session CLI)', () => {
        const result = ensureParentStamp('brief', undefined, { requireParent: false })
        expect(result.message).toBe('brief')
        expect(result.stamped).toBe(false)
    })
})

describe('P2 falsification: spawn → rename → ping by handoff UUID only', () => {
    it('keeps the handoff UUID usable after the parent display name changes', () => {
        const originalName = 'Producer'
        const renamedName = 'Producer to Infra'
        const stamped = ensureParentStamp('Own steps: implement P0', {
            sessionId: PARENT_ID,
            name: originalName,
            agentSessionId: AGENT_SESSION_ID,
        })

        // Parent is renamed mid-flight; remit text still has the old decorative title.
        expect(stamped.message).toContain(originalName)
        expect(stamped.message).not.toContain(renamedName)

        // Child must address parent by UUID from the handoff chip - not invent titles.
        const handoffIds = extractSessionCitationIds(stamped.message)
        expect(handoffIds).toEqual([PARENT_ID])
        expect(extractParentSessionIdFromRemit(stamped.message)).toBe(PARENT_ID)
        expect(remitCitesSessionId(stamped.message, PARENT_ID)).toBe(true)

        const chip = stamped.message.match(/\[[^\]]*\]\(\/sessions\/[^)]+\)/)?.[0] ?? ''
        expect(normalizeSessionIdPrefix(chip)).toBe(PARENT_ID)

        // Rename is a non-event for routing: UUID is identity; title is decoration.
        const pingTarget = extractParentSessionIdFromRemit(stamped.message)
        expect(pingTarget).toBe(PARENT_ID)
        expect(pingTarget).not.toBe(renamedName)
        expect(pingTarget).not.toBe(originalName)
    })
})
