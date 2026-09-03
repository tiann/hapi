import type { Database } from 'bun:sqlite'

import {
    extractMessageRenderKey,
    extractSearchableMessageText,
    isLiveStreamSnapshot
} from '@hapi/protocol/messages'
import { decodeMessageContent } from './contentCodec'

export const MESSAGE_CONTENT_SEARCH_TABLE = 'message_content_search'
// Bind scoped session IDs as one JSON value instead of expanding them into
// one SQLite variable per ID. Keep a byte bound for defensive request sizing.
export const MAX_CONTENT_SEARCH_SESSION_SCOPE_BYTES = 256 * 1024
const MESSAGE_CONTENT_SEARCH_LOOKUP_TABLE = 'message_content_search_lookup'
const MESSAGE_CONTENT_SEARCH_SHORT_TABLE = 'message_content_search_short'
const initializedDatabases = new WeakSet<object>()

export type MessageContentSearchMatch = {
    sessionId: string
    messageId: string
    role: 'user' | 'assistant'
    seq: number
    createdAt: number
    snippet: string
}

export type SessionMessageContentSearchResult = {
    matches: MessageContentSearchMatch[]
    total: number
}

type IndexableMessage = {
    id: string
    sessionId: string
    content: unknown
    seq: number
    createdAt: number
    invokedAt: number | null
}

type DbMessageRow = {
    row_id: number
    id: string
    session_id: string
    content: string | Uint8Array
    created_at: number
    seq: number
    invoked_at: number | null
}

const SEARCH_REBUILD_BATCH_SIZE = 500
const SEARCH_LOOKUP_BACKFILL_BATCH_SIZE = 500
const MIN_INDEXED_QUERY_LENGTH = 2
export const MAX_INDEXED_MESSAGE_CHARACTERS = 16_384
const INDEXED_TEXT_SEPARATOR = ' '
const INDEXED_TEXT_HEAD_CHARACTERS = Math.floor(
    (MAX_INDEXED_MESSAGE_CHARACTERS - INDEXED_TEXT_SEPARATOR.length) / 2
)
const INDEXED_TEXT_TAIL_CHARACTERS = MAX_INDEXED_MESSAGE_CHARACTERS
    - INDEXED_TEXT_SEPARATOR.length
    - INDEXED_TEXT_HEAD_CHARACTERS

type DbSearchRow = {
    search_rowid?: number
    message_id: string
    session_id: string
    role: 'user' | 'assistant'
    seq: number | string
    created_at: number | string
    snippet?: string | null
    searchable_text?: string
}

type DbSearchLookupRow = {
    search_rowid: number
}

export function serializeContentSearchSessionIds(sessionIds: readonly string[]): string | null {
    const serialized = JSON.stringify(sessionIds)
    return new TextEncoder().encode(serialized).byteLength <= MAX_CONTENT_SEARCH_SESSION_SCOPE_BYTES
        ? serialized
        : null
}

export function backfillMessageContentSearchLookup(db: Database): void {
    ensureMessageContentSearchTable(db)
    const select = db.prepare(`
        SELECT rowid AS search_rowid, message_id
        FROM ${MESSAGE_CONTENT_SEARCH_TABLE}
        WHERE rowid > ?
        ORDER BY rowid ASC
        LIMIT ?
    `)
    const insert = db.prepare(`
        INSERT OR IGNORE INTO ${MESSAGE_CONTENT_SEARCH_LOOKUP_TABLE} (
            search_rowid, message_id, target_message_id
        ) VALUES (?, ?, ?)
    `)

    let afterRowId = 0
    while (true) {
        const rows = select.all(afterRowId, SEARCH_LOOKUP_BACKFILL_BATCH_SIZE) as Array<{
            search_rowid: number
            message_id: string
        }>
        if (rows.length === 0) break

        for (const row of rows) {
            insert.run(row.search_rowid, row.message_id, row.message_id)
        }
        afterRowId = rows[rows.length - 1]!.search_rowid
    }
}

function getShortSearchGrams(text: string): string[] {
    const characters = Array.from(text.toLocaleLowerCase())
    const grams = new Set<string>()

    for (let index = 0; index + 1 < characters.length; index += 1) {
        grams.add(`${characters[index]!}${characters[index + 1]!}`)
    }

    return [...grams]
}

function boundSearchableText(text: string): string {
    if (text.length <= MAX_INDEXED_MESSAGE_CHARACTERS) return text

    // Slice before converting to code points so a very large message cannot
    // allocate an Array for its entire contents just to index its head and
    // tail. The cap is intentionally expressed in UTF-16 code units to keep
    // this work bounded even for messages containing only astral characters.
    let head = text.slice(0, INDEXED_TEXT_HEAD_CHARACTERS)
    let tail = text.slice(text.length - INDEXED_TEXT_TAIL_CHARACTERS)
    const headLastCodeUnit = head.charCodeAt(head.length - 1)
    if (headLastCodeUnit >= 0xd800 && headLastCodeUnit <= 0xdbff) {
        head = head.slice(0, -1)
    }
    const tailFirstCodeUnit = tail.charCodeAt(0)
    if (tailFirstCodeUnit >= 0xdc00 && tailFirstCodeUnit <= 0xdfff) {
        tail = tail.slice(1)
    }
    return `${head}${INDEXED_TEXT_SEPARATOR}${tail}`
}

export function backfillMessageContentSearchShortIndex(db: Database): void {
    db.transaction(() => {
        ensureMessageContentSearchTable(db)
        // A failed pre-v28 startup may have left a partially populated short
        // index behind. Remove obsolete unigram rows while preserving any
        // completed bigrams so a retry can resume without a full reset.
        db.exec(`DELETE FROM ${MESSAGE_CONTENT_SEARCH_SHORT_TABLE} WHERE length(gram) < 2`)
        const select = db.prepare(`
            SELECT rowid AS search_rowid,
                   CASE WHEN length(searchable_text) <= ?
                        THEN searchable_text
                        ELSE substr(searchable_text, 1, ?) || ? || substr(searchable_text, -?)
                   END AS searchable_text,
                   length(searchable_text) AS searchable_text_length
            FROM ${MESSAGE_CONTENT_SEARCH_TABLE}
            WHERE rowid > ?
            ORDER BY rowid ASC
            LIMIT ?
        `)
        const insert = db.prepare(`
            INSERT OR IGNORE INTO ${MESSAGE_CONTENT_SEARCH_SHORT_TABLE} (gram, search_rowid)
            VALUES (?, ?)
        `)
        const updateSearchableText = db.prepare(`
            UPDATE ${MESSAGE_CONTENT_SEARCH_TABLE}
            SET searchable_text = ?
            WHERE rowid = ?
        `)

        let afterRowId = 0
        while (true) {
            const rows = select.all(
                MAX_INDEXED_MESSAGE_CHARACTERS,
                INDEXED_TEXT_HEAD_CHARACTERS,
                INDEXED_TEXT_SEPARATOR,
                INDEXED_TEXT_TAIL_CHARACTERS,
                afterRowId,
                SEARCH_LOOKUP_BACKFILL_BATCH_SIZE
            ) as Array<{
                search_rowid: number
                searchable_text: string
                searchable_text_length: number
            }>
            if (rows.length === 0) break

            for (const row of rows) {
                const searchableText = boundSearchableText(row.searchable_text)
                if (row.searchable_text_length > MAX_INDEXED_MESSAGE_CHARACTERS
                    || searchableText !== row.searchable_text) {
                    updateSearchableText.run(searchableText, row.search_rowid)
                }
                for (const gram of getShortSearchGrams(searchableText)) {
                    insert.run(gram, row.search_rowid)
                }
            }
            afterRowId = rows[rows.length - 1]!.search_rowid
        }
    })()
}

export function createMessageContentSearchTable(db: Database): void {
    if (initializedDatabases.has(db)) return

    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${MESSAGE_CONTENT_SEARCH_TABLE} USING fts5(
            searchable_text,
            message_id UNINDEXED,
            session_id UNINDEXED,
            seq UNINDEXED,
            created_at UNINDEXED,
            role UNINDEXED,
            tokenize = 'trigram'
        )
    `)
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${MESSAGE_CONTENT_SEARCH_LOOKUP_TABLE} (
            search_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT NOT NULL UNIQUE,
            target_message_id TEXT NOT NULL
        )
    `)
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${MESSAGE_CONTENT_SEARCH_SHORT_TABLE} (
            gram TEXT NOT NULL,
            search_rowid INTEGER NOT NULL,
            PRIMARY KEY (gram, search_rowid)
        ) WITHOUT ROWID
    `)
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_message_content_search_short_rowid
        ON ${MESSAGE_CONTENT_SEARCH_SHORT_TABLE} (search_rowid)
    `)
    const lookupColumns = db.prepare(`PRAGMA table_info(${MESSAGE_CONTENT_SEARCH_LOOKUP_TABLE})`).all() as Array<{ name: string }>
    if (!lookupColumns.some((column) => column.name === 'target_message_id')) {
        // V26/V27 databases created the lookup without a separate target ID.
        // Keep schema v28 compatible by upgrading the derived table in place.
        db.exec(`ALTER TABLE ${MESSAGE_CONTENT_SEARCH_LOOKUP_TABLE} ADD COLUMN target_message_id TEXT`)
    }
    db.exec(`
        UPDATE ${MESSAGE_CONTENT_SEARCH_LOOKUP_TABLE}
        SET target_message_id = message_id
        WHERE target_message_id IS NULL
    `)
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_message_content_search_lookup_target
        ON ${MESSAGE_CONTENT_SEARCH_LOOKUP_TABLE} (target_message_id)
    `)
    // FTS5 UNINDEXED columns are intentionally not searchable, but SQLite
    // still has to scan the virtual table when deleting by one of them. Keep
    // an ordinary indexed message-id lookup so the write path stays bounded.
    // Existing rows are backfilled explicitly by schema migrations. Do not
    // scan the FTS table on every database reopen or first search.
    initializedDatabases.add(db)
}

function ensureMessageContentSearchTable(db: Database): void {
    if (!initializedDatabases.has(db)) {
        createMessageContentSearchTable(db)
    }
}

export function removeMessageContentSearchIndex(db: Database, messageId: string): void {
    ensureMessageContentSearchTable(db)
    const lookups = db.prepare(`
        SELECT search_rowid
        FROM ${MESSAGE_CONTENT_SEARCH_LOOKUP_TABLE}
        WHERE target_message_id = ? OR message_id = ?
    `).all(messageId, messageId) as DbSearchLookupRow[]
    for (const lookup of lookups) {
        removeMessageContentSearchRow(db, lookup.search_rowid)
    }
}

function removeMessageContentSearchRow(db: Database, searchRowId: number): void {
    db.prepare(`DELETE FROM ${MESSAGE_CONTENT_SEARCH_SHORT_TABLE} WHERE search_rowid = ?`).run(searchRowId)
    db.prepare(`DELETE FROM ${MESSAGE_CONTENT_SEARCH_TABLE} WHERE rowid = ?`).run(searchRowId)
    db.prepare(`DELETE FROM ${MESSAGE_CONTENT_SEARCH_LOOKUP_TABLE} WHERE search_rowid = ?`).run(searchRowId)
}

function removeMessageContentSearchIndexByKey(db: Database, searchKey: string): void {
    const lookup = db.prepare(`
        SELECT search_rowid
        FROM ${MESSAGE_CONTENT_SEARCH_LOOKUP_TABLE}
        WHERE message_id = ?
    `).get(searchKey) as DbSearchLookupRow | undefined
    if (lookup) removeMessageContentSearchRow(db, lookup.search_rowid)
}

function insertMessageContentSearchIndex(
    db: Database,
    message: {
        id: string
        targetMessageId: string
        sessionId: string
        text: string
        role: 'user' | 'assistant'
        seq: number
        createdAt: number
    }
): void {
    db.prepare(`
        INSERT INTO ${MESSAGE_CONTENT_SEARCH_LOOKUP_TABLE} (message_id, target_message_id)
        VALUES (?, ?)
    `).run(message.id, message.targetMessageId)
    const lookup = db.prepare(`
        SELECT search_rowid
        FROM ${MESSAGE_CONTENT_SEARCH_LOOKUP_TABLE}
        WHERE message_id = ?
    `).get(message.id) as DbSearchLookupRow | undefined
    if (!lookup) throw new Error('Failed to create message content search lookup')
    const searchableText = boundSearchableText(message.text)

    db.prepare(`
        INSERT INTO ${MESSAGE_CONTENT_SEARCH_TABLE} (
            rowid, searchable_text, message_id, session_id, seq, created_at, role
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        lookup.search_rowid,
        searchableText,
        message.targetMessageId,
        message.sessionId,
        message.seq,
        message.createdAt,
        message.role
    )
    const insertShortGram = db.prepare(`
        INSERT INTO ${MESSAGE_CONTENT_SEARCH_SHORT_TABLE} (gram, search_rowid)
        VALUES (?, ?)
    `)
    for (const gram of getShortSearchGrams(searchableText)) {
        insertShortGram.run(gram, lookup.search_rowid)
    }
}

export function indexMessageContent(db: Database, message: IndexableMessage): void {
    // Pi emits cumulative live snapshots every 250 ms. They are deliberately
    // not indexed; the explicit terminal snapshot carries the same render key
    // and is indexed once when the stream finishes.
    if (isLiveStreamSnapshot(message.content)) return
    ensureMessageContentSearchTable(db)
    const renderKey = extractMessageRenderKey(message.content)
    const searchKey = renderKey ? `${message.sessionId}:${renderKey}` : message.id
    removeMessageContentSearchIndex(db, message.id)
    if (searchKey !== message.id) removeMessageContentSearchIndexByKey(db, searchKey)
    if (message.invokedAt === null) return

    const searchable = extractSearchableMessageText(message.content)
    if (!searchable) return

    insertMessageContentSearchIndex(db, {
        id: searchKey,
        targetMessageId: message.id,
        sessionId: message.sessionId,
        text: searchable.text,
        role: searchable.role,
        seq: message.seq,
        createdAt: message.createdAt
    })
}

export function rebuildMessageContentSearch(db: Database): void {
    db.transaction(() => {
        rebuildMessageContentSearchInternal(db)
    })()
}

function removeMessageContentSearchRowsForSessions(db: Database, sessionIds: string[]): void {
    if (sessionIds.length === 0) return
    const placeholders = sessionIds.map(() => '?').join(', ')
    const messageIds = `SELECT id FROM messages WHERE session_id IN (${placeholders})`
    db.prepare(`
        DELETE FROM ${MESSAGE_CONTENT_SEARCH_SHORT_TABLE}
        WHERE search_rowid IN (
            SELECT search_rowid
            FROM ${MESSAGE_CONTENT_SEARCH_LOOKUP_TABLE}
            WHERE target_message_id IN (${messageIds})
        )
    `).run(...sessionIds)
    db.prepare(`
        DELETE FROM ${MESSAGE_CONTENT_SEARCH_TABLE}
        WHERE rowid IN (
            SELECT search_rowid
            FROM ${MESSAGE_CONTENT_SEARCH_LOOKUP_TABLE}
            WHERE target_message_id IN (${messageIds})
        )
    `).run(...sessionIds)
    db.prepare(`
        DELETE FROM ${MESSAGE_CONTENT_SEARCH_LOOKUP_TABLE}
        WHERE target_message_id IN (${messageIds})
    `).run(...sessionIds)
}

function rebuildMessageContentSearchInternal(db: Database, sessionIds?: string[]): void {
    createMessageContentSearchTable(db)

    const insertLookup = db.prepare(`
        INSERT INTO ${MESSAGE_CONTENT_SEARCH_LOOKUP_TABLE} (message_id, target_message_id)
        VALUES (?, ?)
    `)
    const getLookup = db.prepare(`
        SELECT search_rowid
        FROM ${MESSAGE_CONTENT_SEARCH_LOOKUP_TABLE}
        WHERE message_id = ?
    `)
    const insert = db.prepare(`
        INSERT INTO ${MESSAGE_CONTENT_SEARCH_TABLE} (
            rowid, searchable_text, message_id, session_id, seq, created_at, role
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    let selectBatch: ReturnType<Database['prepare']>
    if (sessionIds) {
        const placeholders = sessionIds.map(() => '?').join(', ')
        removeMessageContentSearchRowsForSessions(db, sessionIds)
        selectBatch = db.prepare(`
            SELECT rowid AS row_id, id, session_id, content, created_at, seq, invoked_at
            FROM messages
            WHERE session_id IN (${placeholders})
              AND invoked_at IS NOT NULL
              AND rowid > ?
            ORDER BY rowid ASC
            LIMIT ?
        `)
    } else {
        db.exec(`DELETE FROM ${MESSAGE_CONTENT_SEARCH_TABLE}`)
        db.exec(`DELETE FROM ${MESSAGE_CONTENT_SEARCH_LOOKUP_TABLE}`)
        db.exec(`DELETE FROM ${MESSAGE_CONTENT_SEARCH_SHORT_TABLE}`)
        selectBatch = db.prepare(`
            SELECT rowid AS row_id, id, session_id, content, created_at, seq, invoked_at
            FROM messages
            WHERE invoked_at IS NOT NULL
              AND rowid > ?
            ORDER BY rowid ASC
            LIMIT ?
        `)
    }

    let afterRowId = 0
    while (true) {
        const rows = (sessionIds
            ? selectBatch.all(...sessionIds, afterRowId, SEARCH_REBUILD_BATCH_SIZE)
            : selectBatch.all(afterRowId, SEARCH_REBUILD_BATCH_SIZE)) as DbMessageRow[]
        if (rows.length === 0) break

        for (const row of rows) {
            const decodedContent = decodeMessageContent(row.content)
            if (isLiveStreamSnapshot(decodedContent)) continue
            const renderKey = extractMessageRenderKey(decodedContent)
            const searchKey = renderKey ? `${row.session_id}:${renderKey}` : row.id
            removeMessageContentSearchIndex(db, row.id)
            if (searchKey !== row.id) removeMessageContentSearchIndexByKey(db, searchKey)
            const searchable = extractSearchableMessageText(decodedContent)
            if (!searchable) continue
            const searchableText = boundSearchableText(searchable.text)
            insertLookup.run(searchKey, row.id)
            const lookup = getLookup.get(searchKey) as DbSearchLookupRow | undefined
            if (!lookup) throw new Error('Failed to create message content search lookup')
            insert.run(
                lookup.search_rowid,
                searchableText,
                row.id,
                row.session_id,
                row.seq,
                row.created_at,
                searchable.role
            )
            const insertShortGram = db.prepare(`
                INSERT INTO ${MESSAGE_CONTENT_SEARCH_SHORT_TABLE} (gram, search_rowid)
                VALUES (?, ?)
            `)
            for (const gram of getShortSearchGrams(searchableText)) {
                insertShortGram.run(gram, lookup.search_rowid)
            }
        }

        afterRowId = rows[rows.length - 1]!.row_id
    }
}

export function rebuildMessageContentSearchForSessions(
    db: Database,
    sessionIds: string[],
    alreadyInTransaction = false
): void {
    if (sessionIds.length === 0) return
    const rebuild = () => rebuildMessageContentSearchInternal(db, sessionIds)
    if (alreadyInTransaction) {
        rebuild()
    } else {
        db.transaction(rebuild)()
    }
}

export function removeMessageContentSearchForSessions(db: Database, sessionIds: string[]): void {
    ensureMessageContentSearchTable(db)
    removeMessageContentSearchRowsForSessions(db, sessionIds)
}

export function removeMessageContentSearchForSession(db: Database, sessionId: string): void {
    removeMessageContentSearchForSessions(db, [sessionId])
}

function normalizeSearchQuery(query: string): string {
    return query.trim().replace(/\s+/g, ' ')
}

function escapeFtsPhrase(query: string): string {
    return `"${query.replaceAll('"', '""')}"`
}

function makeLikeSnippet(text: string, query: string, radius: number = 90): string {
    const lowerText = text.toLocaleLowerCase()
    const lowerQuery = query.toLocaleLowerCase()
    const matchAt = lowerText.indexOf(lowerQuery)
    const start = matchAt < 0 ? 0 : Math.max(0, matchAt - radius)
    const end = Math.min(text.length, (matchAt < 0 ? 0 : matchAt) + query.length + radius)
    const prefix = start > 0 ? '…' : ''
    const suffix = end < text.length ? '…' : ''
    return `${prefix}${text.slice(start, end)}${suffix}`.replace(/\s+/g, ' ').trim()
}

/** Sidebar stays terse; in-session pickers need enough prose to choose a turn. */
const SIDEBAR_SNIPPET_TOKENS = 24
/** ~2 UI lines at hit-card width (~55 chars/line); FTS token snippets were still one line. */
const IN_SESSION_LIKE_SNIPPET_RADIUS = 100

export function searchMessageContent(
    db: Database,
    query: string,
    namespace: string,
    limit: number = 50,
    sessionIds?: readonly string[]
): MessageContentSearchMatch[] {
    ensureMessageContentSearchTable(db)
    const normalizedQuery = normalizeSearchQuery(query)
    if (!normalizedQuery) return []

    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 50
    const queryLength = [...normalizedQuery].length
    if (queryLength < MIN_INDEXED_QUERY_LENGTH) return []
    const scopedSessionIds = sessionIds === undefined
        ? undefined
        : [...new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean))]
    if (scopedSessionIds?.length === 0) return []
    const serializedSessionIds = scopedSessionIds === undefined
        ? undefined
        : serializeContentSearchSessionIds(scopedSessionIds)
    if (serializedSessionIds === null) return []
    const sessionScope = scopedSessionIds === undefined
        ? ''
        : ' AND f.session_id IN (SELECT value FROM json_each(?))'
    const sessionScopeParams: string[] = serializedSessionIds === undefined ? [] : [serializedSessionIds]
    const useShortIndex = queryLength === MIN_INDEXED_QUERY_LENGTH
    const rows = useShortIndex
        ? db.prepare(`
            WITH ranked_matches AS (
                SELECT
                    f.rowid AS search_rowid,
                    f.message_id,
                    f.session_id,
                    f.role,
                    f.seq,
                    f.created_at,
                    f.searchable_text,
                    s.updated_at,
                    ROW_NUMBER() OVER (
                        PARTITION BY f.session_id
                        ORDER BY CAST(f.seq AS INTEGER) DESC,
                                 CAST(f.created_at AS INTEGER) DESC,
                                 f.message_id DESC
                    ) AS session_rank
                FROM ${MESSAGE_CONTENT_SEARCH_TABLE} AS f
                INNER JOIN ${MESSAGE_CONTENT_SEARCH_SHORT_TABLE} AS short
                    ON short.search_rowid = f.rowid AND short.gram = ?
                INNER JOIN sessions AS s
                    ON s.id = f.session_id AND s.namespace = ?
                WHERE 1 = 1${sessionScope}
            )
            SELECT message_id, session_id, role, seq, created_at, searchable_text
            FROM ranked_matches
            WHERE session_rank = 1
            ORDER BY updated_at DESC, CAST(seq AS INTEGER) DESC
            LIMIT ?
        `).all(normalizedQuery.toLocaleLowerCase(), namespace, ...sessionScopeParams, safeLimit) as DbSearchRow[]
        : db.prepare(`
            WITH ranked_matches AS (
                SELECT
                    f.rowid AS search_rowid,
                    f.message_id,
                    f.session_id,
                    f.role,
                    f.seq,
                    f.created_at,
                    s.updated_at,
                    ROW_NUMBER() OVER (
                        PARTITION BY f.session_id
                        ORDER BY CAST(f.seq AS INTEGER) DESC,
                                 CAST(f.created_at AS INTEGER) DESC,
                                 f.message_id DESC
                    ) AS session_rank
                FROM ${MESSAGE_CONTENT_SEARCH_TABLE} AS f
                INNER JOIN sessions AS s
                    ON s.id = f.session_id AND s.namespace = ?
                WHERE ${MESSAGE_CONTENT_SEARCH_TABLE} MATCH ?${sessionScope}
            )
            SELECT ranked.message_id, ranked.session_id, ranked.role, ranked.seq, ranked.created_at,
                   snippet(${MESSAGE_CONTENT_SEARCH_TABLE}, 0, '', '', '…', ${SIDEBAR_SNIPPET_TOKENS}) AS snippet
            FROM ranked_matches AS ranked
            INNER JOIN ${MESSAGE_CONTENT_SEARCH_TABLE} AS f
                ON f.rowid = ranked.search_rowid
            WHERE ranked.session_rank = 1
            ORDER BY ranked.updated_at DESC, CAST(ranked.seq AS INTEGER) DESC
            LIMIT ?
        `).all(namespace, escapeFtsPhrase(normalizedQuery), ...sessionScopeParams, safeLimit) as DbSearchRow[]

    return rows.map((row) => ({
        sessionId: row.session_id,
        messageId: row.message_id,
        role: row.role,
        seq: Number(row.seq),
        createdAt: Number(row.created_at),
        snippet: useShortIndex
            ? makeLikeSnippet(row.searchable_text ?? '', normalizedQuery)
            : String(row.snippet ?? '').replace(/\s+/g, ' ').trim()
    }))
}

/**
 * Return every matching message in one session for in-chat navigation.
 *
 * The sidebar deliberately deduplicates to one result per session. Once a
 * result is opened, the chat needs the message-level result set so the user
 * can move between older and newer matches without loading the whole session.
 */
export function searchMessageContentInSession(
    db: Database,
    query: string,
    namespace: string,
    sessionId: string,
    limit: number = 500
): SessionMessageContentSearchResult {
    ensureMessageContentSearchTable(db)
    const normalizedQuery = normalizeSearchQuery(query)
    if (!normalizedQuery) return { matches: [], total: 0 }

    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 500
    const queryLength = [...normalizedQuery].length
    if (queryLength < MIN_INDEXED_QUERY_LENGTH) return { matches: [], total: 0 }
    const useShortIndex = queryLength === MIN_INDEXED_QUERY_LENGTH
    const countRow = useShortIndex
        ? db.prepare(`
            SELECT COUNT(*) AS count
            FROM ${MESSAGE_CONTENT_SEARCH_TABLE} AS f
            INNER JOIN ${MESSAGE_CONTENT_SEARCH_SHORT_TABLE} AS short
                ON short.search_rowid = f.rowid AND short.gram = ?
            INNER JOIN sessions AS s
                ON s.id = f.session_id AND s.namespace = ?
            WHERE f.session_id = ?
        `).get(normalizedQuery.toLocaleLowerCase(), namespace, sessionId) as { count: number | string }
        : db.prepare(`
            SELECT COUNT(*) AS count
            FROM ${MESSAGE_CONTENT_SEARCH_TABLE} AS f
            INNER JOIN sessions AS s
                ON s.id = f.session_id AND s.namespace = ?
            WHERE f.session_id = ?
              AND ${MESSAGE_CONTENT_SEARCH_TABLE} MATCH ?
        `).get(namespace, sessionId, escapeFtsPhrase(normalizedQuery)) as { count: number | string }

    const rows = useShortIndex
        ? db.prepare(`
            SELECT f.message_id, f.session_id, f.role, f.seq, f.created_at, f.searchable_text
            FROM ${MESSAGE_CONTENT_SEARCH_TABLE} AS f
            INNER JOIN ${MESSAGE_CONTENT_SEARCH_SHORT_TABLE} AS short
                ON short.search_rowid = f.rowid AND short.gram = ?
            INNER JOIN sessions AS s
                ON s.id = f.session_id AND s.namespace = ?
            WHERE f.session_id = ?
            ORDER BY CAST(f.seq AS INTEGER) DESC
            LIMIT ?
        `).all(normalizedQuery.toLocaleLowerCase(), namespace, sessionId, safeLimit) as DbSearchRow[]
        : db.prepare(`
            SELECT f.message_id, f.session_id, f.role, f.seq, f.created_at, f.searchable_text
            FROM ${MESSAGE_CONTENT_SEARCH_TABLE} AS f
            INNER JOIN sessions AS s
                ON s.id = f.session_id AND s.namespace = ?
            WHERE f.session_id = ?
              AND ${MESSAGE_CONTENT_SEARCH_TABLE} MATCH ?
            ORDER BY CAST(f.seq AS INTEGER) DESC
            LIMIT ?
        `).all(namespace, sessionId, escapeFtsPhrase(normalizedQuery), safeLimit) as DbSearchRow[]

    return {
        matches: rows.map((row) => ({
            sessionId: row.session_id,
            messageId: row.message_id,
            role: row.role,
            seq: Number(row.seq),
            createdAt: Number(row.created_at),
            // Character window (not FTS token snippet) so the web hit card can
            // reliably fill two lines of context around the query.
            snippet: makeLikeSnippet(
                row.searchable_text ?? '',
                normalizedQuery,
                IN_SESSION_LIKE_SNIPPET_RADIUS
            )
        })),
        total: Number(countRow?.count ?? 0)
    }
}
