import { describe, expect, it } from 'bun:test'
import type { Session } from '../../sync/syncEngine'
import {
    normalizeSessionSearchQuery,
    scoreSessionSearchMatch,
    sessionSearchFields
} from './sessionSearchMatch'

function createSession(overrides?: Partial<Session> & { metadata?: Session['metadata'] }): Session {
    const baseMetadata = {
        path: '/tmp/project',
        host: 'localhost',
        flavor: 'codex' as const
    }
    const base: Session = {
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: baseMetadata,
        metadataVersion: 1,
        agentState: {
            controlledByUser: false,
            requests: {},
            completedRequests: {}
        },
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        model: 'gpt-5.4',
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        permissionMode: 'default',
        collaborationMode: 'default'
    }
    return {
        ...base,
        ...overrides,
        metadata: overrides?.metadata === undefined
            ? base.metadata
            : overrides.metadata === null
                ? null
                : { ...baseMetadata, ...overrides.metadata },
        agentState: overrides?.agentState === undefined ? base.agentState : overrides.agentState
    }
}

describe('sessionSearchMatch', () => {
    it('normalizes query trim + lowercase', () => {
        expect(normalizeSessionSearchQuery('  HeTzNeR  ')).toBe('hetzner')
    })

    it('scores name higher than path and agentSessionId', () => {
        const byName = createSession({
            metadata: { name: 'Arthur Scout deploy (hetzner)', path: '/tmp/x', host: 'localhost', flavor: 'cursor', cursorSessionId: 'cur-1' }
        })
        const byPath = createSession({
            id: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
            metadata: { name: 'other', path: '/home/hetzner/deploy', host: 'localhost', flavor: 'cursor', cursorSessionId: 'cur-2' }
        })
        const byAgent = createSession({
            id: 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee',
            metadata: { name: 'other', path: '/tmp/y', host: 'localhost', flavor: 'cursor', cursorSessionId: 'hetzner-agent-id' }
        })
        const q = normalizeSessionSearchQuery('hetzner')
        expect(scoreSessionSearchMatch(byName, q)).toBeGreaterThan(scoreSessionSearchMatch(byPath, q))
        expect(scoreSessionSearchMatch(byPath, q)).toBeGreaterThan(scoreSessionSearchMatch(byAgent, q))
        expect(scoreSessionSearchMatch(byAgent, q)).toBeGreaterThan(0)
    })

    it('matches session id substring', () => {
        const session = createSession({ id: '08461427-9b0e-48c2-82cc-cbb5fad1c148' })
        expect(scoreSessionSearchMatch(session, normalizeSessionSearchQuery('08461427'))).toBeGreaterThan(0)
    })

    it('returns 0 when nothing matches', () => {
        const session = createSession({
            metadata: { name: 'unrelated', path: '/tmp/a', host: 'localhost', flavor: 'codex', codexSessionId: 'cx-1' }
        })
        expect(scoreSessionSearchMatch(session, 'hetzner')).toBe(0)
    })

    it('matches summary.text when name is empty (generated / Claude native titles)', () => {
        const session = createSession({
            id: 'summary-only-title',
            metadata: {
                path: '/tmp/quiet-project',
                host: 'localhost',
                flavor: 'claude',
                claudeSessionId: 'claude-xyz',
                summary: { text: 'Arthur Scout deploy (hetzner)', updatedAt: 1 }
            }
        })
        const q = normalizeSessionSearchQuery('hetzner')
        expect(scoreSessionSearchMatch(session, q)).toBe(400)
        // Keyword lives only in summary.text — not path or ids.
        const fields = sessionSearchFields(session)
        expect(fields.name).toBe('')
        expect(fields.summaryText).toContain('hetzner')
        expect(fields.path.toLowerCase()).not.toContain('hetzner')
        expect(fields.agentSessionId.toLowerCase()).not.toContain('hetzner')
        expect(fields.id.toLowerCase()).not.toContain('hetzner')
    })

    it('exposes search fields from summary metadata', () => {
        const fields = sessionSearchFields(createSession({
            metadata: {
                name: 'Peer search',
                path: '/work/coding/hapi',
                host: 'localhost',
                flavor: 'cursor',
                cursorSessionId: 'cursor-abc',
                summary: { text: 'generated title', updatedAt: 1 }
            }
        }))
        expect(fields).toEqual({
            id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            name: 'Peer search',
            summaryText: 'generated title',
            path: '/work/coding/hapi',
            agentSessionId: 'cursor-abc'
        })
    })
})
