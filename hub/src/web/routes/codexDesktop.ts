import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir, hostname, platform } from 'node:os'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { Hono } from 'hono'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { Store, StoredMessage } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

type ScriptLogKind = 'sync' | 'restart'

const DIRECT_IMPORT_COMMAND = 'direct-import'
const RESTART_SCRIPT_ENV_NAME = 'HAPI_CODEX_RESTART_SCRIPT'
const RESTART_SCRIPT_DEFAULT_FILE = 'Restart-CodexDesktop.ps1'
const RESTART_SCRIPT_ARGS = ['-Apply']
const RESTART_SCRIPT_MESSAGE = 'Codex Desktop restart script started'

type ScriptLaunchResponse = {
    success: true
    message: string
    pid: number
    command: string
    script?: string
    cwd: string
    output?: string
    codexDesktopRunning?: boolean
    codexClientAvailable?: boolean
    syncedCount?: number
    sessionIds?: string[]
    hapiSessionIds?: string[]
} | {
    success: false
    error: string
    script?: string
    cwd: string
    output?: string
    codexDesktopRunning?: boolean
    codexClientAvailable?: boolean
    syncedCount?: number
    sessionIds?: string[]
    hapiSessionIds?: string[]
}

type CodexDesktopStatus = {
    running: boolean
    clientAvailable: boolean
}

type CodexDesktopStatusResponse = {
    success: true
    codexDesktopRunning: boolean
    codexClientAvailable: boolean
}

type CodexLocalSessionSummary = {
    id: string
    title: string
    lastUserMessage?: string | null
    cwd?: string | null
    file: string
    modifiedAt: number
    originator?: string | null
    cliVersion?: string | null
}

type CodexLocalSessionsResponse = {
    success: true
    sessions: CodexLocalSessionSummary[]
    machineId?: string
} | {
    success: false
    error: string
    sessions: []
    machineId?: string
}

type CodexImportedMessageContent = {
    role: 'user'
    content: {
        type: 'text'
        text: string
    }
    meta: {
        sentFrom: 'cli'
    }
} | {
    role: 'agent'
    content: {
        type: typeof AGENT_MESSAGE_PAYLOAD_TYPE
        data: unknown
    }
    meta: {
        sentFrom: 'cli'
    }
}

type CodexImportedMessageSource = 'event_msg' | 'response_item'
type CodexImportedMessageEntry = {
    source: CodexImportedMessageSource
    message: CodexImportedMessageContent
}

type CodexTranscriptImportData = CodexLocalSessionSummary & {
    messages: CodexImportedMessageContent[]
}

type CodexSessionIndexTitle = {
    threadName: string
    updatedAt: string
}
type RemoteCodexSession = CodexTranscriptImportData

type ImportCandidate = {
    sessionId: string
    active: boolean
    updatedAt: number
    metadata: Record<string, unknown> | null
}

type ImportTargetSelection = {
    sessionId: string | null
    comparablePrefixCount: number
}

type SyncSessionRequestParseResult = {
    sessionIds: string[]
    cwd?: string | null
    machineId?: string | null
    model?: string | null
    modelReasoningEffort?: string | null
    yolo?: boolean
    error?: string
}

type CodexDuplicateSessionGroup = {
    codexSessionId: string
    hapiSessionIds: string[]
    canonicalSessionId?: string
    removedSessionIds?: string[]
}

type CodexDuplicateSessionsResponse = {
    success: true
    duplicates: CodexDuplicateSessionGroup[]
} | {
    success: false
    error: string
}

type CodexMergeDuplicateSessionsResponse = {
    success: true
    merged: CodexDuplicateSessionGroup[]
    mergedCount: number
} | {
    success: false
    error: string
}

type DuplicateSessionGroupCandidate = {
    codexSessionId: string
    sessions: ImportCandidate[]
}

const CODEX_DESKTOP_NOT_FOUND_ERROR = '尝试重启codex客户端失败，未安装/找不到codex客户端'
const SCRIPT_TIMEOUT_ERROR = '执行超时'
const NO_SYNC_SESSION_SELECTED_ERROR = '未选择需要导入的 Codex 会话'
const CODEX_TRANSCRIPT_IMPORT_NAMESPACE_ERROR = 'Codex transcript import is not available outside the default namespace'
const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000
const DEFAULT_CODEX_SESSION_SCAN_LIMIT = 500

function resolveLocalPath(pathValue: string): string {
    return isAbsolute(pathValue) ? pathValue : resolve(process.cwd(), pathValue)
}

function getScriptRoot(): string {
    const configured = process.env.HAPI_CODEX_SCRIPT_ROOT?.trim()
    return configured ? resolveLocalPath(configured) : process.cwd()
}

function getDefaultScriptPath(defaultFile: string): string {
    const configuredRoot = process.env.HAPI_CODEX_SCRIPT_ROOT?.trim()
    if (configuredRoot) {
        return join(resolveLocalPath(configuredRoot), defaultFile)
    }

    const cwd = process.cwd()
    const candidateRoots = [
        cwd,
        resolve(cwd, '..'),
        resolve(cwd, '..', '..')
    ]

    for (const root of candidateRoots) {
        const candidate = join(root, defaultFile)
        if (existsSync(candidate)) {
            return candidate
        }
    }

    return join(getScriptRoot(), defaultFile)
}

function getRestartScriptPath(): string {
    const configured = process.env[RESTART_SCRIPT_ENV_NAME]?.trim()
    return configured ? resolveLocalPath(configured) : getDefaultScriptPath(RESTART_SCRIPT_DEFAULT_FILE)
}

function getWorkspace(scriptPath: string): string {
    const configured = process.env.HAPI_CODEX_WORKSPACE?.trim()
    return configured ? resolveLocalPath(configured) : dirname(scriptPath)
}

function getDirectImportWorkspace(): string {
    const configured = process.env.HAPI_CODEX_WORKSPACE?.trim()
    return configured ? resolveLocalPath(configured) : process.cwd()
}

function expandHomePath(pathValue: string): string {
    return pathValue.replace(/^~(?=$|[\\/])/, homedir())
}

function getCodexHome(): string {
    const configured = process.env.CODEX_HOME?.trim()
    return configured ? resolveLocalPath(expandHomePath(configured)) : join(homedir(), '.codex')
}

function getCodexSessionRoots(): string[] {
    const codexHome = getCodexHome()
    // 中文注释：当前 direct import 只从 sessions 目录解析 transcript，避免把 archived_sessions 中暂不参与导入的会话展示给用户。
    return [join(codexHome, 'sessions')]
}

function getCodexSessionIndexPath(): string {
    return join(getCodexHome(), 'session_index.jsonl')
}

function collectJsonlFiles(root: string, files: string[]): void {
    if (!existsSync(root)) return
    let entries
    try {
        entries = readdirSync(root, { withFileTypes: true })
    } catch {
        return
    }

    for (const entry of entries) {
        const fullPath = join(root, entry.name)
        if (entry.isDirectory()) {
            collectJsonlFiles(fullPath, files)
            continue
        }
        if (entry.isFile() && fullPath.toLowerCase().endsWith('.jsonl')) {
            files.push(fullPath)
        }
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

function extractCodexText(value: unknown): string {
    if (typeof value === 'string') {
        return value.trim()
    }
    if (Array.isArray(value)) {
        return value
            .map((item) => {
                const record = asRecord(item)
                if (record?.type === 'text' && typeof record.text === 'string') return record.text
                if (record?.type === 'input_text' && typeof record.text === 'string') return record.text
                if (record?.type === 'output_text' && typeof record.text === 'string') return record.text
                return null
            })
            .filter((part): part is string => Boolean(part))
            .join(' ')
            .trim()
    }
    const record = asRecord(value)
    if (record?.type === 'text' && typeof record.text === 'string') {
        return record.text.trim()
    }
    if (record?.type === 'input_text' && typeof record.text === 'string') {
        return record.text.trim()
    }
    if (record?.type === 'output_text' && typeof record.text === 'string') {
        return record.text.trim()
    }
    return ''
}

function truncateText(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

function shouldIgnoreInjectedResponseUserMessage(text: string): boolean {
    const normalized = text.trim()
    const lower = normalized.toLowerCase()
    const isAgentInstructions = lower.startsWith('# agents.md instructions')
    const isEnvironmentContext = lower.startsWith('<environment_context>')
        && lower.endsWith('</environment_context>')
    return isAgentInstructions || isEnvironmentContext
}

function inferSessionIdFromFileName(filePath: string): string | null {
    const match = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(filePath)
    return match?.[1] ?? null
}

function parseCodexFunctionArguments(value: unknown): unknown {
    if (typeof value !== 'string') {
        return value
    }

    const trimmed = value.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return value
    }

    try {
        return JSON.parse(trimmed)
    } catch {
        return value
    }
}

function extractCodexToolCallId(payload: Record<string, unknown>): string | null {
    const candidates = ['call_id', 'callId', 'tool_call_id', 'toolCallId', 'id']
    for (const key of candidates) {
        const value = payload[key]
        if (typeof value === 'string' && value.length > 0) {
            return value
        }
    }
    return null
}

function extractCodexChangedTitle(record: Record<string, unknown>): string | null {
    const type = typeof record.type === 'string' ? record.type : null
    if (type === 'response_item') {
        const payload = asRecord(record.payload)
        if (payload?.type === 'function_call' && payload.name === 'change_title') {
            const argumentsText = typeof payload.arguments === 'string' ? payload.arguments : null
            if (!argumentsText) return null
            try {
                const parsedArguments = JSON.parse(argumentsText) as { title?: unknown }
                return typeof parsedArguments.title === 'string' && parsedArguments.title.trim()
                    ? parsedArguments.title.trim()
                    : null
            } catch {
                return null
            }
        }
    }

    if (type === 'event_msg') {
        const payload = asRecord(record.payload)
        if (payload?.type === 'mcp_tool_call_end') {
            const invocation = asRecord(payload.invocation)
            const argumentsRecord = asRecord(invocation?.arguments)
            if (invocation?.tool === 'change_title' && typeof argumentsRecord?.title === 'string' && argumentsRecord.title.trim()) {
                return argumentsRecord.title.trim()
            }
        }
    }

    return null
}

function getLatestCodexChangedTitle(lines: string[]): string | null {
    // 中文注释：Codex 会在 transcript 中记录 change_title 调用；这里从后往前取最后一次成功设置的标题，作为弹窗主标题显示。
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const parsed = JSON.parse(lines[index])
            const record = asRecord(parsed)
            if (!record) continue
            const title = extractCodexChangedTitle(record)
            if (title) {
                return title
            }
        } catch {
            continue
        }
    }
    return null
}

function getLatestCodexUserMessage(lines: string[]): string | null {
    // 中文注释：弹窗副标题展示最近一次真实用户提问，不再显示路径，便于用户按会话内容而不是目录来识别。
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const parsed = JSON.parse(lines[index])
            const record = asRecord(parsed)
            if (!record || record.type !== 'response_item') continue
            const payload = asRecord(record.payload)
            if (payload?.type !== 'message' || payload.role !== 'user') continue
            const text = extractCodexText(payload.content)
            if (text && !shouldIgnoreInjectedResponseUserMessage(text)) {
                return truncateText(text, 140)
            }
        } catch {
            continue
        }
    }
    return null
}

function getCodexSessionTitle(
    cwd: string | null | undefined,
    sessionId: string,
    sessionIndexTitle: string | null,
    changedTitle: string | null,
    firstUserMessage: string | null
): string {
    if (sessionIndexTitle) {
        return truncateText(sessionIndexTitle, 80)
    }

    if (changedTitle) {
        return truncateText(changedTitle, 80)
    }

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

function isSubagentSource(value: unknown): boolean {
    const record = asRecord(value)
    return record ? Object.prototype.hasOwnProperty.call(record, 'subagent') : false
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
        let parsed: unknown
        try {
            parsed = JSON.parse(line)
        } catch {
            continue
        }

        const record = asRecord(parsed)
        const id = typeof record?.id === 'string' ? record.id : null
        const threadName = typeof record?.thread_name === 'string' && record.thread_name.trim()
            ? record.thread_name.trim()
            : null
        const updatedAt = typeof record?.updated_at === 'string' && record.updated_at.trim()
            ? record.updated_at.trim()
            : null
        if (!id || !threadName || !updatedAt) {
            continue
        }

        const previous = titles.get(id)
        if (!previous || previous.updatedAt < updatedAt) {
            titles.set(id, { threadName, updatedAt })
        }
    }

    return titles
}

function parseCodexLocalSession(
    filePath: string,
    sessionIndexTitles = new Map<string, CodexSessionIndexTitle>()
): CodexLocalSessionSummary | null {
    let content: string
    try {
        content = readFileSync(filePath, 'utf-8')
    } catch {
        return null
    }

    const allLines = content.split(/\r?\n/).filter(Boolean)
    const headLines = allLines.slice(0, 200)
    let sessionId: string | null = null
    let cwd: string | null = null
    let originator: string | null = null
    let cliVersion: string | null = null
    let firstUserMessage: string | null = null

    for (const line of headLines) {
        let parsed: unknown
        try {
            parsed = JSON.parse(line)
        } catch {
            continue
        }

        const record = asRecord(parsed)
        const type = typeof record?.type === 'string' ? record.type : null
        if (type === 'session_meta') {
            const payload = asRecord(record?.payload)
            if (payload) {
                if (isSubagentSource(payload.source)) {
                    return null
                }
                if (!sessionId && typeof payload.id === 'string') {
                    sessionId = payload.id
                }
                if (!cwd && typeof payload.cwd === 'string') {
                    cwd = payload.cwd
                }
                if (!originator && typeof payload.originator === 'string') {
                    originator = payload.originator
                }
                if (!cliVersion && typeof payload.cli_version === 'string') {
                    cliVersion = payload.cli_version
                }
            }
        }

        if (!firstUserMessage && type === 'response_item') {
            const payload = asRecord(record?.payload)
            if (payload?.type === 'message' && payload.role === 'user') {
                const text = extractCodexText(payload.content)
                if (text && !shouldIgnoreInjectedResponseUserMessage(text)) {
                    firstUserMessage = text
                }
            }
        }
    }

    const changedTitle = getLatestCodexChangedTitle(allLines)
    const lastUserMessage = getLatestCodexUserMessage(allLines)

    sessionId = sessionId ?? inferSessionIdFromFileName(filePath)
    if (!sessionId) return null
    const sessionIndexTitle = sessionIndexTitles.get(sessionId)?.threadName ?? null

    let modifiedAt = Date.now()
    try {
        modifiedAt = statSync(filePath).mtimeMs
    } catch {
        // Fall back to current time if stat fails during a concurrent file change.
    }

    return {
        id: sessionId,
        title: getCodexSessionTitle(cwd, sessionId, sessionIndexTitle, changedTitle, firstUserMessage),
        lastUserMessage,
        cwd,
        file: filePath,
        modifiedAt,
        originator,
        cliVersion
    }
}

function listLocalCodexSessions(limit = DEFAULT_CODEX_SESSION_SCAN_LIMIT): CodexLocalSessionSummary[] {
    const files: string[] = []
    for (const root of getCodexSessionRoots()) {
        collectJsonlFiles(root, files)
    }

    const sessionIndexTitles = readCodexSessionIndexTitles()
    const deduped = new Map<string, CodexLocalSessionSummary>()
    for (const filePath of files) {
        const session = parseCodexLocalSession(filePath, sessionIndexTitles)
        if (!session) continue
        const previous = deduped.get(session.id)
        if (!previous || previous.modifiedAt < session.modifiedAt) {
            deduped.set(session.id, session)
        }
    }

    return Array.from(deduped.values())
        .sort((a, b) => b.modifiedAt - a.modifiedAt)
        .slice(0, limit)
}

function buildImportedUserMessage(text: string): CodexImportedMessageContent {
    return {
        role: 'user',
        content: {
            type: 'text',
            text
        },
        meta: {
            sentFrom: 'cli'
        }
    }
}

function buildImportedAgentMessage(data: unknown): CodexImportedMessageContent {
    return {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data
        },
        meta: {
            sentFrom: 'cli'
        }
    }
}

function convertCodexRecordToImportedMessage(record: Record<string, unknown>): CodexImportedMessageContent | null {
    const type = asString(record.type)
    const payload = asRecord(record.payload)
    if (!type || !payload) {
        return null
    }

    if (type === 'event_msg') {
        const eventType = asString(payload.type)
        if (!eventType) {
            return null
        }

        if (eventType === 'user_message') {
            const text = asString(payload.message)
                ?? asString(payload.text)
                ?? asString(payload.content)
            if (!text) {
                return null
            }
            return buildImportedUserMessage(text)
        }

        if (eventType === 'agent_message') {
            const message = asString(payload.message)
            return message ? buildImportedAgentMessage({ type: 'message', message, id: randomUUID() }) : null
        }

        if (eventType === 'agent_reasoning') {
            const message = asString(payload.text) ?? asString(payload.message)
            return message ? buildImportedAgentMessage({ type: 'reasoning', message, id: randomUUID() }) : null
        }

        if (eventType === 'agent_reasoning_delta') {
            const delta = asString(payload.delta) ?? asString(payload.text) ?? asString(payload.message)
            return delta ? buildImportedAgentMessage({ type: 'reasoning-delta', delta }) : null
        }

        if (eventType === 'token_count') {
            const info = asRecord(payload.info)
            return info ? buildImportedAgentMessage({ type: 'token_count', info, id: randomUUID() }) : null
        }

        return null
    }

    if (type === 'response_item') {
        const itemType = asString(payload.type)
        if (!itemType) {
            return null
        }

        if (itemType === 'message') {
            const role = asString(payload.role)
            const text = extractCodexText(payload.content)
            if (!text) {
                return null
            }
            if (role === 'user') {
                return shouldIgnoreInjectedResponseUserMessage(text) ? null : buildImportedUserMessage(text)
            }
            if (role === 'assistant') {
                return buildImportedAgentMessage({ type: 'message', message: text, id: randomUUID() })
            }
            return null
        }

        if (itemType === 'function_call') {
            const name = asString(payload.name)
            const callId = extractCodexToolCallId(payload)
            if (!name || !callId) {
                return null
            }
            return buildImportedAgentMessage({
                type: 'tool-call',
                name,
                callId,
                input: parseCodexFunctionArguments(payload.arguments),
                id: randomUUID()
            })
        }

        if (itemType === 'function_call_output') {
            const callId = extractCodexToolCallId(payload)
            if (!callId) {
                return null
            }
            return buildImportedAgentMessage({
                type: 'tool-call-result',
                callId,
                output: payload.output,
                id: randomUUID()
            })
        }
    }

    return null
}

function getCodexImportedMessageSource(record: Record<string, unknown>): CodexImportedMessageSource | null {
    const type = asString(record.type)
    return type === 'event_msg' || type === 'response_item' ? type : null
}

function normalizeComparableUserMessage(content: unknown): string | null {
    const record = asRecord(content)
    if (!record || record.role !== 'user') {
        return null
    }

    const body = asRecord(record.content)
    if (body?.type !== 'text' || typeof body.text !== 'string') {
        return null
    }

    return stableSerialize({
        role: 'user',
        text: body.text.trimEnd()
    })
}

function normalizeComparableAgentMessage(content: unknown): string | null {
    const record = asRecord(content)
    if (!record || record.role !== 'agent') {
        return null
    }

    const body = asRecord(record.content)
    if (!body || body.type !== AGENT_MESSAGE_PAYLOAD_TYPE) {
        return null
    }

    const data = asRecord(body.data)
    if (data?.type !== 'message' || typeof data.message !== 'string') {
        return null
    }

    return stableSerialize({
        role: 'agent',
        type: 'message',
        message: data.message
    })
}

function normalizeAdjacentDuplicateMessage(content: unknown): string | null {
    return normalizeComparableUserMessage(content) ?? normalizeComparableAgentMessage(content)
}

function isAdjacentDuplicateImportedMessage(
    previous: CodexImportedMessageContent,
    next: CodexImportedMessageContent
): boolean {
    const previousKey = normalizeAdjacentDuplicateMessage(previous)
    const nextKey = normalizeAdjacentDuplicateMessage(next)
    return previousKey !== null && previousKey === nextKey
}

function isMirroredAdjacentDuplicate(
    previous: CodexImportedMessageEntry | undefined,
    next: CodexImportedMessageEntry
): boolean {
    return Boolean(
        previous
        && previous.source !== next.source
        && isAdjacentDuplicateImportedMessage(previous.message, next.message)
    )
}

function isResponseItemDuplicateOfEventUserMessage(
    entry: CodexImportedMessageEntry,
    recentEventUserMessageKey: string | null
): boolean {
    if (entry.source !== 'response_item' || recentEventUserMessageKey === null) {
        return false
    }

    return normalizeComparableUserMessage(entry.message) === recentEventUserMessageKey
}

function parseCodexTranscriptImportData(summary: CodexLocalSessionSummary): CodexTranscriptImportData | null {
    let content: string
    try {
        content = readFileSync(summary.file, 'utf-8')
    } catch {
        return null
    }

    const lines = content.split(/\r?\n/).filter(Boolean)
    const entries: CodexImportedMessageEntry[] = []
    let recentEventUserMessageKey: string | null = null

    for (const line of lines) {
        let parsed: unknown
        try {
            parsed = JSON.parse(line)
        } catch {
            continue
        }

        const record = asRecord(parsed)
        if (!record) continue
        const source = getCodexImportedMessageSource(record)
        if (!source) continue
        const message = convertCodexRecordToImportedMessage(record)
        if (message) {
            const entry = { source, message }
            const userMessageKey = normalizeComparableUserMessage(message)
            if (source === 'event_msg' && userMessageKey !== null) {
                const previous = entries[entries.length - 1]
                if (previous?.source === 'response_item' && isMirroredAdjacentDuplicate(previous, entry)) {
                    entries[entries.length - 1] = entry
                } else {
                    entries.push(entry)
                }
                recentEventUserMessageKey = userMessageKey
                continue
            }
            if (isResponseItemDuplicateOfEventUserMessage(entry, recentEventUserMessageKey)) {
                continue
            }
            const previous = entries[entries.length - 1]
            if (isMirroredAdjacentDuplicate(previous, entry)) {
                recentEventUserMessageKey = null
                continue
            }
            entries.push(entry)
            recentEventUserMessageKey = null
        }
    }

    return {
        ...summary,
        messages: entries.map((entry) => entry.message)
    }
}

function normalizeComparablePath(pathValue: string, options?: { caseInsensitive?: boolean }): string {
    let normalized = pathValue.trim().replace(/\\/g, '/').replace(/\/+/g, '/')
    if (normalized.length > 1) {
        normalized = normalized.replace(/\/+$/, '')
    }
    return options?.caseInsensitive ? normalized.toLowerCase() : normalized
}

function shouldCompareCaseInsensitive(...pathValues: string[]): boolean {
    return pathValues.some((pathValue) => /^[a-z]:[\\/]/i.test(pathValue) || pathValue.includes('\\'))
}

function isPathInsideWorkspaceRoot(pathValue: string, rootValue: string): boolean {
    if (!pathValue.trim() || !rootValue.trim()) {
        return false
    }

    const caseInsensitive = shouldCompareCaseInsensitive(pathValue, rootValue)
    const path = normalizeComparablePath(pathValue, { caseInsensitive })
    const root = normalizeComparablePath(rootValue, { caseInsensitive })
    if (!path || !root) {
        return false
    }
    if (path === root) {
        return true
    }
    if (root === '/') {
        return path.startsWith('/')
    }
    return path.startsWith(`${root}/`)
}

function machineOwnsCodexCwd(machine: Machine, cwd: string): boolean {
    const workspaceRoots = machine.metadata?.workspaceRoots ?? []
    return workspaceRoots.some((workspaceRoot) => isPathInsideWorkspaceRoot(cwd, workspaceRoot))
}

function resolveImportMachineId(
    cwd: string | null | undefined,
    namespace: string,
    engine: SyncEngine | null
): string | undefined {
    if (!cwd || !engine) {
        return undefined
    }

    const matches = engine.getOnlineMachinesByNamespace(namespace)
        .filter((machine) => machineOwnsCodexCwd(machine, cwd))
    const machineIds = Array.from(new Set(matches.map((machine) => machine.id)))
    return machineIds.length === 1 ? machineIds[0] : undefined
}


function resolveCodexImportMachineId(
    cwd: string | null | undefined,
    namespace: string,
    engine: SyncEngine | null,
    requestedMachineId?: string | null
): string | null {
    if (!engine) return null
    const onlineMachines = engine.getOnlineMachinesByNamespace(namespace)
    if (requestedMachineId) {
        return onlineMachines.some((machine) => machine.id === requestedMachineId)
            ? requestedMachineId
            : null
    }
    if (cwd) {
        const resolved = resolveImportMachineId(cwd, namespace, engine)
        if (resolved) return resolved
    }
    return onlineMachines.length === 1 ? onlineMachines[0].id : null
}

function asRemoteCodexSessions(value: unknown, requireMessages: boolean): RemoteCodexSession[] {
    if (!Array.isArray(value)) return []
    return value.filter((session): session is RemoteCodexSession => {
        const record = asRecord(session)
        return typeof record?.id === 'string'
            && typeof record.title === 'string'
            && typeof record.file === 'string'
            && typeof record.modifiedAt === 'number'
            && (!requireMessages || Array.isArray(record.messages))
    })
}

async function listCodexSessionsViaMachine(options: {
    engine: SyncEngine | null
    namespace: string
    cwd?: string | null
    machineId?: string | null
    sessionIds?: string[]
}): Promise<{ sessions: RemoteCodexSession[]; machineId?: string; error?: string }> {
    const machineId = resolveCodexImportMachineId(options.cwd, options.namespace, options.engine, options.machineId)
    if (!machineId || !options.engine) {
        return { sessions: [], error: 'No online machine available for Codex history import' }
    }
    const result = await options.engine.listCodexSessionsForMachine(machineId, options.cwd, options.sessionIds)
    if (!result || typeof result !== 'object') {
        return { sessions: [], machineId, error: 'Unexpected Codex sessions RPC response' }
    }
    if ((result as { success?: unknown }).success !== true) {
        return { sessions: [], machineId, error: typeof (result as { error?: unknown }).error === 'string' ? (result as { error: string }).error : 'Failed to list local Codex sessions' }
    }
    return { sessions: asRemoteCodexSessions((result as { sessions?: unknown }).sessions, Boolean(options.sessionIds?.length)), machineId }
}

function buildImportedSessionMetadata(
    data: CodexTranscriptImportData,
    existingMetadata?: Record<string, unknown> | null,
    resolvedMachineId?: string,
    permissionMode?: string
): Record<string, unknown> {
    const now = Date.now()
    const path = data.cwd ?? (typeof existingMetadata?.path === 'string' ? existingMetadata.path : dirname(data.file))
    const host = typeof existingMetadata?.host === 'string' ? existingMetadata.host : (process.env.HAPI_HOSTNAME || hostname())
    const osValue = typeof existingMetadata?.os === 'string' ? existingMetadata.os : platform()
    const summaryText = data.lastUserMessage ?? data.title
    const machineId = typeof existingMetadata?.machineId === 'string'
        ? existingMetadata.machineId
        : resolvedMachineId
    const currentCodexSessionId = typeof existingMetadata?.codexSessionId === 'string'
        ? existingMetadata.codexSessionId
        : data.id

    return {
        ...(existingMetadata ?? {}),
        path,
        host,
        os: osValue,
        name: data.title,
        summary: summaryText
            ? {
                text: summaryText,
                updatedAt: now
            }
            : existingMetadata?.summary,
        flavor: 'codex',
        codexSessionId: currentCodexSessionId,
        codexSourceSessionId: typeof existingMetadata?.codexSourceSessionId === 'string'
            ? existingMetadata.codexSourceSessionId
            : data.id,
        ...(permissionMode ? { preferredPermissionMode: permissionMode } : {}),
        ...(machineId ? { machineId } : {}),
        lifecycleState: typeof existingMetadata?.lifecycleState === 'string'
            ? existingMetadata.lifecycleState
            : 'imported',
        lifecycleStateSince: typeof existingMetadata?.lifecycleStateSince === 'number'
            ? existingMetadata.lifecycleStateSince
            : now
    }
}

function stableSerialize(value: unknown): string {
    if (value === null || value === undefined) {
        return String(value)
    }
    if (typeof value === 'string') {
        return JSON.stringify(value)
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return JSON.stringify(value)
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableSerialize(item)).join(',')}]`
    }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>
        const keys = Object.keys(record).sort()
        return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`
    }
    return JSON.stringify(value)
}

function normalizeComparableText(value: string): string {
    return value.replace(/\s+$/u, '')
}

function normalizeComparableAgentData(value: unknown): unknown {
    const record = asRecord(value)
    if (!record) {
        return value
    }

    const normalized = { ...record }
    if ('id' in normalized) {
        delete normalized.id
    }
    return normalized
}

function normalizeComparableContent(content: unknown): string | null {
    const record = asRecord(content)
    if (!record) {
        return null
    }

    if (record.role === 'user') {
        const body = asRecord(record.content)
        if (body?.type !== 'text' || typeof body.text !== 'string') {
            return null
        }
        return stableSerialize({
            role: 'user',
            text: normalizeComparableText(body.text)
        })
    }

    if (record.role === 'agent') {
        const body = asRecord(record.content)
        if (!body || body.type !== AGENT_MESSAGE_PAYLOAD_TYPE) {
            return null
        }
        return stableSerialize({
            role: 'agent',
            data: normalizeComparableAgentData(body.data)
        })
    }

    return null
}

function getComparableStoredMessageKey(message: StoredMessage): string {
    // 中文注释：重复会话合并时优先按标准 user/agent 结构去重；遇到非标准消息再回退到稳定序列化，确保不会遗漏相同内容。
    return normalizeComparableContent(message.content) ?? stableSerialize(message.content)
}

function collectImportCandidates(
    store: Store,
    namespace: string,
    getSyncEngine?: () => SyncEngine | null
): ImportCandidate[] {
    const engineSessions = getSyncEngine?.()?.getSessionsByNamespace(namespace) ?? []
    if (engineSessions.length > 0) {
        return engineSessions.map((session) => ({
            sessionId: session.id,
            active: session.active,
            updatedAt: session.updatedAt,
            metadata: asRecord(session.metadata)
        }))
    }

    return store.sessions.getSessionsByNamespace(namespace).map((session) => ({
        sessionId: session.id,
        active: session.active,
        updatedAt: session.updatedAt,
        metadata: asRecord(session.metadata)
    }))
}

function getCodexImportIds(metadata: Record<string, unknown> | null | undefined): string[] {
    return [metadata?.codexSessionId, metadata?.codexSourceSessionId]
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

function selectImportTargetSession(
    store: Store,
    candidates: ImportCandidate[],
    codexSessionId: string,
    importedComparableMessages: string[],
    sourceMachineId?: string | null
): ImportTargetSelection {
    const relatedCandidates = candidates
        .filter((candidate) => (
            candidate.metadata?.codexSessionId === codexSessionId
            || candidate.metadata?.codexSourceSessionId === codexSessionId
        ))
        .filter((candidate) => (
            !sourceMachineId
            || typeof candidate.metadata?.machineId !== 'string'
            || candidate.metadata.machineId === sourceMachineId
        ))
        .sort((a, b) => b.updatedAt - a.updatedAt)

    let bestSessionId: string | null = null
    let bestPrefixCount = -1

    for (const candidate of relatedCandidates) {
        const comparableMessages = store.messages.getAllMessages(candidate.sessionId)
            .map((message) => normalizeComparableContent(message.content))
            .filter((value): value is string => value !== null)

        if (comparableMessages.length > importedComparableMessages.length) {
            continue
        }

        let prefixMatches = true
        for (let index = 0; index < comparableMessages.length; index += 1) {
            if (comparableMessages[index] !== importedComparableMessages[index]) {
                prefixMatches = false
                break
            }
        }

        if (!prefixMatches) {
            continue
        }

        if (comparableMessages.length > bestPrefixCount) {
            bestPrefixCount = comparableMessages.length
            bestSessionId = candidate.sessionId
        }
    }

    return {
        sessionId: bestSessionId,
        comparablePrefixCount: Math.max(0, bestPrefixCount)
    }
}

function listDuplicateCodexSessionGroups(
    store: Store,
    namespace: string,
    codexSessionIds: string[],
    getSyncEngine?: () => SyncEngine | null
): DuplicateSessionGroupCandidate[] {
    const requestedSessionIds = new Set(codexSessionIds)
    if (requestedSessionIds.size === 0) {
        return []
    }

    const groups = new Map<string, ImportCandidate[]>()
    for (const candidate of collectImportCandidates(store, namespace, getSyncEngine)) {
        for (const codexSessionId of getCodexImportIds(candidate.metadata)) {
            if (!requestedSessionIds.has(codexSessionId)) {
                continue
            }

            const existing = groups.get(codexSessionId)
            if (existing) {
                existing.push(candidate)
            } else {
                groups.set(codexSessionId, [candidate])
            }
        }
    }

    return Array.from(groups.entries())
        .map(([codexSessionId, sessions]) => ({
            codexSessionId,
            sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt)
        }))
        .filter((group) => group.sessions.length > 1)
}

async function mergeDuplicateCodexSessionGroups(options: {
    store: Store
    namespace: string
    codexSessionIds: string[]
    getSyncEngine?: () => SyncEngine | null
}): Promise<CodexMergeDuplicateSessionsResponse> {
    const groups = listDuplicateCodexSessionGroups(
        options.store,
        options.namespace,
        options.codexSessionIds,
        options.getSyncEngine
    )
    if (groups.length === 0) {
        return {
            success: true,
            merged: [],
            mergedCount: 0
        }
    }

    const merged: CodexDuplicateSessionGroup[] = []
    for (const group of groups) {
        const result = await mergeSingleDuplicateCodexSessionGroup({
            group,
            store: options.store,
            namespace: options.namespace,
            getSyncEngine: options.getSyncEngine
        })
        merged.push(result)
    }

    return {
        success: true,
        merged,
        mergedCount: merged.length
    }
}

async function mergeSingleDuplicateCodexSessionGroup(options: {
    group: DuplicateSessionGroupCandidate
    store: Store
    namespace: string
    getSyncEngine?: () => SyncEngine | null
}): Promise<CodexDuplicateSessionGroup> {
    const engine = options.getSyncEngine?.() ?? null
    const sessionStates = options.group.sessions
        .map((candidate) => ({
            ...candidate,
            storedMessages: options.store.messages.getAllMessages(candidate.sessionId),
        }))
        .map((candidate) => ({
            ...candidate,
            comparableKeys: candidate.storedMessages.map((message) => getComparableStoredMessageKey(message))
        }))
        .sort((a, b) => {
            if (b.comparableKeys.length !== a.comparableKeys.length) {
                return b.comparableKeys.length - a.comparableKeys.length
            }
            if (b.updatedAt !== a.updatedAt) {
                return b.updatedAt - a.updatedAt
            }
            return a.sessionId.localeCompare(b.sessionId)
        })

    if (sessionStates.some((candidate) => candidate.active)) {
        throw new Error('当前会话仍处于活跃状态，请等待会话结束后重试')
    }

    const canonical = sessionStates[0]
    if (!canonical) {
        throw new Error(`No duplicate Hapi session found for Codex thread: ${options.group.codexSessionId}`)
    }

    const knownKeys = new Set(canonical.comparableKeys)
    const removedSessionIds: string[] = []
    const appendedMessages: StoredMessage[] = []
    let latestActivity = canonical.updatedAt

    for (const source of sessionStates.slice(1)) {
        latestActivity = Math.max(latestActivity, source.updatedAt)
        for (const message of source.storedMessages) {
            const comparableKey = getComparableStoredMessageKey(message)
            if (knownKeys.has(comparableKey)) {
                continue
            }

            const copied = options.store.messages.copyMessageToSession(canonical.sessionId, {
                content: message.content,
                createdAt: message.createdAt,
                localId: message.localId,
                invokedAt: message.invokedAt,
                scheduledAt: message.scheduledAt
            })
            knownKeys.add(comparableKey)
            appendedMessages.push(copied)
            latestActivity = Math.max(latestActivity, copied.invokedAt ?? copied.createdAt)
        }

        if (engine) {
            await engine.deleteSession(source.sessionId)
        } else {
            const deleted = options.store.sessions.deleteSession(source.sessionId, options.namespace)
            if (!deleted) {
                throw new Error(`Failed to delete duplicate Hapi session: ${source.sessionId}`)
            }
        }
        removedSessionIds.push(source.sessionId)
    }

    if (appendedMessages.length > 0) {
        emitImportedMessageEvents(engine, canonical.sessionId, appendedMessages)
    }

    if (engine) {
        engine.recordSessionActivity(canonical.sessionId, latestActivity)
        // 中文注释：即使这次只是删除重复分身、没有新增消息，也主动刷新 canonical 会话，确保左侧列表立刻收敛到合并后的状态。
        engine.handleRealtimeEvent({
            type: 'session-updated',
            sessionId: canonical.sessionId
        })
    } else {
        options.store.sessions.touchSessionUpdatedAt(canonical.sessionId, latestActivity, options.namespace)
    }

    return {
        codexSessionId: options.group.codexSessionId,
        hapiSessionIds: sessionStates.map((candidate) => candidate.sessionId),
        canonicalSessionId: canonical.sessionId,
        removedSessionIds
    }
}

function emitImportedMessageEvents(
    engine: SyncEngine | null,
    sessionId: string,
    appendedMessages: StoredMessage[]
): void {
    if (!engine) {
        return
    }

    // 中文注释：只有追加到已有 Hapi 会话时才逐条广播新增消息，确保当前打开的会话右侧消息区能立即刷新到最新 transcript。
    for (const message of appendedMessages) {
        engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId,
            message: {
                id: message.id,
                seq: message.seq,
                localId: message.localId ?? null,
                content: message.content,
                createdAt: message.createdAt,
                invokedAt: message.invokedAt
            }
        })
    }
}

function getPathExts(): string[] {
    if (process.platform !== 'win32') {
        return ['']
    }
    const fromEnv = (process.env.PATHEXT ?? '')
        .split(';')
        .map(ext => ext.trim().toLowerCase())
        .filter(Boolean)
    return Array.from(new Set(['', '.exe', '.cmd', '.bat', '.ps1', ...fromEnv]))
}

function findOnPath(commandName: string): string | null {
    if (commandName.includes('\\') || commandName.includes('/')) {
        return existsSync(commandName) ? commandName : null
    }

    const pathDirs = (process.env.PATH ?? '')
        .split(process.platform === 'win32' ? ';' : ':')
        .map(part => part.trim())
        .filter(Boolean)
    const extensions = getPathExts()

    for (const dir of pathDirs) {
        for (const ext of extensions) {
            const candidate = join(dir, commandName.endsWith(ext) ? commandName : `${commandName}${ext}`)
            if (existsSync(candidate)) {
                return candidate
            }
        }
    }

    return null
}

function getCodexLauncherCandidates(): string[] {
    return [
        process.env.HAPI_CODEX_COMMAND?.trim() ?? '',
        findOnPath('codex') ?? '',
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'codex.exe') : ''
    ].filter(Boolean)
}

function isCodexLauncherAvailable(): boolean {
    return getCodexLauncherCandidates().some(candidate => {
        try {
            return existsSync(candidate)
        } catch {
            return false
        }
    })
}

function isCodexDesktopPath(pathValue: string): boolean {
    return /\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:Codex|resources\\codex)\.exe$/i.test(pathValue)
}

function isCodexDesktopPackageInstalled(): boolean {
    if (process.platform !== 'win32') {
        return false
    }

    const command = [
        "$package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue",
        "if ($package) { 'true' } else { 'false' }"
    ].join('\n')

    for (const shell of ['pwsh', 'powershell.exe']) {
        try {
            const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-Command', command], {
                encoding: 'utf-8',
                timeout: 5000,
                windowsHide: true
            })
            if (result.status === 0) {
                return result.stdout.trim().toLowerCase().includes('true')
            }
        } catch {
            // Try next shell.
        }
    }

    return false
}

function isCodexDesktopInstallAvailable(): boolean {
    if (process.platform !== 'win32') {
        return isCodexLauncherAvailable()
    }

    if (isCodexDesktopPackageInstalled()) {
        return true
    }

    return getCodexLauncherCandidates().some(candidate => {
        try {
            return isCodexDesktopPath(candidate) && existsSync(candidate)
        } catch {
            return false
        }
    })
}

function isCodexDesktopRunning(): boolean {
    if (process.platform !== 'win32') {
        return false
    }

    const command = [
        "$targets = @(Get-CimInstance Win32_Process | Where-Object {",
        "    ($_.Name -ieq 'Codex.exe' -or $_.Name -ieq 'codex.exe') -and",
        "    $_.ExecutablePath -match '\\\\WindowsApps\\\\OpenAI\\.Codex_'",
        '})',
        "if ($targets.Count -gt 0) { 'true' } else { 'false' }"
    ].join('\n')

    for (const shell of ['pwsh', 'powershell.exe']) {
        try {
            const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-Command', command], {
                encoding: 'utf-8',
                timeout: 5000,
                windowsHide: true
            })
            if (result.status === 0) {
                return result.stdout.trim().toLowerCase().includes('true')
            }
        } catch {
            // Try next shell.
        }
    }

    return false
}

function getCodexDesktopStatus(): CodexDesktopStatus {
    const running = isCodexDesktopRunning()
    return {
        running,
        clientAvailable: running || isCodexDesktopInstallAvailable()
    }
}

function getScriptTimeoutMs(): number {
    const configured = Number(process.env.HAPI_CODEX_SCRIPT_TIMEOUT_MS)
    if (Number.isFinite(configured) && configured > 0) {
        return configured
    }
    return DEFAULT_SCRIPT_TIMEOUT_MS
}

function createLaunchArgs(scriptPath: string, workspace: string, scriptArgs: string[]): string[] {
    return [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-Workspace',
        workspace,
        ...scriptArgs
    ]
}

function appendScriptLog(workspace: string, kind: ScriptLogKind, message: string): void {
    try {
        const logDir = join(workspace, 'logs')
        mkdirSync(logDir, { recursive: true })
        const line = `[${new Date().toISOString()}] [${kind}] ${message}\n`
        appendFileSync(join(logDir, 'CodexDesktopScript.log'), line, 'utf-8')
    } catch {
        // Best-effort logging only; API response still carries the error.
    }
}

async function runPowerShellScript(scriptPath: string, workspace: string, scriptArgs: string[]): Promise<{ pid: number; command: string; output: string }> {
    const configuredPwsh = process.env.HAPI_PWSH_PATH?.trim()
    const candidates = Array.from(new Set([
        configuredPwsh || 'pwsh',
        'powershell.exe'
    ]))
    const args = createLaunchArgs(scriptPath, workspace, scriptArgs)
    let lastError: unknown = null

    for (const command of candidates) {
        try {
            return await new Promise((resolvePromise, rejectPromise) => {
                const output: string[] = []
                let settled = false
                let didSpawn = false
                let timeout: ReturnType<typeof setTimeout> | null = null
                const child = spawn(command, args, {
                    cwd: workspace,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true
                })

                const cleanup = () => {
                    if (timeout) {
                        clearTimeout(timeout)
                    }
                    child.off('spawn', onSpawn)
                    child.off('error', onError)
                    child.off('exit', onExit)
                }

                const settleResolve = (value: { pid: number; command: string; output: string }) => {
                    if (settled) return
                    settled = true
                    cleanup()
                    resolvePromise(value)
                }

                const settleReject = (error: Error) => {
                    if (settled) return
                    settled = true
                    cleanup()
                    rejectPromise(error)
                }

                const onSpawn = () => {
                    didSpawn = true
                }

                const onError = (error: Error) => {
                    if (!didSpawn) {
                        ;(error as Error & { shellLaunchFailed?: boolean }).shellLaunchFailed = true
                    }
                    settleReject(error)
                }

                const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
                    const combinedOutput = output.join('').trim()
                    if (code === 0) {
                        settleResolve({ pid: child.pid ?? 0, command, output: combinedOutput })
                        return
                    }
                    const detail = combinedOutput ? `\n${combinedOutput}` : ''
                    settleReject(new Error(`${command} exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}.${detail}`))
                }

                timeout = setTimeout(() => {
                    child.kill()
                    settleReject(new Error(SCRIPT_TIMEOUT_ERROR))
                }, getScriptTimeoutMs())

                child.stdout?.on('data', (chunk) => output.push(String(chunk)))
                child.stderr?.on('data', (chunk) => output.push(String(chunk)))
                child.once('spawn', onSpawn)
                child.once('error', onError)
                child.once('exit', onExit)
            })
        } catch (error) {
            lastError = error
            if (!(error instanceof Error && (error as Error & { shellLaunchFailed?: boolean }).shellLaunchFailed)) {
                throw error instanceof Error ? error : new Error(String(error))
            }
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function launchRestartScript(): Promise<ScriptLaunchResponse> {
    const scriptPath = getRestartScriptPath()
    const workspace = getWorkspace(scriptPath)

    if (!existsSync(scriptPath)) {
        appendScriptLog(workspace, 'restart', `FAILED: Script not found: ${scriptPath}`)
        return {
            success: false,
            error: `Script not found: ${scriptPath}`,
            script: scriptPath,
            cwd: workspace
        }
    }

    if (!existsSync(workspace)) {
        appendScriptLog(workspace, 'restart', `FAILED: Workspace not found: ${workspace}`)
        return {
            success: false,
            error: `Workspace not found: ${workspace}`,
            script: scriptPath,
            cwd: workspace
        }
    }

    try {
        const launched = await runPowerShellScript(scriptPath, workspace, RESTART_SCRIPT_ARGS)
        const output = launched.output
        appendScriptLog(
            workspace,
            'restart',
            `SUCCESS: ${RESTART_SCRIPT_MESSAGE}; pid=${launched.pid}; command=${launched.command}; script=${scriptPath}${output ? `; output=${output}` : ''}`
        )
        return {
            success: true,
            message: RESTART_SCRIPT_MESSAGE,
            pid: launched.pid,
            command: launched.command,
            script: scriptPath,
            cwd: workspace,
            output
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        appendScriptLog(workspace, 'restart', `FAILED: ${message}; script=${scriptPath}`)
        return {
            success: false,
            error: message,
            script: scriptPath,
            cwd: workspace
        }
    }
}

function parseSyncSessionRequest(body: unknown): SyncSessionRequestParseResult {
    // 中文注释：导入弹窗现在直接提交 Codex thread ID；未传 body 时按“未选择会话”处理，避免再回退到旧的默认最新会话逻辑。
    if (body === null || typeof body !== 'object' || Array.isArray(body) || !('sessionIds' in body)) {
        return { sessionIds: [] }
    }

    const bodyRecord = body as { sessionIds?: unknown; cwd?: unknown; machineId?: unknown; model?: unknown; modelReasoningEffort?: unknown; yolo?: unknown }
    const rawSessionIds = bodyRecord.sessionIds
    if (!Array.isArray(rawSessionIds)) {
        return { sessionIds: [], error: 'Invalid sessionIds' }
    }

    const sessionIds: string[] = []
    for (const value of rawSessionIds) {
        if (typeof value !== 'string') {
            return { sessionIds: [], error: 'Invalid sessionIds' }
        }
        const trimmed = value.trim()
        if (trimmed) {
            sessionIds.push(trimmed)
        }
    }

    const hasModel = Object.prototype.hasOwnProperty.call(bodyRecord, 'model')
    const hasModelReasoningEffort = Object.prototype.hasOwnProperty.call(bodyRecord, 'modelReasoningEffort')

    // 中文注释：前端允许多选，这里按 Codex thread 去重，避免重复导入同一条本地 transcript。
    return {
        sessionIds: Array.from(new Set(sessionIds)),
        cwd: typeof bodyRecord.cwd === 'string' && bodyRecord.cwd.trim() ? bodyRecord.cwd.trim() : null,
        machineId: typeof bodyRecord.machineId === 'string' && bodyRecord.machineId.trim() ? bodyRecord.machineId.trim() : null,
        model: hasModel ? (typeof bodyRecord.model === 'string' && bodyRecord.model.trim() ? bodyRecord.model.trim() : null) : undefined,
        modelReasoningEffort: hasModelReasoningEffort ? (typeof bodyRecord.modelReasoningEffort === 'string' && bodyRecord.modelReasoningEffort.trim() ? bodyRecord.modelReasoningEffort.trim() : null) : undefined,
        yolo: bodyRecord.yolo === true
    }
}

function combineSyncOutputs(results: ScriptLaunchResponse[]): string | undefined {
    const output = results
        .map((result, index) => {
            // 中文注释：direct import 不再依赖隐藏脚本；这里把每个会话的导入摘要拼成一段文本，便于前端或日志统一查看。
            const detail = result.success ? (result.output ?? '') : (result.output ?? result.error)
            return detail ? `[${index + 1}] ${detail}` : ''
        })
        .filter(Boolean)
        .join('\n\n')
        .trim()
    return output || undefined
}

function getDirectImportRouteContext(): { workspace: string } {
    return {
        workspace: getDirectImportWorkspace()
    }
}

function createImportErrorResponse(
    codexSessionIds: string[],
    error: string,
    syncedCount = 0
): ScriptLaunchResponse {
    const { workspace } = getDirectImportRouteContext()
    appendScriptLog(workspace, 'sync', `FAILED: ${error}; sessionIds=${codexSessionIds.join(',') || '(none)'}`)
    return {
        success: false,
        error,
        cwd: workspace,
        sessionIds: codexSessionIds,
        syncedCount
    }
}

function parseImportedHapiSessionId(output?: string): string | null {
    if (!output) return null
    const match = /^Hapi session:\s*(.+)$/m.exec(output)
    return match?.[1]?.trim() || null
}

function createImportSuccessResponse(
    codexSessionIds: string[],
    results: ScriptLaunchResponse[]
): ScriptLaunchResponse {
    const { workspace } = getDirectImportRouteContext()
    appendScriptLog(
        workspace,
        'sync',
        `SUCCESS: imported ${results.length} Codex session(s); sessionIds=${codexSessionIds.join(',')}`
    )
    return {
        success: true,
        message: `Imported ${results.length} Codex session(s) into Hapi`,
        pid: 0,
        command: DIRECT_IMPORT_COMMAND,
        cwd: workspace,
        output: combineSyncOutputs(results),
        sessionIds: codexSessionIds,
        hapiSessionIds: results.map((result) => parseImportedHapiSessionId(result.output)).filter((id): id is string => Boolean(id)),
        syncedCount: results.length
    }
}

function importSingleCodexSession(options: {
    codexSessionId: string
    localSessionsById: Map<string, CodexLocalSessionSummary | RemoteCodexSession>
    store: Store
    namespace: string
    getSyncEngine?: () => SyncEngine | null
    model?: string | null
    modelReasoningEffort?: string | null
    yolo?: boolean
    machineId?: string | null
}): ScriptLaunchResponse {
    const summary = options.localSessionsById.get(options.codexSessionId)
    if (!summary) {
        return {
            ...createImportErrorResponse([options.codexSessionId], `Transcript not found for Codex session: ${options.codexSessionId}`),
            output: `未找到对应的本地 transcript：${options.codexSessionId}`
        }
    }

    const transcript = 'messages' in summary && Array.isArray((summary as RemoteCodexSession).messages)
        ? summary as RemoteCodexSession
        : parseCodexTranscriptImportData(summary)
    if (!transcript) {
        return {
            ...createImportErrorResponse([options.codexSessionId], `Failed to parse Codex transcript: ${summary.file}`),
            output: `解析 transcript 失败：${summary.file}`
        }
    }

    if (transcript.messages.length === 0) {
        return {
            ...createImportErrorResponse([options.codexSessionId], `No importable conversation content found in transcript: ${summary.file}`),
            output: `transcript 中没有可导入的会话内容：${summary.file}`
        }
    }

    const importedComparableMessages = transcript.messages
        .map((message) => normalizeComparableContent(message))
        .filter((value): value is string => value !== null)

    try {
        const candidates = collectImportCandidates(options.store, options.namespace, options.getSyncEngine)
        const target = selectImportTargetSession(
            options.store,
            candidates,
            options.codexSessionId,
            importedComparableMessages,
            options.machineId
        )
        const engine = options.getSyncEngine?.() ?? null
        const existingStored = target.sessionId ? options.store.sessions.getSessionByNamespace(target.sessionId, options.namespace) : null
        const metadata = buildImportedSessionMetadata(
            transcript,
            asRecord(existingStored?.metadata),
            options.machineId ?? resolveImportMachineId(transcript.cwd, options.namespace, engine) ?? undefined,
            options.yolo ? 'yolo' : undefined
        )

        let sessionId = existingStored?.id ?? null
        let created = false
        if (!sessionId) {
            // 中文注释：找不到可安全续写的历史会话时，直接新建一个 Hapi 会话，避免把已分叉的数据硬写进旧会话。
            const createdSession = engine?.getOrCreateSession(
                randomUUID(),
                metadata,
                {},
                options.namespace,
                options.model ?? undefined,
                undefined,
                options.modelReasoningEffort ?? undefined
            ) ?? options.store.sessions.getOrCreateSession(randomUUID(), metadata, {}, options.namespace, options.model ?? undefined, undefined, options.modelReasoningEffort ?? undefined)
            sessionId = createdSession.id
            created = true
        } else if (existingStored) {
            const updatedMetadata = options.store.sessions.updateSessionMetadata(
                existingStored.id,
                metadata,
                existingStored.metadataVersion,
                options.namespace
            )
            if (updatedMetadata.result !== 'success') {
                throw new Error(`Failed to update metadata for Hapi session: ${existingStored.id}`)
            }
            if (options.model !== undefined) {
                options.store.sessions.setSessionModel(existingStored.id, options.model, options.namespace, { touchUpdatedAt: false })
            }
            if (options.modelReasoningEffort !== undefined) {
                options.store.sessions.setSessionModelReasoningEffort(existingStored.id, options.modelReasoningEffort, options.namespace, { touchUpdatedAt: false })
            }
            engine?.handleRealtimeEvent({ type: 'session-updated', sessionId: existingStored.id })
        }

        if (!sessionId) {
            throw new Error(`Failed to determine target Hapi session for Codex thread: ${options.codexSessionId}`)
        }

        const comparablePrefixCount = sessionId ? target.comparablePrefixCount : 0
        const messagesToAppend = transcript.messages.slice(comparablePrefixCount)
        const targetIsActive = Boolean(candidates.find((candidate) => candidate.sessionId === sessionId)?.active)
        if (targetIsActive && messagesToAppend.length > 0) {
            throw new Error('当前会话正在运行且 Codex transcript 有新消息，停止或归档后再同步，避免消息顺序错乱')
        }
        const appendedMessages = messagesToAppend.map((message) => options.store.messages.addMessage(sessionId!, message))

        // 中文注释：更新 Hapi 会话的 updatedAt，并在已有会话追加时广播新增消息，让当前打开的聊天页立刻显示客户端新增内容。
        const latestMessageCreatedAt = appendedMessages[appendedMessages.length - 1]?.createdAt ?? Date.now()
        if (engine) {
            engine.recordSessionActivity(sessionId, latestMessageCreatedAt)
        } else {
            options.store.sessions.touchSessionUpdatedAt(sessionId, latestMessageCreatedAt, options.namespace)
        }
        if (!created) {
            emitImportedMessageEvents(engine, sessionId, appendedMessages)
        }

        const output = [
            `Codex thread: ${options.codexSessionId}`,
            `Hapi session: ${sessionId}`,
            `Action: ${created ? 'created' : 'updated'}`,
            `Appended messages: ${appendedMessages.length}`
        ].join('\n')

        appendScriptLog(
            getDirectImportRouteContext().workspace,
            'sync',
            `SUCCESS: codexSessionId=${options.codexSessionId}; hapiSessionId=${sessionId}; created=${created}; appended=${appendedMessages.length}`
        )

        return {
            success: true,
            message: created ? 'Codex session imported into a new Hapi session' : 'Codex session appended to existing Hapi session',
            pid: 0,
            command: DIRECT_IMPORT_COMMAND,
            cwd: getDirectImportRouteContext().workspace,
            output,
            sessionIds: [options.codexSessionId],
            hapiSessionIds: [sessionId],
            syncedCount: 1
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
            ...createImportErrorResponse([options.codexSessionId], message),
            output: `Codex thread: ${options.codexSessionId}\n${message}`
        }
    }
}

export async function importSelectedCodexSessions(options: {
    codexSessionIds: string[]
    store: Store
    namespace: string
    getSyncEngine?: () => SyncEngine | null
    localSessions?: RemoteCodexSession[]
    model?: string | null
    modelReasoningEffort?: string | null
    yolo?: boolean
    machineId?: string | null
}): Promise<ScriptLaunchResponse> {
    const codexSessionIds = options.codexSessionIds
    if (codexSessionIds.length === 0) {
        return createImportErrorResponse(codexSessionIds, NO_SYNC_SESSION_SELECTED_ERROR)
    }

    const localSessionsById = new Map((options.localSessions ?? listLocalCodexSessions()).map((session) => [session.id, session]))
    const results: ScriptLaunchResponse[] = []
    for (const codexSessionId of codexSessionIds) {
        const result = importSingleCodexSession({
            codexSessionId,
            localSessionsById,
            store: options.store,
            namespace: options.namespace,
            getSyncEngine: options.getSyncEngine,
            model: options.model,
            modelReasoningEffort: options.modelReasoningEffort,
            yolo: options.yolo,
            machineId: options.machineId
        })
        results.push(result)

        if (!result.success) {
            return {
                ...result,
                sessionIds: codexSessionIds,
                syncedCount: Math.max(0, results.length - 1),
                output: combineSyncOutputs(results) ?? result.output
            }
        }
    }

    return createImportSuccessResponse(codexSessionIds, results)
}

export function createCodexDesktopRoutes(options: {
    store: Store
    getSyncEngine: () => SyncEngine | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.use('/codex/*', async (c, next) => {
        if (c.get('namespace') !== 'default') {
            return c.json({
                success: false,
                error: CODEX_TRANSCRIPT_IMPORT_NAMESPACE_ERROR
            }, 403)
        }
        return next()
    })

    app.get('/codex/status', (c) => {
        const codexStatus = getCodexDesktopStatus()
        return c.json({
            success: true,
            codexDesktopRunning: codexStatus.running,
            codexClientAvailable: codexStatus.clientAvailable
        } satisfies CodexDesktopStatusResponse)
    })

    app.get('/codex/sessions', async (c) => {
        const cwd = c.req.query('cwd')?.trim() || null
        const machineId = c.req.query('machineId')?.trim() || null
        const remote = await listCodexSessionsViaMachine({
            engine: options.getSyncEngine(),
            namespace: c.get('namespace'),
            cwd,
            machineId
        })
        if (remote.error) {
            return c.json({
                success: false,
                error: remote.error,
                sessions: [],
                ...(remote.machineId ? { machineId: remote.machineId } : {})
            } satisfies CodexLocalSessionsResponse, 503)
        }
        return c.json({
            success: true,
            sessions: remote.sessions.map(({ messages: _messages, ...summary }) => summary),
            ...(remote.machineId ? { machineId: remote.machineId } : {})
        } satisfies CodexLocalSessionsResponse)
    })


    app.post('/codex/archive-session', async (c) => {
        const body = await c.req.json().catch(() => null)
        const record = asRecord(body)
        const sessionId = typeof record?.sessionId === 'string' ? record.sessionId.trim() : ''
        const requestedMachineId = typeof record?.machineId === 'string' ? record.machineId.trim() : null
        if (!sessionId) {
            return c.json({ success: false, error: 'sessionId is required' }, 400)
        }

        const engine = options.getSyncEngine()
        const machineId = resolveCodexImportMachineId(null, c.get('namespace'), engine, requestedMachineId)
        if (!engine || !machineId) {
            return c.json({ success: false, error: 'No online machine available for Codex history archive' }, 503)
        }

        const result = await engine.archiveCodexSessionForMachine(machineId, sessionId)
        if (!result || typeof result !== 'object') {
            return c.json({ success: false, error: 'Unexpected Codex archive RPC response', machineId }, 500)
        }
        if ((result as { success?: unknown }).success !== true) {
            const error = typeof (result as { error?: unknown }).error === 'string'
                ? (result as { error: string }).error
                : 'Failed to archive Codex session'
            return c.json({ success: false, error, machineId }, 500)
        }
        return c.json({ success: true, archivedPath: (result as { archivedPath: string }).archivedPath, machineId })
    })

    app.post('/codex/sync-session', async (c) => {
        const codexStatus = getCodexDesktopStatus()
        const body = await c.req.json().catch(() => null)
        const parsed = parseSyncSessionRequest(body)
        if (parsed.error) {
            const { workspace } = getDirectImportRouteContext()
            appendScriptLog(workspace, 'sync', `FAILED: ${parsed.error}`)
            return c.json({
                success: false,
                error: parsed.error,
                cwd: workspace,
                codexDesktopRunning: codexStatus.running,
                codexClientAvailable: codexStatus.clientAvailable
            })
        }

        // 中文注释：hub 可能运行在服务器上；Codex transcript 必须通过用户本机 runner RPC 读取，不能扫描服务器磁盘。
        const remote = await listCodexSessionsViaMachine({
            engine: options.getSyncEngine(),
            namespace: c.get('namespace'),
            cwd: parsed.cwd,
            machineId: parsed.machineId,
            sessionIds: parsed.sessionIds
        })
        if (remote.error) {
            const { workspace } = getDirectImportRouteContext()
            return c.json({
                success: false,
                error: remote.error,
                cwd: workspace,
                codexDesktopRunning: codexStatus.running,
                codexClientAvailable: codexStatus.clientAvailable
            })
        }
        const result = await importSelectedCodexSessions({
            codexSessionIds: parsed.sessionIds,
            store: options.store,
            namespace: c.get('namespace'),
            getSyncEngine: options.getSyncEngine,
            localSessions: remote.sessions,
            machineId: remote.machineId ?? null,
            model: parsed.model,
            modelReasoningEffort: parsed.modelReasoningEffort,
            yolo: parsed.yolo
        })
        return c.json({
            ...result,
            codexDesktopRunning: codexStatus.running,
            codexClientAvailable: codexStatus.clientAvailable
        })
    })

    app.post('/codex/duplicate-sessions', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = parseSyncSessionRequest(body)
        if (parsed.error) {
            return c.json({
                success: false,
                error: parsed.error
            } satisfies CodexDuplicateSessionsResponse)
        }

        if (parsed.sessionIds.length === 0) {
            return c.json({
                success: false,
                error: NO_SYNC_SESSION_SELECTED_ERROR
            } satisfies CodexDuplicateSessionsResponse)
        }

        // 中文注释：这里只检查本次导入弹窗里勾选过的 codexSessionId；未选中的会话即使也有重复，也不参与本轮提示。
        const duplicates = listDuplicateCodexSessionGroups(
            options.store,
            c.get('namespace'),
            parsed.sessionIds,
            options.getSyncEngine
        ).map((group) => ({
            codexSessionId: group.codexSessionId,
            hapiSessionIds: group.sessions.map((session) => session.sessionId)
        }))

        return c.json({
            success: true,
            duplicates
        } satisfies CodexDuplicateSessionsResponse)
    })

    app.post('/codex/merge-duplicate-sessions', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = parseSyncSessionRequest(body)
        if (parsed.error) {
            return c.json({
                success: false,
                error: parsed.error
            } satisfies CodexMergeDuplicateSessionsResponse)
        }

        if (parsed.sessionIds.length === 0) {
            return c.json({
                success: false,
                error: NO_SYNC_SESSION_SELECTED_ERROR
            } satisfies CodexMergeDuplicateSessionsResponse)
        }

        const { workspace } = getDirectImportRouteContext()
        try {
            // 中文注释：真正执行合并时仍然只按这次选中的 codexSessionId 收口，防止顺手把别的会话历史也改掉。
            const result = await mergeDuplicateCodexSessionGroups({
                store: options.store,
                namespace: c.get('namespace'),
                codexSessionIds: parsed.sessionIds,
                getSyncEngine: options.getSyncEngine
            })
            appendScriptLog(
                workspace,
                'sync',
                `SUCCESS: merged duplicate Hapi sessions for selected codexSessionIds=${parsed.sessionIds.join(',')}`
            )
            return c.json(result satisfies CodexMergeDuplicateSessionsResponse)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            appendScriptLog(
                workspace,
                'sync',
                `FAILED: duplicate-session merge error=${message}; selectedCodexSessionIds=${parsed.sessionIds.join(',')}`
            )
            return c.json({
                success: false,
                error: message
            } satisfies CodexMergeDuplicateSessionsResponse)
        }
    })

    app.post('/codex/restart-desktop', async (c) => {
        const codexStatus = getCodexDesktopStatus()
        if (!codexStatus.clientAvailable) {
            const scriptPath = getRestartScriptPath()
            const workspace = getWorkspace(scriptPath)
            const error = CODEX_DESKTOP_NOT_FOUND_ERROR
            appendScriptLog(workspace, 'restart', `FAILED: ${error}; script=${scriptPath}`)
            return c.json({
                success: false,
                error,
                script: scriptPath,
                cwd: workspace,
                codexDesktopRunning: codexStatus.running,
                codexClientAvailable: codexStatus.clientAvailable
            })
        }

        const result = await launchRestartScript()
        return c.json({
            ...result,
            codexDesktopRunning: codexStatus.running,
            codexClientAvailable: codexStatus.clientAvailable
        })
    })

    return app
}
