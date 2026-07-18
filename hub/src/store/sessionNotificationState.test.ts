import { describe, expect, it } from 'bun:test'
import { Store } from './index'

describe('SessionNotificationStateStore', () => {
    it('returns total unread count by namespace', () => {
        const store = new Store(':memory:')

        const session1 = store.sessions.getOrCreateSession('session-1', null, null, 'default')
        const session2 = store.sessions.getOrCreateSession('session-2', null, null, 'default')
        const session3 = store.sessions.getOrCreateSession('session-3', null, null, 'other')

        store.sessionNotifications.incrementUnread(session1.id, 'default')
        store.sessionNotifications.incrementUnread(session1.id, 'default')
        store.sessionNotifications.incrementUnread(session2.id, 'default')
        store.sessionNotifications.incrementUnread(session3.id, 'other')

        expect((store.sessionNotifications as any).getTotalUnreadCountByNamespace('default')).toBe(3)
    })
})
