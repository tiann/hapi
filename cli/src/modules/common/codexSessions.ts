import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, relative } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import {
    AGENT_MESSAGE_PAYLOAD_TYPE,
    deduplicateCodexTranscriptMessages,
    shouldIgnoreInjectedResponseUserMessage,
    type CodexImportedMessageContent,
    type CodexImportedMessageEntry,
    type CodexImportedMessageSource
} from '@hapi/protocol'
import { isCodexSubagentSource } from '@/codex/utils/codexSessionMetadata'

const DEFAULT_CODEX_SESSION_SCAN_LIMIT = 200

type CodexSessionIndexTitle = {
    threadName: string
    updatedAt: string
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
    loadError?: string
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

function inferSessionIdFromFileName(filePath: string): string | null {
    return /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(filePath)?.[1] ?? null
}

function collectJsonlFiles(root: string, files: string[], pattern = /\.jsonl$/i): void {
    let entries: import('node:fs').Dirent[]
    try {
        entries = readdirSync(root, { withFileTypes: true })
    } catch {
        return
    }
    for (const entry of entries) {
        const fullPath = join(root, entry.name)
        if (entry.isDirectory()) collectJsonlFiles(fullPath, files, pattern)
        else if (entry.isFile() && pattern.test(entry.name)) files.push(fullPath)
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
            if (text && !shouldIgnoreInjectedResponseUserMessage(text)) return truncateText(text, 140)
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

function convertCodexRecordToImportedMessage(record: Record<string, unknown>): CodexImportedMessageEntry | null {
    const type = asString(record.type)
    const payload = asRecord(record.payload)
    if (!type || !payload) return null
    if (type === 'event_msg') {
        const source: CodexImportedMessageSource = 'event_msg'
        const eventType = asString(payload.type)
        if (eventType === 'user_message') {
            const text = asString(payload.message) ?? asString(payload.text) ?? asString(payload.content)
            return text ? { source, message: buildImportedUserMessage(text) } : null
        }
        if (eventType === 'agent_message') {
            const message = asString(payload.message)
            return message ? { source, message: buildImportedAgentMessage({ type: 'message', message, id: randomUUID() }) } : null
        }
        if (eventType === 'token_count') {
            const info = asRecord(payload.info)
            return info ? { source, message: buildImportedAgentMessage({ type: 'token_count', info, id: randomUUID() }) } : null
        }
        return null
    }
    if (type !== 'response_item') return null
    const source: CodexImportedMessageSource = 'response_item'
    const itemType = asString(payload.type)
    if (itemType === 'message') {
        const role = asString(payload.role)
        const text = extractCodexText(payload.content)
        if (!text) return null
        if (role === 'user') {
            return shouldIgnoreInjectedResponseUserMessage(text) ? null : { source, message: buildImportedUserMessage(text) }
        }
        if (role === 'assistant') {
            return { source, message: buildImportedAgentMessage({ type: 'message', message: text, id: randomUUID() }) }
        }
    }
    if (itemType === 'function_call') {
        const name = asString(payload.name)
        const callId = extractCodexToolCallId(payload)
        return name && callId ? { source, message: buildImportedAgentMessage({ type: 'tool-call', name, callId, input: parseCodexFunctionArguments(payload.arguments), id: randomUUID() }) } : null
    }
    if (itemType === 'function_call_output') {
        const callId = extractCodexToolCallId(payload)
        return callId ? { source, message: buildImportedAgentMessage({ type: 'tool-call-result', callId, output: payload.output, id: randomUUID() }) } : null
    }
    return null
}

function parseCodexRecords(lines: string[]): Record<string, unknown>[] {
    const records: Record<string, unknown>[] = []
    for (const line of lines) {
        try {
            const record = asRecord(JSON.parse(line))
            if (record) records.push(record)
        } catch { continue }
    }
    return records
}

function findCodexRolloutFile(rolloutId: string): string | null {
    const files: string[] = []
    for (const root of [join(getCodexHome(), 'sessions'), join(getCodexHome(), 'archived_sessions')]) {
        collectJsonlFiles(root, files, /\.jsonl(\.zst)?$/i)
    }
    return files.find((file) => basename(file).replace(/\.jsonl(\.zst)?$/i, '').endsWith(rolloutId)) ?? null
}

function readCodexRolloutLines(filePath: string, endByteOffset: number | undefined): string[] {
    const raw = readFileSync(filePath)
    const decoded = filePath.toLowerCase().endsWith('.zst') ? zstdDecompressSync(raw) : raw
    if (endByteOffset !== undefined && endByteOffset > decoded.length) {
        throw new Error('Codex fork history is incomplete: parent rollout ends before the saved byte boundary')
    }
    return decoded.subarray(0, endByteOffset).toString('utf-8').split(/\r?\n/).filter(Boolean)
}

// Paginated Codex forks persist only their own records; inherited history stays in the
// history_base rollout, bounded by its saved byte position and exclusive ordinal.
function resolveCodexForkRecords(records: Record<string, unknown>[], seen = new Set<string>()): Record<string, unknown>[] {
    const meta = records[0]?.type === 'session_meta' ? asRecord(records[0].payload) : null
    if (meta?.history_base == null) return records
    const base = asRecord(meta.history_base)
    const rolloutId = asString(base?.thread_id)
    const end = base?.end_ordinal_exclusive
    const endByteOffset = base?.end_byte_offset
    if (!rolloutId || typeof end !== 'number' || !Number.isSafeInteger(end) || end <= 0
        || (endByteOffset !== undefined && (typeof endByteOffset !== 'number' || !Number.isSafeInteger(endByteOffset) || endByteOffset <= 0))) {
        throw new Error('Codex fork history is incomplete: invalid history_base')
    }
    if (seen.has(rolloutId)) {
        throw new Error(`Codex fork history is incomplete: cycle at rollout ${rolloutId}`)
    }
    seen.add(rolloutId)
    const parentFile = findCodexRolloutFile(rolloutId)
    if (!parentFile) throw new Error(`Codex fork history is incomplete: parent rollout ${rolloutId} not found`)
    const parentRecords = parseCodexRecords(readCodexRolloutLines(parentFile, endByteOffset))
    const parentMeta = parentRecords[0]?.type === 'session_meta' ? asRecord(parentRecords[0].payload) : null
    if (parentMeta?.id !== rolloutId) {
        throw new Error(`Codex fork history is incomplete: parent rollout ${rolloutId} has invalid session metadata`)
    }
    const inherited = resolveCodexForkRecords(parentRecords, seen)
        .filter((record) => typeof record.ordinal === 'number' && record.ordinal < end)
    // Ordinals are contiguous across the lineage, so a complete prefix is exactly 0..end-1.
    if (inherited.length !== end || inherited.some((record, index) => record.ordinal !== index)) {
        throw new Error(`Codex fork history is incomplete: parent rollout ${rolloutId} is missing records before the fork point`)
    }
    return [...inherited, ...records]
}

function parseCodexLocalSession(
    filePath: string,
    includeMessages: boolean,
    sessionIndexTitles = new Map<string, CodexSessionIndexTitle>()
): LocalCodexSessionWithMessages | LocalCodexSessionSummary | null {
    let content: string
    try { content = readFileSync(filePath, 'utf-8') } catch { return null }
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
                    if (text && !shouldIgnoreInjectedResponseUserMessage(text)) firstUserMessage = text
                }
            }
        } catch { continue }
    }

    sessionId = sessionId ?? inferSessionIdFromFileName(filePath)
    if (!sessionId) return null
    const sessionIndexTitle = sessionIndexTitles.get(sessionId)?.threadName ?? null
    const changedTitle = getLatestCodexChangedTitle(lines)
    const lastUserMessage = getLatestCodexUserMessage(lines)
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
    if (!includeMessages) return summary

    let records: Record<string, unknown>[]
    try {
        records = resolveCodexForkRecords(parseCodexRecords(lines))
    } catch (error) {
        return { ...summary, loadError: error instanceof Error ? error.message : String(error) }
    }
    const entries: CodexImportedMessageEntry[] = []
    for (const record of records) {
        const entry = convertCodexRecordToImportedMessage(record)
        if (entry) entries.push(entry)
    }
    return { ...summary, messages: deduplicateCodexTranscriptMessages(entries) }
}

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
    return listLocalCodexSessions(true, limit).filter((session): session is LocalCodexSessionWithMessages => 'messages' in session)
}

export function listLocalCodexSessionsWithMessagesByIds(ids: Set<string>): Array<LocalCodexSessionWithMessages | LocalCodexSessionSummary> {
    if (ids.size === 0) return []
    const sessionIndexTitles = readCodexSessionIndexTitles()
    const files: string[] = []
    for (const root of getCodexSessionRoots()) collectJsonlFiles(root, files)
    const candidates = new Map<string, Array<{ file: string; modifiedAt: number }>>()
    for (const file of files) {
        let fd: number | undefined
        let identity: string | null = null
        let rejected = false
        try {
            // 先读取有限的元数据，再完整加载被选中的会话记录。
            fd = openSync(file, 'r')
            const buffer = Buffer.alloc(1024 * 1024)
            const size = readSync(fd, buffer, 0, buffer.length, 0)
            const prefix = buffer.subarray(0, size).toString('utf8')
            const lines = prefix.split(/\r?\n/)
            if (size === buffer.length && !prefix.endsWith('\n')) lines.pop()
            for (const line of lines.filter(Boolean).slice(0, 200)) {
                try {
                    const record = asRecord(JSON.parse(line))
                    if (record?.type !== 'session_meta') continue
                    const payload = asRecord(record.payload)
                    if (isCodexSubagentSource(payload?.source)) { rejected = true; break }
                    if (!identity && typeof payload?.id === 'string') identity = payload.id
                } catch { continue }
            }
            if (!identity && !rejected) {
                // 对异常或过大的文件头保留原有解析行为。
                const fallback = parseCodexLocalSession(file, false, sessionIndexTitles)
                identity = fallback?.id ?? null
            }
            if (!identity || rejected || !ids.has(identity)) continue
            const entries = candidates.get(identity) ?? []
            entries.push({ file, modifiedAt: statSync(file).mtimeMs })
            candidates.set(identity, entries)
        } catch { continue }
        finally { if (fd !== undefined) closeSync(fd) }
    }
    const result: Array<LocalCodexSessionWithMessages | LocalCodexSessionSummary> = []
    for (const [id, entries] of candidates) {
        entries.sort((a, b) => b.modifiedAt - a.modifiedAt)
        for (const entry of entries) {
            const session = parseCodexLocalSession(entry.file, true, sessionIndexTitles)
            if (session && session.id === id) { result.push(session); break }
        }
    }
    return result.sort((a, b) => b.modifiedAt - a.modifiedAt)
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
