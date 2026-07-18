import { describe, expect, it, spyOn } from 'bun:test'
import { PushService } from './pushService'
import type { Store } from '../store'

type StoredSubscription = { endpoint: string; p256dh: string; auth: string }

const vapidKeys = {
    publicKey: 'BI2mGp2npODvccK_M8qXIp09mZxH-BqkR5Bce5p8lttel_0QedqtFZOu7eKbQ8DNvUyN_XEFWSX_QFwZyyyCJoM',
    privateKey: 'NOPpnMRFRN4jmg-tVYfC69-jRi6Qucv8Y9lhmU8Kc1I'
}

function createStore(subscriptions: StoredSubscription[] = [{ endpoint: 'https://web.push.apple.com/stale', p256dh: 'p', auth: 'a' }]) {
    const removed: string[] = []
    return {
        removed,
        store: {
            push: {
                getPushSubscriptionsByNamespace: () => subscriptions,
                removePushSubscription: (namespace: string, endpoint: string) => {
                    removed.push(`${namespace}:${endpoint}`)
                }
            }
        } as unknown as Store
    }
}

function createError(fields: { statusCode?: number; code?: string }): Error & { statusCode?: number; code?: string } {
    const error = new Error(fields.code ?? `status ${fields.statusCode ?? 'unknown'}`) as Error & { statusCode?: number; code?: string }
    if (fields.statusCode !== undefined) error.statusCode = fields.statusCode
    if (fields.code !== undefined) error.code = fields.code
    return error
}

describe('PushService failed subscription handling', () => {
    it('removes subscriptions that fail with permanent status codes', async () => {
        const { store, removed } = createStore()
        const service = new PushService(
            vapidKeys,
            'mailto:test@example.com',
            store,
            async () => { throw createError({ statusCode: 404 }) }
        )

        await service.sendToNamespace('default', { title: 't', body: 'b' })

        expect(removed).toEqual(['default:https://web.push.apple.com/stale'])
    })

    it('does not remove subscriptions for TLS certificate transport errors', async () => {
        const { store, removed } = createStore()
        const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
        const service = new PushService(
            vapidKeys,
            'mailto:test@example.com',
            store,
            async () => { throw createError({ code: 'UNKNOWN_CERTIFICATE_VERIFICATION_ERROR' }) }
        )

        await service.sendToNamespace('default', { title: 't', body: 'b' })

        expect(removed).toEqual([])
        expect(errorSpy).toHaveBeenCalledTimes(1)
        errorSpy.mockRestore()
    })

    it('removes subscriptions after repeated transient failures', async () => {
        const { store, removed } = createStore()
        const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
        const service = new PushService(
            vapidKeys,
            'mailto:test@example.com',
            store,
            async () => { throw createError({ statusCode: 500 }) },
            { maxConsecutiveFailures: 2 }
        )

        await service.sendToNamespace('default', { title: 't', body: 'b' })
        expect(removed).toEqual([])

        await service.sendToNamespace('default', { title: 't', body: 'b' })
        expect(removed).toEqual(['default:https://web.push.apple.com/stale'])
        expect(errorSpy).toHaveBeenCalledTimes(1)
        errorSpy.mockRestore()
    })

    it('resets transient failure count after a successful send', async () => {
        const { store, removed } = createStore()
        let callCount = 0
        const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
        const service = new PushService(
            vapidKeys,
            'mailto:test@example.com',
            store,
            async () => {
                callCount += 1
                if (callCount === 2) {
                    return { statusCode: 201, body: '', headers: {} }
                }
                throw createError({ statusCode: 500 })
            },
            { maxConsecutiveFailures: 2 }
        )

        await service.sendToNamespace('default', { title: 't', body: 'b' })
        await service.sendToNamespace('default', { title: 't', body: 'b' })
        await service.sendToNamespace('default', { title: 't', body: 'b' })

        expect(removed).toEqual([])
        expect(errorSpy).toHaveBeenCalledTimes(2)
        errorSpy.mockRestore()
    })

    it('tracks transient failures per namespace even when endpoints match', async () => {
        const subscription = { endpoint: 'https://web.push.apple.com/shared', p256dh: 'p', auth: 'a' }
        const { store, removed } = createStore([subscription])
        const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
        const service = new PushService(
            vapidKeys,
            'mailto:test@example.com',
            store,
            async () => { throw createError({ statusCode: 500 }) },
            { maxConsecutiveFailures: 2 }
        )

        await service.sendToNamespace('alpha', { title: 't', body: 'b' })
        await service.sendToNamespace('beta', { title: 't', body: 'b' })
        expect(removed).toEqual([])

        await service.sendToNamespace('beta', { title: 't', body: 'b' })
        expect(removed).toEqual(['beta:https://web.push.apple.com/shared'])
        expect(errorSpy).toHaveBeenCalledTimes(2)
        errorSpy.mockRestore()
    })
})
