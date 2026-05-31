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
    it('resolveAgentSessionIdFromMetadata matches hub flavor precedence (codex before cursor)', () => {
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p',
            host: 'h',
            codexSessionId: 'codex-1',
            cursorSessionId: 'cursor-1',
        })).toBe('codex-1')
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p',
            host: 'h',
            cursorSessionId: 'cursor-1',
        })).toBe('cursor-1')
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

    it('inactiveSessionCanResume rejects when metadata path is missing', () => {
        expect(inactiveSessionCanResume(makeSession({ metadata: { path: '', host: 'localhost' } }), 0)).toBe(false)
    })
})
