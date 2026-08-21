import type { Database } from 'bun:sqlite'

export type NotificationPreferenceFlags = {
    permissionRequests: number
    sessionReady: number
    taskNotifications: number
    sessionCompletion: number
}

export type NotificationPreferences = NotificationPreferenceFlags & {
    namespace: string
    updatedAt: number
}

type DbPreferenceRow = {
    namespace: string
    permission_requests: number
    session_ready: number
    task_notifications: number
    session_completion: number
    updated_at: number
}

// All event types default to enabled — new namespaces behave exactly like the
// pre-preferences behavior (push everything).
const DEFAULTS: NotificationPreferenceFlags = {
    permissionRequests: 1,
    sessionReady: 1,
    taskNotifications: 1,
    sessionCompletion: 1
}

function rowToFlags(row: DbPreferenceRow): NotificationPreferenceFlags {
    return {
        permissionRequests: row.permission_requests,
        sessionReady: row.session_ready,
        taskNotifications: row.task_notifications,
        sessionCompletion: row.session_completion
    }
}

function getRow(db: Database, namespace: string): DbPreferenceRow | undefined {
    return db.prepare(
        'SELECT * FROM notification_preferences WHERE namespace = ?'
    ).get(namespace) as DbPreferenceRow | undefined
}

export function getPreferences(db: Database, namespace: string): NotificationPreferences {
    const row = getRow(db, namespace)
    if (row) {
        return {
            namespace: row.namespace,
            ...rowToFlags(row),
            updatedAt: row.updated_at
        }
    }
    return {
        namespace,
        ...DEFAULTS,
        updatedAt: 0
    }
}

/**
 * Fast path for the notification hot loop: flags only, no timestamp.
 */
export function getPreferenceFlags(db: Database, namespace: string): NotificationPreferenceFlags {
    const row = getRow(db, namespace)
    if (row) {
        return rowToFlags(row)
    }
    return { ...DEFAULTS }
}

/**
 * Upserts a partial preference update. When no row exists yet, defaults are
 * merged with the provided flags before inserting.
 */
export function setPreferences(
    db: Database,
    namespace: string,
    partial: Partial<NotificationPreferenceFlags>
): NotificationPreferences {
    const existing = getRow(db, namespace)
    const now = Date.now()
    if (existing) {
        const fields: string[] = ['updated_at = @updated_at']
        const params: Record<string, number | string> = { namespace, updated_at: now }
        for (const [key, column] of [
            ['permissionRequests', 'permission_requests'],
            ['sessionReady', 'session_ready'],
            ['taskNotifications', 'task_notifications'],
            ['sessionCompletion', 'session_completion']
        ] as const) {
            if (partial[key] !== undefined) {
                fields.push(`${column} = @${key}`)
                params[key] = partial[key]
            }
        }
        db.prepare(
            `UPDATE notification_preferences SET ${fields.join(', ')} WHERE namespace = @namespace`
        ).run(params)
    } else {
        const flags = { ...DEFAULTS, ...partial }
        db.prepare(`
            INSERT INTO notification_preferences (
                namespace, permission_requests, session_ready,
                task_notifications, session_completion, updated_at
            ) VALUES (
                @namespace, @permissionRequests, @sessionReady,
                @taskNotifications, @sessionCompletion, @updatedAt
            )
        `).run({
            namespace,
            permissionRequests: flags.permissionRequests,
            sessionReady: flags.sessionReady,
            taskNotifications: flags.taskNotifications,
            sessionCompletion: flags.sessionCompletion,
            updatedAt: now
        })
    }
    return getPreferences(db, namespace)
}
