import { describe, expect, it } from 'vitest'
import { normalizeMessageSearchTarget } from './messageSearchTarget'

describe('normalizeMessageSearchTarget', () => {
    it('keeps a complete content-search deep link', () => {
        expect(normalizeMessageSearchTarget(' message-1 ', ' hello ')).toEqual({
            messageId: 'message-1',
            messageQuery: 'hello',
        })
    })

    it('drops incomplete deep links instead of locking the message window', () => {
        expect(normalizeMessageSearchTarget('message-1', undefined)).toEqual({})
        expect(normalizeMessageSearchTarget(undefined, 'hello')).toEqual({})
        expect(normalizeMessageSearchTarget('   ', 'hello')).toEqual({})
    })
})
