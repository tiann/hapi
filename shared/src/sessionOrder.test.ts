import { describe, expect, it } from 'bun:test'
import { compareSessionSummaries, compareSessionsByOrderKeyDesc, getSessionOrderKey } from './sessionOrder'

describe('user-activity session order', () => {
    it('uses original user-message time, or creation before any user input', () => {
        expect(getSessionOrderKey({ id: 'a', createdAt: 10, lastUserMessageAt: 20 })).toBe(20)
        expect(getSessionOrderKey({ id: 'a', createdAt: 10 })).toBe(10)
    })

    it('ignores output, connection and permission changes', () => {
        const sessions = [
            { id: 'old', createdAt: 10, lastUserMessageAt: 100, updatedAt: 900, active: true, pendingRequestsCount: 5 },
            { id: 'new', createdAt: 20, lastUserMessageAt: 200, updatedAt: 200, active: false, pendingRequestsCount: 0 }
        ]
        expect(sessions.sort(compareSessionSummaries).map(s => s.id)).toEqual(['new', 'old'])
        sessions[1]!.updatedAt = 10_000
        expect(sessions.sort(compareSessionSummaries).map(s => s.id)).toEqual(['new', 'old'])
        sessions[1]!.lastUserMessageAt = 300
        expect(sessions.sort(compareSessionSummaries).map(s => s.id)).toEqual(['old', 'new'])
    })

    it('keeps explicit global and project pins ahead of user recency', () => {
        const sessions = [
            { id: 'new', createdAt: 500 },
            { id: 'project', createdAt: 200, pinned: true },
            { id: 'global', createdAt: 100, globalPinned: true }
        ]
        expect(sessions.sort(compareSessionSummaries).map(s => s.id)).toEqual(['global', 'project', 'new'])
    })

    it('uses creation and id to make timestamp ties independent of input order', () => {
        const sessions = [
            { id: 'b', createdAt: 20, lastUserMessageAt: 100 },
            { id: 'a', createdAt: 20, lastUserMessageAt: 100 },
            { id: 'c', createdAt: 10, lastUserMessageAt: 100 }
        ]
        expect([...sessions].sort(compareSessionsByOrderKeyDesc).map(s => s.id)).toEqual(['a', 'b', 'c'])
        expect([...sessions].reverse().sort(compareSessionsByOrderKeyDesc).map(s => s.id)).toEqual(['a', 'b', 'c'])
    })
})
