import type { Database } from 'bun:sqlite'

export type StoredUserPreferences = {
    namespace: string
    readyAnnouncements: boolean
    updatedAt: number
}

type DbUserPreferencesRow = {
    namespace: string
    ready_announcements: number
    updated_at: number
}

function toStoredUserPreferences(row: DbUserPreferencesRow): StoredUserPreferences {
    return {
        namespace: row.namespace,
        readyAnnouncements: row.ready_announcements !== 0,
        updatedAt: row.updated_at
    }
}

export function getUserPreferences(db: Database, namespace: string): StoredUserPreferences {
    const row = db.prepare(
        'SELECT * FROM user_preferences WHERE namespace = ? LIMIT 1'
    ).get(namespace) as DbUserPreferencesRow | undefined

    if (!row) {
        return {
            namespace,
            readyAnnouncements: true,
            updatedAt: 0
        }
    }

    return toStoredUserPreferences(row)
}

export function upsertReadyAnnouncementsPreference(
    db: Database,
    namespace: string,
    readyAnnouncements: boolean
): StoredUserPreferences {
    const now = Date.now()
    db.prepare(`
        INSERT INTO user_preferences (namespace, ready_announcements, updated_at)
        VALUES (@namespace, @ready_announcements, @updated_at)
        ON CONFLICT(namespace) DO UPDATE SET
            ready_announcements = excluded.ready_announcements,
            updated_at = excluded.updated_at
    `).run({
        namespace,
        ready_announcements: readyAnnouncements ? 1 : 0,
        updated_at: now
    })

    return {
        namespace,
        readyAnnouncements,
        updatedAt: now
    }
}
