import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import {
    type ImportedMessage,
    type ImportedMessageContent,
    type ImporterAdapter,
    type LocalSessionSummary,
    type ScriptLaunchResponse,
    type TranscriptImportData,
    DEFAULT_SESSION_SCAN_LIMIT,
    appendScriptLog,
    asRecord,
    asString,
    buildImportedAgentMessage,
    buildImportedUserMessage,
    expandHomePath,
    getDirectImportRouteContext,
    importSelectedSessions,
    parseImportedTimestamp,
    parseSyncSessionRequest,
    truncateText
} from './transcriptImport'

type ClaudeStatusResponse = {
    success: true
    claudeProjectsAvailable: boolean
}

type ClaudeLocalSessionsResponse = {
    success: true
    sessions: LocalSessionSummary[]
}

const CLAUDE_SESSION_ID_KEY = 'claudeSessionId'
const CLAUDE_TRANSCRIPT_IMPORT_NAMESPACE_ERROR = 'Claude transcript import is not available outside the default namespace'

function resolveLocalPath(pathValue: string): string {
    return isAbsolute(pathValue) ? pathValue : resolve(process.cwd(), pathValue)
}

function getClaudeHome(): string {
    // 中文注释：与 codex 的 getCodexHome 对称；优先 CLAUDE_CONFIG_DIR，否则回退 ~/.claude。
    const configured = process.env.CLAUDE_CONFIG_DIR?.trim()
    return configured ? resolveLocalPath(expandHomePath(configured)) : join(homedir(), '.claude')
}

function getClaudeProjectRoots(): string[] {
    return [join(getClaudeHome(), 'projects')]
}

function decodeProjectDirName(dirName: string): string | null {
    // 中文注释：Claude 把 cwd 里的路径分隔符编码成 '-'（如 /home/ubuntu → -home-ubuntu）。
    // 由于含 '-' 的真实路径无法可靠还原，cwd 仍以 transcript 行内的 cwd 字段为准，这里只作回退用途。
    if (!dirName) return null
    const decoded = dirName.replace(/-/g, '/')
    return decoded.startsWith('/') ? decoded : `/${decoded}`
}

function extractClaudeBlockText(value: unknown): string {
    if (typeof value === 'string') {
        return value.trim()
    }
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
    // 中文注释：Claude 会写入本地命令/环境提示等 isMeta 用户行，这些不是真实对话内容，跳过。
    return record.isMeta === true
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
        if (text) {
            return text
        }
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
    if (firstUserMessage) {
        return truncateText(firstUserMessage, 80)
    }
    if (cwd) {
        const parts = cwd.split(/[\\/]+/).filter(Boolean)
        if (parts.length > 0) {
            return parts[parts.length - 1]
        }
    }
    return sessionId.slice(0, 8)
}

function parseClaudeLocalSession(filePath: string, dirName: string): LocalSessionSummary | null {
    let content: string
    try {
        content = readFileSync(filePath, 'utf-8')
    } catch {
        return null
    }

    const lines = content.split(/\r?\n/).filter(Boolean)
    if (lines.length === 0) {
        return null
    }

    const { sessionId: inlineSessionId, cwd: inlineCwd, cliVersion } = readClaudeFields(lines)
    const fileSessionId = filePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.jsonl$/i, '') ?? null
    const sessionId = fileSessionId || inlineSessionId
    if (!sessionId) {
        return null
    }

    const cwd = inlineCwd ?? decodeProjectDirName(dirName)
    const firstUserMessage = getClaudeFirstUserMessage(lines)

    let modifiedAt = Date.now()
    try {
        modifiedAt = statSync(filePath).mtimeMs
    } catch {
        // Fall back to current time if stat fails during a concurrent file change.
    }

    return {
        id: sessionId,
        title: getClaudeSessionTitle(cwd, sessionId, firstUserMessage),
        lastUserMessage: firstUserMessage ? truncateText(firstUserMessage, 140) : null,
        cwd,
        file: filePath,
        modifiedAt,
        originator: 'claude_code',
        cliVersion
    }
}

function listLocalClaudeSessions(limit = DEFAULT_SESSION_SCAN_LIMIT): LocalSessionSummary[] {
    const deduped = new Map<string, LocalSessionSummary>()

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
                const session = parseClaudeLocalSession(filePath, projectDir.name)
                if (!session) continue
                // 中文注释：仅含 sidecar、没有任何可导入对话的会话不进入列表，避免给用户展示空壳会话。
                if (!parseClaudeTranscriptImportData(session)) continue
                const previous = deduped.get(session.id)
                if (!previous || previous.modifiedAt < session.modifiedAt) {
                    deduped.set(session.id, session)
                }
            }
        }
    }

    const sorted = Array.from(deduped.values()).sort((a, b) => b.modifiedAt - a.modifiedAt)
    if (sorted.length > limit) {
        // 中文注释：不静默截断；超过扫描上限时记录被截断的数量，方便排查“为什么少了会话”。
        console.warn(`[claude-import] listLocalClaudeSessions truncated ${sorted.length - limit} session(s) beyond limit=${limit}`)
    }
    return sorted.slice(0, limit)
}

function convertClaudeRecordToImportedMessage(record: Record<string, unknown>): ImportedMessageContent[] {
    // 中文注释：一行 Claude 记录可能含多块（text/thinking/tool_use/tool_result），故返回数组而非单条。
    const type = asString(record.type)
    const message = asRecord(record.message)
    if (!type || !message) {
        return []
    }

    const content = message.content
    const results: ImportedMessageContent[] = []

    if (type === 'user') {
        if (isMetaUserRecord(record)) {
            return []
        }
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
                // 中文注释：把用户文本拼成一条 user message，置于 tool_result 之前以保留视觉顺序。
                results.unshift(buildImportedUserMessage(userTextParts.join('\n')))
            }
            return results
        }
        return []
    }

    if (type === 'assistant') {
        if (!Array.isArray(content)) {
            return []
        }
        for (const item of content) {
            const block = asRecord(item)
            if (!block) continue
            const blockType = asString(block.type)
            if (blockType === 'text' && typeof block.text === 'string') {
                const text = block.text.trim()
                if (text) {
                    results.push(buildImportedAgentMessage({ type: 'message', message: text }))
                }
            } else if (blockType === 'thinking' && typeof block.thinking === 'string') {
                const thinking = block.thinking.trim()
                if (thinking) {
                    results.push(buildImportedAgentMessage({ type: 'reasoning', message: thinking }))
                }
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

    // 中文注释：其余 sidecar 类型（last-prompt/mode/agent-setting/permission-mode/attachment/system/
    // file-history-snapshot/ai-title/agent-name/queue-operation 等）一律安全跳过。
    return []
}

function parseClaudeTranscriptImportData(summary: LocalSessionSummary): TranscriptImportData | null {
    let content: string
    try {
        content = readFileSync(summary.file, 'utf-8')
    } catch {
        return null
    }

    const lines = content.split(/\r?\n/).filter(Boolean)
    const messages: ImportedMessage[] = []

    for (const line of lines) {
        let parsed: unknown
        try {
            parsed = JSON.parse(line)
        } catch {
            continue
        }
        const record = asRecord(parsed)
        if (!record) continue
        // 中文注释：Claude 记录在顶层 `timestamp` 带 ISO 时间串，解析出来随消息一起落库；
        // 一行可拆出多块消息（text/tool_use/...），它们共用该行的时间戳。
        const createdAt = parseImportedTimestamp(record.timestamp)
        for (const content of convertClaudeRecordToImportedMessage(record)) {
            messages.push({ content, createdAt })
        }
    }

    if (messages.length === 0) {
        return null
    }

    return {
        ...summary,
        messages
    }
}

// 中文注释：claudeAdapter 把 Claude 专属扫描/解析封装成通用 ImporterAdapter，落库/同步/去重复用 transcriptImport。
const claudeAdapter: ImporterAdapter = {
    flavor: 'claude',
    sessionIdKey: CLAUDE_SESSION_ID_KEY,
    listLocalSessions: (limit) => listLocalClaudeSessions(limit),
    parseTranscript: (summary) => parseClaudeTranscriptImportData(summary)
}

export async function importSelectedClaudeSessions(options: {
    claudeSessionIds: string[]
    store: Store
    namespace: string
    getSyncEngine?: () => SyncEngine | null
}): Promise<ScriptLaunchResponse> {
    return importSelectedSessions({
        adapter: claudeAdapter,
        sessionIds: options.claudeSessionIds,
        store: options.store,
        namespace: options.namespace,
        getSyncEngine: options.getSyncEngine
    })
}

export {
    listLocalClaudeSessions,
    parseClaudeTranscriptImportData,
    convertClaudeRecordToImportedMessage
}

export function createClaudeDesktopRoutes(options: {
    store: Store
    getSyncEngine: () => SyncEngine | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.use('/claude/*', async (c, next) => {
        if (c.get('namespace') !== 'default') {
            return c.json({
                success: false,
                error: CLAUDE_TRANSCRIPT_IMPORT_NAMESPACE_ERROR
            }, 403)
        }
        return next()
    })

    app.get('/claude/status', (c) => {
        const available = getClaudeProjectRoots().some((root) => existsSync(root))
        return c.json({
            success: true,
            claudeProjectsAvailable: available
        } satisfies ClaudeStatusResponse)
    })

    app.get('/claude/sessions', (c) => {
        return c.json({
            success: true,
            sessions: listLocalClaudeSessions()
        } satisfies ClaudeLocalSessionsResponse)
    })

    app.post('/claude/sync-session', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = parseSyncSessionRequest(body)
        if (parsed.error) {
            const { workspace } = getDirectImportRouteContext()
            appendScriptLog(workspace, 'sync', `FAILED: ${parsed.error}`)
            return c.json({
                success: false,
                error: parsed.error,
                cwd: workspace
            })
        }

        // 中文注释：直接读取本地 Claude transcript 写入 Hapi store，复用与 Codex 相同的落库/同步/去重引擎。
        const result = await importSelectedClaudeSessions({
            claudeSessionIds: parsed.sessionIds,
            store: options.store,
            namespace: c.get('namespace'),
            getSyncEngine: options.getSyncEngine
        })
        return c.json(result)
    })

    return app
}
