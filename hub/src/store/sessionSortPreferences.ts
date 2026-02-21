import type { Database } from 'bun:sqlite'
import { SessionManualOrderSchema, type SessionManualOrder, type SessionSortMode } from '@hapi/protocol/schemas'

import type { SessionSortPreferenceUpdateResult, StoredSessionSortPreference } from './types'
import { safeJsonParse } from './json'

const EMPTY_MANUAL_ORDER: SessionManualOrder = {
    groupOrder: [],
    sessionOrder: {}
}

type DbSessionSortPreferenceRow = {
    user_id: number
    namespace: string
    sort_mode: string
    manual_order: string
    version: number
    created_at: number
    updated_at: number
}

function normalizeSortMode(value: string): SessionSortMode {
    return value === 'manual' ? 'manual' : 'auto'
}

function normalizeManualOrder(value: unknown): SessionManualOrder {
    const parsed = SessionManualOrderSchema.safeParse(value)
    if (parsed.success) {
        return parsed.data
    }

    return {
        groupOrder: [],
        sessionOrder: {}
    }
}

function toStoredSessionSortPreference(row: DbSessionSortPreferenceRow): StoredSessionSortPreference {
    return {
        userId: row.user_id,
        namespace: row.namespace,
        sortMode: normalizeSortMode(row.sort_mode),
        manualOrder: normalizeManualOrder(safeJsonParse(row.manual_order)),
        version: Math.max(1, row.version),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

function getDefaultSessionSortPreference(userId: number, namespace: string): StoredSessionSortPreference {
    return {
        userId,
        namespace,
        sortMode: 'auto',
        manualOrder: EMPTY_MANUAL_ORDER,
        version: 1,
        createdAt: 0,
        updatedAt: 0
    }
}

export function getSessionSortPreferenceByUser(
    db: Database,
    userId: number,
    namespace: string
): StoredSessionSortPreference {
    const row = db.prepare(
        'SELECT * FROM session_sort_preferences WHERE user_id = ? AND namespace = ? LIMIT 1'
    ).get(userId, namespace) as DbSessionSortPreferenceRow | undefined

    if (!row) {
        return getDefaultSessionSortPreference(userId, namespace)
    }

    return toStoredSessionSortPreference(row)
}

export function upsertSessionSortPreferenceByUser(
    db: Database,
    userId: number,
    namespace: string,
    preference: {
        sortMode: SessionSortMode
        manualOrder: SessionManualOrder
    },
    expectedVersion?: number
): SessionSortPreferenceUpdateResult {
    try {
        const current = getSessionSortPreferenceByUser(db, userId, namespace)
        if (expectedVersion !== undefined && expectedVersion !== current.version) {
            return {
                result: 'version-mismatch',
                preference: current
            }
        }

        const now = Date.now()
        const nextVersion = current.version + 1
        const manualOrderJson = JSON.stringify(preference.manualOrder)

        db.prepare(`
            INSERT INTO session_sort_preferences (
                user_id,
                namespace,
                sort_mode,
                manual_order,
                version,
                created_at,
                updated_at
            ) VALUES (
                @user_id,
                @namespace,
                @sort_mode,
                @manual_order,
                @version,
                @created_at,
                @updated_at
            )
            ON CONFLICT(user_id, namespace)
            DO UPDATE SET
                sort_mode = excluded.sort_mode,
                manual_order = excluded.manual_order,
                version = excluded.version,
                updated_at = excluded.updated_at
        `).run({
            user_id: userId,
            namespace,
            sort_mode: preference.sortMode,
            manual_order: manualOrderJson,
            version: nextVersion,
            created_at: current.createdAt || now,
            updated_at: now
        })

        const updated = getSessionSortPreferenceByUser(db, userId, namespace)
        return {
            result: 'success',
            preference: updated
        }
    } catch {
        return {
            result: 'error'
        }
    }
}
