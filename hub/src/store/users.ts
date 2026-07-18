import type { Database } from 'bun:sqlite'

import type { StoredUser } from './types'

type DbUserRow = {
    id: number
    platform: string
    platform_user_id: string
    namespace: string
    credential_fingerprint: string
    created_at: number
}

function toStoredUser(row: DbUserRow): StoredUser {
    return {
        id: row.id,
        platform: row.platform,
        platformUserId: row.platform_user_id,
        namespace: row.namespace,
        credentialFingerprint: row.credential_fingerprint,
        createdAt: row.created_at
    }
}

export function getUser(db: Database, platform: string, platformUserId: string): StoredUser | null {
    const row = db.prepare(
        'SELECT * FROM users WHERE platform = ? AND platform_user_id = ? LIMIT 1'
    ).get(platform, platformUserId) as DbUserRow | undefined
    return row ? toStoredUser(row) : null
}

export function getUsersByPlatform(db: Database, platform: string): StoredUser[] {
    const rows = db.prepare(
        'SELECT * FROM users WHERE platform = ? ORDER BY created_at ASC'
    ).all(platform) as DbUserRow[]
    return rows.map(toStoredUser)
}

export function getUsersByPlatformAndNamespace(
    db: Database,
    platform: string,
    namespace: string
): StoredUser[] {
    const rows = db.prepare(
        'SELECT * FROM users WHERE platform = ? AND namespace = ? ORDER BY created_at ASC'
    ).all(platform, namespace) as DbUserRow[]
    return rows.map(toStoredUser)
}

export function addUser(
    db: Database,
    platform: string,
    platformUserId: string,
    namespace: string,
    credentialFingerprint: string,
): StoredUser {
    const now = Date.now()
    db.prepare(`
        INSERT INTO users (
            platform, platform_user_id, namespace, credential_fingerprint, created_at
        ) VALUES (
            @platform, @platform_user_id, @namespace, @credential_fingerprint, @created_at
        )
        ON CONFLICT(platform, platform_user_id) DO UPDATE SET
            credential_fingerprint = excluded.credential_fingerprint,
            created_at = excluded.created_at
        WHERE users.namespace = excluded.namespace
    `).run({
        platform,
        platform_user_id: platformUserId,
        namespace,
        credential_fingerprint: credentialFingerprint,
        created_at: now
    })

    const row = getUser(db, platform, platformUserId)
    if (!row || row.namespace !== namespace || row.credentialFingerprint !== credentialFingerprint) {
        throw new Error('Failed to create credential-bound user')
    }
    return row
}

export function removeUser(db: Database, platform: string, platformUserId: string): boolean {
    const result = db.prepare(
        'DELETE FROM users WHERE platform = ? AND platform_user_id = ?'
    ).run(platform, platformUserId)
    return result.changes > 0
}
