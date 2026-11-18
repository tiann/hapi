import { describe, expect, it } from 'vitest'
import { getSessionSortKey } from './sessionListOrder'

describe('getSessionSortKey', () => {
    const session = { id: 's', active: false, createdAt: 100, updatedAt: 300, lastUserMessageAt: 200 }

    it('falls back to creation time before any user message', () => {
        expect(getSessionSortKey(session, 'last-message')).toBe(200)
        expect(getSessionSortKey({ ...session, lastUserMessageAt: undefined }, 'last-message')).toBe(100)
        expect(getSessionSortKey(session, 'created')).toBe(100)
    })
})
