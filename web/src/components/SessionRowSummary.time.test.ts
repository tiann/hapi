import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { getSessionTimeLabel } from './SessionRowSummary'

const now = new Date('2026-08-11T12:00:00.000Z')
const translate = (key: string, params?: Record<string, string | number>) =>
    params?.n === undefined ? key : `${key}:${params.n}`

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
    return {
        id: 'session-time-test',
        title: 'session time test',
        active: false,
        thinking: false,
        activeAt: 0,
        createdAt: now.getTime() - 20 * 60_000,
        updatedAt: now.getTime() - 10 * 60_000,
        lastAssistantMessageAt: null,
        pinned: false,
        globalPinned: false,
        pendingRequestsCount: 0,
        futureScheduledMessageCount: 0,
        metadata: {
            flavor: 'codex',
            agentSessionId: 'codex-imported-thread',
        },
        ...overrides,
    } as SessionSummary
}

describe('getSessionTimeLabel', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(now)
        localStorage.clear()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('uses updatedAt for an imported session without an assistant reply', () => {
        localStorage.setItem('hapi.codexImportedSessions', JSON.stringify({
            'codex-imported-thread': now.getTime() - 60_000,
        }))

        expect(getSessionTimeLabel(makeSession({}), translate)).toBe('session.time.minutesAgo:10')
    })

    it('prefers the latest assistant reply over updatedAt', () => {
        expect(getSessionTimeLabel(
            makeSession({ lastAssistantMessageAt: now.getTime() - 3 * 60_000 }),
            translate
        )).toBe('session.time.minutesAgo:3')
    })
})
