import * as webPush from 'web-push'
import type { Store } from '../store'
import type { VapidKeys } from '../config/vapidKeys'

export type PushPayload = {
    title: string
    body: string
    tag?: string
    data?: {
        type: 'permission-request' | 'ready' | 'attention'
        sessionId: string
        url: string
        unreadCount?: number
        totalUnreadCount?: number
    }
}

type StoredSubscription = {
    endpoint: string
    p256dh: string
    auth: string
}

type PushSubscription = {
    endpoint: string
    keys: {
        p256dh: string
        auth: string
    }
}

type SendNotification = (subscription: PushSubscription, body: string) => Promise<unknown>

type PushServiceOptions = {
    maxConsecutiveFailures?: number
}

function subscriptionFailureKey(namespace: string, endpoint: string): string {
    return `${namespace}:${endpoint}`
}

function getErrorStatusCode(error: unknown): number | null {
    return typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : null
}

function isPermanentPushFailure(error: unknown): boolean {
    const statusCode = getErrorStatusCode(error)
    return statusCode === 404 || statusCode === 410
}

export class PushService {
    private readonly sendNotification: SendNotification
    private readonly maxConsecutiveFailures: number
    private readonly failuresBySubscription: Map<string, number> = new Map()

    constructor(
        private readonly vapidKeys: VapidKeys,
        private readonly subject: string,
        private readonly store: Store,
        sendNotification?: SendNotification,
        options?: PushServiceOptions
    ) {
        webPush.setVapidDetails(this.subject, this.vapidKeys.publicKey, this.vapidKeys.privateKey)
        this.sendNotification = sendNotification ?? ((subscription, body) => webPush.sendNotification(subscription, body))
        this.maxConsecutiveFailures = options?.maxConsecutiveFailures ?? 5
    }

    async sendToNamespace(namespace: string, payload: PushPayload): Promise<void> {
        const subscriptions = this.store.push.getPushSubscriptionsByNamespace(namespace)
        if (subscriptions.length === 0) {
            return
        }

        const body = JSON.stringify(payload)
        await Promise.all(subscriptions.map((subscription) => {
            return this.sendToSubscription(namespace, subscription, body)
        }))
    }

    private async sendToSubscription(
        namespace: string,
        subscription: StoredSubscription,
        body: string
    ): Promise<void> {
        const pushSubscription: PushSubscription = {
            endpoint: subscription.endpoint,
            keys: {
                p256dh: subscription.p256dh,
                auth: subscription.auth
            }
        }

        const failureKey = subscriptionFailureKey(namespace, subscription.endpoint)
        try {
            await this.sendNotification(pushSubscription, body)
            this.failuresBySubscription.delete(failureKey)
        } catch (error) {
            if (isPermanentPushFailure(error)) {
                this.store.push.removePushSubscription(namespace, subscription.endpoint)
                this.failuresBySubscription.delete(failureKey)
                return
            }

            const failures = (this.failuresBySubscription.get(failureKey) ?? 0) + 1
            this.failuresBySubscription.set(failureKey, failures)
            if (failures >= this.maxConsecutiveFailures) {
                this.store.push.removePushSubscription(namespace, subscription.endpoint)
                this.failuresBySubscription.delete(failureKey)
                return
            }

            console.error('[PushService] Failed to send notification:', error)
        }
    }
}
