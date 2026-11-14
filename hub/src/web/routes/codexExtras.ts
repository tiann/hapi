import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import type { Store, StoredMessage } from '../../store'
import { truncateOversizedMessageContent } from '../../store/contentCodec'
import type { SyncEngine } from '../../sync/syncEngine'
import { collectImportCandidates, type ImportCandidate } from './localSessions/matchContentPrefix'

// The canonical candidate collection lives with the generic matcher; the
// Codex sidecar re-exports it so the route module keeps its import surface.
export { collectImportCandidates } from './localSessions/matchContentPrefix'
export type { ImportCandidate } from './localSessions/matchContentPrefix'

/**
 * Codex sidecar capabilities that live outside the import path:
 * desktop status/restart, duplicate detection/merge, script logs and the
 * shared content-compare helpers. The generic import path never calls these;
 * the Codex route wrappers do.
 */

export const CODEX_DESKTOP_NOT_FOUND_ERROR = '尝试重启codex客户端失败，未安装/找不到codex客户端'
export const SCRIPT_TIMEOUT_ERROR = '执行超时'
export const CODEX_TRANSCRIPT_IMPORT_NAMESPACE_ERROR = 'Codex transcript import is not available outside the default namespace'
const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000
const DARWIN_CODEX_APP_NAME = 'Codex'
const DARWIN_CODEX_APP_CANDIDATES = [
    '/Applications/Codex.app',
    join(homedir(), 'Applications', 'Codex.app')
]

// --- script log + workspace helpers ---------------------------------------

type ScriptLogKind = 'sync' | 'restart'

export const DIRECT_IMPORT_COMMAND = 'direct-import'
const RESTART_SCRIPT_ENV_NAME = 'HAPI_CODEX_RESTART_SCRIPT'
const RESTART_SCRIPT_DEFAULT_FILE = 'Restart-CodexDesktop.ps1'
const RESTART_SCRIPT_ARGS = ['-Apply']
const RESTART_SCRIPT_MESSAGE = 'Codex Desktop restart script started'

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

export function getRestartScriptPath(): string {
    const configured = process.env[RESTART_SCRIPT_ENV_NAME]?.trim()
    return configured ? resolveLocalPath(configured) : getDefaultScriptPath(RESTART_SCRIPT_DEFAULT_FILE)
}

function getWorkspace(scriptPath: string): string {
    const configured = process.env.HAPI_CODEX_WORKSPACE?.trim()
    return configured ? resolveLocalPath(configured) : dirname(scriptPath)
}

export function getRestartScriptWorkspace(): string {
    return getWorkspace(getRestartScriptPath())
}

export function getDirectImportWorkspace(): string {
    const configured = process.env.HAPI_CODEX_WORKSPACE?.trim()
    return configured ? resolveLocalPath(configured) : process.cwd()
}

export function getDirectImportRouteContext(): { workspace: string } {
    return {
        workspace: getDirectImportWorkspace()
    }
}

export function appendScriptLog(workspace: string, kind: ScriptLogKind, message: string): void {
    try {
        const logDir = join(workspace, 'logs')
        mkdirSync(logDir, { recursive: true })
        const line = `[${new Date().toISOString()}] [${kind}] ${message}\n`
        appendFileSync(join(logDir, 'CodexDesktopScript.log'), line, 'utf-8')
    } catch {
        // Best-effort logging only; API response still carries the error.
    }
}

// --- desktop status --------------------------------------------------------

export type CodexDesktopStatus = {
    running: boolean
    clientAvailable: boolean
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

function getDarwinCodexAppCandidates(): string[] {
    return [
        process.env.HAPI_CODEX_APP_PATH?.trim() ?? '',
        ...DARWIN_CODEX_APP_CANDIDATES
    ].filter(Boolean)
}

function isDarwinCodexAppInstalled(): boolean {
    return getDarwinCodexAppCandidates().some(candidate => {
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
    if (process.platform === 'darwin') {
        return isDarwinCodexAppInstalled() || isCodexLauncherAvailable()
    }

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
    if (process.platform === 'darwin') {
        try {
            const result = spawnSync('pgrep', ['-x', DARWIN_CODEX_APP_NAME], {
                encoding: 'utf-8',
                timeout: 5000
            })
            return result.status === 0
        } catch {
            return false
        }
    }

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

export function getCodexDesktopStatus(): CodexDesktopStatus {
    const running = isCodexDesktopRunning()
    return {
        running,
        clientAvailable: running || isCodexDesktopInstallAvailable()
    }
}

export type CodexDesktopStatusResponse = {
    success: true
    codexDesktopRunning: boolean
    codexClientAvailable: boolean
}

// --- restart ---------------------------------------------------------------

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

function getDarwinCodexOpenTarget(): string {
    return getDarwinCodexAppCandidates().find((candidate) => {
        try {
            return existsSync(candidate)
        } catch {
            return false
        }
    }) ?? DARWIN_CODEX_APP_NAME
}

export function getDarwinCodexOpenArgs(target: string): string[] {
    return target.endsWith('.app') ? [target] : ['-a', target]
}

async function restartDarwinCodexDesktop(workspace: string): Promise<{ pid: number; command: string; output: string }> {
    const output: string[] = []
    try {
        const quit = spawnSync('osascript', ['-e', `tell application "${DARWIN_CODEX_APP_NAME}" to quit`], {
            encoding: 'utf-8',
            timeout: 5000
        })
        const quitOutput = `${quit.stdout ?? ''}${quit.stderr ?? ''}`.trim()
        if (quitOutput) {
            output.push(quitOutput)
        }
    } catch (error) {
        output.push(error instanceof Error ? error.message : String(error))
    }

    return await new Promise((resolvePromise, rejectPromise) => {
        const target = getDarwinCodexOpenTarget()
        const child = spawn('open', getDarwinCodexOpenArgs(target), {
            cwd: workspace,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe']
        })
        const launchOutput: string[] = []
        let settled = false
        let timeout: ReturnType<typeof setTimeout> | null = null

        const cleanup = () => {
            if (timeout) {
                clearTimeout(timeout)
            }
            child.off('error', onError)
            child.off('exit', onExit)
        }

        const settle = (callback: () => void) => {
            if (settled) return
            settled = true
            cleanup()
            callback()
        }

        const onError = (error: Error) => {
            settle(() => rejectPromise(error))
        }

        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            const combinedLaunchOutput = launchOutput.join('').trim()
            if (combinedLaunchOutput) {
                output.push(combinedLaunchOutput)
            }
            if (code === 0) {
                child.unref()
                settle(() => resolvePromise({
                    pid: child.pid ?? 0,
                    command: 'open',
                    output: output.join('\n').trim()
                }))
                return
            }
            const detail = output.length > 0 ? `\n${output.join('\n')}` : ''
            settle(() => rejectPromise(new Error(`open exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}.${detail}`)))
        }

        timeout = setTimeout(() => {
            child.kill()
            settle(() => rejectPromise(new Error(SCRIPT_TIMEOUT_ERROR)))
        }, getScriptTimeoutMs())

        child.stdout?.on('data', (chunk) => launchOutput.push(String(chunk)))
        child.stderr?.on('data', (chunk) => launchOutput.push(String(chunk)))
        child.once('error', onError)
        child.once('exit', onExit)
    })
}

export async function launchRestartScript(): Promise<ScriptLaunchResponse> {
    const scriptPath = getRestartScriptPath()
    const workspace = getWorkspace(scriptPath)

    if (!existsSync(scriptPath)) {
        if (process.platform === 'darwin' && !process.env[RESTART_SCRIPT_ENV_NAME]?.trim()) {
            try {
                const launched = await restartDarwinCodexDesktop(workspace)
                const output = launched.output
                appendScriptLog(
                    workspace,
                    'restart',
                    `SUCCESS: ${RESTART_SCRIPT_MESSAGE}; pid=${launched.pid}; command=${launched.command}${output ? `; output=${output}` : ''}`
                )
                return {
                    success: true,
                    message: RESTART_SCRIPT_MESSAGE,
                    pid: launched.pid,
                    command: launched.command,
                    cwd: workspace,
                    output
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                appendScriptLog(workspace, 'restart', `FAILED: ${message}; native=darwin`)
                return {
                    success: false,
                    error: message,
                    cwd: workspace
                }
            }
        }

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

// --- shared response + compare helpers --------------------------------------

export type ScriptLaunchResponse = {
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

export function stableSerialize(value: unknown): string {
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

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
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

export function normalizeComparableContent(content: unknown): string | null {
    // Stored rows are truncated at ingest (contentCodec) while transcript
    // messages arrive in full; truncation is idempotent, so applying it here
    // makes both sides of the prefix comparison canonical. Pre-codec stored
    // rows (never truncated) get normalized the same way.
    const record = asRecord(truncateOversizedMessageContent(content))
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

export function getComparableStoredMessageKey(message: StoredMessage): string {
    // 重复会话合并时优先按标准 user/agent 结构去重；遇到非标准消息再回退到稳定序列化，确保不会遗漏相同内容。
    // Fallback also truncates so a pre-codec (full) row and a post-codec
    // (truncated) copy of the same message still dedupe to one key.
    return normalizeComparableContent(message.content) ?? stableSerialize(truncateOversizedMessageContent(message.content))
}

// --- duplicate detection / merge ---------------------------------------------

export function getCodexImportIds(metadata: Record<string, unknown> | null | undefined): string[] {
    return Array.from(new Set([metadata?.codexSessionId, metadata?.codexSourceSessionId]
        .filter((id): id is string => typeof id === 'string' && id.length > 0)))
}

export function isImportCandidateReusable(candidate: ImportCandidate): boolean {
    const lifecycleState = candidate.metadata?.lifecycleState
    if (lifecycleState === 'archived' || lifecycleState === 'deleted') {
        return false
    }
    return true
}

export type CodexDuplicateSessionGroup = {
    codexSessionId: string
    hapiSessionIds: string[]
    canonicalSessionId?: string
    removedSessionIds?: string[]
}

export type CodexDuplicateSessionsResponse = {
    success: true
    duplicates: CodexDuplicateSessionGroup[]
} | {
    success: false
    error: string
}

export type CodexMergeDuplicateSessionsResponse = {
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

export function listDuplicateCodexSessionGroups(
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
        if (!candidate.persisted || !isImportCandidateReusable(candidate)) {
            continue
        }
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

export function emitImportedMessageEvents(
    engine: SyncEngine | null,
    sessionId: string,
    appendedMessages: StoredMessage[]
): void {
    if (!engine) {
        return
    }

    // 只有追加到已有 Hapi 会话时才逐条广播新增消息，确保当前打开的会话右侧消息区能立即刷新到最新 transcript。
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

async function mergeSingleDuplicateCodexSessionGroup(options: {
    group: DuplicateSessionGroupCandidate
    store: Store
    namespace: string
    getSyncEngine?: () => SyncEngine | null
}): Promise<CodexDuplicateSessionGroup> {
    const engine = options.getSyncEngine?.() ?? null
    const uniqueSessions = Array.from(new Map(options.group.sessions.map((session) => [session.sessionId, session])).values())
    const sessionStates = uniqueSessions
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

    if (
        !engine
        && sessionStates.slice(1).some(
            (source) => options.store.sessionJobs.list(source.sessionId).length > 0
        )
    ) {
        throw new Error(
            'Sync engine unavailable; retry merge so attached-job redirects are preserved'
        )
    }

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

        // Transfer outliving jobs before CASCADE delete (store refuses running jobs).
        // Without SyncEngine we cannot persist jobsAcceptedFromSessionIds / key remaps,
        // so refuse rather than orphan a supervisor still holding the source session id.
        if (engine) {
            engine.transferAttachedJobs(source.sessionId, canonical.sessionId, options.namespace)
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
        // 即使这次只是删除重复分身、没有新增消息，也主动刷新 canonical 会话，确保左侧列表立刻收敛到合并后的状态。
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

export async function mergeDuplicateCodexSessionGroups(options: {
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