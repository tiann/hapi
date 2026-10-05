import type { Database } from 'bun:sqlite'

import type { StoredPushSubscription } from './types'
import { addPushSubscription, getPushSubscriptionsByNamespace, removePushSubscription } from './pushSubscriptions'

export class PushStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    addPushSubscription(namespace: string, subscription: { endpoint: string; p256dh: string; auth: string; language?: string | null }): void {
        addPushSubscription(this.db, namespace, subscription)
    }

    removePushSubscription(namespace: string, endpoint: string): void {
        removePushSubscription(this.db, namespace, endpoint)
    }

    getPushSubscriptionsByNamespace(namespace: string): StoredPushSubscription[] {
        return getPushSubscriptionsByNamespace(this.db, namespace)
    }
}
