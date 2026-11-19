import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { createSessionComparator, getSessionSortKey } from './sessionListOrder'

describe('getSessionSortKey', () => {
    const session = { id: 's', active: false, createdAt: 100, updatedAt: 300, lastUserMessageAt: 200 }

    it('falls back to creation time before any user message', () => {
        expect(getSessionSortKey(session, 'last-message')).toBe(200)
        expect(getSessionSortKey({ ...session, lastUserMessageAt: undefined }, 'last-message')).toBe(100)
        expect(getSessionSortKey(session, 'created')).toBe(100)
    })
})

describe('createSessionComparator', () => {
    const minute = 60_000
    const row = (id: string, active: boolean, lastUserMessageAt: number, updatedAt: number) =>
        ({ id, active, createdAt: 0, lastUserMessageAt, updatedAt, activeAt: lastUserMessageAt }) as SessionSummary
    const order = (sessions: SessionSummary[], activeFirst: boolean) =>
        [...sessions].sort(createSessionComparator({ sort: 'last-message', activeFirst })).map((s) => s.id)

    // One user's real project group: the session archived just now had its last
    // prompt earliest, so last-message order left it third among stopped rows.
    const sessions = [
        row('stopped-1h-ago', false, 200 * minute, 600 * minute),
        row('stopped-2h-ago', false, 210 * minute, 540 * minute),
        row('archived-just-now', false, 100 * minute, 720 * minute),
        row('live-old-prompt', true, 50 * minute, 720 * minute),
        row('live-new-prompt', true, 300 * minute, 700 * minute)
    ]

    it('puts the most recently stopped session first among stopped ones when active sessions come first', () => {
        expect(order(sessions, true)).toEqual([
            'live-new-prompt', 'live-old-prompt',
            'archived-just-now', 'stopped-1h-ago', 'stopped-2h-ago'
        ])
    })

    it('follows the time a stopped row shows, not a stale activeAt', () => {
        // The hub may not refresh activeAt in the live list when a session stops;
        // archiving updates updatedAt, which is the time the row renders.
        const archived = { ...row('archived-just-now', false, 100 * minute, 720 * minute), activeAt: 1 }
        const older = { ...row('stopped-earlier', false, 200 * minute, 600 * minute), activeAt: 700 * minute }
        expect(order([older, archived], true)).toEqual(['archived-just-now', 'stopped-earlier'])
    })

    it('keeps the chosen sort for sessions that stopped within the same minute', () => {
        const restarted = [
            row('restart-older-prompt', false, 100 * minute, 900 * minute + 5_000),
            row('restart-newer-prompt', false, 200 * minute, 900 * minute + 1_000)
        ]
        expect(order(restarted, true)).toEqual(['restart-newer-prompt', 'restart-older-prompt'])
    })

    it('leaves the single list ordered by the chosen sort when active sessions are not separated', () => {
        expect(order(sessions, false)).toEqual([
            'live-new-prompt', 'stopped-2h-ago', 'stopped-1h-ago', 'archived-just-now', 'live-old-prompt'
        ])
    })
})
