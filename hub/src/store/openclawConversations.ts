import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

import type { StoredOpenClawConversation } from './types'

type DbConversationRow = {
    id: string
    namespace: string
    user_key: string
    external_id: string
    title: string | null
    status: string
    connected: number
    thinking: number
    last_error: string | null
    created_at: number
    updated_at: number
}

function toStoredConversation(row: DbConversationRow): StoredOpenClawConversation {
    return {
        id: row.id,
        namespace: row.namespace,
        userKey: row.user_key,
        externalId: row.external_id,
        title: row.title,
        status: row.status,
        connected: row.connected !== 0,
        thinking: row.thinking !== 0,
        lastError: row.last_error,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

export function getOrCreateOpenClawConversation(
    db: Database,
    namespace: string,
    userKey: string,
    defaults?: { externalId?: string; title?: string | null; status?: string }
): StoredOpenClawConversation {
    const existing = db.prepare(
        'SELECT * FROM openclaw_conversations WHERE namespace = ? AND user_key = ? LIMIT 1'
    ).get(namespace, userKey) as DbConversationRow | undefined
    if (existing) {
        return toStoredConversation(existing)
    }

    const now = Date.now()
    const id = randomUUID()

    db.prepare(`
        INSERT INTO openclaw_conversations (
            id, namespace, user_key, external_id, title, status, connected, thinking, last_error, created_at, updated_at
        ) VALUES (
            @id, @namespace, @user_key, @external_id, @title, @status, @connected, @thinking, @last_error, @created_at, @updated_at
        )
    `).run({
        id,
        namespace,
        user_key: userKey,
        external_id: defaults?.externalId ?? id,
        title: defaults?.title ?? 'OpenClaw',
        status: defaults?.status ?? 'ready',
        connected: 1,
        thinking: 0,
        last_error: null,
        created_at: now,
        updated_at: now
    })

    const created = getOpenClawConversationByNamespace(db, id, namespace)
    if (!created) {
        throw new Error('Failed to create OpenClaw conversation')
    }
    return created
}

export function getOpenClawConversationByNamespace(
    db: Database,
    id: string,
    namespace: string
): StoredOpenClawConversation | null {
    const row = db.prepare(
        'SELECT * FROM openclaw_conversations WHERE id = ? AND namespace = ? LIMIT 1'
    ).get(id, namespace) as DbConversationRow | undefined
    return row ? toStoredConversation(row) : null
}

export function getOpenClawConversationByUserKey(
    db: Database,
    namespace: string,
    userKey: string
): StoredOpenClawConversation | null {
    const row = db.prepare(
        'SELECT * FROM openclaw_conversations WHERE namespace = ? AND user_key = ? LIMIT 1'
    ).get(namespace, userKey) as DbConversationRow | undefined
    return row ? toStoredConversation(row) : null
}

export function getOpenClawConversationByExternalId(
    db: Database,
    namespace: string,
    externalId: string
): StoredOpenClawConversation | null {
    const row = db.prepare(
        'SELECT * FROM openclaw_conversations WHERE namespace = ? AND external_id = ? LIMIT 1'
    ).get(namespace, externalId) as DbConversationRow | undefined
    return row ? toStoredConversation(row) : null
}

export function findOpenClawConversationByExternalId(
    db: Database,
    externalId: string
): StoredOpenClawConversation | null {
    const rows = db.prepare(
        'SELECT * FROM openclaw_conversations WHERE external_id = ? LIMIT 2'
    ).all(externalId) as DbConversationRow[]

    if (rows.length !== 1) {
        return null
    }

    return toStoredConversation(rows[0])
}

export function rebindOpenClawConversation(
    db: Database,
    id: string,
    namespace: string,
    externalId: string,
    title?: string | null
): StoredOpenClawConversation | null {
    const existing = getOpenClawConversationByNamespace(db, id, namespace)
    if (!existing) {
        return null
    }

    db.prepare(`
        UPDATE openclaw_conversations
        SET external_id = @external_id,
            title = @title,
            updated_at = @updated_at
        WHERE id = @id
          AND namespace = @namespace
    `).run({
        id,
        namespace,
        external_id: externalId,
        title: title ?? existing.title,
        updated_at: Date.now()
    })

    return getOpenClawConversationByNamespace(db, id, namespace)
}

export function updateOpenClawConversation(
    db: Database,
    id: string,
    namespace: string,
    patch: {
        title?: string | null
        status?: string
        connected?: boolean
        thinking?: boolean
        lastError?: string | null
    }
): StoredOpenClawConversation | null {
    const existing = getOpenClawConversationByNamespace(db, id, namespace)
    if (!existing) {
        return null
    }

    db.prepare(`
        UPDATE openclaw_conversations
        SET title = @title,
            status = @status,
            connected = @connected,
            thinking = @thinking,
            last_error = @last_error,
            updated_at = @updated_at
        WHERE id = @id
          AND namespace = @namespace
    `).run({
        id,
        namespace,
        title: Object.prototype.hasOwnProperty.call(patch, 'title') ? patch.title ?? null : existing.title,
        status: patch.status ?? existing.status,
        connected: Object.prototype.hasOwnProperty.call(patch, 'connected') ? (patch.connected ? 1 : 0) : (existing.connected ? 1 : 0),
        thinking: Object.prototype.hasOwnProperty.call(patch, 'thinking') ? (patch.thinking ? 1 : 0) : (existing.thinking ? 1 : 0),
        last_error: Object.prototype.hasOwnProperty.call(patch, 'lastError') ? patch.lastError ?? null : existing.lastError,
        updated_at: Date.now()
    })

    return getOpenClawConversationByNamespace(db, id, namespace)
}
