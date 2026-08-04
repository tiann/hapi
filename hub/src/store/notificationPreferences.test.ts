import { describe, expect, it } from 'bun:test'
import { Store } from './index'

describe('notificationPreferences', () => {
    it('returns all-enabled defaults when no row exists', () => {
        const store = new Store(':memory:')
        expect(store.notificationPrefs.getPreferences('ns-1')).toEqual({
            namespace: 'ns-1',
            permissionRequests: 1,
            sessionReady: 1,
            taskNotifications: 1,
            sessionCompletion: 1,
            updatedAt: 0
        })
    })

    it('upserts on first set, defaulting untouched fields', () => {
        const store = new Store(':memory:')
        const prefs = store.notificationPrefs.setPreferences('ns-1', { sessionReady: 0 })
        expect(prefs.sessionReady).toBe(0)
        expect(prefs.permissionRequests).toBe(1)
        expect(prefs.taskNotifications).toBe(1)
        expect(prefs.sessionCompletion).toBe(1)
        expect(prefs.updatedAt).toBeGreaterThan(0)
    })

    it('updates only the provided fields on an existing row', () => {
        const store = new Store(':memory:')
        store.notificationPrefs.setPreferences('ns-1', { sessionReady: 0, taskNotifications: 0 })
        const after = store.notificationPrefs.setPreferences('ns-1', { permissionRequests: 0 })
        expect(after).toMatchObject({
            permissionRequests: 0,
            sessionReady: 0,
            taskNotifications: 0,
            sessionCompletion: 1
        })
    })

    it('keeps namespaces independent', () => {
        const store = new Store(':memory:')
        store.notificationPrefs.setPreferences('ns-a', { sessionReady: 0 })
        expect(store.notificationPrefs.getPreferenceFlags('ns-a').sessionReady).toBe(0)
        expect(store.notificationPrefs.getPreferenceFlags('ns-b')).toEqual({
            permissionRequests: 1,
            sessionReady: 1,
            taskNotifications: 1,
            sessionCompletion: 1
        })
    })
})
