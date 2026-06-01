import { describe, expect, it } from 'vitest'
import type { Session } from '@/types/api'
import { inactiveSessionCanResume, resolveAgentSessionIdFromMetadata } from './sessionResume'

function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: { path: '/tmp/project', host: 'localhost', flavor: 'cursor' },
        ...overrides,
    } as Session
}

describe('sessionResume', () => {
    it('resolveAgentSessionIdFromMetadata picks the id matching the session flavor', () => {
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p',
            host: 'h',
            flavor: 'codex',
            codexSessionId: 'codex-1',
            cursorSessionId: 'cursor-1',
        })).toBe('codex-1')
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p',
            host: 'h',
            flavor: 'cursor',
            cursorSessionId: 'cursor-1',
        })).toBe('cursor-1')
    })

    it('resolveAgentSessionIdFromMetadata ignores stale cross-flavor ids', () => {
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p',
            host: 'h',
            flavor: 'cursor',
            codexSessionId: 'codex-1',
        })).toBeUndefined()
    })

    it('resolveAgentSessionIdFromMetadata defaults to claude when flavor is missing', () => {
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p',
            host: 'h',
            claudeSessionId: 'claude-1',
        })).toBe('claude-1')
    })

    it('inactiveSessionCanResume is true for active sessions', () => {
        expect(inactiveSessionCanResume(makeSession({ active: true }), 0)).toBe(true)
    })

    it('inactiveSessionCanResume allows fresh spawn when no agent id and no messages', () => {
        expect(inactiveSessionCanResume(makeSession(), 0)).toBe(true)
    })

    it('inactiveSessionCanResume allows resume when agent id exists', () => {
        expect(inactiveSessionCanResume(makeSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'cursor',
                cursorSessionId: 'cursor-thread-1',
            },
        }), 5)).toBe(true)
    })

    it('inactiveSessionCanResume rejects inactive sessions with messages but no agent id', () => {
        expect(inactiveSessionCanResume(makeSession(), 3)).toBe(false)
    })

    it('inactiveSessionCanResume rejects when stale cross-flavor agent id is present but no messages', () => {
        expect(inactiveSessionCanResume(makeSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'cursor',
                codexSessionId: 'stale-codex-1',
            },
        }), 0)).toBe(true)
        expect(inactiveSessionCanResume(makeSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'cursor',
                codexSessionId: 'stale-codex-1',
            },
        }), 3)).toBe(false)
    })

    it('inactiveSessionCanResume rejects when metadata path is missing', () => {
        expect(inactiveSessionCanResume(makeSession({ metadata: { path: '', host: 'localhost' } }), 0)).toBe(false)
    })

    it('inactiveSessionCanResume allows claude resume by message recovery when no claudeSessionId is stored', () => {
        expect(inactiveSessionCanResume(makeSession({
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
        }), 3)).toBe(true)
    })

    it('inactiveSessionCanResume allows claude recovery when flavor is missing (defaults to claude)', () => {
        expect(inactiveSessionCanResume(makeSession({
            metadata: { path: '/tmp/project', host: 'localhost' },
        }), 3)).toBe(true)
    })

    it('inactiveSessionCanResume rejects non-claude flavors with messages but no flavor-specific id (no recovery path)', () => {
        expect(inactiveSessionCanResume(makeSession({
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
        }), 3)).toBe(false)
    })
})
