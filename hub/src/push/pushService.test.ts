import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { PushService, type PushPayload } from './pushService'

const sendNotification = mock(async (_subscription: unknown, _body: string) => ({}))

mock.module('web-push', () => ({
    setVapidDetails: mock(() => {}),
    sendNotification
}))

type Subscription = {
    endpoint: string
    p256dh: string
    auth: string
}

function createService(subscriptions: Subscription[]) {
    const removePushSubscription = mock(() => {})
    const store = {
        push: {
            getPushSubscriptionsByNamespace: mock(() => subscriptions),
            removePushSubscription
        }
    }
    return {
        service: new PushService(
            { publicKey: 'test-public', privateKey: 'test-private' },
            'mailto:test@example.com',
            store as never
        ),
        removePushSubscription
    }
}

const payload: PushPayload = {
    title: 'Test',
    body: 'Test body'
}

beforeEach(() => {
    sendNotification.mockClear()
    sendNotification.mockImplementation(async () => ({}))
})

describe('PushService.sendToNamespace', () => {
    it('returns zero when the namespace has no subscriptions', async () => {
        const { service } = createService([])

        expect(await service.sendToNamespace('default', payload)).toBe(0)
        expect(sendNotification).not.toHaveBeenCalled()
    })

    it('counts only successful deliveries', async () => {
        const subscriptions = [
            { endpoint: 'https://push.example/ok', p256dh: 'key-1', auth: 'auth-1' },
            { endpoint: 'https://push.example/gone', p256dh: 'key-2', auth: 'auth-2' }
        ]
        sendNotification.mockImplementation(async (subscription: unknown) => {
            if ((subscription as { endpoint: string }).endpoint.endsWith('/gone')) {
                throw { statusCode: 410 }
            }
            return {}
        })
        const { service, removePushSubscription } = createService(subscriptions)

        expect(await service.sendToNamespace('default', payload)).toBe(1)
        expect(removePushSubscription).toHaveBeenCalledWith('default', 'https://push.example/gone')
    })
})
