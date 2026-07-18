import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { CODEX_DESKTOP_SYNC_SOURCE, getSessionDisplayTitle, toSessionSummary } from '@hapi/protocol'
import { deduplicateSessionsByAgentId, getFlavorBadge } from './SessionList'

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        todoProgress: null,
        pendingRequestsCount: 0,
        unreadCount: 0,
        model: null,
        effort: null,
        ...overrides
    }
}

describe('deduplicateSessionsByAgentId', () => {
    it('deduplicates sessions with the same agentSessionId', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 100 }),
            makeSession({ id: 'b', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 200 })
        ]
        const result = deduplicateSessionsByAgentId(sessions)
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('b') // more recent wins
    })

    it('keeps active session over inactive duplicate', () => {
        const sessions = [
            makeSession({ id: 'a', active: true, metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 100 }),
            makeSession({ id: 'b', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 200 })
        ]
        const result = deduplicateSessionsByAgentId(sessions)
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('a') // active wins despite older updatedAt
    })

    it('prefers selected session among inactive duplicates', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 100 }),
            makeSession({ id: 'b', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 200 })
        ]
        const result = deduplicateSessionsByAgentId(sessions, 'a')
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('a') // selected wins despite older updatedAt
    })

    it('active always wins over selected inactive', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 200 }),
            makeSession({ id: 'b', active: true, metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 100 })
        ]
        const result = deduplicateSessionsByAgentId(sessions, 'a')
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('b') // active wins over selected
    })

    it('passes through sessions without agentSessionId', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/p' } }),
            makeSession({ id: 'b', metadata: { path: '/p', agentSessionId: 'thread-1' } }),
            makeSession({ id: 'c', metadata: null })
        ]
        const result = deduplicateSessionsByAgentId(sessions)
        expect(result).toHaveLength(3)
    })

    it('deduplicates independently across different agentSessionIds', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 100 }),
            makeSession({ id: 'b', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 200 }),
            makeSession({ id: 'c', metadata: { path: '/p', agentSessionId: 'thread-2' }, updatedAt: 100 }),
            makeSession({ id: 'd', metadata: { path: '/p', agentSessionId: 'thread-2' }, updatedAt: 200 })
        ]
        const result = deduplicateSessionsByAgentId(sessions)
        expect(result).toHaveLength(2)
        expect(result.map(s => s.id).sort()).toEqual(['b', 'd'])
    })
})

describe('flavor badges', () => {
    it('shows DeepSeek-specific initials for CC-deepseek sessions', () => {
        expect(getFlavorBadge('claude-deepseek').label).toBe('DS')
        expect(getFlavorBadge('claude').label).toBe('Cl')
    })

    it('shows Ark-specific initials for CC-ark sessions', () => {
        expect(getFlavorBadge('claude-ark').label).toBe('ARK')
        expect(getFlavorBadge('claude').label).toBe('Cl')
    })

    it('shows a dedicated API glyph for CC-api sessions', () => {
        expect(getFlavorBadge('cc-api')).toMatchObject({
            label: 'API',
            icon: 'api',
        })
        expect(getFlavorBadge('claude').label).toBe('Cl')
        expect(getFlavorBadge('claude').icon).toBeUndefined()
    })

    it('shows a dedicated MoA badge for Hermes MoA sessions', () => {
        expect(getFlavorBadge('hermes-moa')).toMatchObject({
            label: 'MoA',
        })
        expect(getFlavorBadge('claude').label).toBe('Cl')
    })

    it('uses an exclusive electric-magenta color for Grok sessions', () => {
        expect(getFlavorBadge('grok').colors).toBe('bg-[#c026d3] text-white')
        expect(getFlavorBadge('grok').colors).not.toBe(getFlavorBadge('claude').colors)
    })
})

describe('session summary titles', () => {
    it('preserves desktop mirror source so summaries do not rename mirrored sessions', () => {
        const summary = toSessionSummary({
            id: 'session-1',
            namespace: 'default',
            seq: 1,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
            metadata: {
                path: '/Users/example/Documents/Playground',
                host: 'mac',
                mirrorSource: CODEX_DESKTOP_SYNC_SOURCE,
                summary: { text: 'Changing task title', updatedAt: 1 }
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            model: null,
            modelReasoningEffort: null,
            effort: null
        })

        expect(summary.metadata?.mirrorSource).toBe(CODEX_DESKTOP_SYNC_SOURCE)
        expect(getSessionDisplayTitle(summary)).toBe('Playground')
    })

    it('does not fall back to changing summaries for Codex session-list items', () => {
        const summary = toSessionSummary({
            id: 'session-1',
            namespace: 'default',
            seq: 1,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
            metadata: {
                path: '/Users/example/Documents/Playground',
                host: 'mac',
                flavor: 'codex',
                codexSessionId: 'codex-thread-1',
                summary: { text: 'Changing HAPI task title', updatedAt: 1 }
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            model: null,
            modelReasoningEffort: null,
            effort: null
        })

        expect(getSessionDisplayTitle(summary)).toBe('Playground')
    })
})
