import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type {
    ClaudeImportedMessage,
    ClaudeImportedMessageContent,
    ClaudeLocalSessionSummary,
    ClaudeLocalSessionWithMessages
} from '@hapi/protocol/apiTypes'
import { isClaudeChatVisibleMessage } from '@hapi/protocol/messages'
import { RawJSONLinesSchema, type RawJSONLines } from '@/claude/types'
import { extractRawUserTextContent, isExternalUserMessage } from '@/claude/utils/transcriptMessages'

const DEFAULT_CLAUDE_SESSION_SCAN_LIMIT = 200

type SessionFileCandidate = {
    file: string
    modifiedAt: number
    discoveryIndex: number
}

type ParsedClaudeSession = {
    summary: ClaudeLocalSessionSummary
    messages: ClaudeImportedMessage[]
}

type ClaudeTranscriptRecord = {
    event: RawJSONLines | null
    uuid: string | null
    parentUuid: string | null
    isSidechain: boolean
    parentToolUseId: string | null
    customTitle: string | null
}

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

function collectClaudeSessionFiles(): SessionFileCandidate[] {
    let projectEntries: import('node:fs').Dirent[]
    try {
        projectEntries = readdirSync(getClaudeProjectsRoot(), {
            withFileTypes: true
        })
    } catch {
        return []
    }

    const files: string[] = []
    for (const projectEntry of projectEntries) {
        if (!projectEntry.isDirectory()) continue
        const projectDir = join(getClaudeProjectsRoot(), projectEntry.name)
        let sessionEntries: import('node:fs').Dirent[]
        try {
            sessionEntries = readdirSync(projectDir, { withFileTypes: true })
        } catch {
            continue
        }
        for (const sessionEntry of sessionEntries) {
            if (sessionEntry.isFile() && sessionEntry.name.toLowerCase().endsWith('.jsonl')) {
                files.push(join(projectDir, sessionEntry.name))
            }
        }
    }

    return files
        .flatMap((file, discoveryIndex) => {
            try {
                return [{ file, modifiedAt: statSync(file).mtimeMs, discoveryIndex }]
            } catch {
                return []
            }
        })
        .sort((a, b) => b.modifiedAt - a.modifiedAt || a.discoveryIndex - b.discoveryIndex)
}

function importedUser(text: string): ClaudeImportedMessageContent {
    return {
        role: 'user',
        content: { type: 'text', text },
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

function parseTranscriptRecords(content: string): ClaudeTranscriptRecord[] {
    const records: ClaudeTranscriptRecord[] = []
    for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue
        let raw: unknown
        try {
            raw = JSON.parse(line)
        } catch {
            continue
        }
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
        const rawRecord = raw as Record<string, unknown>
        const parsed = RawJSONLinesSchema.safeParse(raw)
        records.push({
            event: parsed.success ? parsed.data : null,
            uuid: typeof rawRecord.uuid === 'string' ? rawRecord.uuid : null,
            parentUuid: typeof rawRecord.parentUuid === 'string' ? rawRecord.parentUuid : null,
            isSidechain: rawRecord.isSidechain === true,
            parentToolUseId: typeof rawRecord.parentToolUseId === 'string' ? rawRecord.parentToolUseId : null,
            customTitle: rawRecord.type === 'custom-title' && typeof rawRecord.customTitle === 'string'
                ? rawRecord.customTitle
                : null
        })
    }
    return records
}

function isImportableConversationRecord(record: ClaudeTranscriptRecord): record is ClaudeTranscriptRecord & { event: RawJSONLines; uuid: string } {
    const event = record.event
    return Boolean(
        event &&
        record.uuid &&
        !event.isMeta &&
        !event.isCompactSummary &&
        isClaudeChatVisibleMessage(event)
    )
}

function activeClaudeRecordIds(records: ClaudeTranscriptRecord[]): Set<string> | null {
    const topology = new Map<string, ClaudeTranscriptRecord>()
    for (const record of records) {
        if (record.uuid) topology.set(record.uuid, record)
    }
    let leaf: ClaudeTranscriptRecord | null = null
    for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index]!
        if (!record.isSidechain && isImportableConversationRecord(record)) {
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
        if (!record.uuid || !activeMainIds.has(record.uuid) || record.event?.type !== 'assistant') continue
        const content = record.event.message?.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
            if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
            const toolUse = block as Record<string, unknown>
            if (toolUse.type === 'tool_use' && typeof toolUse.id === 'string') activeToolUseIds.add(toolUse.id)
        }
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
    return activeIds
}

function parseClaudeLocalSession(filePath: string, knownModifiedAt?: number): ParsedClaudeSession | null {
    let content: string
    let modifiedAt: number
    try {
        content = readFileSync(filePath, 'utf-8')
        modifiedAt = knownModifiedAt ?? statSync(filePath).mtimeMs
    } catch {
        return null
    }

    const sessionId = basename(filePath, '.jsonl')
    if (!sessionId) return null

    let cwd: string | null = null
    let customTitle: string | null = null
    let aiTitle: string | null = null
    let summary: string | null = null
    let firstUserMessage: string | null = null
    let lastUserMessage: string | null = null
    let model: string | null = null
    const messages: ClaudeImportedMessage[] = []
    const records = parseTranscriptRecords(content)
    const activeRecordIds = activeClaudeRecordIds(records)

    for (const record of records) {
        if (record.customTitle !== null) {
            customTitle = record.customTitle.trim() || customTitle
            continue
        }
        const event = record.event
        if (!event) continue

        cwd ??= event.cwd?.trim() || null
        if (event.type === 'ai-title') {
            aiTitle = event.aiTitle.trim() || aiTitle
            continue
        }
        if (event.type === 'summary') {
            summary = event.summary.trim() || summary
            continue
        }
        if (!isImportableConversationRecord(record)) continue

        const uuid = record.uuid
        if (activeRecordIds && !activeRecordIds.has(uuid)) continue
        const createdAt = parseTimestamp(event.timestamp, modifiedAt)
        if (isExternalUserMessage(event)) {
            const text = extractRawUserTextContent(event.message.content)?.trim()
            if (!text) continue
            firstUserMessage ??= text
            lastUserMessage = text
            messages.push({
                localId: `claude:${sessionId}:${uuid}`,
                createdAt,
                content: importedUser(text)
            })
            continue
        }

        if (event.type === 'assistant' && event.message?.model) model = event.message.model
        messages.push({
            localId: `claude:${sessionId}:${uuid}`,
            createdAt,
            content: importedAgent(event)
        })
    }

    if (!cwd || messages.length === 0) return null
    const displayTitle =
        customTitle ?? aiTitle ?? (firstUserMessage ? truncateText(firstUserMessage, 80) : null) ?? summary ?? basename(cwd) ?? sessionId.slice(0, 8)

    return {
        summary: {
            id: sessionId,
            title: displayTitle,
            lastUserMessage: lastUserMessage ? truncateText(lastUserMessage, 140) : null,
            cwd,
            file: filePath,
            modifiedAt,
            model,
            messageCount: messages.length
        },
        messages
    }
}

export function listLocalClaudeSessionSummaries(limit = DEFAULT_CLAUDE_SESSION_SCAN_LIMIT): ClaudeLocalSessionSummary[] {
    if (limit <= 0) return []
    const summaries: ClaudeLocalSessionSummary[] = []
    const seenIds = new Set<string>()
    for (const candidate of collectClaudeSessionFiles()) {
        const sessionId = basename(candidate.file, '.jsonl')
        if (!sessionId || seenIds.has(sessionId)) continue
        const parsed = parseClaudeLocalSession(candidate.file, candidate.modifiedAt)
        if (!parsed) continue
        seenIds.add(sessionId)
        summaries.push(parsed.summary)
        if (summaries.length >= limit) break
    }
    return summaries
}

export function listLocalClaudeSessionsWithMessagesByIds(ids: Set<string>): ClaudeLocalSessionWithMessages[] {
    if (ids.size === 0) return []
    const unresolved = new Set(ids)
    const sessions: ClaudeLocalSessionWithMessages[] = []
    for (const candidate of collectClaudeSessionFiles()) {
        const sessionId = basename(candidate.file, '.jsonl')
        if (!unresolved.has(sessionId)) continue
        const parsed = parseClaudeLocalSession(candidate.file, candidate.modifiedAt)
        if (!parsed) continue
        unresolved.delete(sessionId)
        sessions.push({ ...parsed.summary, messages: parsed.messages })
        if (unresolved.size === 0) break
    }
    return sessions
}
