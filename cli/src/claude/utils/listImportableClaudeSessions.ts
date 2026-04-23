import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import type { ImportableClaudeSessionSummary } from '@hapi/protocol/rpcTypes'
import { RawJSONLinesSchema, type RawJSONLines } from '@/claude/types'
import { isClaudeChatVisibleMessage } from './chatVisibility'

export type ListImportableClaudeSessionsOptions = {
    rootDir?: string
}

const SYSTEM_INJECTION_PREFIXES = [
    '<task-notification>',
    '<command-name>',
    '<local-command-caveat>',
    '<system-reminder>'
]

export async function listImportableClaudeSessions(
    opts: ListImportableClaudeSessionsOptions = {}
): Promise<{ sessions: ImportableClaudeSessionSummary[] }> {
    const sessionsRoot = opts.rootDir?.trim() ? opts.rootDir : getClaudeSessionsRoot()
    const transcriptPaths = (await collectJsonlFiles(sessionsRoot)).sort((a, b) => a.localeCompare(b))
    const summaries = (await Promise.all(transcriptPaths.map(async (transcriptPath) => scanClaudeTranscript(transcriptPath))))
        .filter((summary): summary is ImportableClaudeSessionSummary => summary !== null)

    summaries.sort(compareImportableClaudeSessions)

    return { sessions: summaries }
}

async function scanClaudeTranscript(transcriptPath: string): Promise<ImportableClaudeSessionSummary | null> {
    let content: string
    try {
        content = await readFile(transcriptPath, 'utf-8')
    } catch {
        return null
    }

    const lines = content.split(/\r?\n/)
    const records = lines
        .map((line, lineIndex) => ({
            lineIndex,
            record: parseJsonLine(line)
        }))
        .filter((entry): entry is { lineIndex: number; record: Record<string, unknown> } => entry.record !== null)

    const rootSessionId = findRootSessionId(records)
    if (!rootSessionId) {
        return null
    }

    const rootStartIndex = findRootSessionStartIndex(records, rootSessionId)

    let cwd: string | null = null
    let timestamp: number | null = null
    let explicitTitle: string | null = null
    let previewPrompt: string | null = null
    let hasVisibleMessage = false

    for (const entry of records) {
        if (entry.lineIndex < rootStartIndex) {
            continue
        }

        const sessionMeta = extractSessionMeta(entry.record)
        if (cwd === null && sessionMeta.cwd !== null) {
            cwd = sessionMeta.cwd
        }
        if (timestamp === null && sessionMeta.timestamp !== null) {
            timestamp = sessionMeta.timestamp
        }
        if (explicitTitle === null && sessionMeta.explicitTitle !== null) {
            explicitTitle = sessionMeta.explicitTitle
        }

        const rawMessage = parseRawClaudeMessage(entry.record)
        if (!rawMessage) {
            continue
        }

        if (!isClaudeChatVisibleMessage(rawMessage)) {
            continue
        }

        hasVisibleMessage = true
        if (!previewPrompt && isRealClaudeUserMessage(rawMessage)) {
            previewPrompt = extractUserPrompt(rawMessage)
        }
    }

    if (!hasVisibleMessage) {
        return null
    }

    const previewTitle = explicitTitle
        ?? previewPrompt
        ?? deriveCwdPreview(cwd)
        ?? rootSessionId

    return {
        agent: 'claude',
        externalSessionId: rootSessionId,
        cwd,
        timestamp,
        transcriptPath,
        previewTitle,
        previewPrompt
    }
}

function getClaudeSessionsRoot(): string {
    const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    return join(claudeHome, 'projects')
}

async function collectJsonlFiles(root: string): Promise<string[]> {
    try {
        const entries = await readdir(root, { withFileTypes: true })
        const files: string[] = []

        for (const entry of entries) {
            const fullPath = join(root, entry.name)
            if (entry.isDirectory()) {
                files.push(...await collectJsonlFiles(fullPath))
            } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                files.push(fullPath)
            }
        }

        return files
    } catch {
        return []
    }
}

function parseJsonLine(line: string): Record<string, unknown> | null {
    if (line.trim().length === 0) {
        return null
    }

    try {
        const parsed = JSON.parse(line) as unknown
        return getRecord(parsed)
    } catch {
        return null
    }
}

function parseRawClaudeMessage(record: Record<string, unknown>): RawJSONLines | null {
    const parsed = RawJSONLinesSchema.safeParse(record)
    return parsed.success ? parsed.data : null
}

function findRootSessionId(records: Array<{ lineIndex: number; record: Record<string, unknown> }>): string | null {
    for (let index = records.length - 1; index >= 0; index -= 1) {
        const sessionId = extractSessionIdCandidate(records[index].record)
        if (sessionId) {
            return sessionId
        }
    }

    return null
}

function findRootSessionStartIndex(records: Array<{ lineIndex: number; record: Record<string, unknown> }>, rootSessionId: string): number {
    const match = records.find((entry) => extractSessionIdCandidate(entry.record) === rootSessionId)
    return match?.lineIndex ?? 0
}

function extractSessionMeta(record: Record<string, unknown>): {
    cwd: string | null
    timestamp: number | null
    explicitTitle: string | null
} {
    const payload = getRecord(record.payload)

    const cwd = getString(record.cwd)
        ?? getString(payload?.cwd)

    const timestamp = parseTimestamp(record.timestamp) ?? parseTimestamp(payload?.timestamp)

    const explicitTitle = extractExplicitTitleFromRecord(record) ?? extractExplicitTitleFromRecord(payload)

    return {
        cwd,
        timestamp,
        explicitTitle
    }
}

function extractExplicitTitleFromRecord(record: Record<string, unknown> | null): string | null {
    if (!record) {
        return null
    }

    const type = getString(record.type)
    if (type === 'session_title_change') {
        return extractTextValue(record.title ?? record.text)
    }

    const payload = getRecord(record.payload)
    if (payload) {
        const payloadType = getString(payload.type)
        if (payloadType === 'session_title_change') {
            return extractTextValue(payload.title ?? payload.text)
        }
    }

    const topLevelTitle = getString(record.title)
    if (topLevelTitle) {
        return extractTextValue(topLevelTitle)
    }

    const payloadTitle = getString(getRecord(record.payload)?.title)
    if (payloadTitle) {
        return extractTextValue(payloadTitle)
    }

    return null
}

function extractUserPrompt(message: RawJSONLines): string | null {
    if (message.type !== 'user') {
        return null
    }

    return extractUserMessageText(message.message?.content)
}

function isRealClaudeUserMessage(message: RawJSONLines): message is Extract<RawJSONLines, { type: 'user' }> {
    if (message.type !== 'user') {
        return false
    }

    if (message.isSidechain === true || message.isMeta === true || message.isCompactSummary === true) {
        return false
    }

    const prompt = extractUserPrompt(message)
    if (!prompt) {
        return false
    }

    const trimmed = prompt.trimStart()
    for (const prefix of SYSTEM_INJECTION_PREFIXES) {
        if (trimmed.startsWith(prefix)) {
            return false
        }
    }

    return true
}

function extractTextValue(value: unknown): string | null {
    const chunks = extractTextChunks(value)
    if (chunks.length === 0) {
        return null
    }

    return normalizePreviewText(chunks.join(' '))
}

function extractUserMessageText(value: unknown): string | null {
    if (typeof value === 'string') {
        const normalized = normalizePreviewText(value)
        return normalized ? normalized : null
    }

    if (!Array.isArray(value)) {
        return null
    }

    const chunks: string[] = []
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') {
            continue
        }

        const item = entry as Record<string, unknown>
        if (item.type !== 'text') {
            continue
        }

        const text = getString(item.text)
        if (text) {
            chunks.push(normalizePreviewText(text))
        }
    }

    if (chunks.length === 0) {
        return null
    }

    return normalizePreviewText(chunks.join(' '))
}

function extractSessionIdCandidate(record: Record<string, unknown>): string | null {
    const payload = getRecord(record.payload)
    return getString(record.sessionId)
        ?? getString(record.session_id)
        ?? getString(payload?.sessionId)
        ?? getString(payload?.session_id)
        ?? getString(payload?.id)
        ?? getString(record.id)
}

function extractTextChunks(value: unknown): string[] {
    if (typeof value === 'string') {
        const normalized = normalizePreviewText(value)
        return normalized ? [normalized] : []
    }

    if (Array.isArray(value)) {
        const chunks: string[] = []
        for (const entry of value) {
            chunks.push(...extractTextChunks(entry))
        }
        return chunks
    }

    const record = getRecord(value)
    if (!record) {
        return []
    }

    const directKeys = ['title', 'message', 'text', 'content', 'input', 'body'] as const
    for (const key of directKeys) {
        const entryValue = record[key]
        if (entryValue === undefined || entryValue === null) {
            continue
        }

        const chunks = extractTextChunks(entryValue)
        if (chunks.length > 0) {
            return chunks
        }
    }

    return []
}

function deriveCwdPreview(cwd: string | null): string | null {
    if (!cwd) {
        return null
    }

    const trimmed = cwd.trim()
    if (!trimmed) {
        return null
    }

    const segment = basename(trimmed)
    return segment.length > 0 ? normalizePreviewText(segment) : null
}

function compareImportableClaudeSessions(
    left: ImportableClaudeSessionSummary,
    right: ImportableClaudeSessionSummary
): number {
    const leftTimestamp = left.timestamp ?? Number.NEGATIVE_INFINITY
    const rightTimestamp = right.timestamp ?? Number.NEGATIVE_INFINITY

    if (leftTimestamp !== rightTimestamp) {
        return rightTimestamp - leftTimestamp
    }

    return right.transcriptPath.localeCompare(left.transcriptPath)
}

function parseTimestamp(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value
    }

    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Date.parse(value)
        return Number.isNaN(parsed) ? null : parsed
    }

    return null
}

function normalizePreviewText(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
}

function getRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null
    }

    return value as Record<string, unknown>
}

function getString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}
