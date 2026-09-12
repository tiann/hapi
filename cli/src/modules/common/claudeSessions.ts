/**
 * Claude Code session discovery + transcript parse for machine RPC.
 * Mirrors `codexSessions.ts` / #1088: hub must not scan its own ~/.claude.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'

const DEFAULT_CLAUDE_SESSION_SCAN_LIMIT = 200

type ClaudeImportedMessageContent = {
    role: 'user'
    content: { type: 'text'; text: string }
    meta: { sentFrom: 'cli' }
} | {
    role: 'agent'
    content: { type: typeof AGENT_MESSAGE_PAYLOAD_TYPE; data: unknown }
    meta: { sentFrom: 'cli' }
}

export type LocalClaudeSessionSummary = {
    id: string
    title: string
    lastUserMessage?: string | null
    cwd?: string | null
    file: string
    modifiedAt: number
    originator?: string | null
    cliVersion?: string | null
}

export type LocalClaudeSessionWithMessages = LocalClaudeSessionSummary & {
    messages: Array<{ content: ClaudeImportedMessageContent; createdAt?: number }>
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

function truncateText(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

function expandHomePath(pathValue: string): string {
    return pathValue.replace(/^~(?=$|[\\/])/, homedir())
}

function resolveLocalPath(pathValue: string): string {
    return isAbsolute(pathValue) ? pathValue : resolve(process.cwd(), pathValue)
}

function getClaudeHome(): string {
    const configured = process.env.CLAUDE_CONFIG_DIR?.trim()
    return configured ? resolveLocalPath(expandHomePath(configured)) : join(homedir(), '.claude')
}

function getClaudeProjectRoots(): string[] {
    return [join(getClaudeHome(), 'projects')]
}

function decodeProjectDirName(dirName: string): string | null {
    if (!dirName) return null
    const decoded = dirName.replace(/-/g, '/')
    return decoded.startsWith('/') ? decoded : `/${decoded}`
}

function extractClaudeBlockText(value: unknown): string {
    if (typeof value === 'string') return value.trim()
    if (Array.isArray(value)) {
        return value
            .map((item) => {
                const record = asRecord(item)
                if (record?.type === 'text' && typeof record.text === 'string') return record.text
                return null
            })
            .filter((part): part is string => Boolean(part))
            .join(' ')
            .trim()
    }
    return ''
}

function isMetaUserRecord(record: Record<string, unknown>): boolean {
    return record.isMeta === true
}

function buildImportedUserMessage(text: string): ClaudeImportedMessageContent {
    return {
        role: 'user',
        content: { type: 'text', text },
        meta: { sentFrom: 'cli' }
    }
}

function buildImportedAgentMessage(data: unknown): ClaudeImportedMessageContent {
    return {
        role: 'agent',
        content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data },
        meta: { sentFrom: 'cli' }
    }
}

function parseImportedTimestamp(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.length > 0) {
        const parsed = Date.parse(value)
        if (Number.isFinite(parsed)) return parsed
    }
    return undefined
}

function getClaudeFirstUserMessage(lines: string[]): string | null {
    for (const line of lines) {
        let parsed: unknown
        try {
            parsed = JSON.parse(line)
        } catch {
            continue
        }
        const record = asRecord(parsed)
        if (!record || record.type !== 'user' || isMetaUserRecord(record)) continue
        const message = asRecord(record.message)
        const text = extractClaudeBlockText(message?.content)
        if (text) return text
    }
    return null
}

function readClaudeFields(lines: string[]): { sessionId: string | null; cwd: string | null; cliVersion: string | null } {
    let sessionId: string | null = null
    let cwd: string | null = null
    let cliVersion: string | null = null
    for (const line of lines) {
        if (sessionId && cwd && cliVersion) break
        let parsed: unknown
        try {
            parsed = JSON.parse(line)
        } catch {
            continue
        }
        const record = asRecord(parsed)
        if (!record) continue
        if (!sessionId && typeof record.sessionId === 'string') sessionId = record.sessionId
        if (!cwd && typeof record.cwd === 'string') cwd = record.cwd
        if (!cliVersion && typeof record.version === 'string') cliVersion = record.version
    }
    return { sessionId, cwd, cliVersion }
}

function getClaudeSessionTitle(cwd: string | null, sessionId: string, firstUserMessage: string | null): string {
    if (firstUserMessage) return truncateText(firstUserMessage, 80)
    if (cwd) {
        const parts = cwd.split(/[\\/]+/).filter(Boolean)
        if (parts.length > 0) return parts[parts.length - 1]
    }
    return sessionId.slice(0, 8)
}

function convertClaudeRecordToImportedMessage(record: Record<string, unknown>): ClaudeImportedMessageContent[] {
    const type = asString(record.type)
    const message = asRecord(record.message)
    if (!type || !message) return []

    const content = message.content
    const results: ClaudeImportedMessageContent[] = []

    if (type === 'user') {
        if (isMetaUserRecord(record)) return []
        if (typeof content === 'string') {
            const text = content.trim()
            return text ? [buildImportedUserMessage(text)] : []
        }
        if (Array.isArray(content)) {
            const userTextParts: string[] = []
            for (const item of content) {
                const block = asRecord(item)
                if (!block) continue
                const blockType = asString(block.type)
                if (blockType === 'text' && typeof block.text === 'string') {
                    const text = block.text.trim()
                    if (text) userTextParts.push(text)
                } else if (blockType === 'tool_result') {
                    const callId = asString(block.tool_use_id)
                    if (callId) {
                        results.push(buildImportedAgentMessage({
                            type: 'tool-call-result',
                            callId,
                            output: block.content
                        }))
                    }
                }
            }
            if (userTextParts.length > 0) {
                results.unshift(buildImportedUserMessage(userTextParts.join('\n')))
            }
            return results
        }
        return []
    }

    if (type === 'assistant') {
        if (!Array.isArray(content)) return []
        for (const item of content) {
            const block = asRecord(item)
            if (!block) continue
            const blockType = asString(block.type)
            if (blockType === 'text' && typeof block.text === 'string') {
                const text = block.text.trim()
                if (text) results.push(buildImportedAgentMessage({ type: 'message', message: text }))
            } else if (blockType === 'thinking' && typeof block.thinking === 'string') {
                const thinking = block.thinking.trim()
                if (thinking) results.push(buildImportedAgentMessage({ type: 'reasoning', message: thinking }))
            } else if (blockType === 'tool_use') {
                const name = asString(block.name)
                const callId = asString(block.id)
                if (name && callId) {
                    results.push(buildImportedAgentMessage({
                        type: 'tool-call',
                        name,
                        callId,
                        input: block.input
                    }))
                }
            }
        }
        return results
    }

    return []
}

function parseClaudeTranscriptMessages(filePath: string): LocalClaudeSessionWithMessages['messages'] {
    let content: string
    try {
        content = readFileSync(filePath, 'utf-8')
    } catch {
        return []
    }
    const lines = content.split(/\r?\n/).filter(Boolean)
    const messages: LocalClaudeSessionWithMessages['messages'] = []
    for (const line of lines) {
        let parsed: unknown
        try {
            parsed = JSON.parse(line)
        } catch {
            continue
        }
        const record = asRecord(parsed)
        if (!record) continue
        const createdAt = parseImportedTimestamp(record.timestamp)
        for (const messageContent of convertClaudeRecordToImportedMessage(record)) {
            messages.push({ content: messageContent, createdAt })
        }
    }
    return messages
}

function parseClaudeLocalSession(filePath: string, dirName: string, includeMessages: boolean): LocalClaudeSessionSummary | LocalClaudeSessionWithMessages | null {
    let content: string
    try {
        content = readFileSync(filePath, 'utf-8')
    } catch {
        return null
    }

    const lines = content.split(/\r?\n/).filter(Boolean)
    if (lines.length === 0) return null

    const { sessionId: inlineSessionId, cwd: inlineCwd, cliVersion } = readClaudeFields(lines)
    const fileSessionId = filePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.jsonl$/i, '') ?? null
    const sessionId = fileSessionId || inlineSessionId
    if (!sessionId) return null

    const cwd = inlineCwd ?? decodeProjectDirName(dirName)
    const firstUserMessage = getClaudeFirstUserMessage(lines)
    let modifiedAt = Date.now()
    try {
        modifiedAt = statSync(filePath).mtimeMs
    } catch {
        // concurrent change
    }

    const summary: LocalClaudeSessionSummary = {
        id: sessionId,
        title: getClaudeSessionTitle(cwd, sessionId, firstUserMessage),
        lastUserMessage: firstUserMessage ? truncateText(firstUserMessage, 140) : null,
        cwd,
        file: filePath,
        modifiedAt,
        originator: 'claude_code',
        cliVersion
    }

    if (!includeMessages) {
        // Keep list lean: only sessions with at least one importable message.
        if (parseClaudeTranscriptMessages(filePath).length === 0) return null
        return summary
    }

    const messages = parseClaudeTranscriptMessages(filePath)
    if (messages.length === 0) return null
    return { ...summary, messages }
}

function listLocalClaudeSessions(includeMessages: false, limit?: number): LocalClaudeSessionSummary[]
function listLocalClaudeSessions(includeMessages: true, limit?: number): LocalClaudeSessionWithMessages[]
function listLocalClaudeSessions(includeMessages: boolean, limit = DEFAULT_CLAUDE_SESSION_SCAN_LIMIT): Array<LocalClaudeSessionSummary | LocalClaudeSessionWithMessages> {
    const deduped = new Map<string, LocalClaudeSessionSummary | LocalClaudeSessionWithMessages>()

    for (const root of getClaudeProjectRoots()) {
        if (!existsSync(root)) continue
        let projectDirs
        try {
            projectDirs = readdirSync(root, { withFileTypes: true })
        } catch {
            continue
        }
        for (const projectDir of projectDirs) {
            if (!projectDir.isDirectory()) continue
            const projectPath = join(root, projectDir.name)
            let entries
            try {
                entries = readdirSync(projectPath, { withFileTypes: true })
            } catch {
                continue
            }
            for (const entry of entries) {
                if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jsonl')) continue
                const filePath = join(projectPath, entry.name)
                const session = parseClaudeLocalSession(filePath, projectDir.name, includeMessages)
                if (!session) continue
                const previous = deduped.get(session.id)
                if (!previous || previous.modifiedAt < session.modifiedAt) {
                    deduped.set(session.id, session)
                }
            }
        }
    }

    return Array.from(deduped.values()).sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, limit)
}

export function listLocalClaudeSessionSummaries(limit = DEFAULT_CLAUDE_SESSION_SCAN_LIMIT): LocalClaudeSessionSummary[] {
    return listLocalClaudeSessions(false, limit)
}

export function listLocalClaudeSessionsWithMessagesByIds(ids: Set<string>): LocalClaudeSessionWithMessages[] {
    if (ids.size === 0) return []
    return listLocalClaudeSessionSummaries(Number.MAX_SAFE_INTEGER)
        .filter((session) => ids.has(session.id))
        .map((session) => {
            const messages = parseClaudeTranscriptMessages(session.file)
            if (messages.length === 0) return null
            return { ...session, messages }
        })
        .filter((session): session is LocalClaudeSessionWithMessages => session !== null)
}
