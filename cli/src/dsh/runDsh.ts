import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory'
import { createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle'
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc'
import type { ApiSessionClient } from '@/api/apiSession'
import type { Metadata } from '@/api/types'
import { registerKillSessionHandler, type KillSessionLifecycle } from '@/claude/registerKillSessionHandler'
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter'
import { hashObject } from '@/utils/deterministicJson'
import { getInvokedCwd } from '@/utils/invokedCwd'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { logger } from '@/ui/logger'
import { randomUUID } from 'node:crypto'
import type { DshPermissionMode } from '@hapi/protocol'
import type { DshModelsResponse } from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { convertDshEvent, convertDshHistoryEntry } from './dshEvents'
import { getDshModelsForSession } from './dshModels'
import { readDshHistoryAfter } from './dshSessions'
import {
    DshWebClient,
    type DshHistoryEntry,
    type DshModelSelection,
    type DshModelSummary,
    type DshServerRequest,
    type DshSessionEvent
} from './dshWebClient'

type DshQueueMode = {
    deliveryMode: 'queue' | 'steer'
}

type DshNativePermissionMode = Exclude<DshPermissionMode, 'default'>

type PendingTurn = {
    userSeen: boolean
    resolve: () => void
    reject: (error: Error) => void
}

type PermissionResponseMessage = {
    id: string
    approved: boolean
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function eventSourceRpcId(event: DshSessionEvent): string | null {
    if (event.type !== 'user/message' || !isRecord(event.data) || !isRecord(event.data.source)) return null
    return typeof event.data.source.rpcId === 'string' ? event.data.source.rpcId : null
}

function eventPermissionPreset(event: DshSessionEvent): DshNativePermissionMode | null {
    if (event.type !== 'permission/preset' || !isRecord(event.data)) return null
    const preset = event.data.preset
    return preset === 'read-only' || preset === 'workspace-write' || preset === 'danger-full-access'
        ? preset
        : null
}

function summaryPermissionPreset(value: unknown): DshNativePermissionMode | null {
    if (!isRecord(value)) return null
    const preset = value.currentValue
    return preset === 'read-only' || preset === 'workspace-write' || preset === 'danger-full-access'
        ? preset
        : null
}

function resolveRequestedModel(
    requested: string,
    models: readonly DshModelSummary[],
    preferredProvider?: string
): DshModelSummary {
    const exactRoute = models.find((entry) => `${entry.provider}/${entry.model}` === requested)
    if (exactRoute) return exactRoute
    const byModel = models.filter((entry) => entry.model === requested)
    if (byModel.length === 1) return byModel[0]!
    if (byModel.length > 1) {
        const preferred = preferredProvider
            ? byModel.find((entry) => entry.provider === preferredProvider)
            : null
        if (preferred) return preferred
        throw new Error(`DeepSeek Harness model ${requested} exists in multiple providers; use provider/model`)
    }
    throw new Error(`DeepSeek Harness model not found: ${requested}`)
}

export function advanceDshHistoryCursor(
    metadata: Metadata,
    eventSeq: number,
    now = Date.now(),
    coveredPendingPromptRpcIds: readonly string[] = []
): Metadata {
    const nextEventSeq = Math.max(metadata.dshHistoryLastEventSeq ?? -1, eventSeq)
    const dshPendingPrompts = { ...(metadata.dshPendingPrompts ?? {}) }
    for (const rpcId of coveredPendingPromptRpcIds) delete dshPendingPrompts[rpcId]
    return {
        ...metadata,
        dshHistoryLastEventSeq: nextEventSeq,
        dshPendingPrompts,
        ...(metadata.dshImportState ? {
            dshImportState: {
                ...metadata.dshImportState,
                updatedAt: now,
                lastEventSeq: Math.max(metadata.dshImportState.lastEventSeq ?? -1, nextEventSeq)
            }
        } : {})
    }
}

type DshPendingPrompt = NonNullable<Metadata['dshPendingPrompts']>[string]
type DshMetadataSession = Pick<ApiSessionClient, 'updateMetadata' | 'flushMetadata'>

export async function persistDshPendingPrompt(
    session: DshMetadataSession,
    rpcId: string,
    localIds: readonly string[],
    now = Date.now()
): Promise<void> {
    const pending: DshPendingPrompt = {
        localIds: [...new Set(localIds.filter(Boolean))],
        createdAt: now
    }
    session.updateMetadata((metadata) => ({
        ...metadata,
        dshPendingPrompts: { ...(metadata.dshPendingPrompts ?? {}), [rpcId]: pending }
    }))
    if (!await session.flushMetadata(10_000)) {
        throw new Error(`Failed to persist DeepSeek Harness prompt identity: ${rpcId}`)
    }
}

async function removeDshPendingPrompts(
    session: DshMetadataSession,
    rpcIds: readonly string[]
): Promise<void> {
    if (rpcIds.length === 0) return
    session.updateMetadata((metadata) => {
        const dshPendingPrompts = { ...(metadata.dshPendingPrompts ?? {}) }
        for (const rpcId of rpcIds) delete dshPendingPrompts[rpcId]
        return { ...metadata, dshPendingPrompts }
    })
    if (!await session.flushMetadata(10_000)) {
        throw new Error('Failed to clear DeepSeek Harness prompt identity')
    }
}

export function findDshPendingPrompt(
    pendingPrompts: ReadonlyMap<string, DshPendingPrompt>,
    localIds: readonly string[]
): { rpcId: string; prompt: DshPendingPrompt } | null {
    if (localIds.length === 0) return null
    for (const [rpcId, prompt] of pendingPrompts) {
        if (prompt.localIds.length !== localIds.length) continue
        if (prompt.localIds.every((localId, index) => localId === localIds[index])) {
            return { rpcId, prompt }
        }
    }
    return null
}

export async function bootstrapDshAfterPreflight<T>(
    client: Pick<DshWebClient, 'describe'>,
    bootstrap: () => Promise<T>
): Promise<T> {
    await client.describe()
    return bootstrap()
}

export class DshContiguousEventBuffer {
    private readonly pending = new Map<number, DshHistoryEntry>()

    constructor(private lastEventSeq: number) {}

    get cursor(): number {
        return this.lastEventSeq
    }

    get hasPendingGap(): boolean {
        return this.pending.size > 0 && !this.pending.has(this.lastEventSeq + 1)
    }

    enqueue(entry: DshHistoryEntry): void {
        if (entry.event.seq <= this.lastEventSeq || this.pending.has(entry.event.seq)) return
        this.pending.set(entry.event.seq, entry)
    }

    enqueueMany(entries: readonly DshHistoryEntry[]): void {
        for (const entry of entries) this.enqueue(entry)
    }

    takeContiguous(): DshHistoryEntry[] {
        const entries: DshHistoryEntry[] = []
        while (true) {
            const nextSeq = this.lastEventSeq + 1
            const next = this.pending.get(nextSeq)
            if (!next) break
            this.pending.delete(nextSeq)
            this.lastEventSeq = nextSeq
            entries.push(next)
        }
        return entries
    }
}

export async function persistContiguousDshEvents(options: {
    buffer: DshContiguousEventBuffer
    persistEntry: (entry: DshHistoryEntry) => Promise<void>
    commitCursor: (eventSeq: number) => Promise<void> | void
}): Promise<boolean> {
    const entries = options.buffer.takeContiguous()
    if (entries.length === 0) return false
    for (const entry of entries) await options.persistEntry(entry)
    await options.commitCursor(entries.at(-1)!.event.seq)
    return true
}

export function createDshKillSessionLifecycle(options: {
    lifecycle: KillSessionLifecycle
    client: Pick<DshWebClient, 'cancel'>
    getNativeSessionId: () => string | null
    isThinking: () => boolean
}): KillSessionLifecycle {
    return {
        setArchiveReason: options.lifecycle.setArchiveReason,
        cleanupAndExit: async () => {
            const nativeSessionId = options.getNativeSessionId()
            if (options.isThinking() && nativeSessionId) {
                try {
                    await options.client.cancel(nativeSessionId)
                } catch (error) {
                    logger.debug('[dsh] Failed to cancel native turn during explicit archive:', error)
                }
            }
            await options.lifecycle.cleanupAndExit()
        }
    }
}

export async function runDsh(opts: {
    startedBy?: 'runner' | 'terminal'
    startingMode?: 'local' | 'remote'
    permissionMode?: DshPermissionMode
    model?: string
    modelReasoningEffort?: string
    resumeSessionId?: string
    existingSessionId?: string
    workingDirectory?: string
} = {}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd()
    const startedBy = opts.startedBy ?? 'terminal'

    if (opts.startingMode === 'local') {
        logger.debug('[dsh] Local mode requested; forcing remote because DSH Web owns the native UI')
    }

    const client = new DshWebClient()
    const bootstrap = await bootstrapDshAfterPreflight(client, () => opts.existingSessionId
        ? bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: 'dsh',
            startedBy,
            workingDirectory
        })
        : bootstrapSession({
            flavor: 'dsh',
            startedBy,
            workingDirectory,
            model: opts.model,
            modelReasoningEffort: opts.modelReasoningEffort
        }))
    const { session, sessionInfo } = bootstrap
    setControlledByUser(session, 'remote')

    const muxAbort = new AbortController()
    const loopAbort = new AbortController()
    const queue = new MessageQueue2<DshQueueMode>((mode) => hashObject(mode))
    const pendingTurns = new Map<string, PendingTurn>()
    const ownedRpcIds = new Set<string>()
    const durablePendingPrompts = new Map(Object.entries(sessionInfo.metadata?.dshPendingPrompts ?? {}))
    const recoveredPendingRpcIds = new Set(durablePendingPrompts.keys())
    const recoveredConsumedLocalIds = new Set<string>()
    const consumedPromptRpcIds = new Set<string>()
    const coveredPendingPromptRpcIds = new Set<string>()
    const pendingApprovals = new Map<string, { rpcId: string; toolName: string; arguments: unknown; createdAt: number }>()

    let nativeSessionId = opts.resumeSessionId ?? sessionInfo.metadata?.dshSessionId ?? null
    let thinking = false
    let stopped = false
    let currentPermissionMode: DshPermissionMode = opts.permissionMode
        ?? (sessionInfo.permissionMode as DshPermissionMode | undefined)
        ?? 'default'
    let nativeDefaultPermissionMode: DshNativePermissionMode | null = null
    let currentModel: string | null = sessionInfo.model ?? opts.model ?? null
    let currentReasoningEffort: string | null = sessionInfo.modelReasoningEffort ?? opts.modelReasoningEffort ?? null
    let currentSelection: DshModelSelection | null = null
    let nativeTurnStateObserved = false
    let keepAliveInterval: ReturnType<typeof setInterval> | null = null
    const eventBuffer = new DshContiguousEventBuffer(sessionInfo.metadata?.dshHistoryLastEventSeq ?? -1)
    const bufferedMuxFrames: DshServerRequest[] = []
    let muxReady = false
    let historyReconciliation: Promise<void> | null = null
    let historyReconciliationRequested = false
    let eventPersistenceError: Error | null = null
    let eventDrainTail = Promise.resolve()

    const syncKeepAlive = () => {
        session.keepAlive(thinking, 'remote', {
            permissionMode: currentPermissionMode,
            model: currentModel,
            modelReasoningEffort: currentReasoningEffort
        })
    }

    const finishPendingApprovals = (reason: string) => {
        const now = Date.now()
        session.updateAgentState((state) => {
            const completedRequests = { ...state.completedRequests }
            for (const [id, pending] of pendingApprovals) {
                completedRequests[id] = {
                    tool: pending.toolName,
                    arguments: pending.arguments,
                    createdAt: pending.createdAt,
                    completedAt: now,
                    status: 'canceled',
                    reason,
                    decision: 'abort'
                }
            }
            return { ...state, requests: {}, completedRequests }
        })
        pendingApprovals.clear()
    }

    const failPendingTurns = (error: Error) => {
        for (const pending of pendingTurns.values()) pending.reject(error)
        pendingTurns.clear()
    }

    const abortForDshError = (error: unknown) => {
        if (stopped || loopAbort.signal.aborted) return
        const normalized = error instanceof Error ? error : new Error(String(error))
        session.sendSessionEvent({ type: 'error', message: normalized.message })
        failPendingTurns(normalized)
        loopAbort.abort(normalized)
    }

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'dsh',
        stopKeepAlive: () => {
            if (keepAliveInterval) clearInterval(keepAliveInterval)
            keepAliveInterval = null
        },
        onBeforeClose: () => {
            stopped = true
            queue.close()
            loopAbort.abort()
            muxAbort.abort()
            failPendingTurns(new Error('DeepSeek Harness session stopped'))
            finishPendingApprovals('Session stopped')
        }
    })
    lifecycle.registerProcessHandlers()
    registerKillSessionHandler(session.rpcHandlerManager, createDshKillSessionLifecycle({
        lifecycle,
        client,
        getNativeSessionId: () => nativeSessionId,
        isThinking: () => thinking
    }))

    const handleDshEvent = async (entry: DshHistoryEntry) => {
        const event = entry.event
        const sourceRpcId = eventSourceRpcId(event)
        const durablePrompt = sourceRpcId ? durablePendingPrompts.get(sourceRpcId) : undefined
        const submittedByHapi = sourceRpcId !== null
            && (ownedRpcIds.has(sourceRpcId) || durablePrompt !== undefined)
        if (sourceRpcId) {
            const pending = pendingTurns.get(sourceRpcId)
            if (pending) pending.userSeen = true
        }
        if (event.type === 'user/message' && sourceRpcId && submittedByHapi) {
            if (durablePrompt && durablePrompt.localIds.length > 0) {
                await session.acknowledgeMessagesConsumed(durablePrompt.localIds)
                consumedPromptRpcIds.add(sourceRpcId)
                if (recoveredPendingRpcIds.has(sourceRpcId)) {
                    for (const localId of durablePrompt.localIds) {
                        if (!queue.cancelByLocalId(localId)) recoveredConsumedLocalIds.add(localId)
                    }
                }
            }
            coveredPendingPromptRpcIds.add(sourceRpcId)
        }

        const preset = eventPermissionPreset(event)
        if (preset) {
            currentPermissionMode = preset
            session.sendSessionEvent({ type: 'permission-mode-changed', mode: preset })
        }

        if (event.type === 'turn/start') {
            nativeTurnStateObserved = true
            thinking = true
        } else if (event.type === 'turn/end') {
            nativeTurnStateObserved = true
            thinking = false
            for (const [rpcId, pending] of pendingTurns) {
                if (!pending.userSeen) continue
                pendingTurns.delete(rpcId)
                pending.resolve()
            }
            if (queue.size() === 0) session.sendSessionEvent({ type: 'ready' })
        }

        const converted = convertDshEvent(event, entry)
        if (converted.model) currentModel = converted.model
        if (converted.reasoningEffort) currentReasoningEffort = converted.reasoningEffort

        if (!nativeSessionId) throw new Error('DeepSeek Harness event arrived before session attachment')
        for (const message of convertDshHistoryEntry(nativeSessionId, entry)) {
            if (message.content.role === 'user' && submittedByHapi) continue
            await session.sendImportedMessage(message.content, message.localId, message.createdAt)
        }
    }

    const drainDshEvents = async () => {
        const persisted = await persistContiguousDshEvents({
            buffer: eventBuffer,
            persistEntry: handleDshEvent,
            commitCursor: async (eventSeq) => {
                const covered = [...coveredPendingPromptRpcIds]
                session.updateMetadata((metadata) =>
                    advanceDshHistoryCursor(metadata, eventSeq, Date.now(), covered))
                if (!await session.flushMetadata(10_000)) {
                    throw new Error('Failed to persist DeepSeek Harness history cursor')
                }
                for (const rpcId of covered) {
                    coveredPendingPromptRpcIds.delete(rpcId)
                    durablePendingPrompts.delete(rpcId)
                    recoveredPendingRpcIds.delete(rpcId)
                    if (!ownedRpcIds.has(rpcId)) consumedPromptRpcIds.delete(rpcId)
                    ownedRpcIds.delete(rpcId)
                }
            }
        })
        if (persisted) syncKeepAlive()
    }

    const queueDshEventDrain = (): Promise<void> => {
        const task = eventDrainTail.then(async () => {
            if (eventPersistenceError) throw eventPersistenceError
            try {
                await drainDshEvents()
            } catch (error) {
                eventPersistenceError = error instanceof Error ? error : new Error(String(error))
                throw eventPersistenceError
            }
        })
        eventDrainTail = task.catch(() => {})
        return task
    }

    const handleMuxFrameNow = (
        request: DshServerRequest,
        reconcileGaps: boolean,
        scheduleDrain = true
    ) => {
        const frame = request.payload
        if (frame.sessionId !== nativeSessionId) return

        if (frame.type === 'session/event' && frame.event) {
            eventBuffer.enqueue({
                event: frame.event,
                ...(frame.view !== undefined ? { view: frame.view } : {})
            })
            if (scheduleDrain) void queueDshEventDrain().catch(abortForDshError)
            if (reconcileGaps && eventBuffer.hasPendingGap) scheduleHistoryReconciliation()
            return
        }

        if (frame.type === 'approval/requested') {
            const approvalId = typeof frame.approvalId === 'string' ? frame.approvalId : null
            const toolName = typeof frame.toolName === 'string' ? frame.toolName : 'DeepSeek Harness tool'
            if (!approvalId || pendingApprovals.has(approvalId)) return
            const createdAt = Date.now()
            const argumentsValue = {
                ...(typeof frame.callId === 'string' ? { callId: frame.callId } : {}),
                ...(typeof frame.reason === 'string' ? { reason: frame.reason } : {})
            }
            pendingApprovals.set(approvalId, {
                rpcId: request.rpcId,
                toolName,
                arguments: argumentsValue,
                createdAt
            })
            session.updateAgentState((state) => ({
                ...state,
                requests: {
                    ...state.requests,
                    [approvalId]: { tool: toolName, arguments: argumentsValue, createdAt }
                }
            }))
            return
        }

        if (frame.type === 'approval/resolved') {
            const approvalId = typeof frame.approvalId === 'string' ? frame.approvalId : null
            if (!approvalId) return
            const pending = pendingApprovals.get(approvalId)
            if (!pending) return
            pendingApprovals.delete(approvalId)
            const approved = frame.outcome === 'allowed-once'
            session.updateAgentState((state) => {
                const { [approvalId]: _, ...requests } = state.requests ?? {}
                return {
                    ...state,
                    requests,
                    completedRequests: {
                        ...state.completedRequests,
                        [approvalId]: {
                            tool: pending.toolName,
                            arguments: pending.arguments,
                            createdAt: pending.createdAt,
                            completedAt: Date.now(),
                            status: approved ? 'approved' : 'denied',
                            decision: approved ? 'approved' : 'denied'
                        }
                    }
                }
            })
            return
        }

        if (frame.type === 'question/requested') {
            session.sendSessionEvent({
                type: 'error',
                message: 'DeepSeek Harness requested structured user input, which this HAPI client cannot answer yet.'
            })
            void client.cancelResponse(request.rpcId).catch((error) => {
                logger.debug('[dsh] Failed to cancel unsupported user question:', error)
            })
            return
        }

    }

    const handleMuxFrame = (request: DshServerRequest) => {
        if (!muxReady) {
            bufferedMuxFrames.push(request)
            return
        }
        handleMuxFrameNow(request, true)
    }

    const reconcileDshHistory = async () => {
        if (!nativeSessionId) return
        const entries = await readDshHistoryAfter(client, nativeSessionId, eventBuffer.cursor)
        eventBuffer.enqueueMany(entries)
        await queueDshEventDrain()
    }

    function scheduleHistoryReconciliation(): void {
        if (stopped) return
        if (historyReconciliation) {
            historyReconciliationRequested = true
            return
        }
        historyReconciliationRequested = false
        historyReconciliation = reconcileDshHistory()
            .catch(abortForDshError)
            .finally(() => {
                historyReconciliation = null
                if (historyReconciliationRequested && eventBuffer.hasPendingGap) {
                    scheduleHistoryReconciliation()
                }
            })
    }

    try {
        await client.subscribeMux({
            signal: muxAbort.signal,
            onFrame: handleMuxFrame,
            onError: (error) => {
                if (stopped || muxAbort.signal.aborted) return
                abortForDshError(error)
            }
        })

        let nativeSummary
        if (!nativeSessionId) {
            nativeSessionId = await client.createSession({ cwd: workingDirectory })
            nativeSummary = (await client.listSessions()).find((entry) => entry.sessionId === nativeSessionId)
        } else {
            nativeSummary = (await client.listSessions()).find((entry) => entry.sessionId === nativeSessionId)
            if (!nativeSummary) throw new Error(`DeepSeek Harness session not found: ${nativeSessionId}`)
        }

        await reconcileDshHistory()
        while (bufferedMuxFrames.length > 0) {
            for (const request of bufferedMuxFrames.splice(0)) handleMuxFrameNow(request, false, false)
            await queueDshEventDrain()
        }
        muxReady = true
        if (eventBuffer.hasPendingGap) scheduleHistoryReconciliation()

        if (!nativeTurnStateObserved) thinking = nativeSummary?.running === true

        const projectedPermission = summaryPermissionPreset(nativeSummary?.projections?.values.permissions)
        if (projectedPermission) {
            nativeDefaultPermissionMode = projectedPermission
            currentPermissionMode = projectedPermission
        }

        session.updateMetadata((metadata) => ({ ...metadata, dshSessionId: nativeSessionId! }))

        const catalog = await client.getModels(nativeSessionId)
        currentSelection = catalog.current
        currentModel = currentSelection.model
        currentReasoningEffort = currentSelection.reasoningEffort ?? null

        session.rpcHandlerManager.registerHandler<Record<string, never>, DshModelsResponse>(
            RPC_METHODS.ListDshModels,
            async () => {
                try {
                    return await getDshModelsForSession(client, nativeSessionId!)
                } catch (error) {
                    return {
                        success: false,
                        error: error instanceof Error ? error.message : 'Failed to list DeepSeek Harness models'
                    }
                }
            }
        )

        if (opts.model || opts.modelReasoningEffort) {
            const selectedModel = opts.model
                ? opts.model === currentSelection.model
                    ? resolveRequestedModel(`${currentSelection.provider}/${currentSelection.model}`, catalog.models)
                    : resolveRequestedModel(opts.model, catalog.models)
                : resolveRequestedModel(`${currentSelection.provider}/${currentSelection.model}`, catalog.models)
            currentSelection = await client.selectModel({
                sessionId: nativeSessionId,
                provider: selectedModel.provider,
                model: selectedModel.model,
                ...(opts.modelReasoningEffort ? { reasoningEffort: opts.modelReasoningEffort } : {})
            })
            currentModel = currentSelection.model
            currentReasoningEffort = currentSelection.reasoningEffort ?? null
        }

        if (opts.permissionMode && opts.permissionMode !== 'default') {
            await client.setPermissionPreset(nativeSessionId, opts.permissionMode)
            currentPermissionMode = opts.permissionMode
        }

        registerSessionConfigRpc<DshPermissionMode>({
            rpcHandlerManager: session.rpcHandlerManager,
            flavor: 'dsh',
            modelMode: 'nullable',
            modelReasoningEffortMode: 'nullable',
            onApply: async (config) => {
                if (config.permissionMode !== undefined) {
                    const targetPermissionMode = config.permissionMode === 'default'
                        ? nativeDefaultPermissionMode
                        : config.permissionMode
                    if (!targetPermissionMode) {
                        throw new Error('DeepSeek Harness default permission preset is unavailable')
                    }
                    await client.setPermissionPreset(nativeSessionId!, targetPermissionMode)
                    currentPermissionMode = targetPermissionMode
                }
                if (config.model !== undefined || config.modelReasoningEffort !== undefined) {
                    const latest = await client.getModels(nativeSessionId!)
                    const requestedModel = config.model ?? currentSelection?.model ?? latest.current.model
                    const selectedModel = resolveRequestedModel(
                        requestedModel,
                        latest.models,
                        currentSelection?.provider ?? latest.current.provider
                    )
                    currentSelection = await client.selectModel({
                        sessionId: nativeSessionId!,
                        provider: selectedModel.provider,
                        model: selectedModel.model,
                        ...(config.modelReasoningEffort
                            ? { reasoningEffort: config.modelReasoningEffort }
                            : {})
                    })
                    currentModel = currentSelection.model
                    currentReasoningEffort = currentSelection.reasoningEffort ?? null
                }
            },
            onAfterApply: syncKeepAlive,
            appliedFallback: () => ({
                permissionMode: currentPermissionMode,
                model: currentModel,
                modelReasoningEffort: currentReasoningEffort
            })
        })

        session.rpcHandlerManager.registerHandler<PermissionResponseMessage, void>(
            RPC_METHODS.Permission,
            async (response) => {
                const pending = pendingApprovals.get(response.id)
                if (!pending) return
                const outcome = response.approved ? 'allowed-once' : 'rejected'
                await client.respond(pending.rpcId, {
                    sessionId: nativeSessionId,
                    approvalId: response.id,
                    outcome
                })
                if (response.decision === 'abort') await client.cancel(nativeSessionId!)
            }
        )

        session.rpcHandlerManager.registerHandler(RPC_METHODS.Abort, async () => {
            if (!nativeSessionId) return
            await client.cancel(nativeSessionId)
            thinking = false
            syncKeepAlive()
            session.sendSessionEvent({ type: 'ready' })
        })

        const submitSteer = async (text: string, localId?: string): Promise<void> => {
            const localIds = localId ? [localId] : []
            const recovered = findDshPendingPrompt(durablePendingPrompts, localIds)
            const requestedRpcId = recovered?.rpcId ?? randomUUID()
            if (!recovered) {
                const createdAt = Date.now()
                await persistDshPendingPrompt(session, requestedRpcId, localIds, createdAt)
                durablePendingPrompts.set(requestedRpcId, { localIds, createdAt })
            }
            ownedRpcIds.add(requestedRpcId)
            const completion = new Promise<void>((resolve, reject) => {
                pendingTurns.set(requestedRpcId, { userSeen: false, resolve, reject })
            })
            try {
                const { rpcId, command } = await client.prompt({
                    sessionId: nativeSessionId!,
                    text,
                    mode: 'steer',
                    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    rpcId: requestedRpcId
                })
                if (localIds.length > 0 && !consumedPromptRpcIds.has(rpcId)) {
                    await session.acknowledgeMessagesConsumed(localIds)
                    consumedPromptRpcIds.add(rpcId)
                }
                if (command) {
                    pendingTurns.delete(rpcId)
                    ownedRpcIds.delete(rpcId)
                    try {
                        await removeDshPendingPrompts(session, [rpcId])
                        durablePendingPrompts.delete(rpcId)
                        recoveredPendingRpcIds.delete(rpcId)
                        consumedPromptRpcIds.delete(rpcId)
                    } catch (error) {
                        logger.debug('[dsh] Failed to clear command prompt identity:', error)
                    }
                    if (command.text) session.sendSessionEvent({ type: 'message', message: command.text })
                    return
                }
                void completion.then(
                    () => {
                        ownedRpcIds.delete(rpcId)
                        consumedPromptRpcIds.delete(rpcId)
                    },
                    (error) => {
                        ownedRpcIds.delete(rpcId)
                        consumedPromptRpcIds.delete(rpcId)
                        logger.debug('[dsh] Steered prompt completion failed:', error)
                    }
                )
            } catch (error) {
                pendingTurns.delete(requestedRpcId)
                ownedRpcIds.delete(requestedRpcId)
                throw error
            }
        }

        session.rpcHandlerManager.registerHandler(RPC_METHODS.SteerQueuedMessage, async (payload: unknown) => {
            const localId = isRecord(payload) && typeof payload.localId === 'string'
                ? payload.localId
                : null
            if (!localId) return { steered: false, error: 'localId is required' }
            if (!thinking) return { steered: false, error: 'Session is not running a turn' }

            const queued = queue.queue.find((item) => item.localId === localId)
            if (!queued || !queue.cancelByLocalId(localId)) {
                return { steered: false, error: 'Message not found or already dispatched' }
            }

            try {
                await submitSteer(queued.message, localId)
                return { steered: true }
            } catch (error) {
                queue.unshift(queued.message, queued.mode, localId)
                return {
                    steered: false,
                    error: error instanceof Error ? error.message : 'DeepSeek Harness steer failed'
                }
            }
        })

        session.onCancelQueuedMessage((localId) => queue.cancelByLocalId(localId))
        session.onUserMessage((message, localId) => {
            if (localId && recoveredConsumedLocalIds.delete(localId)) return
            const text = formatMessageWithAttachments(message.content.text, message.content.attachments)
            const deliveryMode = message.meta?.deliveryMode ?? 'queue'
            if (thinking && deliveryMode === 'steer') {
                void submitSteer(text, localId).catch((error) => {
                    logger.debug('[dsh] Native steer submission failed; restoring queue item:', error)
                    queue.unshift(text, { deliveryMode }, localId)
                })
                return
            }
            queue.push(text, { deliveryMode }, localId)
        })

        syncKeepAlive()
        keepAliveInterval = setInterval(syncKeepAlive, 2_000)
        session.sendSessionEvent({ type: 'ready' })

        while (!stopped && !loopAbort.signal.aborted) {
            const batch = await queue.waitForMessagesAndGetAsString(loopAbort.signal)
            if (!batch) break

            try {
                const localIds = batch.items.flatMap((item) => item.localId ? [item.localId] : [])
                const recovered = findDshPendingPrompt(durablePendingPrompts, localIds)
                const requestedRpcId = recovered?.rpcId ?? randomUUID()
                if (!recovered) {
                    const createdAt = Date.now()
                    await persistDshPendingPrompt(session, requestedRpcId, localIds, createdAt)
                    durablePendingPrompts.set(requestedRpcId, { localIds, createdAt })
                }
                ownedRpcIds.add(requestedRpcId)
                const completion = new Promise<void>((resolve, reject) => {
                    pendingTurns.set(requestedRpcId, { userSeen: false, resolve, reject })
                })
                const { rpcId, command } = await client.prompt({
                    sessionId: nativeSessionId,
                    text: batch.message,
                    mode: batch.mode.deliveryMode,
                    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    rpcId: requestedRpcId
                })
                if (localIds.length > 0 && !consumedPromptRpcIds.has(rpcId)) {
                    await session.acknowledgeMessagesConsumed(localIds)
                    consumedPromptRpcIds.add(rpcId)
                }
                if (command) {
                    pendingTurns.delete(rpcId)
                    ownedRpcIds.delete(rpcId)
                    try {
                        await removeDshPendingPrompts(session, [rpcId])
                        durablePendingPrompts.delete(rpcId)
                        recoveredPendingRpcIds.delete(rpcId)
                        consumedPromptRpcIds.delete(rpcId)
                    } catch (error) {
                        logger.debug('[dsh] Failed to clear command prompt identity:', error)
                    }
                    if (command.text) session.sendSessionEvent({ type: 'message', message: command.text })
                    thinking = false
                    syncKeepAlive()
                    session.sendSessionEvent({ type: 'ready' })
                    continue
                }
                thinking = true
                syncKeepAlive()

                await completion
                ownedRpcIds.delete(rpcId)
                consumedPromptRpcIds.delete(rpcId)
            } catch (error) {
                for (const rpcId of ownedRpcIds) {
                    if (!pendingTurns.has(rpcId)) continue
                    pendingTurns.delete(rpcId)
                    ownedRpcIds.delete(rpcId)
                }
                for (let index = batch.items.length - 1; index >= 0; index -= 1) {
                    const item = batch.items[index]!
                    if (batch.isolate) queue.unshiftIsolated(item.message, batch.mode, item.localId)
                    else queue.unshift(item.message, batch.mode, item.localId)
                }
                throw error
            }
        }

        if (!stopped && loopAbort.signal.aborted) {
            throw loopAbort.signal.reason instanceof Error
                ? loopAbort.signal.reason
                : new Error('DeepSeek Harness event stream stopped')
        }
    } catch (error) {
        lifecycle.markCrash(error)
        session.sendSessionEvent({
            type: 'error',
            message: error instanceof Error ? error.message : 'DeepSeek Harness session failed'
        })
        await lifecycle.cleanup()
        throw error
    }
}
