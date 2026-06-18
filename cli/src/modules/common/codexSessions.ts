import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, relative } from 'node:path'
import { homedir } from 'node:os'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { isCodexSubagentSource } from '@/codex/utils/codexSessionMetadata'

const DEFAULT_CODEX_SESSION_SCAN_LIMIT = 200
/** Head window for summary listing — enough for session_meta + early user/title events. */
const CODEX_SUMMARY_HEAD_BYTES = 256 * 1024

type CodexSessionIndexTitle = {
    threadName: string
    updatedAt: string
}

type CodexImportedMessageContent = {
    role: 'user'
    content: { type: 'text'; text: string }
    meta: { sentFrom: 'cli' }
} | {
    role: 'agent'
    content: { type: typeof AGENT_MESSAGE_PAYLOAD_TYPE; data: unknown }
    meta: { sentFrom: 'cli' }
}

export type LocalCodexSessionSummary = {
    id: string
    title: string
    lastUserMessage?: string | null
    cwd?: string | null
    file: string
    modifiedAt: number
    originator?: string | null
    cliVersion?: string | null
    source?: string | null
    threadSource?: string | null
    forkedFromId?: string | null
}

export type LocalCodexSessionWithMessages = LocalCodexSessionSummary & {
    messages: CodexImportedMessageContent[]
}

export type ArchiveLocalCodexSessionOptions = {
    canArchive?: (session: LocalCodexSessionSummary) => boolean | Promise<boolean>
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

function extractCodexText(value: unknown): string {
    if (typeof value === 'string') return value.trim()
    if (Array.isArray(value)) {
        return value.map((item) => {
            const record = asRecord(item)
            if (record?.type === 'text' && typeof record.text === 'string') return record.text
            if (record?.type === 'input_text' && typeof record.text === 'string') return record.text
            if (record?.type === 'output_text' && typeof record.text === 'string') return record.text
            return null
        }).filter((part): part is string => Boolean(part)).join(' ').trim()
    }
    const record = asRecord(value)
    if (record?.type === 'text' && typeof record.text === 'string') return record.text.trim()
    if (record?.type === 'input_text' && typeof record.text === 'string') return record.text.trim()
    if (record?.type === 'output_text' && typeof record.text === 'string') return record.text.trim()
    return ''
}

function truncateText(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

function shouldIgnoreSyntheticUserMessage(text: string): boolean {
    const normalized = text.trim()
    return normalized.startsWith('# AGENTS.md instructions') || normalized.startsWith('<environment_context>')
}

function inferSessionIdFromFileName(filePath: string): string | null {
    return /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(filePath)?.[1] ?? null
}

function collectJsonlFiles(root: string, files: string[]): void {
    let entries: import('node:fs').Dirent[]
    try {
        entries = readdirSync(root, { withFileTypes: true })
    } catch {
        return
    }
    for (const entry of entries) {
        const fullPath = join(root, entry.name)
        if (entry.isDirectory()) collectJsonlFiles(fullPath, files)
        else if (entry.isFile() && fullPath.toLowerCase().endsWith('.jsonl')) files.push(fullPath)
    }
}

function readFileHead(filePath: string, maxBytes: number): string | null {
    let fd: number | undefined
    try {
        fd = openSync(filePath, 'r')
        const buffer = Buffer.alloc(Math.max(1, maxBytes))
        const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
        return buffer.subarray(0, bytesRead).toString('utf-8')
    } catch {
        return null
    } finally {
        if (fd !== undefined) {
            try { closeSync(fd) } catch { /* ignore */ }
        }
    }
}

function getCodexHome(): string {
    return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
}

function getCodexSessionRoots(): string[] {
    const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
    return [join(codexHome, 'sessions')]
}

function getCodexSessionIndexPath(): string {
    return join(getCodexHome(), 'session_index.jsonl')
}

function readCodexSessionIndexTitles(): Map<string, CodexSessionIndexTitle> {
    let content: string
    try {
        content = readFileSync(getCodexSessionIndexPath(), 'utf-8')
    } catch {
        return new Map()
    }

    const titles = new Map<string, CodexSessionIndexTitle>()
    for (const line of content.split(/\r?\n/).filter(Boolean)) {
        try {
            const record = asRecord(JSON.parse(line))
            const id = typeof record?.id === 'string' ? record.id : null
            const threadName = typeof record?.thread_name === 'string' && record.thread_name.trim()
                ? record.thread_name.trim()
                : null
            const updatedAt = typeof record?.updated_at === 'string' && record.updated_at.trim()
                ? record.updated_at.trim()
                : null
            if (!id || !threadName || !updatedAt) continue

            const previous = titles.get(id)
            if (!previous || previous.updatedAt < updatedAt) {
                titles.set(id, { threadName, updatedAt })
            }
        } catch {
            continue
        }
    }
    return titles
}

function extractCodexChangedTitle(record: Record<string, unknown>): string | null {
    if (record.type === 'response_item') {
        const payload = asRecord(record.payload)
        if (payload?.type === 'function_call' && payload.name === 'change_title' && typeof payload.arguments === 'string') {
            try {
                const parsed = JSON.parse(payload.arguments) as { title?: unknown }
                return typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null
            } catch { return null }
        }
    }
    if (record.type === 'event_msg') {
        const payload = asRecord(record.payload)
        const invocation = asRecord(payload?.invocation)
        const args = asRecord(invocation?.arguments)
        if (payload?.type === 'mcp_tool_call_end' && invocation?.tool === 'change_title' && typeof args?.title === 'string' && args.title.trim()) {
            return args.title.trim()
        }
    }
    return null
}

function getLatestCodexChangedTitle(lines: string[]): string | null {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const record = asRecord(JSON.parse(lines[index]))
            if (!record) continue
            const title = extractCodexChangedTitle(record)
            if (title) return title
        } catch { continue }
    }
    return null
}

function getLatestCodexUserMessage(lines: string[]): string | null {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const record = asRecord(JSON.parse(lines[index]))
            if (!record || record.type !== 'response_item') continue
            const payload = asRecord(record.payload)
            if (payload?.type !== 'message' || payload.role !== 'user') continue
            const text = extractCodexText(payload.content)
            if (text && !shouldIgnoreSyntheticUserMessage(text)) return truncateText(text, 140)
        } catch { continue }
    }
    return null
}

function getCodexSessionTitle(cwd: string | null | undefined, sessionId: string, sessionIndexTitle: string | null, changedTitle: string | null, firstUserMessage: string | null): string {
    if (sessionIndexTitle) return truncateText(sessionIndexTitle, 80)
    if (changedTitle) return changedTitle
    if (firstUserMessage) return truncateText(firstUserMessage, 80)
    if (cwd) return basename(cwd) || cwd
    return sessionId.slice(0, 8)
}

function parseCodexFunctionArguments(value: unknown): unknown {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
    try { return JSON.parse(trimmed) } catch { return value }
}

function extractCodexToolCallId(payload: Record<string, unknown>): string | null {
    for (const key of ['call_id', 'callId', 'tool_call_id', 'toolCallId', 'id']) {
        const value = payload[key]
        if (typeof value === 'string' && value.length > 0) return value
    }
    return null
}

function buildImportedUserMessage(text: string): CodexImportedMessageContent {
    return { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } }
}

function buildImportedAgentMessage(data: unknown): CodexImportedMessageContent {
    return { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data }, meta: { sentFrom: 'cli' } }
}

function convertCodexRecordToImportedMessage(record: Record<string, unknown>): CodexImportedMessageContent | null {
    const type = asString(record.type)
    const payload = asRecord(record.payload)
    if (!type || !payload) return null
    if (type === 'event_msg') {
        const eventType = asString(payload.type)
        if (eventType === 'user_message') {
            const text = asString(payload.message) ?? asString(payload.text) ?? asString(payload.content)
            return text && !shouldIgnoreSyntheticUserMessage(text) ? buildImportedUserMessage(text) : null
        }
        if (eventType === 'agent_message') {
            const message = asString(payload.message)
            return message ? buildImportedAgentMessage({ type: 'message', message, id: randomUUID() }) : null
        }
        if (eventType === 'token_count') {
            const info = asRecord(payload.info)
            return info ? buildImportedAgentMessage({ type: 'token_count', info, id: randomUUID() }) : null
        }
        return null
    }
    if (type !== 'response_item') return null
    const itemType = asString(payload.type)
    if (itemType === 'message') {
        const role = asString(payload.role)
        const text = extractCodexText(payload.content)
        if (!text || shouldIgnoreSyntheticUserMessage(text)) return null
        if (role === 'user') return buildImportedUserMessage(text)
        if (role === 'assistant') return buildImportedAgentMessage({ type: 'message', message: text, id: randomUUID() })
    }
    if (itemType === 'function_call') {
        const name = asString(payload.name)
        const callId = extractCodexToolCallId(payload)
        return name && callId ? buildImportedAgentMessage({ type: 'tool-call', name, callId, input: parseCodexFunctionArguments(payload.arguments), id: randomUUID() }) : null
    }
    if (itemType === 'function_call_output') {
        const callId = extractCodexToolCallId(payload)
        return callId ? buildImportedAgentMessage({ type: 'tool-call-result', callId, output: payload.output, id: randomUUID() }) : null
    }
    return null
}

function stableSerialize(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`
}

function normalizeComparableContent(content: unknown): string | null {
    const record = asRecord(content)
    if (!record) return null
    if (record.role === 'user') {
        const body = asRecord(record.content)
        return body?.type === 'text' && typeof body.text === 'string'
            ? stableSerialize({ role: 'user', text: body.text.replace(/\s+$/u, '') })
            : null
    }
    if (record.role === 'agent') {
        const body = asRecord(record.content)
        const data = asRecord(body?.data)
        const normalized = data ? { ...data } : body?.data
        if (data) delete (normalized as Record<string, unknown>).id
        return body?.type === AGENT_MESSAGE_PAYLOAD_TYPE ? stableSerialize({ role: 'agent', data: normalized }) : null
    }
    return null
}

function deduplicateAdjacentImportedMessages(messages: CodexImportedMessageContent[]): CodexImportedMessageContent[] {
    const deduped: CodexImportedMessageContent[] = []
    let previousKey: string | null = null
    for (const message of messages) {
        const key = normalizeComparableContent(message)
        if (key && key === previousKey) continue
        deduped.push(message)
        previousKey = key
    }
    return deduped
}

function parseCodexLocalSession(
    filePath: string,
    includeMessages: boolean,
    sessionIndexTitles = new Map<string, CodexSessionIndexTitle>()
): LocalCodexSessionWithMessages | LocalCodexSessionSummary | null {
    // Summary listing must not load entire transcripts into memory — only a head window.
    // Full-file reads are reserved for explicit import (includeMessages=true).
    const content = includeMessages
        ? (() => { try { return readFileSync(filePath, 'utf-8') } catch { return null } })()
        : readFileHead(filePath, CODEX_SUMMARY_HEAD_BYTES)
    if (content === null) return null
    const lines = content.split(/\r?\n/).filter(Boolean)
    const headLines = lines.slice(0, 200)
    let sessionId: string | null = null
    let cwd: string | null = null
    let originator: string | null = null
    let cliVersion: string | null = null
    let source: string | null = null
    let threadSource: string | null = null
    let forkedFromId: string | null = null
    let firstUserMessage: string | null = null
    const messages: CodexImportedMessageContent[] = []

    if (includeMessages) {
        for (const line of lines) {
            let record: Record<string, unknown> | null = null
            try { record = asRecord(JSON.parse(line)) } catch { continue }
            if (!record) continue
            const message = convertCodexRecordToImportedMessage(record)
            if (message) messages.push(message)
        }
    }

    for (const line of headLines) {
        try {
            const record = asRecord(JSON.parse(line))
            if (!record) continue
            if (record.type === 'session_meta') {
                const payload = asRecord(record.payload)
                if (isCodexSubagentSource(payload?.source)) return null
                if (!sessionId && typeof payload?.id === 'string') sessionId = payload.id
                if (!cwd && typeof payload?.cwd === 'string') cwd = payload.cwd
                if (!originator && typeof payload?.originator === 'string') originator = payload.originator
                if (!cliVersion && typeof payload?.cli_version === 'string') cliVersion = payload.cli_version
                if (!source && typeof payload?.source === 'string') source = payload.source
                if (!threadSource && typeof payload?.thread_source === 'string') threadSource = payload.thread_source
                if (!forkedFromId && typeof payload?.forked_from_id === 'string') forkedFromId = payload.forked_from_id
            }
            if (!firstUserMessage && record.type === 'response_item') {
                const payload = asRecord(record.payload)
                if (payload?.type === 'message' && payload.role === 'user') {
                    const text = extractCodexText(payload.content)
                    if (text && !shouldIgnoreSyntheticUserMessage(text)) firstUserMessage = text
                }
            }
        } catch { continue }
    }

    sessionId = sessionId ?? inferSessionIdFromFileName(filePath)
    if (!sessionId) return null
    const sessionIndexTitle = sessionIndexTitles.get(sessionId)?.threadName ?? null
    // Title/last-user scans stay on the same line set we already loaded (head for
    // summaries, full file only when importing messages).
    const changedTitle = getLatestCodexChangedTitle(includeMessages ? lines : headLines)
    const lastUserMessage = getLatestCodexUserMessage(includeMessages ? lines : headLines)
    let modifiedAt = Date.now()
    try { modifiedAt = statSync(filePath).mtimeMs } catch {}
    const summary = {
        id: sessionId,
        title: getCodexSessionTitle(cwd, sessionId, sessionIndexTitle, changedTitle, firstUserMessage),
        lastUserMessage,
        cwd,
        file: filePath,
        modifiedAt,
        originator,
        cliVersion,
        source,
        threadSource,
        forkedFromId
    }
    return includeMessages ? { ...summary, messages: deduplicateAdjacentImportedMessages(messages) } : summary
}

function listLocalCodexSessions(includeMessages: false, limit?: number): LocalCodexSessionSummary[]
function listLocalCodexSessions(includeMessages: true, limit?: number): LocalCodexSessionWithMessages[]
function listLocalCodexSessions(includeMessages: boolean, limit = DEFAULT_CODEX_SESSION_SCAN_LIMIT): Array<LocalCodexSessionSummary | LocalCodexSessionWithMessages> {
    const files: string[] = []
    for (const root of getCodexSessionRoots()) collectJsonlFiles(root, files)
    const sessionIndexTitles = readCodexSessionIndexTitles()
    const deduped = new Map<string, LocalCodexSessionSummary | LocalCodexSessionWithMessages>()
    for (const file of files) {
        const session = parseCodexLocalSession(file, includeMessages, sessionIndexTitles)
        if (!session) continue
        const previous = deduped.get(session.id)
        if (!previous || previous.modifiedAt < session.modifiedAt) deduped.set(session.id, session)
    }
    return Array.from(deduped.values()).sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, limit)
}

export function listLocalCodexSessionSummaries(limit = DEFAULT_CODEX_SESSION_SCAN_LIMIT): LocalCodexSessionSummary[] {
    return listLocalCodexSessions(false, limit)
}

export function listLocalCodexSessionsWithMessages(limit = DEFAULT_CODEX_SESSION_SCAN_LIMIT): LocalCodexSessionWithMessages[] {
    return listLocalCodexSessions(true, limit)
}

export function listLocalCodexSessionsWithMessagesByIds(ids: Set<string>): LocalCodexSessionWithMessages[] {
    if (ids.size === 0) return []
    const sessionIndexTitles = readCodexSessionIndexTitles()
    const files: string[] = []
    for (const root of getCodexSessionRoots()) {
        collectJsonlFiles(root, files)
    }

    const results: LocalCodexSessionWithMessages[] = []
    for (const file of files) {
        const idFromName = inferSessionIdFromFileName(file)
        // Skip unrelated transcripts without reading message bodies.
        if (idFromName && !ids.has(idFromName)) continue

        if (idFromName && ids.has(idFromName)) {
            const session = parseCodexLocalSession(file, true, sessionIndexTitles)
            if (session && Array.isArray((session as LocalCodexSessionWithMessages).messages)) {
                results.push(session as LocalCodexSessionWithMessages)
            }
            continue
        }

        // Filename lacked a UUID — head-parse for id, then full-load only on match.
        const summary = parseCodexLocalSession(file, false, sessionIndexTitles)
        if (!summary || !ids.has(summary.id)) continue
        const session = parseCodexLocalSession(file, true, sessionIndexTitles)
        if (session && Array.isArray((session as LocalCodexSessionWithMessages).messages)) {
            results.push(session as LocalCodexSessionWithMessages)
        }
    }
    return results
}

/** Resolve a Codex thread's workspace cwd without loading the full transcript body. */
export function findCodexSessionPath(sessionId: string): string | null {
    const normalized = sessionId.trim()
    if (!normalized) return null

    const files: string[] = []
    for (const root of getCodexSessionRoots()) {
        collectJsonlFiles(root, files)
    }

    for (const file of files) {
        const idFromName = inferSessionIdFromFileName(file)
        if (idFromName && idFromName !== normalized) continue
        const summary = parseCodexLocalSession(file, false)
        if (summary?.id === normalized) {
            return summary.cwd ?? null
        }
    }
    return null
}

/** Resolve the on-disk transcript path for a Codex thread id (head-parse only). */
export function findCodexSessionFile(sessionId: string): string | null {
    const normalized = sessionId.trim()
    if (!normalized) return null

    const files: string[] = []
    for (const root of getCodexSessionRoots()) {
        collectJsonlFiles(root, files)
    }

    for (const file of files) {
        const idFromName = inferSessionIdFromFileName(file)
        if (idFromName && idFromName !== normalized) continue
        if (idFromName === normalized) return file
        const summary = parseCodexLocalSession(file, false)
        if (summary?.id === normalized) return summary.file
    }
    return null
}


export async function archiveLocalCodexSession(sessionId: string, options: ArchiveLocalCodexSessionOptions = {}): Promise<{ success: true; archivedPath: string } | { success: false; error: string }> {
    const normalizedId = sessionId.trim()
    if (!normalizedId) return { success: false, error: 'sessionId is required' }

    const sessionsRoot = getCodexSessionRoots()[0]
    const archivedRoot = join(getCodexHome(), 'archived_sessions')
    const sessions = listLocalCodexSessionSummaries(DEFAULT_CODEX_SESSION_SCAN_LIMIT * 5)
    const target = sessions.find((session) => session.id === normalizedId)
    if (!target) return { success: false, error: 'Codex session not found' }
    if (options.canArchive && !(await options.canArchive(target))) {
        return { success: false, error: 'Codex session is outside workspace roots' }
    }

    const relativePath = relative(sessionsRoot, target.file)
    if (!relativePath || relativePath.startsWith('..')) {
        return { success: false, error: 'Codex session file is outside local sessions root' }
    }

    const archivedPath = join(archivedRoot, relativePath)
    try {
        mkdirSync(dirname(archivedPath), { recursive: true })
        if (existsSync(archivedPath)) {
            return { success: false, error: 'Archived Codex session already exists' }
        }
        renameSync(target.file, archivedPath)
        return { success: true, archivedPath }
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to archive Codex session' }
    }
}
