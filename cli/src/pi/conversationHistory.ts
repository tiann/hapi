import type { Metadata } from '@/api/types'
import {
    PI_CONVERSATION_HISTORY_INITIAL,
    markSupported,
    markUnsupported,
    toConversationHistoryCapabilities,
    type ConversationHistoryCapabilityStates
} from '@hapi/protocol/conversationHistory'
import type { ForkConversationRpcResult, RewindConversationRpcResult } from '@hapi/protocol/apiTypes'
import type { PiSession } from './session'

type PiRpc = (command: Record<string, unknown>) => Promise<unknown>

type PiIdentity = {
    sessionId: string
    sessionFile: string
}

type PiEntry = {
    id: string
    type: string
    message?: { role?: unknown }
}

type PendingUserEntry = {
    localId: string
    kind: 'prompt' | 'steer'
}

/** Source identity could not be restored; caller must terminate this Pi wrapper. */
export class PiHistoryRestoreError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'PiHistoryRestoreError'
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

function wasCancelled(data: unknown): boolean {
    return asRecord(data)?.cancelled === true
}

function readIdentity(data: unknown): PiIdentity {
    const state = asRecord(data)
    const sessionId = asString(state?.sessionId)
    const sessionFile = asString(state?.sessionFile)
    if (!sessionId || !sessionFile) {
        throw new Error('Pi get_state did not return sessionId and sessionFile')
    }
    return { sessionId, sessionFile }
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

    /** Called before Pi reports native-ready, while its prompt gate is closed. */
    async initialize(): Promise<void> {
        try {
            await this.syncEntries()
            await this.probeCapabilities()
        } catch {
            // Capability publication remains absent; normal Pi startup continues.
        }
    }

    registerPrompt(localId: string | undefined): void {
        this.registerUserEntry(localId, 'prompt')
    }

    /** Steer is persisted as a Pi user entry once accepted, just like prompt. */
    registerSteer(localId: string | undefined): void {
        this.registerUserEntry(localId, 'steer')
    }

    /** Remove a rejected/aborted entry by exact localId; never cross-consume kinds. */
    rejectPendingEntry(localId: string | undefined, kind: PendingUserEntry['kind']): void {
        if (!localId) return
        const index = this.pendingUserEntries.findIndex((entry) => entry.localId === localId && entry.kind === kind)
        if (index !== -1) this.pendingUserEntries.splice(index, 1)
    }

    observeEntry(rawEntry: unknown): void {
        if (this.session.isHistoryTransactionActive) return
        const parsed = readEntries({ entries: [rawEntry], leafId: null })
        for (const entry of parsed.entries) this.observeParsedEntry(entry)
    }

    async syncEntries(): Promise<void> {
        if (this.session.isHistoryTransactionActive) return
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
            if (scheduleFollowUp) void this.syncEntries()
        })
        return await this.syncInFlight
    }

    private async runEntrySync(): Promise<void> {
        do {
            this.syncRequestedWhileInFlight = false
            await this.syncEntriesOnce()
        } while (this.syncRequestedWhileInFlight && !this.session.isHistoryTransactionActive)
    }

    private async syncEntriesOnce(): Promise<void> {
        const generation = this.syncGeneration
        const data = await this.rpc(this.appendCursor
            ? { type: 'get_entries', since: this.appendCursor }
            : { type: 'get_entries' })
        if (generation !== this.syncGeneration) return
        const result = readEntries(data)
        for (const entry of result.entries) this.observeParsedEntry(entry)
        // `since` indexes the immutable append log, not the active branch.
        // A fork can move leafId backwards; advancing the cursor to it would
        // replay entries and break FIFO pairing. Empty increments keep cursor.
        if (result.entries.length > 0) this.appendCursor = result.entries[result.entries.length - 1]!.id
    }

    async probeCapabilities(): Promise<void> {
        if (this.states.forkCurrent !== 'unknown' && this.states.forkAtMessage !== 'unknown'
            && this.states.rewindToMessage !== 'unknown') return
        try {
            // Both reads are side-effect free and exist together with Pi 0.83's
            // clone/fork APIs. Do not expose controls before this succeeds.
            await this.rpc({ type: 'get_fork_messages' })
            await this.rpc({ type: 'get_entries', ...(this.appendCursor ? { since: this.appendCursor } : {}) })
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

        return await this.withSourceRestored('forkCurrent', async (source) => {
            const clone = await this.cloneAndReadIdentity(source)
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
        const { release } = transaction
        let source: PiIdentity | null = null
        let committed = false
        let rollbackRewindMetadata = false
        const locatorSnapshot = this.captureLocatorState()
        let success: Extract<RewindConversationRpcResult, { success: true }> | null = null
        let failure: { error: string; outcome: 'rejected' | 'cancelled' | 'source_restored' } | null = null
        try {
            source = await this.getState()
            const forkMessages = await this.rpc({ type: 'get_fork_messages' })
            if (!containsForkEntry(forkMessages, entryId)) {
                throw new Error('Pi rewind point is no longer available')
            }
            const result = await this.rpc({ type: 'fork', entryId })
            if (wasCancelled(result)) {
                failure = { error: 'Pi rewind was cancelled', outcome: 'cancelled' }
                throw new Error(failure.error)
            }
            const forked = await this.getState()
            this.assertDistinctIdentity(source, forked, 'Pi rewind')
            const entries = readEntries(await this.rpc({ type: 'get_entries' }))
            this.commitRewindIdentity(forked, entries)
            if (!await this.session.flushMetadata()) {
                rollbackRewindMetadata = true
                throw new Error('Pi rewind metadata did not persist')
            }
            committed = true
            this.states = markSupported(this.states, 'rewindToMessage')
            success = { success: true, truncateFromLocalId: messageLocalId, messages: [] }
        } catch (error) {
            if (!failure) {
                failure = {
                    error: error instanceof Error ? error.message : String(error),
                    outcome: 'rejected'
                }
            }
            if (isUnknownCommand(error)) this.states = markUnsupported(this.states, 'rewindToMessage')
        } finally {
            let restoreError: unknown
            // Before commit this is a failed transaction and the old source must
            // remain active. After commit, the branched Pi session *is* rewind.
            if (!committed && source) {
                try {
                    await this.restoreSource(source)
                } catch (error) {
                    restoreError = error
                }
            }
            if (!restoreError && rollbackRewindMetadata && source) {
                this.restoreLocatorState(locatorSnapshot)
                this.session.commitNativeSessionIdentity(source, (metadata) =>
                    this.metadataWithLocators(metadata, locatorSnapshot.entryIds, locatorSnapshot.points)
                )
                if (!await this.session.flushMetadata()) {
                    restoreError = new Error('Pi rewind metadata rollback did not persist')
                }
            }
            release({ drain: !restoreError })
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

        return await this.withSourceRestored('forkAtMessage', async (source) => {
            const result = await this.rpc({ type: 'fork', entryId })
            if (wasCancelled(result)) throw new Error('Pi historical fork was cancelled')
            const afterFork = await this.getState()
            this.assertDistinctIdentity(source, afterFork, 'Pi historical fork')
            return { nativeSessionId: afterFork.sessionId }
        })
    }

    private async withSourceRestored<T>(capability: keyof ConversationHistoryCapabilityStates, work: (source: PiIdentity) => Promise<T>): Promise<T> {
        const transaction = await this.beginHistoryTransaction()
        if (transaction.rejection) {
            transaction.release()
            throw new Error(transaction.rejection)
        }
        const { release } = transaction
        let source: PiIdentity | null = null
        let outcome: T | undefined
        let operationError: unknown
        try {
            source = await this.getState()
            outcome = await work(source)
            this.states = markSupported(this.states, capability)
        } catch (error) {
            operationError = error
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
            if (source) {
                try {
                    await this.restoreSource(source)
                } catch (error) {
                    restoreError = error
                }
            }
            release({ drain: !restoreError })
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
        if (!this.session.isNativeReady) throw new Error('Pi native session is not ready')
        if (this.session.piIsStreaming) throw new Error('Pi session is busy')
    }

    /**
     * Lock new prompts before waiting for old reads, then take one final source
     * snapshot. This closes the mapping race between Pi persistence and a
     * history mutation without discarding a pre-existing pending localId.
     */
    private async beginHistoryTransaction(): Promise<{
        release: (options?: { drain?: boolean }) => void
        rejection?: string
    }> {
        const release = this.session.beginHistoryTransaction()
        try {
            await this.syncInFlight
            await this.syncEntriesOnce()
            if (!await this.session.flushMetadata()) {
                return { release, rejection: 'Pi history metadata did not persist before native fork' }
            }
        } catch (error) {
            return {
                release,
                rejection: `Pi history synchronization failed: ${error instanceof Error ? error.message : String(error)}`
            }
        }
        if (this.pendingUserEntries.length > 0) {
            return { release, rejection: 'Pi session has pending user entries' }
        }
        this.invalidatePendingSync()
        return { release }
    }

    private async cloneAndReadIdentity(source: PiIdentity): Promise<PiIdentity> {
        const cloned = await this.rpc({ type: 'clone' })
        if (wasCancelled(cloned)) throw new Error('Pi clone was cancelled')
        const clone = await this.getState()
        this.assertDistinctIdentity(source, clone, 'Pi clone')
        return clone
    }

    private assertDistinctIdentity(source: PiIdentity, next: PiIdentity, operation: string): void {
        if (next.sessionId === source.sessionId && next.sessionFile === source.sessionFile) {
            throw new Error(`${operation} did not create a distinct native session identity`)
        }
    }

    /** Reset the append cursor and retain only Pi entry mappings copied into the new branch. */
    private commitRewindIdentity(identity: PiIdentity, entries: { entries: PiEntry[]; leafId: string | null }): void {
        const validEntryIds = new Set(entries.entries.map((entry) => entry.id))
        for (const [localId, entryId] of this.entryIdByLocalId.entries()) {
            if (!validEntryIds.has(entryId)) this.entryIdByLocalId.delete(localId)
        }
        this.observedEntryIds = validEntryIds
        this.appendCursor = entries.entries.length > 0 ? entries.entries[entries.entries.length - 1]!.id : null
        this.invalidatePendingSync()
        const entryIds = this.getEntryIds()
        const points = this.getHistoryPoints()
        this.session.commitNativeSessionIdentity(identity, (metadata) => this.metadataWithLocators(metadata, entryIds, points))
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
        const next: Metadata = { ...metadata, conversationHistoryEntryIds: entryIds, conversationHistoryPoints: points }
        if (Object.keys(entryIds).length === 0) delete next.conversationHistoryEntryIds
        if (Object.keys(points).length === 0) delete next.conversationHistoryPoints
        return next
    }

    private async restoreSource(source: PiIdentity): Promise<void> {
        const current = await this.getState()
        if (current.sessionId === source.sessionId && current.sessionFile === source.sessionFile) return
        const switched = await this.rpc({ type: 'switch_session', sessionPath: source.sessionFile })
        if (wasCancelled(switched)) throw new Error('Pi source session restoration was cancelled')
        const restored = await this.getState()
        if (restored.sessionId !== source.sessionId || restored.sessionFile !== source.sessionFile) {
            throw new Error('Pi source session restoration returned a different identity')
        }
    }

    private async getState(): Promise<PiIdentity> {
        return readIdentity(await this.rpc({ type: 'get_state' }))
    }

    private observeParsedEntry(entry: PiEntry): void {
        if (this.observedEntryIds.has(entry.id)) return
        this.observedEntryIds.add(entry.id)
        this.appendCursor = entry.id
        if (!isUserEntry(entry)) return
        const pending = this.pendingUserEntries.shift()
        if (!pending || this.entryIdByLocalId.has(pending.localId)) return
        const localId = pending.localId
        this.entryIdByLocalId.set(localId, entry.id)
        this.session.updateMetadata((metadata) => ({
            ...metadata,
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

    private registerUserEntry(localId: string | undefined, kind: PendingUserEntry['kind']): void {
        if (localId) this.pendingUserEntries.push({ localId, kind })
    }

    private invalidatePendingSync(): void {
        this.syncGeneration += 1
        this.syncRequestedWhileInFlight = false
    }
}
