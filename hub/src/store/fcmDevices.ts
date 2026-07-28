import type { Database } from 'bun:sqlite'

import type { StoredFcmDevice } from './types'

type DbFcmDeviceRow = {
    id: number
    namespace: string
    token: string
    platform: string
    device_id: string
    created_at: number
    updated_at: number
}

function toStoredFcmDevice(row: DbFcmDeviceRow): StoredFcmDevice {
    return {
        id: row.id,
        namespace: row.namespace,
        token: row.token,
        platform: row.platform as StoredFcmDevice['platform'],
        deviceId: row.device_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

export function upsertFcmDevice(
    db: Database,
    namespace: string,
    device: { token: string; platform: 'phone' | 'wear'; deviceId: string }
): void {
    const now = Date.now()
    const params = {
        namespace,
        token: device.token,
        platform: device.platform,
        device_id: device.deviceId,
        created_at: now,
        updated_at: now
    }

    db.transaction(() => {
        // One FCM token must not deliver across namespaces. Re-pairing the
        // same native install under a new namespace drops stale rows that
        // still reference this token elsewhere.
        db.prepare(`
            DELETE FROM fcm_devices
            WHERE token = @token
              AND (namespace != @namespace OR device_id != @device_id OR platform != @platform)
        `).run(params)

        db.prepare(`
            INSERT INTO fcm_devices (
                namespace, token, platform, device_id, created_at, updated_at
            ) VALUES (
                @namespace, @token, @platform, @device_id, @created_at, @updated_at
            )
            ON CONFLICT(namespace, device_id, platform)
            DO UPDATE SET
                token = excluded.token,
                updated_at = excluded.updated_at
        `).run(params)
    })()
}

export function removeFcmDeviceByToken(db: Database, namespace: string, token: string): void {
    db.prepare('DELETE FROM fcm_devices WHERE namespace = ? AND token = ?').run(namespace, token)
}

export function getFcmDevicesByNamespace(db: Database, namespace: string): StoredFcmDevice[] {
    const rows = db.prepare(
        'SELECT * FROM fcm_devices WHERE namespace = ? ORDER BY updated_at DESC'
    ).all(namespace) as DbFcmDeviceRow[]
    return rows.map(toStoredFcmDevice)
}
