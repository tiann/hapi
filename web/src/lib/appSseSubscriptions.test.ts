import { describe, expect, it } from 'vitest'
import { getAppGlobalSseSubscription, getAppSessionSseSubscription } from './appSseSubscriptions'

describe('app SSE subscriptions', () => {
    it('always uses a global all:true subscription for the session list', () => {
        expect(getAppGlobalSseSubscription()).toEqual({ all: true })
    })

    it('uses a session-scoped subscription only when a session is selected', () => {
        expect(getAppSessionSseSubscription(null)).toBeNull()
        expect(getAppSessionSseSubscription(undefined)).toBeNull()
        expect(getAppSessionSseSubscription('')).toBeNull()
        expect(getAppSessionSseSubscription('session-a')).toEqual({ sessionId: 'session-a' })
    })
})
