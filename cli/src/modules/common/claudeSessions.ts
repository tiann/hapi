import { createReadStream, type Dirent } from 'node:fs'
import { open, readdir, stat, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type {
    ClaudeImportedMessage,
    ClaudeImportedMessageContent,
    ClaudeLocalSessionMessagesPage,
    ClaudeLocalSessionSummary
} from '@hapi/protocol/apiTypes'
import {
    CLAUDE_IMPORTED_USER_TRUNCATION_MARKER,
    isClaudeChatVisibleMessage,
    normalizeClaudeImportedUserText,
    truncateOversizedAgentMessageContent
} from '@hapi/protocol/messages'
import { RawJSONLinesSchema, type RawJSONLines } from '@/claude/types'
import { extractRawUserTextContent, isExternalUserMessage } from '@/claude/utils/transcriptMessages'

const DEFAULT_CLAUDE_SESSION_SCAN_LIMIT = 200
const CLAUDE_TRANSCRIPT_INDEX_CACHE_LIMIT = 16
const OVERSIZED_AGENT_MESSAGE = '[hapi: oversized imported Claude message omitted]'

type SessionFileCandidate = {
    file: string
    modifiedAt: number
    size: number
    discoveryIndex: number
}

type ClaudeTranscriptRecord = {
    uuid: string | null
    parentUuid: string | null
    relatedMessageId: string | null
    systemSubtype: string | null
    isSidechain: boolean
    parentToolUseId: string | null
    importableConversation: boolean
    messageKind: 'user' | 'agent' | null
    userPreview: string | null
    assistantModel: string | null
    assistantToolUseIds: string[]
    offset: number
    length: number
}

type ClaudeTranscriptLocation = {
    uuid: string
    offset: number
    length: number
}

type ClaudeTranscriptIndex = {
    summary: ClaudeLocalSessionSummary
    messageLocations: ClaudeTranscriptLocation[]
    modifiedAt: number
    size: number
}

type ClaudeTranscriptIndexCacheEntry = {
    file: string
    modifiedAt: number
    size: number
    index: Promise<ClaudeTranscriptIndex | null>
}

const transcriptIndexCache = new Map<string, ClaudeTranscriptIndexCacheEntry>()

function truncateText(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

function parseTimestamp(value: string | undefined, fallback: number): number {
    if (!value) return fallback
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : fallback
}

export function getClaudeProjectsRoot(): string {
    const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
    return join(configDir, 'projects')
}

async function collectClaudeSessionFiles(): Promise<SessionFileCandidate[]> {
    let projectEntries: Dirent[]
    try {
        projectEntries = await readdir(getClaudeProjectsRoot(), { withFileTypes: true })
    } catch {
        return []
    }

    const files: string[] = []
    for (const projectEntry of projectEntries) {
        if (!projectEntry.isDirectory()) continue
        const projectDir = join(getClaudeProjectsRoot(), projectEntry.name)
        let sessionEntries: Dirent[]
        try {
            sessionEntries = await readdir(projectDir, { withFileTypes: true })
        } catch {
            continue
        }
        for (const sessionEntry of sessionEntries) {
            if (sessionEntry.isFile() && sessionEntry.name.toLowerCase().endsWith('.jsonl')) {
                files.push(join(projectDir, sessionEntry.name))
            }
        }
    }

    const candidates = await Promise.all(files.map(async (file, discoveryIndex): Promise<SessionFileCandidate | null> => {
        try {
            const fileStat = await stat(file)
            return { file, modifiedAt: fileStat.mtimeMs, size: fileStat.size, discoveryIndex }
        } catch {
            return null
        }
    }))
    return candidates
        .filter((candidate): candidate is SessionFileCandidate => candidate !== null)
        .sort((a, b) => b.modifiedAt - a.modifiedAt || a.discoveryIndex - b.discoveryIndex)
}

type JsonLine = {
    text: string
    offset: number
    length: number
}

async function* streamJsonLines(filePath: string): AsyncGenerator<JsonLine> {
    const fragments: Buffer[] = []
    let fragmentBytes = 0
    let lineOffset = 0
    let fileOffset = 0

    const takeLine = (): JsonLine => {
        const buffer = fragments.length === 1
            ? fragments[0]!
            : Buffer.concat(fragments, fragmentBytes)
        const length = buffer.at(-1) === 0x0d ? buffer.length - 1 : buffer.length
        const result = {
            text: buffer.toString('utf8', 0, length),
            offset: lineOffset,
            length
        }
        fragments.length = 0
        fragmentBytes = 0
        return result
    }

    for await (const rawChunk of createReadStream(filePath)) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
        let cursor = 0
        while (cursor < chunk.length) {
            const newline = chunk.indexOf(0x0a, cursor)
            const end = newline === -1 ? chunk.length : newline
            const fragment = chunk.subarray(cursor, end)
            if (fragment.length > 0) {
                fragments.push(fragment)
                fragmentBytes += fragment.length
            }
            if (newline === -1) break
            yield takeLine()
            cursor = newline + 1
            lineOffset = fileOffset + cursor
        }
        fileOffset += chunk.length
    }

    if (fragmentBytes > 0) yield takeLine()
}

function importedUser(text: string): ClaudeImportedMessageContent {
    return {
        role: 'user',
        content: { type: 'text', text: normalizeClaudeImportedUserText(text) },
        meta: { sentFrom: 'cli' }
    }
}

function importedAgent(data: RawJSONLines): ClaudeImportedMessageContent {
    return {
        role: 'agent',
        content: { type: 'output', data },
        meta: { sentFrom: 'cli' }
    }
}

function isImportableConversationRecord(record: ClaudeTranscriptRecord): boolean {
    return record.importableConversation
}

function canAnchorClaudeBranch(record: ClaudeTranscriptRecord): boolean {
    return record.messageKind === 'user' || record.parentUuid !== null
}

function activeClaudeRecordIds(records: ClaudeTranscriptRecord[]): Set<string> | null {
    const topology = new Map<string, ClaudeTranscriptRecord>()
    for (const record of records) {
        if (record.uuid) topology.set(record.uuid, record)
    }
    let leaf: ClaudeTranscriptRecord | null = null
    for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index]!
        if (
            !record.isSidechain &&
            isImportableConversationRecord(record) &&
            canAnchorClaudeBranch(record)
        ) {
            leaf = record
            break
        }
    }
    if (!leaf?.uuid) return null

    const activeMainIds = new Set<string>()
    const visited = new Set<string>()
    let currentUuid: string | null = leaf.uuid
    let followedKnownParent = false
    while (currentUuid && !visited.has(currentUuid)) {
        visited.add(currentUuid)
        activeMainIds.add(currentUuid)
        const current = topology.get(currentUuid)
        const parentUuid = current?.parentUuid ?? null
        if (parentUuid && topology.has(parentUuid)) followedKnownParent = true
        currentUuid = parentUuid
    }
    if (!followedKnownParent) return null

    const activeToolUseIds = new Set<string>()
    for (const record of records) {
        if (!record.uuid || !activeMainIds.has(record.uuid)) continue
        for (const toolUseId of record.assistantToolUseIds) activeToolUseIds.add(toolUseId)
    }

    const activeIds = new Set(activeMainIds)
    for (const record of records) {
        if (!record.uuid || !record.isSidechain || !isImportableConversationRecord(record)) continue
        const sidechainVisited = new Set<string>()
        let sidechainUuid: string | null = record.uuid
        while (sidechainUuid && !sidechainVisited.has(sidechainUuid)) {
            if (activeMainIds.has(sidechainUuid)) {
                activeIds.add(record.uuid)
                break
            }
            sidechainVisited.add(sidechainUuid)
            const current = topology.get(sidechainUuid)
            if (current && !current.isSidechain) break
            if (current?.parentToolUseId && activeToolUseIds.has(current.parentToolUseId)) {
                activeIds.add(record.uuid)
                break
            }
            sidechainUuid = current?.parentUuid ?? null
        }
    }
    for (const record of records) {
        if (
            record.uuid &&
            (
                (record.relatedMessageId && activeMainIds.has(record.relatedMessageId)) ||
                record.systemSubtype === 'away_summary'
            )
        ) {
            activeIds.add(record.uuid)
        }
    }
    return activeIds
}

function assistantToolUseIds(event: RawJSONLines): string[] {
    if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) return []
    const ids: string[] = []
    for (const block of event.message.content) {
        if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
        const toolUse = block as Record<string, unknown>
        if (toolUse.type === 'tool_use' && typeof toolUse.id === 'string') ids.push(toolUse.id)
    }
    return ids
}

async function indexClaudeTranscript(candidate: SessionFileCandidate): Promise<ClaudeTranscriptIndex | null> {
    const sessionId = basename(candidate.file, '.jsonl')
    if (!sessionId) return null

    let cwd: string | null = null
    let customTitle: string | null = null
    let aiTitle: string | null = null
    let summaryText: string | null = null
    const records: ClaudeTranscriptRecord[] = []

    for await (const line of streamJsonLines(candidate.file)) {
        if (!line.text.trim()) continue
        let raw: unknown
        try {
            raw = JSON.parse(line.text)
        } catch {
            continue
        }
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
        const rawRecord = raw as Record<string, unknown>
        const uuid = typeof rawRecord.uuid === 'string' ? rawRecord.uuid : null
        const parentUuid = typeof rawRecord.parentUuid === 'string' ? rawRecord.parentUuid : null
        const isSidechain = rawRecord.isSidechain === true
        const parentToolUseId = typeof rawRecord.parentToolUseId === 'string' ? rawRecord.parentToolUseId : null
        const parsed = RawJSONLinesSchema.safeParse(raw)
        let importableConversation = false
        let messageKind: ClaudeTranscriptRecord['messageKind'] = null
        let userPreview: string | null = null
        let assistantModel: string | null = null
        let toolUseIds: string[] = []
        let relatedMessageId: string | null = null
        let systemSubtype: string | null = null

        if (rawRecord.type === 'custom-title' && typeof rawRecord.customTitle === 'string') {
            customTitle = rawRecord.customTitle.trim() || customTitle
        } else if (parsed.success) {
            const event = parsed.data
            cwd ??= event.cwd?.trim() || null
            if (event.type === 'ai-title') {
                aiTitle = event.aiTitle.trim() || aiTitle
            } else if (event.type === 'summary') {
                summaryText = event.summary.trim() || summaryText
            }

            importableConversation = Boolean(
                uuid &&
                !event.isMeta &&
                !event.isCompactSummary &&
                isClaudeChatVisibleMessage(event)
            )
            if (event.type === 'assistant') {
                assistantModel = event.message?.model?.trim() || null
                toolUseIds = assistantToolUseIds(event)
            } else if (event.type === 'system') {
                relatedMessageId = event.messageId ?? null
                systemSubtype = event.subtype ?? null
            }
            if (importableConversation) {
                if (isExternalUserMessage(event)) {
                    const text = extractRawUserTextContent(event.message.content)?.trim()
                    if (text) {
                        messageKind = 'user'
                        userPreview = truncateText(text, 140)
                    }
                } else {
                    messageKind = 'agent'
                }
            }
        }

        records.push({
            uuid,
            parentUuid,
            relatedMessageId,
            systemSubtype,
            isSidechain,
            parentToolUseId,
            importableConversation,
            messageKind,
            userPreview,
            assistantModel,
            assistantToolUseIds: toolUseIds,
            offset: line.offset,
            length: line.length
        })
    }

    const finalStat = await stat(candidate.file)
    if (finalStat.mtimeMs !== candidate.modifiedAt || finalStat.size !== candidate.size) {
        throw new Error('Claude transcript changed while paging')
    }

    const activeRecordIds = activeClaudeRecordIds(records)
    const messageLocations: ClaudeTranscriptLocation[] = []
    let firstUserMessage: string | null = null
    let lastUserMessage: string | null = null
    let model: string | null = null
    for (const record of records) {
        if (!record.uuid || !record.messageKind) continue
        if (activeRecordIds && !activeRecordIds.has(record.uuid)) continue
        messageLocations.push({ uuid: record.uuid, offset: record.offset, length: record.length })
        if (record.messageKind === 'user' && record.userPreview) {
            firstUserMessage ??= record.userPreview
            lastUserMessage = record.userPreview
        }
        if (record.assistantModel) model = record.assistantModel
    }

    if (!cwd || messageLocations.length === 0) return null
    const displayTitle =
        customTitle ?? aiTitle ?? (firstUserMessage ? truncateText(firstUserMessage, 80) : null) ?? summaryText ?? basename(cwd) ?? sessionId.slice(0, 8)

    return {
        summary: {
            id: sessionId,
            title: displayTitle,
            lastUserMessage,
            cwd,
            file: candidate.file,
            modifiedAt: candidate.modifiedAt,
            model,
            messageCount: messageLocations.length
        },
        messageLocations,
        modifiedAt: candidate.modifiedAt,
        size: candidate.size
    }
}

async function getTranscriptIndex(
    candidate: SessionFileCandidate,
    cacheOnMiss = true
): Promise<ClaudeTranscriptIndex | null> {
    const cached = transcriptIndexCache.get(candidate.file)
    if (
        cached &&
        cached.modifiedAt === candidate.modifiedAt &&
        cached.size === candidate.size
    ) {
        transcriptIndexCache.delete(candidate.file)
        transcriptIndexCache.set(candidate.file, cached)
        return await cached.index
    }
    if (cached) transcriptIndexCache.delete(candidate.file)
    if (!cacheOnMiss) return await indexClaudeTranscript(candidate)

    const entry: ClaudeTranscriptIndexCacheEntry = {
        file: candidate.file,
        modifiedAt: candidate.modifiedAt,
        size: candidate.size,
        index: indexClaudeTranscript(candidate)
    }
    transcriptIndexCache.set(candidate.file, entry)
    while (transcriptIndexCache.size > CLAUDE_TRANSCRIPT_INDEX_CACHE_LIMIT) {
        const oldestKey = transcriptIndexCache.keys().next().value
        if (typeof oldestKey !== 'string') break
        transcriptIndexCache.delete(oldestKey)
    }
    try {
        return await entry.index
    } catch (error) {
        if (transcriptIndexCache.get(candidate.file) === entry) {
            transcriptIndexCache.delete(candidate.file)
        }
        throw error
    }
}

export async function listLocalClaudeSessionSummaries(
    limit = DEFAULT_CLAUDE_SESSION_SCAN_LIMIT
): Promise<ClaudeLocalSessionSummary[]> {
    if (limit <= 0) return []
    const summaries: ClaudeLocalSessionSummary[] = []
    const seenIds = new Set<string>()
    let candidateIndex = 0
    for (const candidate of await collectClaudeSessionFiles()) {
        const sessionId = basename(candidate.file, '.jsonl')
        if (!sessionId || seenIds.has(sessionId)) continue
        let index: ClaudeTranscriptIndex | null
        try {
            index = await getTranscriptIndex(
                candidate,
                candidateIndex < CLAUDE_TRANSCRIPT_INDEX_CACHE_LIMIT
            )
        } catch {
            candidateIndex += 1
            continue
        }
        candidateIndex += 1
        if (!index) continue
        seenIds.add(sessionId)
        summaries.push(index.summary)
        if (summaries.length >= limit) break
    }
    return summaries
}

function serializedBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function normalizeImportedMessageForTransport(message: ClaudeImportedMessage): ClaudeImportedMessage {
    const content = truncateOversizedAgentMessageContent(message.content) as ClaudeImportedMessageContent
    return content === message.content ? message : { ...message, content }
}

function fitUserMessage(message: ClaudeImportedMessage, maxBytes: number): ClaudeImportedMessage | null {
    if (message.content.role !== 'user') return null
    const original = message.content.content.text
    const empty = {
        ...message,
        content: { ...message.content, content: { ...message.content.content, text: '' } }
    }
    const available = maxBytes - serializedBytes(empty)
    if (available <= 0) return null

    let low = 0
    let high = original.length
    let best = ''
    while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const candidate = middle < original.length
            ? `${original.slice(0, middle)}${CLAUDE_IMPORTED_USER_TRUNCATION_MARKER}`
            : original
        if (Buffer.byteLength(candidate, 'utf8') <= available) {
            best = candidate
            low = middle + 1
        } else {
            high = middle - 1
        }
    }
    if (!best) return null
    return {
        ...message,
        content: { ...message.content, content: { ...message.content.content, text: best } }
    }
}

function compactAgentMessage(message: ClaudeImportedMessage): ClaudeImportedMessage | null {
    if (message.content.role !== 'agent') return null
    const data = message.content.content.data
    const source = data !== null && typeof data === 'object' && !Array.isArray(data)
        ? data as Record<string, unknown>
        : {}
    return {
        ...message,
        content: {
            ...message.content,
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    ...(typeof source.uuid === 'string' ? { uuid: source.uuid } : {}),
                    ...(typeof source.sessionId === 'string' ? { sessionId: source.sessionId } : {}),
                    ...(typeof source.timestamp === 'string' ? { timestamp: source.timestamp } : {}),
                    message: { role: 'assistant', content: [{ type: 'text', text: OVERSIZED_AGENT_MESSAGE }] }
                }
            }
        }
    }
}

function fitMessageOnEmptyPage(message: ClaudeImportedMessage, maxBytes: number): ClaudeImportedMessage | null {
    const fitted = message.content.role === 'user'
        ? fitUserMessage(message, maxBytes)
        : compactAgentMessage(message)
    return fitted && serializedBytes(fitted) <= maxBytes ? fitted : null
}

async function readAt(file: FileHandle, offset: number, length: number): Promise<string> {
    const buffer = Buffer.allocUnsafe(length)
    let bytesRead = 0
    while (bytesRead < length) {
        const result = await file.read(buffer, bytesRead, length - bytesRead, offset + bytesRead)
        if (result.bytesRead === 0) throw new Error('Claude transcript changed while paging')
        bytesRead += result.bytesRead
    }
    return buffer.toString('utf8')
}

async function readImportedMessage(
    file: FileHandle,
    location: ClaudeTranscriptLocation,
    sessionId: string,
    modifiedAt: number
): Promise<ClaudeImportedMessage> {
    let raw: unknown
    try {
        raw = JSON.parse(await readAt(file, location.offset, location.length))
    } catch {
        throw new Error('Claude transcript changed while paging')
    }
    const parsed = RawJSONLinesSchema.safeParse(raw)
    if (!parsed.success || parsed.data.uuid !== location.uuid) {
        throw new Error('Claude transcript changed while paging')
    }
    const event = parsed.data
    const createdAt = parseTimestamp(event.timestamp, modifiedAt)
    if (isExternalUserMessage(event)) {
        const text = extractRawUserTextContent(event.message.content)
        if (text === null || text.trim().length === 0) {
            throw new Error('Claude transcript changed while paging')
        }
        return {
            localId: `claude:${sessionId}:${location.uuid}`,
            createdAt,
            content: importedUser(text)
        }
    }
    return {
        localId: `claude:${sessionId}:${location.uuid}`,
        createdAt,
        content: importedAgent(event)
    }
}

export async function listLocalClaudeSessionMessagesPageById(
    sessionId: string,
    cursor: number,
    maxBytes: number
): Promise<ClaudeLocalSessionMessagesPage | null> {
    const candidate = (await collectClaudeSessionFiles())
        .find((entry) => basename(entry.file, '.jsonl') === sessionId)
    if (!candidate) return null
    const index = await getTranscriptIndex(candidate)
    if (!index) return null
    if (cursor > index.messageLocations.length) throw new Error('Claude transcript changed while paging')

    const responseWithCursor = (nextCursor: number | null) => ({
        success: true,
        mode: 'messages',
        page: { session: index.summary, messages: [], nextCursor }
    })
    const baseBytes = Math.max(
        serializedBytes(responseWithCursor(index.messageLocations.length)),
        serializedBytes(responseWithCursor(null))
    )
    if (baseBytes >= maxBytes) throw new Error('Claude transcript metadata exceeds the page budget')

    const messages: ClaudeImportedMessage[] = []
    let pageBytes = baseBytes
    let nextIndex = cursor
    const file = await open(candidate.file, 'r')
    try {
        while (nextIndex < index.messageLocations.length) {
            const imported = await readImportedMessage(
                file,
                index.messageLocations[nextIndex]!,
                sessionId,
                index.modifiedAt
            )
            const normalized = normalizeImportedMessageForTransport(imported)
            const separatorBytes = messages.length > 0 ? 1 : 0
            const messageBytes = serializedBytes(normalized)
            if (pageBytes + separatorBytes + messageBytes <= maxBytes) {
                messages.push(normalized)
                pageBytes += separatorBytes + messageBytes
                nextIndex += 1
                continue
            }
            if (messages.length > 0) break

            const fitted = fitMessageOnEmptyPage(normalized, maxBytes - baseBytes)
            if (!fitted) throw new Error('Claude transcript message exceeds the page budget')
            messages.push(fitted)
            nextIndex += 1
            break
        }

        const finalStat = await file.stat()
        if (finalStat.mtimeMs !== index.modifiedAt || finalStat.size !== index.size) {
            throw new Error('Claude transcript changed while paging')
        }
    } finally {
        await file.close()
    }

    return {
        session: index.summary,
        messages,
        nextCursor: nextIndex < index.messageLocations.length ? nextIndex : null
    }
}
