import { describe, expect, it } from 'vitest'
import { buildNotificationOptions, shouldShowPushNotification } from './pushNotification'

describe('buildNotificationOptions', () => {
    it('re-notifies when replacing an existing tagged notification', () => {
        const options = buildNotificationOptions({
            title: 'Ready for input',
            body: 'Agent is waiting',
            tag: 'ready-session-1',
            data: { type: 'ready', sessionId: 'session-1', url: '/sessions/session-1' }
        })

        expect(options.tag).toBe('ready-session-1')
        expect(options.renotify).toBe(true)
    })

    it('keeps renotify disabled for untagged notifications', () => {
        const options = buildNotificationOptions({
            title: 'One-off notification',
            body: 'No replacement semantics'
        })

        expect(options.tag).toBeUndefined()
        expect(options.renotify).toBe(false)
    })
})

describe('shouldShowPushNotification', () => {
    it('suppresses the native notification when this device already has a focused HAPI window', async () => {
        const clientsApi = {
            matchAll: async () => [
                { url: 'http://127.0.0.1:3006/sessions/session-1', visibilityState: 'visible', focused: true }
            ]
        }

        await expect(shouldShowPushNotification(clientsApi)).resolves.toBe(false)
    })

    it('allows the native notification when iOS reports a background PWA window as visible but not focused', async () => {
        const clientsApi = {
            matchAll: async () => [
                { url: 'http://127.0.0.1:3006/sessions/session-1', visibilityState: 'visible', focused: false }
            ]
        }

        await expect(shouldShowPushNotification(clientsApi)).resolves.toBe(true)
    })

    it('allows the native notification when this device only has hidden HAPI windows', async () => {
        const clientsApi = {
            matchAll: async () => [
                { url: 'http://127.0.0.1:3006/sessions/session-1', visibilityState: 'hidden' }
            ]
        }

        await expect(shouldShowPushNotification(clientsApi)).resolves.toBe(true)
    })
})
