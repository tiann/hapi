import type { Database } from 'bun:sqlite'

import type { StoredPushSubscription } from './types'

type DbPushSubscriptionRow = {
    id: number
    namespace: string
    endpoint: string
    p256dh: string
    auth: string
    language: string | null
    created_at: number
}

function toStoredPushSubscription(row: DbPushSubscriptionRow): StoredPushSubscription {
    return {
        id: row.id,
        namespace: row.namespace,
        endpoint: row.endpoint,
        p256dh: row.p256dh,
        auth: row.auth,
        language: row.language ?? null,
        createdAt: row.created_at
    }
}

export function addPushSubscription(
    db: Database,
    namespace: string,
    subscription: { endpoint: string; p256dh: string; auth: string; language?: string | null }
): void {
    const now = Date.now()
    db.prepare(`
        INSERT INTO push_subscriptions (
            namespace, endpoint, p256dh, auth, language, created_at
        ) VALUES (
            @namespace, @endpoint, @p256dh, @auth, @language, @created_at
        )
        ON CONFLICT(namespace, endpoint)
        DO UPDATE SET
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            language = excluded.language,
            created_at = excluded.created_at
    `).run({
        namespace,
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        language: subscription.language ?? null,
        created_at: now
    })
}

export function removePushSubscription(db: Database, namespace: string, endpoint: string): void {
    db.prepare(
        'DELETE FROM push_subscriptions WHERE namespace = ? AND endpoint = ?'
    ).run(namespace, endpoint)
}

export function getPushSubscriptionsByNamespace(
    db: Database,
    namespace: string
): StoredPushSubscription[] {
    const rows = db.prepare(
        'SELECT * FROM push_subscriptions WHERE namespace = ? ORDER BY created_at DESC'
    ).all(namespace) as DbPushSubscriptionRow[]
    return rows.map(toStoredPushSubscription)
}
