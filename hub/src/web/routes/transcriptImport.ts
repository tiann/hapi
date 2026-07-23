import { appendFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir, hostname, platform } from 'node:os'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { Store, StoredMessage } from '../../store'

// 中文注释：本文件收敛 Codex / Claude transcript 导入共用的“落库 / 同步 / 去重 / 响应”逻辑。
// 各 flavor 只需提供 ImporterAdapter（扫描路径 + 解析器 + flavor/metadata），不再复制粘贴第二份并行逻辑。

export type ScriptLogKind = 'sync' | 'restart'

export type TranscriptFlavor = 'codex' | 'claude'

export type ImportedMessageContent = {
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

// 中文注释：导入消息在落库前包一层 createdAt，保留 transcript 记录里的原始时间戳。
// content 仍是会被 JSON.stringify 持久化的 payload，createdAt 只参与排序/活跃时间，不写进 content。
export type ImportedMessage = {
    content: ImportedMessageContent
    createdAt?: number
}

export type LocalSessionSummary = {
    id: string
    title: string
    lastUserMessage?: string | null
    cwd?: string | null
    file: string
    modifiedAt: number
    originator?: string | null
    cliVersion?: string | null
}

export type TranscriptImportData = LocalSessionSummary & {
    messages: ImportedMessage[]
}

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
}

export type ImportCandidate = {
    sessionId: string
    active: boolean
    updatedAt: number
    metadata: Record<string, unknown> | null
}

export type ImportTargetSelection = {
    sessionId: string | null
    comparablePrefixCount: number
}

export type SyncSessionRequestParseResult = {
    sessionIds: string[]
    error?: string
}

export type DuplicateSessionGroup = {
    sessionId: string
    hapiSessionIds: string[]
    canonicalSessionId?: string
    removedSessionIds?: string[]
}

export type DuplicateSessionsResponse = {
    success: true
    duplicates: DuplicateSessionGroup[]
} | {
    success: false
    error: string
}

export type MergeDuplicateSessionsResponse = {
    success: true
    merged: DuplicateSessionGroup[]
    mergedCount: number
} | {
    success: false
    error: string
}

type DuplicateSessionGroupCandidate = {
    flavorSessionId: string
    sessions: ImportCandidate[]
}

// 中文注释：ImporterAdapter 是各 flavor 与通用引擎之间的唯一契约。
// - sessionIdKey 决定去重/绑定时在 metadata 上读哪个键（codexSessionId / claudeSessionId）。
// - listLocalSessions / parseTranscript 是各 flavor 专属的扫描与解析。
export interface ImporterAdapter {
    flavor: TranscriptFlavor
    sessionIdKey: string
    listLocalSessions(limit?: number): LocalSessionSummary[]
    parseTranscript(summary: LocalSessionSummary): TranscriptImportData | null
}

export const DIRECT_IMPORT_COMMAND = 'direct-import'
export const NO_SYNC_SESSION_SELECTED_ERROR = '未选择需要导入的会话'
export const DEFAULT_SESSION_SCAN_LIMIT = 500

function resolveLocalPath(pathValue: string): string {
    return isAbsolute(pathValue) ? pathValue : resolve(process.cwd(), pathValue)
}

export function expandHomePath(pathValue: string): string {
    return pathValue.replace(/^~(?=$|[\\/])/, homedir())
}

export function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

export function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

// 中文注释：把 transcript 记录里的 ISO 时间戳（如 "2026-06-15T09:12:00.706Z"）解析成毫秒；
// 缺失或非法时返回 undefined，让调用方回退到文件 mtime。Claude / Codex 共用此入口避免各写一份。
export function parseImportedTimestamp(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value
    }
    if (typeof value === 'string' && value.length > 0) {
        const parsed = Date.parse(value)
        if (Number.isFinite(parsed)) {
            return parsed
        }
    }
    return undefined
}

export function truncateText(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

export function buildImportedUserMessage(text: string): ImportedMessageContent {
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

export function buildImportedAgentMessage(data: unknown): ImportedMessageContent {
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

function machineOwnsCwd(machine: Machine, cwd: string): boolean {
    const workspaceRoots = machine.metadata?.workspaceRoots ?? []
    return workspaceRoots.some((workspaceRoot) => isPathInsideWorkspaceRoot(cwd, workspaceRoot))
}

export function resolveImportMachineId(
    cwd: string | null | undefined,
    namespace: string,
    engine: SyncEngine | null
): string | undefined {
    if (!cwd || !engine) {
        return undefined
    }

    const matches = engine.getOnlineMachinesByNamespace(namespace)
        .filter((machine) => machineOwnsCwd(machine, cwd))
    const machineIds = Array.from(new Set(matches.map((machine) => machine.id)))
    return machineIds.length === 1 ? machineIds[0] : undefined
}

export function buildImportedSessionMetadata(
    data: TranscriptImportData,
    flavor: TranscriptFlavor,
    sessionIdKey: string,
    existingMetadata?: Record<string, unknown> | null,
    resolvedMachineId?: string
): Record<string, unknown> {
    const now = Date.now()
    const path = data.cwd ?? (typeof existingMetadata?.path === 'string' ? existingMetadata.path : dirname(data.file))
    const host = typeof existingMetadata?.host === 'string' ? existingMetadata.host : (process.env.HAPI_HOSTNAME || hostname())
    const osValue = typeof existingMetadata?.os === 'string' ? existingMetadata.os : platform()
    const summaryText = data.lastUserMessage ?? data.title
    const machineId = typeof existingMetadata?.machineId === 'string'
        ? existingMetadata.machineId
        : resolvedMachineId

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
        flavor,
        [sessionIdKey]: data.id,
        ...(machineId ? { machineId } : {}),
        lifecycleState: typeof existingMetadata?.lifecycleState === 'string'
            ? existingMetadata.lifecycleState
            : 'imported',
        lifecycleStateSince: typeof existingMetadata?.lifecycleStateSince === 'number'
            ? existingMetadata.lifecycleStateSince
            : now
    }
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
            text: body.text
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
    // 中文注释：重复会话合并时优先按标准 user/agent 结构去重；遇到非标准消息再回退到稳定序列化，确保不会遗漏相同内容。
    return normalizeComparableContent(message.content) ?? stableSerialize(message.content)
}

export function collectImportCandidates(
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

export function selectImportTargetSession(
    store: Store,
    candidates: ImportCandidate[],
    sessionIdKey: string,
    flavorSessionId: string,
    importedComparableMessages: string[]
): ImportTargetSelection {
    const relatedCandidates = candidates
        .filter((candidate) => candidate.metadata?.[sessionIdKey] === flavorSessionId)
        .sort((a, b) => b.updatedAt - a.updatedAt)

    if (relatedCandidates.some((candidate) => candidate.active)) {
        throw new Error('当前会话仍处于活跃状态，请等待会话结束后重试')
    }

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

export function listDuplicateSessionGroups(
    store: Store,
    namespace: string,
    sessionIdKey: string,
    flavorSessionIds: string[],
    getSyncEngine?: () => SyncEngine | null
): DuplicateSessionGroupCandidate[] {
    const requestedSessionIds = new Set(flavorSessionIds)
    if (requestedSessionIds.size === 0) {
        return []
    }

    const groups = new Map<string, ImportCandidate[]>()
    for (const candidate of collectImportCandidates(store, namespace, getSyncEngine)) {
        const flavorSessionId = typeof candidate.metadata?.[sessionIdKey] === 'string'
            ? candidate.metadata[sessionIdKey] as string
            : null
        if (!flavorSessionId || !requestedSessionIds.has(flavorSessionId)) {
            continue
        }

        const existing = groups.get(flavorSessionId)
        if (existing) {
            existing.push(candidate)
        } else {
            groups.set(flavorSessionId, [candidate])
        }
    }

    return Array.from(groups.entries())
        .map(([flavorSessionId, sessions]) => ({
            flavorSessionId,
            sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt)
        }))
        .filter((group) => group.sessions.length > 1)
}

export async function mergeDuplicateSessionGroups(options: {
    store: Store
    namespace: string
    sessionIdKey: string
    flavorSessionIds: string[]
    getSyncEngine?: () => SyncEngine | null
}): Promise<MergeDuplicateSessionsResponse> {
    const groups = listDuplicateSessionGroups(
        options.store,
        options.namespace,
        options.sessionIdKey,
        options.flavorSessionIds,
        options.getSyncEngine
    )
    if (groups.length === 0) {
        return {
            success: true,
            merged: [],
            mergedCount: 0
        }
    }

    const merged: DuplicateSessionGroup[] = []
    for (const group of groups) {
        const result = await mergeSingleDuplicateSessionGroup({
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

async function mergeSingleDuplicateSessionGroup(options: {
    group: DuplicateSessionGroupCandidate
    store: Store
    namespace: string
    getSyncEngine?: () => SyncEngine | null
}): Promise<DuplicateSessionGroup> {
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
        throw new Error(`No duplicate Hapi session found for thread: ${options.group.flavorSessionId}`)
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
        sessionId: options.group.flavorSessionId,
        hapiSessionIds: sessionStates.map((candidate) => candidate.sessionId),
        canonicalSessionId: canonical.sessionId,
        removedSessionIds
    }
}

export function emitImportedMessageEvents(
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

export function parseSyncSessionRequest(body: unknown): SyncSessionRequestParseResult {
    // 中文注释：导入弹窗直接提交 thread ID；未传 body 时按“未选择会话”处理，避免再回退到旧的默认最新会话逻辑。
    if (body === null || typeof body !== 'object' || Array.isArray(body) || !('sessionIds' in body)) {
        return { sessionIds: [] }
    }

    const rawSessionIds = (body as { sessionIds?: unknown }).sessionIds
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

    // 中文注释：前端允许多选，这里按 thread 去重，避免重复导入同一条本地 transcript。
    return { sessionIds: Array.from(new Set(sessionIds)) }
}

function getDirectImportWorkspace(): string {
    const configured = process.env.HAPI_CODEX_WORKSPACE?.trim()
    return configured ? resolveLocalPath(expandHomePath(configured)) : process.cwd()
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

export function combineSyncOutputs(results: ScriptLaunchResponse[]): string | undefined {
    const output = results
        .map((result, index) => {
            // 中文注释：direct import 不依赖隐藏脚本；这里把每个会话的导入摘要拼成一段文本，便于前端或日志统一查看。
            const detail = result.success ? (result.output ?? '') : (result.output ?? result.error)
            return detail ? `[${index + 1}] ${detail}` : ''
        })
        .filter(Boolean)
        .join('\n\n')
        .trim()
    return output || undefined
}

export function createImportErrorResponse(
    flavor: TranscriptFlavor,
    flavorSessionIds: string[],
    error: string,
    syncedCount = 0
): ScriptLaunchResponse {
    const { workspace } = getDirectImportRouteContext()
    appendScriptLog(workspace, 'sync', `FAILED: ${error}; sessionIds=${flavorSessionIds.join(',') || '(none)'}`)
    return {
        success: false,
        error,
        cwd: workspace,
        sessionIds: flavorSessionIds,
        syncedCount
    }
}

export function createImportSuccessResponse(
    flavor: TranscriptFlavor,
    flavorSessionIds: string[],
    results: ScriptLaunchResponse[]
): ScriptLaunchResponse {
    const { workspace } = getDirectImportRouteContext()
    const flavorLabel = flavor === 'codex' ? 'Codex' : 'Claude'
    appendScriptLog(
        workspace,
        'sync',
        `SUCCESS: imported ${results.length} ${flavorLabel} session(s); sessionIds=${flavorSessionIds.join(',')}`
    )
    return {
        success: true,
        message: `Imported ${results.length} ${flavorLabel} session(s) into Hapi`,
        pid: 0,
        command: DIRECT_IMPORT_COMMAND,
        cwd: workspace,
        output: combineSyncOutputs(results),
        sessionIds: flavorSessionIds,
        syncedCount: results.length
    }
}

export function importSingleSession(options: {
    adapter: ImporterAdapter
    sessionId: string
    localSessionsById: Map<string, LocalSessionSummary>
    store: Store
    namespace: string
    getSyncEngine?: () => SyncEngine | null
}): ScriptLaunchResponse {
    const { adapter } = options
    const flavorLabel = adapter.flavor === 'codex' ? 'Codex' : 'Claude'
    const summary = options.localSessionsById.get(options.sessionId)
    if (!summary) {
        return {
            ...createImportErrorResponse(adapter.flavor, [options.sessionId], `Transcript not found for ${flavorLabel} session: ${options.sessionId}`),
            output: `未找到对应的本地 transcript：${options.sessionId}`
        }
    }

    const transcript = adapter.parseTranscript(summary)
    if (!transcript) {
        return {
            ...createImportErrorResponse(adapter.flavor, [options.sessionId], `Failed to parse ${flavorLabel} transcript: ${summary.file}`),
            output: `解析 transcript 失败：${summary.file}`
        }
    }

    if (transcript.messages.length === 0) {
        return {
            ...createImportErrorResponse(adapter.flavor, [options.sessionId], `No importable conversation content found in transcript: ${summary.file}`),
            output: `transcript 中没有可导入的会话内容：${summary.file}`
        }
    }

    const importedComparableMessages = transcript.messages
        .map((message) => normalizeComparableContent(message.content))
        .filter((value): value is string => value !== null)

    try {
        const candidates = collectImportCandidates(options.store, options.namespace, options.getSyncEngine)
        const target = selectImportTargetSession(
            options.store,
            candidates,
            adapter.sessionIdKey,
            options.sessionId,
            importedComparableMessages
        )
        const engine = options.getSyncEngine?.() ?? null
        const existingStored = target.sessionId ? options.store.sessions.getSessionByNamespace(target.sessionId, options.namespace) : null
        const metadata = buildImportedSessionMetadata(
            transcript,
            adapter.flavor,
            adapter.sessionIdKey,
            asRecord(existingStored?.metadata),
            resolveImportMachineId(transcript.cwd, options.namespace, engine)
        )

        let sessionId = existingStored?.id ?? null
        let created = false
        if (!sessionId) {
            // 中文注释：找不到可安全续写的历史会话时，直接新建一个 Hapi 会话，避免把已分叉的数据硬写进旧会话。
            const createdSession = engine?.getOrCreateSession(
                randomUUID(),
                metadata,
                {},
                options.namespace
            ) ?? options.store.sessions.getOrCreateSession(randomUUID(), metadata, {}, options.namespace)
            sessionId = createdSession.id
            created = true
        } else if (existingStored) {
            const updatedMetadata = options.store.sessions.updateSessionMetadata(
                existingStored.id,
                metadata,
                existingStored.metadataVersion,
                options.namespace,
                { touchUpdatedAt: false }
            )
            if (updatedMetadata.result !== 'success') {
                throw new Error(`Failed to update metadata for Hapi session: ${existingStored.id}`)
            }
            engine?.handleRealtimeEvent({ type: 'session-updated', sessionId: existingStored.id })
        }

        if (!sessionId) {
            throw new Error(`Failed to determine target Hapi session for ${flavorLabel} thread: ${options.sessionId}`)
        }

        const comparablePrefixCount = sessionId ? target.comparablePrefixCount : 0
        const messagesToAppend = transcript.messages.slice(comparablePrefixCount)
        // 中文注释：导入历史会话走 copyMessageToSession 落库，保留 transcript 记录里的原始时间戳；
        // addMessage 会盖成 Date.now()，导致旧会话被排成“今天刚活跃”、消息时间线被压平。
        // 单条记录缺少逐行时间戳时回退到 transcript.modifiedAt（文件 mtime）。localId 置 null 走已读路径，
        // invokedAt 跟随 createdAt 让消息直接落入聊天区而非排队浮条。
        const appendedMessages = messagesToAppend.map((message) => {
            const createdAt = message.createdAt ?? transcript.modifiedAt
            return options.store.messages.copyMessageToSession(sessionId!, {
                content: message.content,
                createdAt,
                localId: null,
                invokedAt: createdAt,
                scheduledAt: null
            })
        })

        // 中文注释：更新 Hapi 会话的 updatedAt，并在已有会话追加时广播新增消息，让当前打开的聊天页立刻显示客户端新增内容。
        // 取这批消息里最大的真实时间戳作为最后活跃时间，避免个别乱序记录把会话排到错误位置。
        // 已有会话且本轮零追加时不碰 updated_at：metadata 更新也用 touchUpdatedAt:false，否则会把旧会话顶成“今天活跃”。
        if (created) {
            const latestMessageCreatedAt = appendedMessages.length > 0
                ? appendedMessages.reduce((max, message) => Math.max(max, message.invokedAt ?? message.createdAt), 0)
                : transcript.modifiedAt
            // 中文注释：新建的导入会话出生时间是 now（今天），而真实最后活动在历史里；recordSessionActivity /
            // touchSessionUpdatedAt 只前进不后退，无法把 updated_at 调回过去，否则历史会话会一直排在列表顶端
            // 显示成“今天刚活跃”。这里对刚建好的导入会话无条件回填真实最后活动时间，再刷新引擎缓存。
            options.store.sessions.setImportedSessionActivity(sessionId, latestMessageCreatedAt, options.namespace)
            engine?.handleRealtimeEvent({ type: 'session-updated', sessionId })
        } else if (appendedMessages.length > 0) {
            const latestMessageCreatedAt = appendedMessages.reduce(
                (max, message) => Math.max(max, message.invokedAt ?? message.createdAt),
                0
            )
            if (engine) {
                engine.recordSessionActivity(sessionId, latestMessageCreatedAt)
            } else {
                options.store.sessions.touchSessionUpdatedAt(sessionId, latestMessageCreatedAt, options.namespace)
            }
        }
        if (!created) {
            emitImportedMessageEvents(engine, sessionId, appendedMessages)
        }

        const output = [
            `${flavorLabel} thread: ${options.sessionId}`,
            `Hapi session: ${sessionId}`,
            `Action: ${created ? 'created' : 'updated'}`,
            `Appended messages: ${appendedMessages.length}`
        ].join('\n')

        appendScriptLog(
            getDirectImportRouteContext().workspace,
            'sync',
            `SUCCESS: ${adapter.sessionIdKey}=${options.sessionId}; hapiSessionId=${sessionId}; created=${created}; appended=${appendedMessages.length}`
        )

        return {
            success: true,
            message: created ? `${flavorLabel} session imported into a new Hapi session` : `${flavorLabel} session appended to existing Hapi session`,
            pid: 0,
            command: DIRECT_IMPORT_COMMAND,
            cwd: getDirectImportRouteContext().workspace,
            output,
            sessionIds: [options.sessionId],
            syncedCount: 1
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
            ...createImportErrorResponse(adapter.flavor, [options.sessionId], message),
            output: `${flavorLabel} thread: ${options.sessionId}\n${message}`
        }
    }
}

export async function importSelectedSessions(options: {
    adapter: ImporterAdapter
    sessionIds: string[]
    store: Store
    namespace: string
    getSyncEngine?: () => SyncEngine | null
}): Promise<ScriptLaunchResponse> {
    const { adapter } = options
    const sessionIds = options.sessionIds
    if (sessionIds.length === 0) {
        return createImportErrorResponse(adapter.flavor, sessionIds, NO_SYNC_SESSION_SELECTED_ERROR)
    }

    const localSessionsById = new Map(adapter.listLocalSessions().map((session) => [session.id, session]))
    const results: ScriptLaunchResponse[] = []
    for (const sessionId of sessionIds) {
        const result = importSingleSession({
            adapter,
            sessionId,
            localSessionsById,
            store: options.store,
            namespace: options.namespace,
            getSyncEngine: options.getSyncEngine
        })
        results.push(result)

        if (!result.success) {
            return {
                ...result,
                sessionIds,
                syncedCount: Math.max(0, results.length - 1),
                output: combineSyncOutputs(results) ?? result.output
            }
        }
    }

    return createImportSuccessResponse(adapter.flavor, sessionIds, results)
}
