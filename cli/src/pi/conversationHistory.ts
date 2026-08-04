import type { Metadata } from '@/api/types'
import {
    PI_CONVERSATION_HISTORY_INITIAL,
    markSupported,
    markUnsupported,
    toConversationHistoryCapabilities,
    type ConversationHistoryCapabilityStates
} from '@hapi/protocol/conversationHistory'
import type { ForkConversationRpcResult, RewindConversationRpcResult } from '@hapi/protocol/apiTypes'
import { PI_THINKING_LEVELS } from '@hapi/protocol'
import type { PiThinkingLevel } from './types'
import type { PiNativeRuntimeState, PiSession } from './session'

/** Keep the complete native history transaction below the Hub's 120s ceiling. */
export const PI_HISTORY_OPERATION_TIMEOUT_MS = 110_000
const PI_HISTORY_RESTORE_RESERVE_MS = 10_000

type PiRpc = (command: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>

type PiIdentity = {
    sessionId: string
    sessionFile: string
}

type PiState = PiIdentity & {
    runtime: PiNativeRuntimeState
}

type PiEntry = {
    id: string
    type: string
    message?: { role?: unknown }
}

type PendingUserEntry = {
    localId: string
}

/** Source identity could not be restored; caller must terminate this Pi wrapper. */
export class PiHistoryRestoreError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'PiHistoryRestoreError'
    }
}

class PiHistoryDeadlineError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'PiHistoryDeadlineError'
    }
}

class PiHistoryIndeterminateMutationError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'PiHistoryIndeterminateMutationError'
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

function isUnknownCommand(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /unknown command|method not found|-32601/i.test(message)
}

/**
 * PiRpcResolver currently emits this message for elapsed requests. Keep this
 * matcher deliberately narrow so ordinary native errors still use the normal
 * source-restore path. A typed error name is supported for adapters/tests.
 */
function isPiRpcTimeout(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return error.name === 'PiRpcTimeoutError'
        || /^Pi RPC \S+ \(id=\d+\) timed out after \d+ms$/.test(error.message)
}

function wasCancelled(data: unknown): boolean {
    return asRecord(data)?.cancelled === true
}

function readState(data: unknown): PiState {
    const state = asRecord(data)
    const sessionId = asString(state?.sessionId)
    const sessionFile = asString(state?.sessionFile)
    if (!sessionId || !sessionFile) {
        throw new Error('Pi get_state did not return sessionId and sessionFile')
    }
    const model = asRecord(state?.model)
    const thinkingLevel = asString(state?.thinkingLevel)
    const hasModelId = model !== null && ('id' in model || 'modelId' in model)
    const hasProvider = model !== null && 'provider' in model
    return {
        sessionId,
        sessionFile,
        runtime: {
            model: hasModelId ? asString(model.id) ?? asString(model.modelId) ?? null : undefined,
            provider: hasProvider ? asString(model.provider) ?? null : undefined,
            thinkingLevel: thinkingLevel && PI_THINKING_LEVELS.includes(thinkingLevel as PiThinkingLevel)
                ? thinkingLevel as PiThinkingLevel
                : undefined,
            steeringMode: state?.steeringMode === 'all' || state?.steeringMode === 'one-at-a-time'
                ? state.steeringMode
                : undefined,
            isStreaming: typeof state?.isStreaming === 'boolean' ? state.isStreaming : undefined,
        },
    }
}

function readEntries(data: unknown): { entries: PiEntry[]; leafId: string | null } {
    const record = asRecord(data)
    const rawEntries = Array.isArray(record?.entries) ? record.entries : null
    if (!rawEntries) throw new Error('Pi get_entries returned malformed data')
    const entries = rawEntries.flatMap((raw): PiEntry[] => {
        const entry = asRecord(raw)
        const id = asString(entry?.id)
        const type = asString(entry?.type)
        if (!id || !type) return []
        const message = asRecord(entry?.message)
        return [{ id, type, message: message ? { role: message.role } : undefined }]
    })
    return { entries, leafId: asString(record?.leafId) }
}

function isUserEntry(entry: PiEntry): boolean {
    return entry.type === 'message' && entry.message?.role === 'user'
}

function containsForkEntry(data: unknown, entryId: string): boolean {
    const messages = asRecord(data)?.messages
    return Array.isArray(messages) && messages.some((message) => asRecord(message)?.entryId === entryId)
}

/**
 * Native Pi history coordinator. Entry association is intentionally FIFO only:
 * a HAPI prompt is paired with the next Pi user entry, never with message text.
 */
export class PiConversationHistory {
    private states: ConversationHistoryCapabilityStates = { ...PI_CONVERSATION_HISTORY_INITIAL }
    private readonly entryIdByLocalId = new Map<string, string>()
    private readonly pendingUserEntries: PendingUserEntry[] = []
    private observedEntryIds = new Set<string>()
    private appendCursor: string | null = null
    private publishCapabilities: (() => Promise<void>) | null = null
    private syncInFlight: Promise<void> | null = null
    private syncRequestedWhileInFlight = false
    private syncGeneration = 0
    private historySyncDisabled = false

    constructor(
        private readonly session: PiSession,
        private readonly rpc: PiRpc,
    ) {}

    setPublishCapabilities(fn: () => Promise<void>): void {
        this.publishCapabilities = fn
    }

    getCapabilitiesForMetadata(): Metadata['capabilities'] {
        const conversationHistory = toConversationHistoryCapabilities(this.states)
        return conversationHistory ? { conversationHistory } : undefined
    }

    getHistoryPoints(): Record<string, true> {
        return Object.fromEntries(Array.from(this.entryIdByLocalId.keys(), (localId) => [localId, true]))
    }

    getEntryIds(): Record<string, string> {
        return Object.fromEntries(this.entryIdByLocalId.entries())
    }

    restoreEntryIds(entryIds: Record<string, string> | null | undefined): void {
        if (!entryIds) return
        for (const [localId, entryId] of Object.entries(entryIds)) {
            if (localId && entryId) this.entryIdByLocalId.set(localId, entryId)
        }
    }

    /** Establish the append-log cursor before any buffered prompt is released. */
    async initializeBaseline(): Promise<boolean> {
        try {
            await this.syncEntries()
        } catch (error) {
            // A trustworthy append-log baseline is mandatory before prompts are
            // released. Any startup failure disables history for this wrapper;
            // otherwise a later full-log read could pair an old user entry with
            // the first new HAPI localId.
            this.historySyncDisabled = true
            this.pendingUserEntries.length = 0
            this.states = markUnsupported(this.states, 'forkCurrent')
            this.states = markUnsupported(this.states, 'forkAtMessage')
            this.states = markUnsupported(this.states, 'rewindToMessage')
            await this.publishCapabilities?.().catch(() => {})
            return false
        }
        return true
    }

    /** Probe and publish controls only after Pi has a validated native identity. */
    async initialize(): Promise<void> {
        if (!await this.initializeBaseline()) return
        await this.probeCapabilities().catch(() => {})
    }

    /**
     * Register a HAPI user message before its corresponding native command is
     * written. Prompts and native steers both append Pi user entries, so their
     * associations share one strict FIFO rather than a prompt-only queue.
     */
    registerUserEntry(localId: string | undefined): void {
        if (this.historySyncDisabled) return
        if (localId) this.pendingUserEntries.push({ localId })
    }

    /** Remove a rejected/aborted local FIFO entry by exact localId. */
    rejectPendingEntry(localId: string | undefined): void {
        if (!localId) return
        const index = this.pendingUserEntries.findIndex((entry) => entry.localId === localId)
        if (index !== -1) this.pendingUserEntries.splice(index, 1)
    }

    observeEntry(rawEntry: unknown): void {
        if (this.historySyncDisabled || this.session.isHistoryTransactionActive) return
        const parsed = readEntries({ entries: [rawEntry], leafId: null })
        for (const entry of parsed.entries) this.observeParsedEntry(entry)
    }

    async syncEntries(): Promise<void> {
        if (this.historySyncDisabled || this.session.isHistoryTransactionActive) return
        if (this.syncInFlight) {
            // A turn_start can be emitted for tool/retry loops before the prior
            // incremental read returns. Coalesce it into one serialized follow-up.
            this.syncRequestedWhileInFlight = true
            return await this.syncInFlight
        }
        this.syncInFlight = this.runEntrySync().finally(() => {
            // A request can land after runEntrySync observes `false` but before
            // finally clears syncInFlight. Preserve that boundary request.
            const scheduleFollowUp = this.syncRequestedWhileInFlight && !this.session.isHistoryTransactionActive
            this.syncInFlight = null
            this.syncRequestedWhileInFlight = false
            if (scheduleFollowUp) void this.syncEntries().catch(() => {})
        })
        return await this.syncInFlight
    }

    private async runEntrySync(): Promise<void> {
        do {
            this.syncRequestedWhileInFlight = false
            await this.syncEntriesOnce()
        } while (this.syncRequestedWhileInFlight && !this.session.isHistoryTransactionActive)
    }

    private async syncEntriesOnce(timeoutMs?: number): Promise<void> {
        const generation = this.syncGeneration
        const data = await this.rpc(
            this.appendCursor
                ? { type: 'get_entries', since: this.appendCursor }
                : { type: 'get_entries' },
            timeoutMs,
        )
        if (generation !== this.syncGeneration) return
        const result = readEntries(data)
        for (const entry of result.entries) this.observeParsedEntry(entry, false)
        // `since` indexes the immutable append log, not the active branch.
        // A fork can move leafId backwards; advancing the cursor to it would
        // replay entries and break FIFO pairing. Empty increments keep cursor.
        if (result.entries.length > 0) {
            this.appendCursor = result.entries[result.entries.length - 1]!.id
            const entryIds = this.getEntryIds()
            const points = this.getHistoryPoints()
            this.session.updateMetadata((metadata) => this.metadataWithLocators(metadata, entryIds, points))
        }
    }

    async probeCapabilities(): Promise<void> {
        if (this.historySyncDisabled) return
        if (this.states.forkCurrent !== 'unknown' && this.states.forkAtMessage !== 'unknown'
            && this.states.rewindToMessage !== 'unknown') return
        try {
            // Both reads are side-effect free and exist together with Pi 0.83's
            // clone/fork APIs. Do not expose controls before this succeeds.
            await this.rpc({ type: 'get_fork_messages' })
            const entries = await this.rpc({ type: 'get_entries', ...(this.appendCursor ? { since: this.appendCursor } : {}) })
            readEntries(entries)
            this.states = markSupported(this.states, 'forkCurrent')
            this.states = markSupported(this.states, 'forkAtMessage')
            this.states = markSupported(this.states, 'rewindToMessage')
        } catch (error) {
            if (isUnknownCommand(error)) {
                this.states = markUnsupported(this.states, 'forkCurrent')
                this.states = markUnsupported(this.states, 'forkAtMessage')
                this.states = markUnsupported(this.states, 'rewindToMessage')
            }
        }
        await this.publishCapabilities?.()
    }

    async fork(messageLocalId?: string): Promise<ForkConversationRpcResult> {
        this.assertHistoryIdle()
        if (messageLocalId) return await this.forkHistorical(messageLocalId)
        if (this.states.forkCurrent === 'unsupported') throw new Error('Fork current is not supported')

        return await this.withSourceRestored('forkCurrent', async (source, deadlineAt, markMutationIssued) => {
            const clone = await this.cloneAndReadIdentity(source, deadlineAt, markMutationIssued)
            return { nativeSessionId: clone.sessionId }
        })
    }

    async rewind(messageLocalId: string): Promise<RewindConversationRpcResult> {
        try {
            this.assertHistoryIdle()
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error), outcome: 'rejected' }
        }
        if (this.states.rewindToMessage === 'unsupported') {
            return { success: false, error: 'Rewind is not supported', outcome: 'rejected' }
        }
        const entryId = this.entryIdByLocalId.get(messageLocalId)
        if (!entryId) {
            return { success: false, error: `No native history point for message ${messageLocalId}`, outcome: 'rejected' }
        }

        const transaction = await this.beginHistoryTransaction()
        if (transaction.rejection) {
            transaction.release()
            return { success: false, error: transaction.rejection, outcome: 'rejected' }
        }
        const { release, deadlineAt } = transaction
        let source: PiState | null = null
        let committed = false
        let mutationIssued = false
        let mutationCompleted = false
        let rollbackRewindMetadata = false
        let indeterminateTimeout: unknown
        const locatorSnapshot = this.captureLocatorState()
        let success: Extract<RewindConversationRpcResult, { success: true }> | null = null
        let failure: { error: string; outcome: 'rejected' | 'cancelled' | 'source_restored' } | null = null
        try {
            source = await this.getState(deadlineAt)
            const forkMessages = await this.rpcWithinDeadline({ type: 'get_fork_messages' }, deadlineAt)
            if (!containsForkEntry(forkMessages, entryId)) {
                throw new Error('Pi rewind point is no longer available')
            }
            const result = await this.nativeMutation(
                { type: 'fork', entryId },
                deadlineAt,
                true,
                () => { mutationIssued = true },
            )
            mutationCompleted = true
            if (wasCancelled(result)) {
                failure = { error: 'Pi rewind was cancelled', outcome: 'cancelled' }
                throw new Error(failure.error)
            }
            const forked = await this.getState(deadlineAt)
            this.assertDistinctIdentity(source, forked, 'Pi rewind')
            const entries = readEntries(await this.rpcWithinDeadline({ type: 'get_entries' }, deadlineAt))
            this.commitRewindState(forked, entries)
            if (!await this.session.flushMetadata(Math.min(5_000, this.remainingMs(deadlineAt)))) {
                rollbackRewindMetadata = true
                throw new Error('Pi rewind metadata did not persist')
            }
            committed = true
            this.states = markSupported(this.states, 'rewindToMessage')
            success = { success: true, truncateFromLocalId: messageLocalId, messages: [] }
        } catch (error) {
            if (error instanceof PiHistoryIndeterminateMutationError) {
                indeterminateTimeout = error
            } else if (mutationCompleted && (isPiRpcTimeout(error) || error instanceof PiHistoryDeadlineError)) {
                indeterminateTimeout = new PiHistoryIndeterminateMutationError(
                    `Pi rewind completed but its resulting state is indeterminate: ${error instanceof Error ? error.message : String(error)}`,
                )
            }
            if (!failure) {
                failure = {
                    error: error instanceof Error ? error.message : String(error),
                    outcome: 'rejected'
                }
            }
            if (isUnknownCommand(error)) this.states = markUnsupported(this.states, 'rewindToMessage')
        } finally {
            let restoreError: unknown
            let restoredSource: PiState | null = null
            // Before commit this is a failed transaction and the old source must
            // remain active. After commit, the branched Pi session *is* rewind.
            // A timeout is indeterminate: Pi may have committed its native
            // mutation after the client gave up. Do not issue a momentary
            // get_state/switch classification against an unknown active branch.
            if (!indeterminateTimeout && !committed && source && mutationIssued) {
                try {
                    const restored = await this.restoreSource(source, deadlineAt)
                    restoredSource = restored
                    this.session.applyNativeRuntimeState(restored.runtime)
                } catch (error) {
                    restoreError = error
                }
            }
            if (!restoreError && rollbackRewindMetadata && restoredSource) {
                this.restoreLocatorState(locatorSnapshot)
                this.session.commitNativeSessionState(restoredSource, restoredSource.runtime, (metadata) =>
                    this.metadataWithLocators(metadata, locatorSnapshot.entryIds, locatorSnapshot.points)
                )
                try {
                    const timeoutMs = Math.min(5_000, this.remainingMs(deadlineAt))
                    if (!await this.session.flushMetadata(timeoutMs)) {
                        restoreError = new Error('Pi rewind metadata rollback did not persist')
                    }
                } catch (error) {
                    // Deadline calculation is part of rollback persistence. Keep
                    // it inside the restoreError path so release() always runs
                    // and the wrapper fails closed instead of retaining both
                    // the history gate and runtime-mutation lease.
                    restoreError = error
                }
            }
            release({ drain: !restoreError && !indeterminateTimeout })
            if (indeterminateTimeout) {
                throw new PiHistoryRestoreError(`Pi rewind timed out with indeterminate native state: ${indeterminateTimeout instanceof Error ? indeterminateTimeout.message : String(indeterminateTimeout)}`)
            }
            if (restoreError) {
                await this.publishCapabilities?.().catch(() => {})
                throw new PiHistoryRestoreError(`Pi rewind failed closed: source session restoration failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`)
            }
            // Capability metadata is advisory; it must not turn a precisely
            // restored deterministic rejection into a Hub-diverging exception.
            await this.publishCapabilities?.().catch(() => {})
        }
        if (success) return success
        if (source && failure?.outcome !== 'cancelled') {
            return { success: false, ...failure!, outcome: 'source_restored' }
        }
        return failure
            ? { success: false, ...failure }
            : { success: false, error: 'Pi rewind did not complete', outcome: 'rejected' }
    }

    private async forkHistorical(messageLocalId: string): Promise<ForkConversationRpcResult> {
        if (this.states.forkAtMessage === 'unsupported') throw new Error('Historical fork is not supported')
        const entryId = this.entryIdByLocalId.get(messageLocalId)
        if (!entryId) throw new Error(`No native history point for message ${messageLocalId}`)

        return await this.withSourceRestored('forkAtMessage', async (source, deadlineAt, markMutationIssued) => {
            let mutationCompleted = false
            try {
                const result = await this.nativeMutation(
                    { type: 'fork', entryId },
                    deadlineAt,
                    true,
                    markMutationIssued,
                )
                mutationCompleted = true
                if (wasCancelled(result)) throw new Error('Pi historical fork was cancelled')
                const afterFork = await this.getState(deadlineAt)
                this.assertDistinctIdentity(source, afterFork, 'Pi historical fork')
                return { nativeSessionId: afterFork.sessionId }
            } catch (error) {
                if (mutationCompleted && (isPiRpcTimeout(error) || error instanceof PiHistoryDeadlineError)) {
                    throw new PiHistoryIndeterminateMutationError(
                        `Pi historical fork completed but its resulting state is indeterminate: ${error instanceof Error ? error.message : String(error)}`,
                    )
                }
                throw error
            }
        })
    }

    private async withSourceRestored<T>(
        capability: keyof ConversationHistoryCapabilityStates,
        work: (source: PiState, deadlineAt: number, markMutationIssued: () => void) => Promise<T>,
    ): Promise<T> {
        const transaction = await this.beginHistoryTransaction()
        if (transaction.rejection) {
            transaction.release()
            throw new Error(transaction.rejection)
        }
        const { release, deadlineAt } = transaction
        let source: PiState | null = null
        let outcome: T | undefined
        let operationError: unknown
        let indeterminateTimeout: unknown
        let mutationIssued = false
        try {
            source = await this.getState(deadlineAt)
            outcome = await work(source, deadlineAt, () => { mutationIssued = true })
            this.states = markSupported(this.states, capability)
        } catch (error) {
            operationError = error
            if (error instanceof PiHistoryIndeterminateMutationError) indeterminateTimeout = error
            if (isUnknownCommand(error)) {
                this.states = markUnsupported(this.states, capability)
                // Both fork flows start with Pi's clone command; a real
                // unknown-command response there invalidates both affordances.
                if (capability === 'forkCurrent' || capability === 'forkAtMessage') {
                    this.states = markUnsupported(this.states, 'forkCurrent')
                    this.states = markUnsupported(this.states, 'forkAtMessage')
                }
            }
        } finally {
            let restoreError: unknown
            // A timed-out native mutation could have completed late. Any read or
            // switch used to classify it is itself a divergent mutation race.
            if (!indeterminateTimeout && source && mutationIssued) {
                try {
                    const restored = await this.restoreSource(source, deadlineAt)
                    this.session.applyNativeRuntimeState(restored.runtime)
                } catch (error) {
                    restoreError = error
                }
            }
            release({ drain: !restoreError && !indeterminateTimeout })
            if (indeterminateTimeout) {
                throw new PiHistoryRestoreError(`Pi history operation timed out with indeterminate native state: ${indeterminateTimeout instanceof Error ? indeterminateTimeout.message : String(indeterminateTimeout)}`)
            }
            if (restoreError) {
                await this.publishCapabilities?.().catch(() => {})
                throw new PiHistoryRestoreError(`Pi history operation failed closed: source session restoration failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`)
            }
            await this.publishCapabilities?.()
        }
        if (operationError) throw operationError
        return outcome as T
    }

    private assertHistoryIdle(): void {
        if (this.historySyncDisabled) throw new Error('Pi conversation history is unavailable')
        if (!this.session.isNativeReady) throw new Error('Pi native session is not ready')
        if (this.session.piIsStreaming || this.session.hasPromptInFlight) throw new Error('Pi session is busy')
    }

    private remainingMs(deadlineAt: number, reserveMs: number = 0): number {
        const remaining = Math.floor(deadlineAt - Date.now() - reserveMs)
        if (remaining <= 0) {
            throw new PiHistoryDeadlineError('Pi history operation exceeded its transaction deadline')
        }
        return remaining
    }

    private async rpcWithinDeadline(
        command: Record<string, unknown>,
        deadlineAt: number,
        reserveMs: number = 0,
    ): Promise<unknown> {
        return await this.rpc(command, this.remainingMs(deadlineAt, reserveMs))
    }

    private async nativeMutation(
        command: Record<string, unknown>,
        deadlineAt: number,
        reserveRestore: boolean = true,
        onIssued?: () => void,
    ): Promise<unknown> {
        const timeoutMs = this.remainingMs(
            deadlineAt,
            reserveRestore ? PI_HISTORY_RESTORE_RESERVE_MS : 0,
        )
        onIssued?.()
        try {
            return await this.rpc(command, timeoutMs)
        } catch (error) {
            if (isPiRpcTimeout(error)) {
                throw new PiHistoryIndeterminateMutationError(
                    `Pi ${String(command.type)} timed out with indeterminate native state: ${error instanceof Error ? error.message : String(error)}`,
                )
            }
            throw error
        }
    }

    private async waitWithinDeadline<T>(promise: Promise<T>, deadlineAt: number, operation: string): Promise<T> {
        const timeoutMs = this.remainingMs(deadlineAt)
        let timer: ReturnType<typeof setTimeout> | null = null
        try {
            return await Promise.race([
                promise,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new PiHistoryDeadlineError(
                        `Pi history operation timed out while waiting to ${operation}`,
                    )), timeoutMs)
                    timer.unref?.()
                }),
            ])
        } finally {
            if (timer) clearTimeout(timer)
        }
    }

    /**
     * Lock new prompts before waiting for old reads, then take one final source
     * snapshot. This closes the mapping race between Pi persistence and a
     * history mutation without discarding a pre-existing pending localId.
     */
    private async beginHistoryTransaction(): Promise<{
        release: (options?: { drain?: boolean }) => void
        deadlineAt: number
        rejection?: string
    }> {
        const deadlineAt = Date.now() + PI_HISTORY_OPERATION_TIMEOUT_MS
        // The history gate is intentionally acquired before the first await.
        // This queues later runtime mutations behind us while an already-active
        // config/abort mutation drains, closing the final-sync/fork race.
        const releaseHistoryGate = this.session.beginHistoryTransaction()
        let releaseRuntimeMutation: (() => void) | null = null
        let released = false
        const release = (options?: { drain?: boolean }) => {
            if (released) return
            released = true
            // Drain (or discard) prompt work while the runtime mutex remains
            // held, then make the next config/abort mutation eligible.
            releaseHistoryGate(options)
            releaseRuntimeMutation?.()
        }
        try {
            const acquireRuntimeMutation = this.session.acquireRuntimeMutation()
            try {
                releaseRuntimeMutation = await this.waitWithinDeadline(
                    acquireRuntimeMutation,
                    deadlineAt,
                    'acquire the runtime mutation lock',
                )
            } catch (error) {
                // The FIFO mutex acquisition cannot be cancelled. Release its
                // eventual lease immediately so a timed-out history request
                // cannot wedge later config/abort operations.
                void acquireRuntimeMutation.then((lateRelease) => lateRelease())
                throw error
            }
            if (this.syncInFlight) {
                await this.waitWithinDeadline(this.syncInFlight, deadlineAt, 'finish the previous history sync')
            }
            await this.syncEntriesOnce(this.remainingMs(deadlineAt))
            if (!await this.session.flushMetadata(Math.min(5_000, this.remainingMs(deadlineAt)))) {
                return { release, deadlineAt, rejection: 'Pi history metadata did not persist before native fork' }
            }
        } catch (error) {
            return {
                release,
                deadlineAt,
                rejection: `Pi history synchronization failed: ${error instanceof Error ? error.message : String(error)}`
            }
        }
        if (this.pendingUserEntries.length > 0) {
            return { release, deadlineAt, rejection: 'Pi session has pending user entries' }
        }
        this.invalidatePendingSync()
        return { release, deadlineAt }
    }

    private async cloneAndReadIdentity(
        source: PiState,
        deadlineAt: number,
        markMutationIssued: () => void,
    ): Promise<PiState> {
        let mutationCompleted = false
        try {
            const cloned = await this.nativeMutation(
                { type: 'clone' },
                deadlineAt,
                true,
                markMutationIssued,
            )
            mutationCompleted = true
            if (wasCancelled(cloned)) throw new Error('Pi clone was cancelled')
            const clone = await this.getState(deadlineAt)
            this.assertDistinctIdentity(source, clone, 'Pi clone')
            return clone
        } catch (error) {
            if (mutationCompleted && (isPiRpcTimeout(error) || error instanceof PiHistoryDeadlineError)) {
                throw new PiHistoryIndeterminateMutationError(
                    `Pi clone completed but its resulting state is indeterminate: ${error instanceof Error ? error.message : String(error)}`,
                )
            }
            throw error
        }
    }

    private assertDistinctIdentity(source: PiIdentity, next: PiIdentity, operation: string): void {
        if (next.sessionId === source.sessionId && next.sessionFile === source.sessionFile) {
            throw new Error(`${operation} did not create a distinct native session identity`)
        }
    }

    /** Reset the append cursor and retain only Pi entry mappings copied into the new branch. */
    private commitRewindState(state: PiState, entries: { entries: PiEntry[]; leafId: string | null }): void {
        const validEntryIds = new Set(entries.entries.map((entry) => entry.id))
        for (const [localId, entryId] of this.entryIdByLocalId.entries()) {
            if (!validEntryIds.has(entryId)) this.entryIdByLocalId.delete(localId)
        }
        this.observedEntryIds = validEntryIds
        this.appendCursor = entries.entries.length > 0 ? entries.entries[entries.entries.length - 1]!.id : null
        this.invalidatePendingSync()
        const entryIds = this.getEntryIds()
        const points = this.getHistoryPoints()
        this.session.commitNativeSessionState(state, state.runtime, (metadata) => this.metadataWithLocators(metadata, entryIds, points))
    }

    private captureLocatorState(): {
        entryIds: Record<string, string>
        points: Record<string, true>
        observedEntryIds: Set<string>
        appendCursor: string | null
    } {
        return {
            entryIds: this.getEntryIds(),
            points: this.getHistoryPoints(),
            observedEntryIds: new Set(this.observedEntryIds),
            appendCursor: this.appendCursor
        }
    }

    private restoreLocatorState(snapshot: ReturnType<PiConversationHistory['captureLocatorState']>): void {
        this.entryIdByLocalId.clear()
        for (const [localId, entryId] of Object.entries(snapshot.entryIds)) {
            this.entryIdByLocalId.set(localId, entryId)
        }
        this.observedEntryIds = new Set(snapshot.observedEntryIds)
        this.appendCursor = snapshot.appendCursor
    }

    private metadataWithLocators(
        metadata: Metadata,
        entryIds: Record<string, string>,
        points: Record<string, true>
    ): Metadata {
        const next: Metadata = {
            ...metadata,
            conversationHistoryEntryIds: entryIds,
            conversationHistoryPoints: points,
            ...(this.appendCursor ? { piHistoryLeafEntryId: this.appendCursor } : {})
        }
        if (Object.keys(entryIds).length === 0) delete next.conversationHistoryEntryIds
        if (Object.keys(points).length === 0) delete next.conversationHistoryPoints
        return next
    }

    private async restoreSource(source: PiState, deadlineAt: number): Promise<PiState> {
        const current = await this.getState(deadlineAt)
        if (current.sessionId === source.sessionId && current.sessionFile === source.sessionFile) return current
        const switched = await this.nativeMutation(
            { type: 'switch_session', sessionPath: source.sessionFile },
            deadlineAt,
            false,
        )
        if (wasCancelled(switched)) throw new Error('Pi source session restoration was cancelled')
        const restored = await this.getState(deadlineAt)
        if (restored.sessionId !== source.sessionId || restored.sessionFile !== source.sessionFile) {
            throw new Error('Pi source session restoration returned a different identity')
        }
        return restored
    }

    private async getState(deadlineAt?: number): Promise<PiState> {
        return readState(await (deadlineAt === undefined
            ? this.rpc({ type: 'get_state' })
            : this.rpcWithinDeadline({ type: 'get_state' }, deadlineAt)))
    }

    private observeParsedEntry(entry: PiEntry, persistMetadata: boolean = true): void {
        if (this.observedEntryIds.has(entry.id)) return
        this.observedEntryIds.add(entry.id)
        this.appendCursor = entry.id
        if (!isUserEntry(entry)) {
            if (persistMetadata) {
                this.session.updateMetadata((metadata) => ({ ...metadata, piHistoryLeafEntryId: entry.id }))
            }
            return
        }
        const pending = this.pendingUserEntries.shift()
        if (!pending || this.entryIdByLocalId.has(pending.localId)) {
            if (persistMetadata) {
                this.session.updateMetadata((metadata) => ({ ...metadata, piHistoryLeafEntryId: entry.id }))
            }
            return
        }
        const localId = pending.localId
        this.entryIdByLocalId.set(localId, entry.id)
        if (!persistMetadata) return
        this.session.updateMetadata((metadata) => ({
            ...metadata,
            piHistoryLeafEntryId: entry.id,
            conversationHistoryPoints: {
                ...metadata.conversationHistoryPoints,
                [localId]: true as const,
            },
            conversationHistoryEntryIds: {
                ...metadata.conversationHistoryEntryIds,
                [localId]: entry.id,
            },
        }))
    }

    private invalidatePendingSync(): void {
        this.syncGeneration += 1
        this.syncRequestedWhileInFlight = false
    }
}
