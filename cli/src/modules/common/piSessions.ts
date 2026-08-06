import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { INCLUSIVE_INPUT_TOKEN_USAGE_MARKER } from '@hapi/protocol/usage'
import type {
    PiImportedMessage,
    PiImportedMessageContent,
    PiLocalSessionSummary,
    PiLocalSessionWithMessages
} from '@hapi/protocol/apiTypes'

const DEFAULT_PI_SESSION_SCAN_LIMIT = 200

type JsonRecord = Record<string, unknown>

type ParsedPiSession = {
    summary: PiLocalSessionSummary
    messages: PiImportedMessage[]
    activeEntryIds: string[]
}

type PiSessionFileCandidate = {
    file: string
    modifiedAt: number
    discoveryIndex: number
}

type PiSessionHeader = {
    id: string
    cwd: string | null
}

function asRecord(value: unknown): JsonRecord | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : null
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function truncateText(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

function parseTimestamp(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value < 1_000_000_000_000 ? value * 1000 : value
    }
    if (typeof value === 'string') {
        const parsed = Date.parse(value)
        if (Number.isFinite(parsed)) return parsed
    }
    return fallback
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

function collectSortedPiSessionFiles(): PiSessionFileCandidate[] {
    const files: string[] = []
    collectJsonlFiles(getPiSessionsRoot(), files)
    return files.flatMap((file, discoveryIndex) => {
        try {
            return [{ file, modifiedAt: statSync(file).mtimeMs, discoveryIndex }]
        } catch {
            return []
        }
    }).sort((a, b) => b.modifiedAt - a.modifiedAt || a.discoveryIndex - b.discoveryIndex)
}

function readPiSessionHeader(filePath: string): PiSessionHeader | null {
    const buffer = Buffer.alloc(64 * 1024)
    let fd: number | null = null
    try {
        fd = openSync(filePath, 'r')
        const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
        const prefix = buffer.toString('utf-8', 0, bytesRead)
        for (const line of prefix.split(/\r?\n/)) {
            if (!line.trim()) continue
            try {
                const record = asRecord(JSON.parse(line))
                if (record?.type !== 'session') continue
                const id = asString(record.id)
                if (id) return { id, cwd: asString(record.cwd) }
            } catch {
                continue
            }
        }
    } catch {
        return null
    } finally {
        if (fd !== null) closeSync(fd)
    }
    return null
}

export function getPiSessionsRoot(): string {
    const direct = process.env.PI_CODING_AGENT_SESSION_DIR?.trim()
    if (direct) return direct
    const agentHome = process.env.PI_CODING_AGENT_DIR?.trim()
    if (agentHome) return join(agentHome, 'sessions')
    return join(homedir(), '.pi', 'agent', 'sessions')
}

function extractText(value: unknown): string {
    if (typeof value === 'string') return value
    if (!Array.isArray(value)) return ''
    return value.map((item) => {
        if (typeof item === 'string') return item
        const block = asRecord(item)
        return block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
    }).filter(Boolean).join('\n')
}

function extractUserText(value: unknown): string {
    if (typeof value === 'string') return value
    if (!Array.isArray(value)) return ''
    return value.map((item) => {
        if (typeof item === 'string') return item
        const block = asRecord(item)
        if (block?.type === 'text' && typeof block.text === 'string') return block.text
        if (block?.type === 'image') {
            const mimeType = asString(block.mimeType) ?? 'image'
            return `[Image attachment: ${mimeType}]`
        }
        return ''
    }).filter(Boolean).join('\n')
}

function importedUser(text: string): PiImportedMessageContent {
    return {
        role: 'user',
        content: { type: 'text', text },
        meta: { sentFrom: 'cli' }
    }
}

function importedAgent(data: unknown): PiImportedMessageContent {
    return {
        role: 'agent',
        content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data },
        meta: { sentFrom: 'cli' }
    }
}

function messageLocalId(sessionId: string, entryId: string, suffix: string): string {
    return `pi:${sessionId}:${entryId}:${suffix}`
}

function pushImportedMessage(
    target: PiImportedMessage[],
    sessionId: string,
    entryId: string,
    parentEntryId: string | null,
    createdAt: number,
    suffix: string,
    content: PiImportedMessageContent
): void {
    target.push({
        localId: messageLocalId(sessionId, entryId, suffix),
        entryId,
        parentEntryId,
        createdAt,
        content
    })
}

function convertMessageRecord(
    record: JsonRecord,
    sessionId: string,
    entryId: string,
    parentEntryId: string | null,
    createdAt: number
): PiImportedMessage[] {
    const message = asRecord(record.message)
    const role = asString(message?.role)
    if (!message || !role) return []
    const result: PiImportedMessage[] = []

    if (role === 'user') {
        const text = extractUserText(message.content).trim()
        if (text) pushImportedMessage(result, sessionId, entryId, parentEntryId, createdAt, 'user', importedUser(text))
        return result
    }

    if (role === 'toolResult') {
        const callId = asString(message.toolCallId) ?? `pi-tool-${entryId}`
        pushImportedMessage(result, sessionId, entryId, parentEntryId, createdAt, 'tool-result', importedAgent({
            type: 'tool-call-result',
            callId,
            output: message.content,
            is_error: message.isError === true
        }))
        return result
    }

    if (role !== 'assistant') return result
    const blocks = Array.isArray(message.content)
        ? message.content
        : typeof message.content === 'string'
            ? [{ type: 'text', text: message.content }]
            : []
    let blockIndex = 0
    for (const rawBlock of blocks) {
        const block = asRecord(rawBlock)
        const type = asString(block?.type)
        if (!block || !type) continue
        const suffix = `${blockIndex++}`
        if (type === 'text') {
            const text = asString(block.text)
            if (text) pushImportedMessage(result, sessionId, entryId, parentEntryId, createdAt, suffix, importedAgent({ type: 'message', message: text, id: messageLocalId(sessionId, entryId, suffix) }))
        } else if (type === 'thinking') {
            const text = asString(block.thinking) ?? asString(block.text)
            if (text) pushImportedMessage(result, sessionId, entryId, parentEntryId, createdAt, suffix, importedAgent({ type: 'reasoning', message: text, id: messageLocalId(sessionId, entryId, suffix) }))
        } else if (type === 'toolCall') {
            const callId = asString(block.id) ?? asString(block.toolCallId) ?? `pi-tool-${entryId}-${suffix}`
            const name = asString(block.name) ?? asString(block.toolName) ?? 'tool'
            pushImportedMessage(result, sessionId, entryId, parentEntryId, createdAt, suffix, importedAgent({
                type: 'tool-call',
                name,
                callId,
                input: block.arguments ?? block.args ?? block.input ?? {},
                status: 'completed'
            }))
        }
    }

    const usage = asRecord(message.usage)
    if (usage) {
        const input = asNumber(usage.input) ?? 0
        const output = asNumber(usage.output) ?? 0
        const cacheRead = asNumber(usage.cacheRead) ?? 0
        const cacheWrite = asNumber(usage.cacheWrite) ?? 0
        const totalTokens = asNumber(usage.totalTokens) ?? input + output + cacheRead + cacheWrite
        pushImportedMessage(result, sessionId, entryId, parentEntryId, createdAt, 'usage', importedAgent({
            type: 'token_count',
            model: asString(message.model),
            ...INCLUSIVE_INPUT_TOKEN_USAGE_MARKER,
            info: {
                total: {
                    inputTokens: input + cacheRead + cacheWrite,
                    outputTokens: output,
                    totalTokens,
                    cachedInputTokens: cacheRead,
                    cacheWriteInputTokens: cacheWrite
                }
            }
        }))
    }
    return result
}

function convertBashRecord(
    record: JsonRecord,
    sessionId: string,
    entryId: string,
    parentEntryId: string | null,
    createdAt: number
): PiImportedMessage[] {
    const callId = `pi-bash-${entryId}`
    const result: PiImportedMessage[] = []
    pushImportedMessage(result, sessionId, entryId, parentEntryId, createdAt, 'bash-call', importedAgent({
        type: 'tool-call',
        name: 'bash',
        callId,
        input: { command: asString(record.command) ?? '' },
        status: 'completed'
    }))
    pushImportedMessage(result, sessionId, entryId, parentEntryId, createdAt, 'bash-result', importedAgent({
        type: 'tool-call-result',
        callId,
        output: record.output ?? '',
        is_error: (asNumber(record.exitCode) ?? 0) !== 0
    }))
    return result
}

function convertVisibleMetadataRecord(
    record: JsonRecord,
    sessionId: string,
    entryId: string,
    parentEntryId: string | null,
    createdAt: number
): PiImportedMessage[] {
    let text: string | null = null
    if (record.type === 'custom_message' && record.display === true) {
        text = extractText(record.content).trim() || null
    } else if (record.type === 'compaction') {
        const summary = asString(record.summary)
        if (summary) text = `[Compaction summary]\n\n${summary}`
    } else if (record.type === 'branch_summary') {
        const summary = asString(record.summary)
        if (summary) text = `[Branch summary]\n\n${summary}`
    }
    if (!text) return []
    const result: PiImportedMessage[] = []
    pushImportedMessage(result, sessionId, entryId, parentEntryId, createdAt, String(record.type), importedAgent({
        type: 'message',
        message: text,
        id: messageLocalId(sessionId, entryId, String(record.type))
    }))
    return result
}

function parsePiLocalSession(filePath: string, knownModifiedAt?: number): ParsedPiSession | null {
    let content: string
    let modifiedAt: number
    try {
        content = readFileSync(filePath, 'utf-8')
        modifiedAt = knownModifiedAt ?? statSync(filePath).mtimeMs
    } catch {
        return null
    }

    const records: JsonRecord[] = []
    for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
            const record = asRecord(JSON.parse(line))
            if (record) records.push(record)
        } catch {
            continue
        }
    }

    const header = records.find((record) => record.type === 'session')
    const sessionId = asString(header?.id)
    if (!sessionId) return null
    const cwd = asString(header?.cwd)

    const nodes = new Map<string, JsonRecord>()
    const orderedNodeIds: string[] = []
    for (const record of records) {
        if (record.type === 'session') continue
        const id = asString(record.id)
        if (!id) continue
        nodes.set(id, record)
        orderedNodeIds.push(id)
    }
    const leafEntryId = orderedNodeIds.at(-1) ?? null
    const activePath = new Set<string>()
    let cursor = leafEntryId
    while (cursor && !activePath.has(cursor)) {
        activePath.add(cursor)
        cursor = asString(nodes.get(cursor)?.parentId)
    }

    let title: string | null = null
    let model: string | null = null
    let thinkingLevel: string | null = null

    const messages: PiImportedMessage[] = []
    let firstUserMessage: string | null = null
    let lastUserMessage: string | null = null
    for (const id of orderedNodeIds) {
        if (!activePath.has(id)) continue
        const record = nodes.get(id)
        if (!record) continue
        if (record.type === 'session_info') title = asString(record.name) ?? title
        if (record.type === 'model_change') model = asString(record.modelId) ?? model
        if (record.type === 'thinking_level_change') thinkingLevel = asString(record.thinkingLevel) ?? thinkingLevel
        const parentEntryId = asString(record.parentId)
        const nestedMessage = asRecord(record.message)
        const createdAt = parseTimestamp(nestedMessage?.timestamp ?? record.timestamp, modifiedAt)
        const converted = record.type === 'message'
            ? convertMessageRecord(record, sessionId, id, parentEntryId, createdAt)
            : record.type === 'bashExecution'
                ? convertBashRecord(record, sessionId, id, parentEntryId, createdAt)
                : convertVisibleMetadataRecord(record, sessionId, id, parentEntryId, createdAt)
        for (const message of converted) {
            if (message.content.role === 'user') {
                const text = message.content.content.text
                firstUserMessage ??= text
                lastUserMessage = text
            }
            messages.push(message)
        }
        if (record.type === 'message' && nestedMessage?.role === 'assistant') {
            model = asString(nestedMessage.model) ?? model
        }
    }

    const displayTitle = title
        ?? (firstUserMessage ? truncateText(firstUserMessage, 80) : null)
        ?? (cwd ? basename(cwd) || cwd : null)
        ?? sessionId.slice(0, 8)
    return {
        summary: {
            id: sessionId,
            title: displayTitle,
            lastUserMessage: lastUserMessage ? truncateText(lastUserMessage, 140) : null,
            cwd,
            file: filePath,
            modifiedAt,
            model,
            thinkingLevel,
            leafEntryId,
            messageCount: messages.length
        },
        messages,
        activeEntryIds: orderedNodeIds.filter((id) => activePath.has(id))
    }
}

export function listLocalPiSessionSummaries(limit = DEFAULT_PI_SESSION_SCAN_LIMIT): PiLocalSessionSummary[] {
    if (limit <= 0) return []
    const seenIds = new Set<string>()
    const summaries: PiLocalSessionSummary[] = []
    for (const candidate of collectSortedPiSessionFiles()) {
        const header = readPiSessionHeader(candidate.file)
        if (!header || seenIds.has(header.id)) continue
        const parsed = parsePiLocalSession(candidate.file, candidate.modifiedAt)
        if (!parsed) continue
        seenIds.add(header.id)
        summaries.push(parsed.summary)
        if (summaries.length >= limit) break
    }
    return summaries
}

export function listLocalPiSessionsWithMessagesByIds(ids: Set<string>): PiLocalSessionWithMessages[] {
    if (ids.size === 0) return []
    const unresolved = new Set(ids)
    const sessions: PiLocalSessionWithMessages[] = []
    for (const candidate of collectSortedPiSessionFiles()) {
        const header = readPiSessionHeader(candidate.file)
        if (!header || !unresolved.has(header.id)) continue
        const parsed = parsePiLocalSession(candidate.file, candidate.modifiedAt)
        if (!parsed) continue
        unresolved.delete(header.id)
        sessions.push({ ...parsed.summary, messages: parsed.messages, activeEntryIds: parsed.activeEntryIds })
        if (unresolved.size === 0) break
    }
    return sessions
}
