import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
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
    NO_SYNC_SESSION_SELECTED_ERROR,
    appendScriptLog,
    asRecord,
    asString,
    buildImportedAgentMessage,
    buildImportedUserMessage,
    getDirectImportRouteContext,
    importSelectedSessions,
    listDuplicateSessionGroups,
    mergeDuplicateSessionGroups,
    parseImportedTimestamp,
    parseSyncSessionRequest,
    truncateText
} from './transcriptImport'

type ScriptLogKind = 'sync' | 'restart'

const RESTART_SCRIPT_ENV_NAME = 'HAPI_CODEX_RESTART_SCRIPT'
const RESTART_SCRIPT_DEFAULT_FILE = 'Restart-CodexDesktop.ps1'
const RESTART_SCRIPT_ARGS = ['-Apply']
const RESTART_SCRIPT_MESSAGE = 'Codex Desktop restart script started'

type CodexDesktopStatus = {
    running: boolean
    clientAvailable: boolean
}

type CodexDesktopStatusResponse = {
    success: true
    codexDesktopRunning: boolean
    codexClientAvailable: boolean
}

type CodexLocalSessionsResponse = {
    success: true
    sessions: LocalSessionSummary[]
}

type CodexDuplicateSessionGroup = {
    codexSessionId: string
    hapiSessionIds: string[]
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
    merged: { codexSessionId: string; hapiSessionIds: string[]; canonicalSessionId?: string; removedSessionIds?: string[] }[]
    mergedCount: number
} | {
    success: false
    error: string
}

const CODEX_SESSION_ID_KEY = 'codexSessionId'
const CODEX_DESKTOP_NOT_FOUND_ERROR = '尝试重启codex客户端失败，未安装/找不到codex客户端'
const SCRIPT_TIMEOUT_ERROR = '执行超时'
const CODEX_TRANSCRIPT_IMPORT_NAMESPACE_ERROR = 'Codex transcript import is not available outside the default namespace'
const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000

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

function shouldIgnoreSyntheticUserMessage(text: string): boolean {
    const normalized = text.trim()
    return normalized.startsWith('# AGENTS.md instructions')
        || normalized.startsWith('<environment_context>')
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
            if (text && !shouldIgnoreSyntheticUserMessage(text)) {
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
    changedTitle: string | null,
    firstUserMessage: string | null
): string {
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

function parseCodexLocalSession(filePath: string): LocalSessionSummary | null {
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
                if (text && !shouldIgnoreSyntheticUserMessage(text)) {
                    firstUserMessage = text
                }
            }
        }
    }

    const changedTitle = getLatestCodexChangedTitle(allLines)
    const lastUserMessage = getLatestCodexUserMessage(allLines)

    sessionId = sessionId ?? inferSessionIdFromFileName(filePath)
    if (!sessionId) return null

    let modifiedAt = Date.now()
    try {
        modifiedAt = statSync(filePath).mtimeMs
    } catch {
        // Fall back to current time if stat fails during a concurrent file change.
    }

    return {
        id: sessionId,
        title: getCodexSessionTitle(cwd, sessionId, changedTitle, firstUserMessage),
        lastUserMessage,
        cwd,
        file: filePath,
        modifiedAt,
        originator,
        cliVersion
    }
}

function listLocalCodexSessions(limit = DEFAULT_SESSION_SCAN_LIMIT): LocalSessionSummary[] {
    const files: string[] = []
    for (const root of getCodexSessionRoots()) {
        collectJsonlFiles(root, files)
    }

    const deduped = new Map<string, LocalSessionSummary>()
    for (const filePath of files) {
        const session = parseCodexLocalSession(filePath)
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

function convertCodexRecordToImportedMessage(record: Record<string, unknown>): ImportedMessageContent | null {
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
            if (!text || shouldIgnoreSyntheticUserMessage(text)) {
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
            if (!text || shouldIgnoreSyntheticUserMessage(text)) {
                return null
            }
            if (role === 'user') {
                return buildImportedUserMessage(text)
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

function parseCodexTranscriptImportData(summary: LocalSessionSummary): TranscriptImportData | null {
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
        const content = convertCodexRecordToImportedMessage(record)
        if (content) {
            // 中文注释：Codex rollout 记录在顶层 `timestamp` 带 ISO 时间串（payload 内还有一份，取顶层即可），
            // 随消息一起落库以保留原始时间线。
            messages.push({ content, createdAt: parseImportedTimestamp(record.timestamp) })
        }
    }

    return {
        ...summary,
        messages
    }
}

// 中文注释：codexAdapter 把 Codex 专属的扫描/解析封装成通用 ImporterAdapter，落库/同步/去重交给 transcriptImport 共享引擎。
const codexAdapter: ImporterAdapter = {
    flavor: 'codex',
    sessionIdKey: CODEX_SESSION_ID_KEY,
    listLocalSessions: (limit) => listLocalCodexSessions(limit),
    parseTranscript: (summary) => parseCodexTranscriptImportData(summary)
}

export async function importSelectedCodexSessions(options: {
    codexSessionIds: string[]
    store: Store
    namespace: string
    getSyncEngine?: () => SyncEngine | null
}): Promise<ScriptLaunchResponse> {
    return importSelectedSessions({
        adapter: codexAdapter,
        sessionIds: options.codexSessionIds,
        store: options.store,
        namespace: options.namespace,
        getSyncEngine: options.getSyncEngine
    })
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

function appendRestartScriptLog(workspace: string, kind: ScriptLogKind, message: string): void {
    appendScriptLog(workspace, kind, message)
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
        appendRestartScriptLog(workspace, 'restart', `FAILED: Script not found: ${scriptPath}`)
        return {
            success: false,
            error: `Script not found: ${scriptPath}`,
            script: scriptPath,
            cwd: workspace
        }
    }

    if (!existsSync(workspace)) {
        appendRestartScriptLog(workspace, 'restart', `FAILED: Workspace not found: ${workspace}`)
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
        appendRestartScriptLog(
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
        appendRestartScriptLog(workspace, 'restart', `FAILED: ${message}; script=${scriptPath}`)
        return {
            success: false,
            error: message,
            script: scriptPath,
            cwd: workspace
        }
    }
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

    app.get('/codex/sessions', (c) => {
        return c.json({
            success: true,
            sessions: listLocalCodexSessions()
        } satisfies CodexLocalSessionsResponse)
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

        // 中文注释：这里直接读取本地 transcript 写入 Hapi store，不再启动隐藏 codex resume 进程，避免漏导入客户端新增内容。
        const result = await importSelectedCodexSessions({
            codexSessionIds: parsed.sessionIds,
            store: options.store,
            namespace: c.get('namespace'),
            getSyncEngine: options.getSyncEngine
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
        const duplicates = listDuplicateSessionGroups(
            options.store,
            c.get('namespace'),
            CODEX_SESSION_ID_KEY,
            parsed.sessionIds,
            options.getSyncEngine
        ).map((group) => ({
            codexSessionId: group.flavorSessionId,
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
            const result = await mergeDuplicateSessionGroups({
                store: options.store,
                namespace: c.get('namespace'),
                sessionIdKey: CODEX_SESSION_ID_KEY,
                flavorSessionIds: parsed.sessionIds,
                getSyncEngine: options.getSyncEngine
            })
            appendScriptLog(
                workspace,
                'sync',
                `SUCCESS: merged duplicate Hapi sessions for selected codexSessionIds=${parsed.sessionIds.join(',')}`
            )
            if (!result.success) {
                return c.json(result satisfies CodexMergeDuplicateSessionsResponse)
            }
            // 中文注释：对外字段保持 codexSessionId 命名不变，避免破坏既有前端契约。
            return c.json({
                success: true,
                merged: result.merged.map((group) => ({
                    codexSessionId: group.sessionId,
                    hapiSessionIds: group.hapiSessionIds,
                    canonicalSessionId: group.canonicalSessionId,
                    removedSessionIds: group.removedSessionIds
                })),
                mergedCount: result.mergedCount
            } satisfies CodexMergeDuplicateSessionsResponse)
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
            appendRestartScriptLog(workspace, 'restart', `FAILED: ${error}; script=${scriptPath}`)
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
