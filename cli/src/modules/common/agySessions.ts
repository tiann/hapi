import { existsSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import type {
    AgyImportedMessage,
    AgyImportedMessageContent,
    AgyLocalSessionSummary,
    AgyLocalSessionWithMessages
} from '@hapi/protocol/apiTypes'
import type { AgentMessage } from '@/agent/types'
import { convertAgentMessage } from '@/agent/messageConverter'
import {
    AGY_WAKEUP_CONTINUE_PROMPT,
    type AgyOpenBackgroundCommand,
    type AgyTranscriptStep,
    agyTranscriptPaths,
    convertAgyReactiveSteps,
    readAgyTranscriptStepsAfter
} from '@/agy/agyReactiveWakeup'
import { mapAgyToolCall, mapAgyToolResult } from '@/agy/agyToolCards'

const DEFAULT_AGY_SESSION_SCAN_LIMIT = 200
const LAST_USER_MESSAGE_MAX_LENGTH = 140
const FALLBACK_TITLE_MAX_LENGTH = 80

type SqlParams = unknown[]

type StatementLike = {
    all: (...params: SqlParams) => unknown[]
}

type DatabaseLike = {
    query: (sql: string) => StatementLike
    close: () => void
    exec?: (sql: string) => void
}

export type AgyDatabaseOpener = (dbPath: string) => Promise<DatabaseLike | null>

export type AgySessionStoreOptions = {
    appDataDir?: string
    brainDir?: string
    limit?: number
    opener?: AgyDatabaseOpener
}

type ConversationSummaryRow = {
    conversation_id: string
    title: string | null
    preview: string | null
    step_count: number | null
    last_modified_time: string | number | null
    workspace_uris: string | null
}

let cachedOpener: AgyDatabaseOpener | null = null

async function getDefaultOpener(): Promise<AgyDatabaseOpener> {
    if (!cachedOpener) {
        cachedOpener = async (dbPath: string) => {
            if (!existsSync(dbPath)) return null
            try {
                const { Database } = await import('bun:sqlite')
                const db = new Database(dbPath, { readonly: true }) as unknown as DatabaseLike & { exec?: (sql: string) => void }
                try { db.exec?.('PRAGMA busy_timeout = 5000') } catch {}
                return db
            } catch {
                // Non-Bun runtimes (such as unit tests under Node Vitest) cannot
                // resolve `bun:sqlite`; callers fall back to transcript scanning.
                return null
            }
        }
    }
    return cachedOpener
}

export function getAgyAppDataDir(overrideRoot?: string): string {
    const direct = overrideRoot?.trim() || process.env.AGY_APP_DATA_DIR?.trim()
    return direct || join(homedir(), '.gemini', 'antigravity-cli')
}

export function getAgyDbPath(overrideRoot?: string): string {
    return join(getAgyAppDataDir(overrideRoot), 'conversation_summaries.db')
}

export function getAgyBrainDir(overrideRoot?: string, overrideBrainDir?: string): string {
    return overrideBrainDir?.trim() || join(getAgyAppDataDir(overrideRoot), 'brain')
}

function truncateText(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

function singleLine(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
}

export function parseAgyTimestampMs(raw: unknown): number | null {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        return raw > 1e12 ? Math.round(raw) : Math.round(raw * 1000)
    }
    if (typeof raw !== 'string') return null
    const trimmed = raw.trim()
    if (!trimmed) return null

    // SQLite timestamps in conversation_summaries look like
    // "2026-11-22 09:19:08.9810408+00:00" (space separator + 7 fractional digits).
    let normalized = trimmed
        .replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/, '$1T$2')
        .replace(/(\.\d{3})\d+/, '$1')
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(normalized)) {
        normalized += 'Z'
    }
    const parsed = Date.parse(normalized)
    return Number.isFinite(parsed) ? parsed : null
}

function parseFileUri(uri: string): string | null {
    const trimmed = uri.trim()
    if (!trimmed) return null
    if (!trimmed.startsWith('file://')) return trimmed
    try {
        return fileURLToPath(trimmed)
    } catch {
        try {
            const url = new URL(trimmed)
            const decoded = decodeURIComponent(url.pathname)
            return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded
        } catch {
            return null
        }
    }
}

export function parseAgyWorkspaceCwd(rawWorkspaceUris: unknown): string | null {
    if (typeof rawWorkspaceUris !== 'string') return null
    const trimmed = rawWorkspaceUris.trim()
    if (!trimmed) return null
    try {
        const parsed = JSON.parse(trimmed) as unknown
        if (Array.isArray(parsed)) {
            for (const entry of parsed) {
                if (typeof entry !== 'string') continue
                const resolved = parseFileUri(entry)
                if (resolved) return resolved
            }
            return null
        }
    } catch {
        // Fall through to plain string / single URI handling.
    }
    return parseFileUri(trimmed)
}

export function extractAgyUserInputText(rawContent: string | undefined): string {
    if (typeof rawContent !== 'string') return ''
    const requestMatch = rawContent.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/)
    const extracted = requestMatch
        ? requestMatch[1]!
        : rawContent
            .replace(/<ADDITIONAL_METADATA>[\s\S]*$/i, '')
            .replace(/<USER_SETTINGS_CHANGE>[\s\S]*$/i, '')
    const trimmed = extracted.trim()
    if (!trimmed || trimmed === AGY_WAKEUP_CONTINUE_PROMPT) return ''
    return trimmed
}

function buildSummaryTitle(options: {
    dbTitle?: string | null
    preview?: string | null
    fallbackText?: string | null
    sessionId: string
}): string {
    const directTitle = options.dbTitle?.trim()
    if (directTitle) return directTitle

    const rawPreview = options.preview ? singleLine(options.preview) : ''
    if (rawPreview) return truncateText(rawPreview, FALLBACK_TITLE_MAX_LENGTH)

    const fallback = options.fallbackText ? singleLine(options.fallbackText) : ''
    if (fallback) return truncateText(fallback, FALLBACK_TITLE_MAX_LENGTH)

    return options.sessionId
}

function formatSummaryPreview(rawPreview: string | null | undefined): string | null {
    if (typeof rawPreview !== 'string') return null
    const clean = singleLine(rawPreview)
    if (!clean || clean === AGY_WAKEUP_CONTINUE_PROMPT) return null
    return truncateText(clean, LAST_USER_MESSAGE_MAX_LENGTH)
}

function toAgyAgentContent(
    sessionId: string,
    stepIndex: number,
    subIdx: number,
    canonical: AgentMessage,
    toolNativeNames: Map<string, string>
): AgyImportedMessageContent | null {
    let normalized: AgentMessage = canonical
    if (canonical.type === 'tool_call') {
        const mapped = mapAgyToolCall(canonical)
        toolNativeNames.set(mapped.id, canonical.nativeName ?? canonical.name)
        normalized = mapped
    } else if (canonical.type === 'tool_result') {
        normalized = mapAgyToolResult(canonical, toolNativeNames.get(canonical.id))
    } else if (canonical.type === 'reasoning') {
        // convertAgentMessage generates randomUUID() when `id` is undefined,
        // which would break anchored re-import content equality checks.
        normalized = {
            ...canonical,
            id: canonical.id ?? `agy:${sessionId}:step:${stepIndex}:${subIdx}`
        }
    }

    const converted = convertAgentMessage(normalized)
    if (!converted) return null
    return {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data: converted
        },
        meta: { sentFrom: 'cli' }
    }
}

export function convertAgyTranscriptStepsToMessages(
    sessionId: string,
    steps: AgyTranscriptStep[],
    fallbackTimestampMs: number
): {
    messages: AgyImportedMessage[]
    firstUserMessage: string | null
    lastUserMessage: string | null
} {
    const messages: AgyImportedMessage[] = []
    const openBackgroundCommands: AgyOpenBackgroundCommand[] = []
    const toolNativeNames = new Map<string, string>()
    let firstUserMessage: string | null = null
    let lastUserMessage: string | null = null

    for (let i = 0; i < steps.length; i += 1) {
        const step = steps[i]!
        const createdAt = parseAgyTimestampMs(step.created_at) ?? fallbackTimestampMs

        if (step.type === 'USER_INPUT' && step.source !== 'SYSTEM') {
            const text = extractAgyUserInputText(step.content)
            if (!text) continue
            if (firstUserMessage === null) firstUserMessage = text
            lastUserMessage = truncateText(singleLine(text), LAST_USER_MESSAGE_MAX_LENGTH)
            messages.push({
                localId: `agy:${sessionId}:step:${step.step_index}:0`,
                anchor: `step:${step.step_index}:0`,
                createdAt,
                content: {
                    role: 'user',
                    content: { type: 'text', text },
                    meta: { sentFrom: 'cli' }
                }
            })
            continue
        }

        if (step.source === 'SYSTEM' && step.type === 'SYSTEM_MESSAGE') {
            const { messages: convertedSlice } = convertAgyReactiveSteps(sessionId, [step], openBackgroundCommands)
            let subIdx = 0
            for (const item of convertedSlice) {
                const payload = toAgyAgentContent(sessionId, step.step_index, subIdx, item, toolNativeNames)
                if (!payload) continue
                messages.push({
                    localId: `agy:${sessionId}:step:${step.step_index}:${subIdx}`,
                    anchor: `step:${step.step_index}:${subIdx}`,
                    createdAt,
                    content: payload
                })
                subIdx += 1
            }
            continue
        }

        if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE') {
            const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : []
            const slice: AgyTranscriptStep[] = [step]
            let cursor = i + 1
            let actionCount = 0
            while (
                cursor < steps.length
                && actionCount < toolCalls.length
                && steps[cursor]!.source === 'MODEL'
                && steps[cursor]!.type !== 'PLANNER_RESPONSE'
            ) {
                slice.push(steps[cursor]!)
                cursor += 1
                actionCount += 1
            }
            i = cursor - 1

            const { messages: convertedSlice } = convertAgyReactiveSteps(sessionId, slice, openBackgroundCommands)
            let subIdx = 0
            for (const item of convertedSlice) {
                const payload = toAgyAgentContent(sessionId, step.step_index, subIdx, item, toolNativeNames)
                if (!payload) continue
                messages.push({
                    localId: `agy:${sessionId}:step:${step.step_index}:${subIdx}`,
                    anchor: `step:${step.step_index}:${subIdx}`,
                    createdAt,
                    content: payload
                })
                subIdx += 1
            }
        }
    }

    return { messages, firstUserMessage, lastUserMessage }
}

function hasTable(db: DatabaseLike, tableName: string): boolean {
    try {
        const rows = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).all(tableName)
        return rows.length > 0
    } catch {
        return false
    }
}

async function openDb(dbPath: string, opener?: AgyDatabaseOpener): Promise<DatabaseLike | null> {
    const resolveOpener = opener ?? await getDefaultOpener()
    return await resolveOpener(dbPath)
}

function safeFileStat(filePath: string): { mtimeMs: number } | null {
    try {
        const stats = statSync(filePath)
        return stats.isFile() ? { mtimeMs: Math.round(stats.mtimeMs) } : null
    } catch {
        return null
    }
}

async function listTranscriptFallbackSummaries(brainDir: string, limit: number): Promise<AgyLocalSessionSummary[]> {
    const entries = await readdir(brainDir, { withFileTypes: true }).catch(() => [])
    const summaries: AgyLocalSessionSummary[] = []

    for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const sessionId = entry.name
        const paths = agyTranscriptPaths(brainDir, sessionId)
        if (!paths) continue
        const stats = safeFileStat(paths.compactPath)
        if (!stats) continue

        const steps = readAgyTranscriptStepsAfter(brainDir, sessionId, -1)
        const parsed = convertAgyTranscriptStepsToMessages(sessionId, steps, stats.mtimeMs)
        if (parsed.messages.length === 0) continue

        summaries.push({
            id: sessionId,
            title: buildSummaryTitle({ fallbackText: parsed.firstUserMessage, sessionId }),
            lastUserMessage: parsed.lastUserMessage,
            cwd: null,
            file: paths.compactPath,
            modifiedAt: stats.mtimeMs,
            messageCount: parsed.messages.length
        })
    }

    summaries.sort((a, b) => (b.modifiedAt - a.modifiedAt) || a.id.localeCompare(b.id))
    return summaries.slice(0, limit)
}

export async function listLocalAgySessionSummaries(
    options: AgySessionStoreOptions = {}
): Promise<AgyLocalSessionSummary[]> {
    const limit = options.limit ?? DEFAULT_AGY_SESSION_SCAN_LIMIT
    const dbPath = getAgyDbPath(options.appDataDir)
    const brainDir = getAgyBrainDir(options.appDataDir, options.brainDir)
    const db = await openDb(dbPath, options.opener)

    if (!db) {
        return await listTranscriptFallbackSummaries(brainDir, limit)
    }

    try {
        if (!hasTable(db, 'conversation_summaries')) {
            return await listTranscriptFallbackSummaries(brainDir, limit)
        }

        const rows = db.query(`
            SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris
            FROM conversation_summaries
            WHERE (nesting_depth IS NULL OR nesting_depth = 0)
              AND (parent_conversation_id IS NULL OR parent_conversation_id = '')
            ORDER BY last_modified_time DESC, conversation_id ASC
        `).all() as ConversationSummaryRow[]

        const summaries: AgyLocalSessionSummary[] = []
        for (const row of rows) {
            if (typeof row.conversation_id !== 'string' || !row.conversation_id) continue
            if (typeof row.step_count === 'number' && row.step_count <= 0) continue
            const paths = agyTranscriptPaths(brainDir, row.conversation_id)
            if (!paths) continue
            const stats = safeFileStat(paths.compactPath)
            if (!stats) continue

            const modifiedAt = parseAgyTimestampMs(row.last_modified_time) ?? stats.mtimeMs
            summaries.push({
                id: row.conversation_id,
                title: buildSummaryTitle({
                    dbTitle: row.title,
                    preview: row.preview,
                    sessionId: row.conversation_id
                }),
                lastUserMessage: formatSummaryPreview(row.preview),
                cwd: parseAgyWorkspaceCwd(row.workspace_uris),
                file: paths.compactPath,
                modifiedAt
            })
            if (summaries.length >= limit) break
        }

        summaries.sort((a, b) => (b.modifiedAt - a.modifiedAt) || a.id.localeCompare(b.id))
        return summaries
    } finally {
        db.close()
    }
}

export async function listLocalAgySessionsWithMessagesByIds(
    sessionIds: Set<string>,
    options: AgySessionStoreOptions = {}
): Promise<AgyLocalSessionWithMessages[]> {
    if (sessionIds.size === 0) return []

    const dbPath = getAgyDbPath(options.appDataDir)
    const brainDir = getAgyBrainDir(options.appDataDir, options.brainDir)
    const rowsById = new Map<string, ConversationSummaryRow>()
    const db = await openDb(dbPath, options.opener)

    if (db) {
        try {
            if (hasTable(db, 'conversation_summaries')) {
                const requested = [...sessionIds]
                const placeholders = requested.map(() => '?').join(', ')
                const rows = db.query(`
                    SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris
                    FROM conversation_summaries
                    WHERE conversation_id IN (${placeholders})
                      AND (nesting_depth IS NULL OR nesting_depth = 0)
                      AND (parent_conversation_id IS NULL OR parent_conversation_id = '')
                `).all(...requested) as ConversationSummaryRow[]
                for (const row of rows) {
                    if (typeof row.conversation_id === 'string' && row.conversation_id) {
                        rowsById.set(row.conversation_id, row)
                    }
                }
            }
        } finally {
            db.close()
        }
    }

    const sessions: AgyLocalSessionWithMessages[] = []
    for (const sessionId of sessionIds) {
        const paths = agyTranscriptPaths(brainDir, sessionId)
        if (!paths) continue
        const stats = safeFileStat(paths.compactPath)
        if (!stats) continue

        const row = rowsById.get(sessionId)
        const modifiedAt = parseAgyTimestampMs(row?.last_modified_time) ?? stats.mtimeMs
        const steps = readAgyTranscriptStepsAfter(brainDir, sessionId, -1)
        const converted = convertAgyTranscriptStepsToMessages(sessionId, steps, modifiedAt)
        const lastUserMessage = converted.lastUserMessage ?? formatSummaryPreview(row?.preview)

        sessions.push({
            id: sessionId,
            title: buildSummaryTitle({
                dbTitle: row?.title,
                preview: row?.preview,
                fallbackText: converted.firstUserMessage,
                sessionId
            }),
            lastUserMessage,
            cwd: parseAgyWorkspaceCwd(row?.workspace_uris),
            file: paths.compactPath,
            modifiedAt,
            messageCount: converted.messages.length,
            messages: converted.messages
        })
    }

    sessions.sort((a, b) => (b.modifiedAt - a.modifiedAt) || a.id.localeCompare(b.id))
    return sessions
}
