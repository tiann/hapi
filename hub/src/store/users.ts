import type { Database } from 'bun:sqlite'

import type { StoredUser } from './types'

type DbUserRow = {
    id: number
    platform: string
    platform_user_id: string
    namespace: string
    language: string | null
    created_at: number
}

function toStoredUser(row: DbUserRow): StoredUser {
    return {
        id: row.id,
        platform: row.platform,
        platformUserId: row.platform_user_id,
        namespace: row.namespace,
        language: row.language ?? null,
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
    language: string | null = null
): StoredUser {
    const now = Date.now()
    db.prepare(`
        INSERT OR IGNORE INTO users (
            platform, platform_user_id, namespace, language, created_at
        ) VALUES (
            @platform, @platform_user_id, @namespace, @language, @created_at
        )
    `).run({
        platform,
        platform_user_id: platformUserId,
        namespace,
        language,
        created_at: now
    })

    const row = getUser(db, platform, platformUserId)
    if (!row) {
        throw new Error('Failed to create user')
    }
    return row
}

/** Remember the language tag the platform reported for this user. */
export function setUserLanguage(
    db: Database,
    platform: string,
    platformUserId: string,
    language: string | null
): void {
    db.prepare(
        'UPDATE users SET language = ? WHERE platform = ? AND platform_user_id = ?'
    ).run(language, platform, platformUserId)
}

export function removeUser(db: Database, platform: string, platformUserId: string): boolean {
    const result = db.prepare(
        'DELETE FROM users WHERE platform = ? AND platform_user_id = ?'
    ).run(platform, platformUserId)
    return result.changes > 0
}
