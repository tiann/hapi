import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import type { CodexCollaborationMode } from '@hapi/protocol/types'
import { Hono, type Context } from 'hono'
import type { LocalTranscript, LocalTranscriptSummary } from '@hapi/protocol/localTranscript'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { importLocalTranscript } from './localSessions/importLocalTranscript'
import { fetchLocalTranscriptSummaries, fetchLocalTranscriptsByIds } from './localSessions/fetchLocalTranscripts'
import { CODEX_LOCAL_SESSION_SOURCE } from './localSessions/sources'
import {
    appendScriptLog,
    CODEX_DESKTOP_NOT_FOUND_ERROR,
    collectImportCandidates,
    DIRECT_IMPORT_COMMAND,
    emitImportedMessageEvents,
    getCodexDesktopStatus,
    getCodexImportIds,
    getDarwinCodexOpenArgs,
    getDirectImportRouteContext,
    getRestartScriptPath,
    getRestartScriptWorkspace,
    isImportCandidateReusable,
    launchRestartScript,
    listDuplicateCodexSessionGroups,
    mergeDuplicateCodexSessionGroups,
    normalizeComparableContent,
    stableSerialize,
    type CodexDesktopStatusResponse,
    type CodexDuplicateSessionGroup,
    type CodexDuplicateSessionsResponse,
    type CodexMergeDuplicateSessionsResponse,
    type ImportCandidate,
    type ScriptLaunchResponse
} from './codexExtras'

// Sidecar capabilities (desktop restart, duplicate merge, script logs, compare
// helpers) moved out of the import path; re-exported so this module stays the
// single Codex route import surface.
export {
    appendScriptLog,
    CODEX_DESKTOP_NOT_FOUND_ERROR,
    CODEX_TRANSCRIPT_IMPORT_NAMESPACE_ERROR,
    collectImportCandidates,
    DIRECT_IMPORT_COMMAND,
    emitImportedMessageEvents,
    getCodexDesktopStatus,
    getCodexImportIds,
    getDarwinCodexOpenArgs,
    getDirectImportRouteContext,
    getRestartScriptPath,
    getRestartScriptWorkspace,
    isImportCandidateReusable,
    launchRestartScript,
    listDuplicateCodexSessionGroups,
    mergeDuplicateCodexSessionGroups,
    normalizeComparableContent,
    stableSerialize,
    type CodexDesktopStatusResponse,
    type CodexDuplicateSessionGroup,
    type CodexDuplicateSessionsResponse,
    type CodexMergeDuplicateSessionsResponse,
    type ImportCandidate,
    type ScriptLaunchResponse
} from './codexExtras'

const NO_SYNC_SESSION_SELECTED_ERROR = '未选择需要导入的 Codex 会话'
const CODEX_TRANSCRIPT_IMPORT_NAMESPACE_ERROR = 'Codex transcript import is not available outside the default namespace'

type CodexLocalSessionSummary = {
    id: string
    title: string
    lastUserMessage?: string | null
    cwd?: string | null
    file: string
    modifiedAt: number
    originator?: string | null
    cliVersion?: string | null
    source?: string | null
    threadSource?: string | null
    forkedFromId?: string | null
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

export type { CodexImportedMessageContent }

type SyncSessionRequestParseResult = {
    sessionIds: string[]
    cwd?: string | null
    machineId?: string | null
    model?: string | null
    modelReasoningEffort?: string | null
    serviceTier?: string | null
    collaborationMode?: CodexCollaborationMode
    yolo?: boolean
    error?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
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
    return onlineMachines.length >= 1 ? onlineMachines[0].id : null
}

/**
 * Map a normalized transcript summary onto the web Codex summary shape: the
 * flavor-only display fields arrive nested in `extra` and are flattened, and
 * the normalization-only keys (flavor/launch/messageCount) are dropped.
 */
function toWebCodexSessionSummary(summary: LocalTranscriptSummary): CodexLocalSessionSummary {
    const extra = summary.extra ?? {}
    const field = (key: string): string | null => (typeof extra[key] === 'string' ? extra[key] as string : null)
    return {
        id: summary.id,
        title: summary.title,
        lastUserMessage: summary.lastUserMessage ?? null,
        cwd: summary.cwd ?? null,
        file: summary.file,
        modifiedAt: summary.modifiedAt,
        originator: field('originator'),
        cliVersion: field('cliVersion'),
        source: field('source'),
        threadSource: field('threadSource'),
        forkedFromId: field('forkedFromId')
    }
}

function resolveCodexImportMachineObject(
    engine: SyncEngine | null,
    namespace: string,
    cwd: string | null | undefined,
    requestedMachineId?: string | null
): Machine | null {
    if (!engine) return null
    const machineId = resolveCodexImportMachineId(cwd, namespace, engine, requestedMachineId)
    if (!machineId) return null
    return engine.getOnlineMachinesByNamespace(namespace).find((machine) => machine.id === machineId) ?? null
}

function parseSyncSessionRequest(body: unknown): SyncSessionRequestParseResult {
    // 中文注释：导入弹窗现在直接提交 Codex thread ID；未传 body 时按“未选择会话”处理，避免再回退到旧的默认最新会话逻辑。
    if (body === null || typeof body !== 'object' || Array.isArray(body) || !('sessionIds' in body)) {
        return { sessionIds: [] }
    }

    const bodyRecord = body as { sessionIds?: unknown; cwd?: unknown; machineId?: unknown; model?: unknown; modelReasoningEffort?: unknown; serviceTier?: unknown; collaborationMode?: unknown; yolo?: unknown }
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
    const hasServiceTier = Object.prototype.hasOwnProperty.call(bodyRecord, 'serviceTier')
    const hasCollaborationMode = Object.prototype.hasOwnProperty.call(bodyRecord, 'collaborationMode')
    if (hasServiceTier && bodyRecord.serviceTier !== null && bodyRecord.serviceTier !== 'fast' && bodyRecord.serviceTier !== 'standard') {
        return { sessionIds: [], error: 'Invalid serviceTier' }
    }
    if (hasCollaborationMode && bodyRecord.collaborationMode !== 'default' && bodyRecord.collaborationMode !== 'plan') {
        return { sessionIds: [], error: 'Invalid collaborationMode' }
    }

    // 中文注释：前端允许多选，这里按 Codex thread 去重，避免重复导入同一条本地 transcript。
    return {
        sessionIds: Array.from(new Set(sessionIds)),
        cwd: typeof bodyRecord.cwd === 'string' && bodyRecord.cwd.trim() ? bodyRecord.cwd.trim() : null,
        machineId: typeof bodyRecord.machineId === 'string' && bodyRecord.machineId.trim() ? bodyRecord.machineId.trim() : null,
        model: hasModel ? (typeof bodyRecord.model === 'string' && bodyRecord.model.trim() ? bodyRecord.model.trim() : null) : undefined,
        modelReasoningEffort: hasModelReasoningEffort ? (typeof bodyRecord.modelReasoningEffort === 'string' && bodyRecord.modelReasoningEffort.trim() ? bodyRecord.modelReasoningEffort.trim() : null) : undefined,
        serviceTier: hasServiceTier ? bodyRecord.serviceTier as 'fast' | 'standard' | null : undefined,
        collaborationMode: hasCollaborationMode ? bodyRecord.collaborationMode as CodexCollaborationMode : undefined,
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

function resolveImportMachineObject(engine: SyncEngine, namespace: string, machineId?: string | null): Machine {
    const online = engine.getOnlineMachinesByNamespace?.(namespace) ?? []
    const found = machineId ? online.find((machine) => machine.id === machineId) : undefined
    const fallbackId = machineId ?? 'codex-import'
    return found ?? online[0] ?? {
        id: fallbackId,
        namespace,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: {
            host: fallbackId,
            platform: process.platform,
            happyCliVersion: 'unknown'
        },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1,
        health: null
    }
}

export async function importSelectedCodexSessions(options: {
    codexSessionIds: string[]
    store: Store
    namespace: string
    getSyncEngine?: () => SyncEngine | null
    cwd?: string | null
    model?: string | null
    modelReasoningEffort?: string | null
    serviceTier?: string | null
    collaborationMode?: CodexCollaborationMode
    yolo?: boolean
    machineId?: string | null
}): Promise<ScriptLaunchResponse> {
    const codexSessionIds = options.codexSessionIds
    if (codexSessionIds.length === 0) {
        return createImportErrorResponse(codexSessionIds, NO_SYNC_SESSION_SELECTED_ERROR)
    }
    const importLimit = CODEX_LOCAL_SESSION_SOURCE.importLimit
    if (importLimit !== undefined && codexSessionIds.length > importLimit) {
        return createImportErrorResponse(codexSessionIds, `At most ${importLimit} Codex sessions can be imported at once`)
    }

    // Transcripts always come from the runner through the source descriptor:
    // ListLocalSessions when the runner advertises the capability, the legacy
    // per-flavor RPC otherwise. The hub never reads its own CODEX_HOME.
    const engine = options.getSyncEngine?.() ?? null
    if (!engine) {
        return createImportErrorResponse(codexSessionIds, 'No online machine available for Codex history import')
    }
    const machine = resolveImportMachineObject(engine, options.namespace, options.machineId)
    const fetched = await fetchLocalTranscriptsByIds({
        source: CODEX_LOCAL_SESSION_SOURCE,
        engine,
        machine,
        cwd: options.cwd ?? null,
        sessionIds: codexSessionIds
    })
    if (!fetched.success) {
        return createImportErrorResponse(codexSessionIds, fetched.error)
    }
    const transcriptsById = new Map(fetched.sessions
        .filter((session): session is LocalTranscript => 'messages' in session)
        .map((session) => [session.id, session]))
    const results: ScriptLaunchResponse[] = []
    for (const codexSessionId of codexSessionIds) {
        const transcript = transcriptsById.get(codexSessionId)
        if (!transcript) {
            const failure: ScriptLaunchResponse = {
                ...createImportErrorResponse([codexSessionId], `Transcript not found for Codex session: ${codexSessionId}`),
                output: `未找到对应的本地 transcript：${codexSessionId}`
            }
            results.push(failure)
            return {
                ...failure,
                sessionIds: codexSessionIds,
                syncedCount: Math.max(0, results.length - 1),
                output: combineSyncOutputs(results) ?? failure.output
            }
        }
        if (transcript.messages.length === 0) {
            const failure: ScriptLaunchResponse = {
                ...createImportErrorResponse([codexSessionId], `No importable conversation content found in transcript: ${transcript.file}`),
                output: `transcript 中没有可导入的会话内容：${transcript.file}`
            }
            results.push(failure)
            return {
                ...failure,
                sessionIds: codexSessionIds,
                syncedCount: Math.max(0, results.length - 1),
                output: combineSyncOutputs(results) ?? failure.output
            }
        }

        const outcome = await importLocalTranscript({
            store: options.store,
            engine,
            namespace: options.namespace,
            source: CODEX_LOCAL_SESSION_SOURCE,
            transcript,
            machine,
            request: {
                launch: {
                    ...(options.model !== undefined ? { model: options.model } : {}),
                    ...(options.modelReasoningEffort !== undefined ? { modelReasoningEffort: options.modelReasoningEffort } : {}),
                    ...(options.serviceTier !== undefined ? { serviceTier: options.serviceTier } : {}),
                    ...(options.collaborationMode !== undefined ? { collaborationMode: options.collaborationMode } : {})
                },
                requestMetadata: options.yolo ? { preferredPermissionMode: 'yolo' } : {}
            }
        })

        if (outcome.error || !outcome.hapiSessionId) {
            const message = outcome.error?.message ?? `Failed to determine target Hapi session for Codex thread: ${codexSessionId}`
            const failure: ScriptLaunchResponse = {
                ...createImportErrorResponse([codexSessionId], message),
                output: `Codex thread: ${codexSessionId}\n${message}`
            }
            results.push(failure)
            return {
                ...failure,
                sessionIds: codexSessionIds,
                syncedCount: Math.max(0, results.length - 1),
                output: combineSyncOutputs(results) ?? failure.output
            }
        }

        // Keep the pre-registry response vocabulary: every delta-bearing or
        // empty re-sync reports "updated".
        const created = outcome.action === 'created'
        const output = [
            `Codex thread: ${codexSessionId}`,
            `Hapi session: ${outcome.hapiSessionId}`,
            `Action: ${created ? 'created' : 'updated'}`,
            `Appended messages: ${outcome.appended ?? 0}`
        ].join('\n')
        appendScriptLog(
            getDirectImportRouteContext().workspace,
            'sync',
            `SUCCESS: codexSessionId=${codexSessionId}; hapiSessionId=${outcome.hapiSessionId}; created=${created}; appended=${outcome.appended ?? 0}`
        )
        results.push({
            success: true,
            message: created ? 'Codex session imported into a new Hapi session' : 'Codex session appended to existing Hapi session',
            pid: 0,
            command: DIRECT_IMPORT_COMMAND,
            cwd: getDirectImportRouteContext().workspace,
            output,
            sessionIds: [codexSessionId],
            hapiSessionIds: [outcome.hapiSessionId],
            syncedCount: 1
        })
    }

    return createImportSuccessResponse(codexSessionIds, results)
}

export function createCodexDesktopRoutes(options: {
    store: Store
    getSyncEngine: () => SyncEngine | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // Transcript list and sync are available in every namespace; only
    // the desktop sidecar capabilities stay default-namespace only.
    const requireDefaultNamespace = async (c: Context<WebAppEnv>, next: () => Promise<void>) => {
        if (c.get('namespace') !== 'default') {
            return c.json({
                success: false,
                error: CODEX_TRANSCRIPT_IMPORT_NAMESPACE_ERROR
            }, 403)
        }
        return next()
    }
    app.use('/codex/status', requireDefaultNamespace)
    app.use('/codex/archive-session', requireDefaultNamespace)
    app.use('/codex/duplicate-sessions', requireDefaultNamespace)
    app.use('/codex/merge-duplicate-sessions', requireDefaultNamespace)
    app.use('/codex/restart-desktop', requireDefaultNamespace)

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
        const requestedMachineId = c.req.query('machineId')?.trim() || null
        const machine = resolveCodexImportMachineObject(options.getSyncEngine(), c.get('namespace'), cwd, requestedMachineId)
        if (!machine) {
            return c.json({
                success: false,
                error: 'No online machine available for Codex history import',
                sessions: []
            } satisfies CodexLocalSessionsResponse, 503)
        }
        const result = await fetchLocalTranscriptSummaries({
            source: CODEX_LOCAL_SESSION_SOURCE,
            engine: options.getSyncEngine()!,
            machine,
            cwd
        })
        if (!result.success) {
            return c.json({
                success: false,
                error: result.error,
                sessions: [],
                machineId: machine.id
            } satisfies CodexLocalSessionsResponse, 503)
        }
        return c.json({
            success: true,
            sessions: result.sessions.map(toWebCodexSessionSummary),
            machineId: machine.id
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
        const importLimit = CODEX_LOCAL_SESSION_SOURCE.importLimit
        if (importLimit !== undefined && parsed.sessionIds.length > importLimit) {
            const { workspace } = getDirectImportRouteContext()
            return c.json({
                success: false,
                error: `At most ${importLimit} Codex sessions can be imported at once`,
                cwd: workspace,
                codexDesktopRunning: codexStatus.running,
                codexClientAvailable: codexStatus.clientAvailable
            }, 400)
        }
        const machine = resolveCodexImportMachineObject(options.getSyncEngine(), c.get('namespace'), parsed.cwd, parsed.machineId)
        if (!machine) {
            const { workspace } = getDirectImportRouteContext()
            return c.json({
                success: false,
                error: 'No online machine available for Codex history import',
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
            cwd: parsed.cwd,
            machineId: machine.id,
            model: parsed.model,
            modelReasoningEffort: parsed.modelReasoningEffort,
            serviceTier: parsed.serviceTier,
            collaborationMode: parsed.collaborationMode,
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
            const workspace = getRestartScriptWorkspace()
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
