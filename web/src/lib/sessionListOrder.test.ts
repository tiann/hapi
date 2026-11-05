import { describe, expect, it } from 'vitest'
import { filterSessionsByStatus, getSessionSortKey } from './sessionListOrder'

describe('getSessionSortKey', () => {
    const session = { id: 's', active: false, createdAt: 100, updatedAt: 300, lastUserMessageAt: 200 }

    it('falls back to creation time before any user message', () => {
        expect(getSessionSortKey(session, 'last-message')).toBe(200)
        expect(getSessionSortKey({ ...session, lastUserMessageAt: undefined }, 'last-message')).toBe(100)
        expect(getSessionSortKey(session, 'created')).toBe(100)
    })
})

describe('filterSessionsByStatus', () => {
    const sessions = [
        { id: 'live', active: true },
        { id: 'closed', active: false },
        { id: 'open-closed', active: false }
    ]

    it('filters by connection and keeps the open session visible', () => {
        expect(filterSessionsByStatus(sessions, 'all').map(s => s.id)).toEqual(['live', 'closed', 'open-closed'])
        expect(filterSessionsByStatus(sessions, 'active', 'open-closed').map(s => s.id)).toEqual(['live', 'open-closed'])
        expect(filterSessionsByStatus(sessions, 'archived', 'live').map(s => s.id)).toEqual(['live', 'closed', 'open-closed'])
        expect(filterSessionsByStatus(sessions, 'archived').map(s => s.id)).toEqual(['closed', 'open-closed'])
    })
})
