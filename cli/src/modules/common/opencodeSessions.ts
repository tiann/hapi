import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import type {
    OpencodeImportedMessage,
    OpencodeImportedMessageContent,
    OpencodeLocalSessionSummary,
    OpencodeLocalSessionWithMessages
} from '@hapi/protocol/apiTypes'

const DEFAULT_OPENCODE_SESSION_SCAN_LIMIT = 200
const LAST_USER_MESSAGE_MAX_LENGTH = 140

type JsonRecord = Record<string, unknown>

type SqlParams = unknown[]

type StatementLike = {
    get: (...params: SqlParams) => unknown
    all: (...params: SqlParams) => unknown[]
}

type DatabaseLike = {
    query: (sql: string) => StatementLike
    close: () => void
    exec?: (sql: string) => void
}

export type OpencodeDatabaseOpener = (dbPath: string) => Promise<DatabaseLike | null>

type SessionRow = {
    id: string
    title: string | null
    directory: string | null
    time_updated: number | string
    model?: string | null
}

type V1MessageRow = {
    id: string
    data: unknown
    time_created: number | string
}

type V2MessageRow = {
    id: string
    seq: number
    type: string
    data: unknown
    time_created: number | string
}

// Which schema generation the database offers. v1 = session/message/part,
// v2 = session_v2/session_message. A migrated database has both.
type SchemaAvailability = {
    v1: boolean
    v2: boolean
}

type MergedSessionRow = {
    id: string
    title: string | null
    directory: string | null
    time_updated: number | string
    model?: string | null
}

type ImportedText = {
    // Stable identity of the text inside its message: "<message id>:<content index>".
    key: string
    text: string
    envelope: 'user' | 'agent'
}

let cachedOpener: OpencodeDatabaseOpener | null = null

async function getDefaultOpener(): Promise<OpencodeDatabaseOpener> {
    if (!cachedOpener) {
        cachedOpener = async (dbPath: string) => {
            const { Database } = await import('bun:sqlite')
            if (!existsSync(dbPath)) return null
            const db = new Database(dbPath, { readonly: true }) as unknown as DatabaseLike & { exec?: (sql: string) => void }
            try { db.exec?.('PRAGMA busy_timeout = 5000') } catch {}
            return db
        }
    }
    return cachedOpener
}

function asRecord(value: unknown): JsonRecord | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : null
}

export function getOpencodeSessionsRoot(overrideRoot?: string): string {
    const direct = overrideRoot ?? process.env.OPENCODE_HOME?.trim()
    if (direct) return direct
    const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share')
    return join(dataHome, 'opencode')
}

export function getOpencodeDbPath(overrideRoot?: string): string {
    return join(getOpencodeSessionsRoot(overrideRoot), 'opencode.db')
}

function truncateText(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

async function openDb(dbPath: string, opener?: OpencodeDatabaseOpener): Promise<DatabaseLike | null> {
    const resolveOpener = opener ?? await getDefaultOpener()
    return await resolveOpener(dbPath)
}

function hasTable(db: DatabaseLike, table: string): boolean {
    try {
        const row = db.query(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`
        ).get(table) as { name: string } | null | undefined
        return Boolean(row?.name)
    } catch {
        return false
    }
}

// Table names are internal constants, so they are safe to inline here:
// PRAGMA does not accept them as bound parameters.
function hasColumn(db: DatabaseLike, table: string, column: string): boolean {
    try {
        const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>
        return rows.some((row) => row.name === column)
    } catch {
        return false
    }
}

function getSchemaAvailability(db: DatabaseLike): SchemaAvailability {
    return {
        v1: hasTable(db, 'session') && hasTable(db, 'message') && hasTable(db, 'part'),
        v2: hasTable(db, 'session_v2') && hasTable(db, 'session_message')
    }
}

function parseJson(value: unknown): JsonRecord | null {
    if (typeof value !== 'string' || !value.trim()) return null
    try {
        return asRecord(JSON.parse(value))
    } catch {
        return null
    }
}

function collectTextParts(db: DatabaseLike, messageId: string, role: string): Array<{ id: string; text: string }> {
    // Query failures must propagate: a swallowed error here would yield a
    // partial transcript that the hub later rejects as transcript_diverged.
    const partRows = db.query(
        `SELECT id, data FROM part WHERE message_id = ? ORDER BY time_created ASC`
    ).all(messageId) as Array<{ id: string; data: unknown }>
    const texts: Array<{ id: string; text: string }> = []
    for (const partRow of partRows) {
        const parsed = parseJson(partRow.data)
        if (parsed?.type !== 'text' || typeof parsed.text !== 'string') continue
        if (!parsed.text.trim()) continue
        // Mirror the live scanner gate: assistant text parts are mutable while
        // the response is still streaming; only finished (or synthetic/user)
        // parts are stable enough to import.
        if (role !== 'user' && parsed.synthetic !== true) {
            const time = asRecord(parsed.time)
            if (typeof time?.end !== 'number') continue
        }
        texts.push({ id: partRow.id, text: parsed.text })
    }
    return texts
}

// OpenCode v2 keeps the message envelope in session_message.type and the
// payload in session_message.data: user/synthetic/system rows carry
// data.text, assistant rows carry data.content[] with {type:'text', text}
// items that have neither an id nor time.end. The v2 rows are already
// finalized, so the v1 "skip text parts without time.end" streaming gate
// must not be applied here. system rows are system prompts, not
// conversation, and are not imported (v1 never imported them either).
function collectV2Texts(row: V2MessageRow): ImportedText[] {
    const parsed = parseJson(row.data)
    if (!parsed) return []
    const singleText = (): ImportedText[] => {
        const text = typeof parsed.text === 'string' ? parsed.text : ''
        if (!text.trim()) return []
        return [{ key: `${row.id}:0`, text, envelope: 'user' }]
    }
    if (row.type === 'user') return singleText()
    if (row.type === 'synthetic') {
        // v1 imported synthetic text parts as part of their (user) message.
        return singleText()
    }
    if (row.type === 'system') {
        // system rows carry the system/context prompt of the session, not
        // conversation: v1 never imported them, so they map to nothing.
        return []
    }
    if (row.type !== 'assistant') return []
    const content = Array.isArray(parsed.content) ? parsed.content : []
    const texts: ImportedText[] = []
    for (let index = 0; index < content.length; index += 1) {
        const item = asRecord(content[index])
        if (!item || item.type !== 'text') continue
        const text = typeof item.text === 'string' ? item.text : ''
        if (!text.trim()) continue
        texts.push({ key: `${row.id}:${index}`, text, envelope: 'agent' })
    }
    return texts
}

function extractLastUserMessageV1(db: DatabaseLike, sessionId: string): string | null {
    let messageRows: Array<{ id: string; data: unknown }> = []
    try {
        messageRows = db.query(
            `SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC`
        ).all(sessionId) as Array<{ id: string; data: unknown }>
    } catch {
        return null
    }
    for (const messageRow of messageRows) {
        const parsed = parseJson(messageRow.data)
        if (parsed?.role !== 'user') continue
        let text: string
        try {
            text = collectTextParts(db, messageRow.id, 'user')
                .filter((part) => !part.text.startsWith('<'))
                .map((part) => part.text)
                .join('')
                .trim()
        } catch {
            continue
        }
        if (!text) continue
        return truncateText(text, LAST_USER_MESSAGE_MAX_LENGTH)
    }
    return null
}

function extractLastUserMessageV2(db: DatabaseLike, sessionId: string): string | null {
    let messageRows: V2MessageRow[] = []
    try {
        messageRows = db.query(
            `SELECT id, seq, type, data, time_created FROM session_message WHERE session_id = ? ORDER BY seq DESC`
        ).all(sessionId) as V2MessageRow[]
    } catch {
        return null
    }
    for (const messageRow of messageRows) {
        // system and synthetic rows are never "last user message" candidates.
        if (messageRow.type !== 'user') continue
        const parsed = parseJson(messageRow.data)
        const text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
        if (!text) continue
        if (text.startsWith('<')) continue
        return truncateText(text, LAST_USER_MESSAGE_MAX_LENGTH)
    }
    return null
}

function extractLastUserMessage(db: DatabaseLike, sessionId: string, availability: SchemaAvailability): string | null {
    // v2 rows are the newer tail of a migrated session, so they win.
    if (availability.v2) {
        const v2 = extractLastUserMessageV2(db, sessionId)
        if (v2 !== null) return v2
    }
    if (availability.v1) return extractLastUserMessageV1(db, sessionId)
    return null
}

function importedUser(text: string): OpencodeImportedMessageContent {
    return {
        role: 'user',
        content: { type: 'text', text },
        meta: { sentFrom: 'cli' }
    }
}

function importedAgent(text: string, id: string): OpencodeImportedMessageContent {
    return {
        role: 'agent',
        content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'message', message: text, id } },
        meta: { sentFrom: 'cli' }
    }
}

function normalizeTimestamp(value: number | string | null | undefined, fallback: number): number {
    const timestamp = Number(value)
    if (!Number.isFinite(timestamp)) return fallback
    return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp
}

function readV1Messages(db: DatabaseLike, sessionId: string): V1MessageRow[] {
    return db.query(
        `SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC`
    ).all(sessionId) as V1MessageRow[]
}

function readV2Messages(db: DatabaseLike, sessionId: string): V2MessageRow[] {
    return db.query(
        `SELECT id, seq, type, data, time_created FROM session_message WHERE session_id = ? ORDER BY seq ASC`
    ).all(sessionId) as V2MessageRow[]
}

// A migrated session keeps its v1 history and appends the v2 messages that
// came after it. The cut-off is the last v1 message: when the migration kept
// the message ids, the counterpart of the last v1 message marks the end of
// the mirrored prefix. Otherwise the prefix is aligned by position: the first
// N v2 user/assistant rows (N = the number of v1 user/assistant messages)
// mirror the v1 messages and everything after them is the tail. Timestamps
// are never used as the cut-off: a migration can re-stamp them, which would
// import the v1 prefix twice. Non-chat v1 rows (system prompts, bookkeeping)
// have no v2 counterpart, so they must not inflate the positional count.
function selectV2Tail(v1Messages: V1MessageRow[], v2Messages: V2MessageRow[]): V2MessageRow[] {
    if (v2Messages.length === 0) return []
    if (v1Messages.length === 0) return v2Messages
    const lastV1 = v1Messages[v1Messages.length - 1]
    const counterpart = v2Messages.find((message) => message.id === lastV1.id)
    if (counterpart) {
        const v1Ids = new Set(v1Messages.map((message) => message.id))
        return v2Messages.filter((message) => {
            if (v1Ids.has(message.id)) return false
            return message.seq > counterpart.seq
        })
    }
    // The ids differ: align the mirrored prefix by position instead.
    const v1Mirrorable = v1Messages.filter((messageRow) => {
        const parsed = parseJson(messageRow.data)
        const role = typeof parsed?.role === 'string' ? parsed.role : null
        return role === 'user' || role === 'assistant'
    })
    if (v1Mirrorable.length === 0) return v2Messages
    const mirror = v2Messages.filter((message) => message.type === 'user' || message.type === 'assistant')
    if (mirror.length < v1Mirrorable.length) {
        // Inconsistent mirror (fewer v2 rows than v1 chat messages): keep the
        // v1 transcript instead of importing a tail that may not belong here.
        return []
    }
    const cutoffIndex = v2Messages.indexOf(mirror[v1Mirrorable.length - 1])
    if (cutoffIndex < 0) return []
    return v2Messages.slice(cutoffIndex + 1)
}

async function buildSessionMessages(
    db: DatabaseLike,
    summary: OpencodeLocalSessionSummary,
    availability: SchemaAvailability
): Promise<OpencodeLocalSessionWithMessages> {
    const messages: OpencodeImportedMessage[] = []
    let createdAt = summary.modifiedAt
    try {
        const v1Messages = availability.v1 ? readV1Messages(db, summary.id) : []
        const v2Messages = availability.v2 ? readV2Messages(db, summary.id) : []
        const v2Tail = selectV2Tail(v1Messages, v2Messages)
        for (const messageRow of v1Messages) {
            const parsed = parseJson(messageRow.data)
            const role = typeof parsed?.role === 'string' ? parsed.role : null
            if (!role) continue
            createdAt = normalizeTimestamp(messageRow.time_created, createdAt)
            // No silent catch here either: a mid-transcript query failure must
            // fail the whole read instead of returning a partial snapshot that
            // the hub would permanently reject as transcript_diverged later.
            for (const part of collectTextParts(db, messageRow.id, role)) {
                messages.push({
                    localId: `opencode:${summary.id}:${messageRow.id}:${part.id}`,
                    createdAt,
                    content: role === 'user' ? importedUser(part.text) : importedAgent(part.text, part.id)
                })
            }
        }
        for (const messageRow of v2Tail) {
            createdAt = normalizeTimestamp(messageRow.time_created, createdAt)
            for (const text of collectV2Texts(messageRow)) {
                messages.push({
                    localId: `opencode:${summary.id}:${messageRow.id}:${text.key}`,
                    createdAt,
                    content: text.envelope === 'user' ? importedUser(text.text) : importedAgent(text.text, text.key)
                })
            }
        }
    } catch (error) {
        if (messages.length === 0 && error instanceof Error && /no such table: (message|session_message)/i.test(error.message)) {
            // Fresh installations without the message tables yet: empty history.
            // Anything else (including a missing part table mid-transcript)
            // must propagate so callers never persist a partial snapshot.
            return { ...summary, messages }
        }
        throw error
    }
    return { ...summary, messages }
}

function readV1Sessions(db: DatabaseLike, limit: number): SessionRow[] {
    try {
        return db.query(
            `SELECT id, title, directory, time_updated FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT ?`
        ).all(limit) as SessionRow[]
    } catch {
        return []
    }
}

function readV2Sessions(db: DatabaseLike, limit: number): SessionRow[] {
    // session_v2 tracks archived sessions like the v1 table does.
    const archivedFilter = hasColumn(db, 'session_v2', 'time_archived') ? ' WHERE time_archived IS NULL' : ''
    // The model column carries the launch hint (D8); older databases lack it.
    const modelColumn = hasColumn(db, 'session_v2', 'model') ? ', model' : ''
    try {
        return db.query(
            `SELECT id, title, directory, time_updated${modelColumn} FROM session_v2${archivedFilter} ORDER BY time_updated DESC LIMIT ?`
        ).all(limit) as SessionRow[]
    } catch {
        return []
    }
}

// Ids of the sessions that are archived in either table. A migrated database
// keeps the v1 rows of an archived session around, and the v2 row of a
// session that was archived in v1 is not archived itself, so the archive
// state of both tables has to be merged before the list is built.
function readArchivedSessionIds(db: DatabaseLike, table: 'session' | 'session_v2'): Set<string> {
    try {
        const rows = db.query(
            `SELECT id FROM ${table} WHERE time_archived IS NOT NULL`
        ).all() as Array<{ id: string }>
        return new Set(rows.map((row) => row.id))
    } catch {
        return new Set()
    }
}

function collectArchivedSessionIds(db: DatabaseLike, availability: SchemaAvailability): Set<string> {
    const archivedIds = new Set<string>()
    if (availability.v1) {
        for (const id of readArchivedSessionIds(db, 'session')) archivedIds.add(id)
    }
    if (availability.v2 && hasColumn(db, 'session_v2', 'time_archived')) {
        for (const id of readArchivedSessionIds(db, 'session_v2')) archivedIds.add(id)
    }
    return archivedIds
}

// One entry per session id: the v2 row wins, but a null v2 title/directory
// falls back to the v1 value instead of blanking the session. Archived
// sessions are dropped from the list.
function mergeSessionRows(v1Rows: SessionRow[], v2Rows: SessionRow[], archivedIds: Set<string>): MergedSessionRow[] {
    const merged = new Map<string, { v1: SessionRow | null; v2: SessionRow | null }>()
    for (const row of v1Rows) {
        if (archivedIds.has(row.id)) continue
        const entry = merged.get(row.id) ?? { v1: null, v2: null }
        entry.v1 = row
        merged.set(row.id, entry)
    }
    for (const row of v2Rows) {
        if (archivedIds.has(row.id)) continue
        const entry = merged.get(row.id) ?? { v1: null, v2: null }
        entry.v2 = row
        merged.set(row.id, entry)
    }
    const rows: MergedSessionRow[] = []
    for (const [id, entry] of merged) {
        const v1 = entry.v1
        const v2 = entry.v2
        rows.push({
            id,
            title: v2?.title ?? v1?.title ?? null,
            directory: v2?.directory ?? v1?.directory ?? null,
            time_updated: v2?.time_updated ?? v1?.time_updated ?? 0,
            model: v2?.model ?? null
        })
    }
    return rows
}

function sortByModifiedAt(rows: MergedSessionRow[]): MergedSessionRow[] {
    return [...rows].sort((a, b) => normalizeTimestamp(b.time_updated, 0) - normalizeTimestamp(a.time_updated, 0))
}

function buildSummary(
    db: DatabaseLike,
    row: MergedSessionRow,
    dbPath: string,
    availability: SchemaAvailability
): OpencodeLocalSessionSummary {
    return {
        id: row.id,
        title: row.title ?? '',
        lastUserMessage: extractLastUserMessage(db, row.id, availability),
        cwd: row.directory ?? null,
        file: dbPath,
        modifiedAt: normalizeTimestamp(row.time_updated, Date.now()),
        ...(row.model ? { model: row.model } : {})
    }
}

function findSessionRow(db: DatabaseLike, id: string, availability: SchemaAvailability): MergedSessionRow | null {
    let v1: SessionRow | null = null
    let v2: SessionRow | null = null
    if (availability.v1) {
        try {
            const rows = db.query(
                `SELECT id, title, directory, time_updated FROM session WHERE id = ?`
            ).all(id) as SessionRow[]
            v1 = rows[0] ?? null
        } catch {
            v1 = null
        }
    }
    if (availability.v2) {
        try {
            const modelColumn = hasColumn(db, 'session_v2', 'model') ? ', model' : ''
            const rows = db.query(
                `SELECT id, title, directory, time_updated${modelColumn} FROM session_v2 WHERE id = ?`
            ).all(id) as SessionRow[]
            v2 = rows[0] ?? null
        } catch {
            v2 = null
        }
    }
    if (!v1 && !v2) return null
    return {
        id,
        title: v2?.title ?? v1?.title ?? null,
        directory: v2?.directory ?? v1?.directory ?? null,
        time_updated: v2?.time_updated ?? v1?.time_updated ?? 0,
        model: v2?.model ?? null
    }
}

export async function listLocalOpencodeSessionSummaries(
    limit = DEFAULT_OPENCODE_SESSION_SCAN_LIMIT,
    opener?: OpencodeDatabaseOpener
): Promise<OpencodeLocalSessionSummary[]> {
    if (limit <= 0) return []
    const dbPath = getOpencodeDbPath()
    const db = await openDb(dbPath, opener)
    if (!db) return []
    try {
        const availability = getSchemaAvailability(db)
        if (!availability.v1 && !availability.v2) return []
        const exec = db.exec?.bind(db)
        const inTransaction = typeof exec === 'function'
        if (inTransaction) exec('BEGIN DEFERRED')
        try {
            const v1Rows = availability.v1 ? readV1Sessions(db, limit) : []
            const v2Rows = availability.v2 ? readV2Sessions(db, limit) : []
            const archivedIds = collectArchivedSessionIds(db, availability)
            const rows = sortByModifiedAt(mergeSessionRows(v1Rows, v2Rows, archivedIds)).slice(0, limit)
            const summaries = rows.map((row) => buildSummary(db, row, dbPath, availability))
            if (inTransaction) exec('COMMIT')
            return summaries
        } catch (error) {
            if (inTransaction) {
                try { exec('ROLLBACK') } catch {}
            }
            throw error
        }
    } finally {
        db.close()
    }
}

export async function listLocalOpencodeSessionsWithMessagesByIds(
    ids: Set<string>,
    opener?: OpencodeDatabaseOpener
): Promise<OpencodeLocalSessionWithMessages[]> {
    if (ids.size === 0) return []
    const dbPath = getOpencodeDbPath()
    const db = await openDb(dbPath, opener)
    if (!db) return []
    try {
        const availability = getSchemaAvailability(db)
        if (!availability.v1 && !availability.v2) return []
        const sessions: OpencodeLocalSessionWithMessages[] = []
        for (const id of ids) {
            const row = findSessionRow(db, id, availability)
            if (!row) continue
            // Read messages and their parts inside one deferred transaction:
            // OpenCode may write while we scan, and a snapshot hole here would
            // permanently fail re-imports as transcript_diverged.
            const exec = db.exec?.bind(db)
            const inTransaction = typeof exec === 'function'
            if (inTransaction) exec('BEGIN DEFERRED')
            try {
                const summary = buildSummary(db, row, dbPath, availability)
                sessions.push(await buildSessionMessages(db, summary, availability))
                if (inTransaction) exec('COMMIT')
            } catch (error) {
                if (inTransaction) {
                    try { exec('ROLLBACK') } catch {}
                }
                throw error
            }
        }
        // same ordering semantics as summaries: modifiedAt desc
        return sessions.sort((a, b) => b.modifiedAt - a.modifiedAt)
    } finally {
        db.close()
    }
}
