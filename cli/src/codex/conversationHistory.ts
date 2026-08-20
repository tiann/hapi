import { CodexAppServerClient } from './codexAppServerClient'
import type { Metadata } from '@/api/types'
import {
    CODEX_CONVERSATION_HISTORY_INITIAL,
    markSupported,
    markUnsupported,
    toConversationHistoryCapabilities,
    type ConversationHistoryCapabilityStates
} from '@hapi/protocol/conversationHistory'
import type {
    ForkConversationRpcResult,
    RewindConversationRpcResult
} from '@hapi/protocol/apiTypes'
import { logger } from '@/ui/logger'

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

function isMethodNotFound(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /method not found|unknown method|unsupported/i.test(message)
}

async function withDeadline<T>(
    operation: () => Promise<T>,
    deadline: number,
    timeoutError: Error,
    onTimeout?: () => void
): Promise<T> {
    let timeoutTriggered = false
    const triggerTimeout = () => {
        if (timeoutTriggered) return
        timeoutTriggered = true
        onTimeout?.()
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
        triggerTimeout()
        throw timeoutError
    }

    let timeout: ReturnType<typeof setTimeout> | null = null
    const timedOut = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
            triggerTimeout()
            reject(timeoutError)
        }, remaining)
        timeout.unref()
    })
    try {
        let result: T
        try {
            result = await Promise.race([operation(), timedOut])
        } catch (error) {
            if (timeoutTriggered || Date.now() >= deadline) {
                triggerTimeout()
                throw timeoutError
            }
            throw error
        }
        if (timeoutTriggered || Date.now() >= deadline) {
            triggerTimeout()
            throw timeoutError
        }
        return result
    } finally {
        if (timeout) clearTimeout(timeout)
    }
}

type TurnInfo = {
    id: string
    status?: string
    clientIds: string[]
}

type ForkClient = Pick<CodexAppServerClient, 'connect' | 'initialize' | 'forkThread' | 'disconnect'>
const HISTORY_OPERATION_TIMEOUT_MS = 90_000
const FORK_CLEANUP_RESERVE_MS = 10_000
type ForkCapability = 'forkCurrent' | 'forkAtMessage'
type SourceLeaseWaiter = {
    signal?: AbortSignal
    resolve: (release: () => void) => void
    reject: (error: unknown) => void
    onAbort?: () => void
}

export class CodexConversationHistory {
    private states: ConversationHistoryCapabilityStates = { ...CODEX_CONVERSATION_HISTORY_INITIAL }
    private threadId: string | null = null
    private readonly turnByLocalId = new Map<string, string>()
    private busy = false
    private publishCapabilities: (() => Promise<void>) | null = null
    private failedForkClient: ForkClient | null = null
    private activeForkClient: ForkClient | null = null
    private activeForkAbortController: AbortController | null = null
    private mutationInFlight: Promise<unknown> | null = null
    private rawRollbackInFlight: Promise<unknown> | null = null
    private probeInFlight: Promise<void> | null = null
    private closing = false
    private leaseOwner: symbol | null = null
    private readonly sourceLeaseWaiters: SourceLeaseWaiter[] = []

    constructor(
        private readonly getClient: () => CodexAppServerClient | null,
        private readonly createForkClient: () => ForkClient = () => new CodexAppServerClient()
    ) {}

    setPublishCapabilities(fn: () => Promise<void>): void {
        this.publishCapabilities = fn
    }

    setBusy(busy: boolean): void {
        this.busy = busy
    }

    async acquireSourceLease(signal?: AbortSignal): Promise<() => void> {
        const release = await this.waitForSourceLease(signal)
        try {
            this.throwIfClosing()
            if (signal?.aborted) throw signal.reason
            await this.retryFailedForkCleanupBy(Date.now() + HISTORY_OPERATION_TIMEOUT_MS)
            this.throwIfClosing()
            if (signal?.aborted) throw signal.reason
            return release
        } catch (error) {
            release()
            throw error
        }
    }

    setThreadId(threadId: string | null): void {
        this.threadId = threadId
    }

    restoreTurns(turns: Record<string, string> | null | undefined): void {
        if (!turns) return
        for (const [localId, turnId] of Object.entries(turns)) {
            if (localId && turnId) this.turnByLocalId.set(localId, turnId)
        }
    }

    getTurns(): Record<string, string> {
        return Object.fromEntries(this.turnByLocalId.entries())
    }

    rememberLocalIdTurn(localId: string | undefined, turnId: string | null | undefined): void {
        if (!localId || !turnId) return
        this.turnByLocalId.set(localId, turnId)
    }

    getCapabilityStates(): ConversationHistoryCapabilityStates {
        return this.states
    }

    getCapabilitiesForMetadata(): Metadata['capabilities'] {
        const conversationHistory = toConversationHistoryCapabilities(this.states)
        return conversationHistory ? { conversationHistory } : undefined
    }

    async cleanup(): Promise<void> {
        this.closing = true
        this.rejectSourceLeaseWaiters(new Error('Codex conversation history is shutting down'))
        this.activeForkAbortController?.abort()
        const deadline = Date.now() + HISTORY_OPERATION_TIMEOUT_MS
        const activeClient = this.activeForkClient
        if (activeClient) {
            try {
                await withDeadline(
                    () => activeClient.disconnect({ deadline }),
                    deadline,
                    new Error(`Codex fork cleanup timed out after ${HISTORY_OPERATION_TIMEOUT_MS}ms total`)
                )
            } catch {
                this.failedForkClient = activeClient
            }
        }

        const probeInFlight = this.probeInFlight
        if (probeInFlight) {
            try {
                await withDeadline(
                    () => probeInFlight,
                    deadline,
                    new Error(`Codex fork cleanup timed out after ${HISTORY_OPERATION_TIMEOUT_MS}ms total`)
                )
            } catch {
                // Probe errors do not prevent the existing shutdown sequence.
            }
        }

        const inFlight = this.mutationInFlight
        if (inFlight) {
            try {
                await withDeadline(
                    () => inFlight,
                    deadline,
                    new Error(`Codex fork cleanup timed out after ${HISTORY_OPERATION_TIMEOUT_MS}ms total`)
                )
            } catch {
                // Mutation errors are expected during teardown; retained cleanup is retried below.
            }
        }

        const rawRollback = this.rawRollbackInFlight
        if (rawRollback) {
            try {
                await withDeadline(
                    () => rawRollback,
                    deadline,
                    new Error(`Codex rollback cleanup timed out after ${HISTORY_OPERATION_TIMEOUT_MS}ms total`)
                )
            } catch {
                // Rollback failures are already reported to the mutation caller.
            }
        }
        await this.retryFailedForkCleanupBy(deadline)
    }

    /** Probe fork/rollback once thread is live. Never optimistic. */
    probeCapabilities(): Promise<void> {
        if (this.closing) return Promise.resolve()
        if (this.probeInFlight) return this.probeInFlight

        const inFlight = this.runCapabilityProbe().finally(() => {
            if (this.probeInFlight === inFlight) this.probeInFlight = null
        })
        this.probeInFlight = inFlight
        return inFlight
    }

    private async runCapabilityProbe(): Promise<void> {
        const client = this.getClient()
        const threadId = this.threadId
        if (!client || !threadId) return

        if (this.states.forkCurrent === 'unknown' || this.states.forkAtMessage === 'unknown') {
            const forkSupported = await client.supportsMethod('thread/fork')
            if (this.closing) return
            if (forkSupported) {
                this.states = markSupported(this.states, 'forkCurrent')
                this.states = markSupported(this.states, 'forkAtMessage')
            } else {
                this.states = markUnsupported(this.states, 'forkCurrent')
                this.states = markUnsupported(this.states, 'forkAtMessage')
            }
        }

        if (this.states.rewindToMessage === 'unknown') {
            const rewindSupported = await client.supportsMethod('thread/rollback')
            if (this.closing) return
            this.states = rewindSupported
                ? markSupported(this.states, 'rewindToMessage')
                : markUnsupported(this.states, 'rewindToMessage')
        }

        await this.publishCapabilities?.()
        if (this.closing) return
    }

    async fork(messageLocalId?: string): Promise<ForkConversationRpcResult> {
        const abortController = new AbortController()
        return this.runMutation(async (deadline) => {
            this.activeForkAbortController = abortController
            try {
                return await this.performFork(messageLocalId, deadline, abortController)
            } finally {
                if (this.activeForkAbortController === abortController) {
                    this.activeForkAbortController = null
                }
            }
        })
    }

    private async runMutation<T>(operation: (deadline: number) => Promise<T>): Promise<T> {
        if (this.closing) throw new Error('Codex conversation history is shutting down')
        if (this.busy) throw new Error('Session is busy')
        if (this.mutationInFlight || this.rawRollbackInFlight) {
            throw new Error('Codex conversation history mutation is already in progress')
        }
        const releaseLease = this.acquireMutationLease()
        const deadline = Date.now() + HISTORY_OPERATION_TIMEOUT_MS
        const inFlight = (async () => {
            await this.retryFailedForkCleanupBy(deadline)
            this.throwIfClosing()
            return await operation(deadline)
        })()
        this.mutationInFlight = inFlight
        try {
            return await inFlight
        } finally {
            if (this.mutationInFlight === inFlight) this.mutationInFlight = null
            this.releaseMutationLeaseAfterRollback(releaseLease)
        }
    }

    private releaseMutationLeaseAfterRollback(releaseLease: () => void): void {
        const rawRollback = this.rawRollbackInFlight
        if (rawRollback) {
            void rawRollback.then(releaseLease, releaseLease)
        } else {
            releaseLease()
        }
    }

    private async performFork(
        messageLocalId: string | undefined,
        deadline: number,
        abortController: AbortController
    ): Promise<ForkConversationRpcResult> {
        if (this.busy) throw new Error('Session is busy')
        const client = this.getClient()
        const threadId = this.threadId
        if (!client || !threadId) throw new Error('Codex thread is not ready')
        this.throwIfForkStopped(abortController.signal)

        if (messageLocalId) {
            if (this.states.forkAtMessage === 'unsupported') {
                throw new Error('Historical fork is not supported')
            }
            // HAPI historical fork excludes the selected boundary turn. Prefer the
            // stable inclusive `lastTurnId` of the previous turn over experimental
            // `beforeTurnId`, so native context matches the hydrated transcript.
            const operationTimeout = new Error(
                `Codex fork timed out after ${HISTORY_OPERATION_TIMEOUT_MS - FORK_CLEANUP_RESERVE_MS}ms`
            )
            const turns = await withDeadline(
                () => this.listTurns(abortController.signal),
                deadline - FORK_CLEANUP_RESERVE_MS,
                operationTimeout,
                () => abortController.abort()
            )
            this.throwIfForkStopped(abortController.signal)
            const selectedTurnId = await this.resolveTurnId(messageLocalId, turns)
            this.throwIfForkStopped(abortController.signal)
            const selectedIndex = turns.findIndex((turn) => turn.id === selectedTurnId)
            if (selectedIndex < 0) {
                throw new Error('Selected turn not found')
            }
            // Prefer stable inclusive lastTurnId of the previous turn. The first
            // turn has no predecessor, so fall back to experimental beforeTurnId
            // (exclusive) for that single boundary.
            const boundary = selectedIndex === 0
                ? { beforeTurnId: selectedTurnId }
                : { lastTurnId: turns[selectedIndex - 1]!.id }
            const response = await this.forkThread({
                threadId,
                ...boundary
            }, 'forkAtMessage', deadline, abortController)
            this.throwIfForkStopped(abortController.signal)
            const nativeSessionId = asString(asRecord(response.thread)?.id)
            if (!nativeSessionId) throw new Error('thread/fork did not return thread.id')
            this.states = markSupported(this.states, 'forkAtMessage')
            this.states = markSupported(this.states, 'forkCurrent')
            await this.publishCapabilitiesBy(deadline)
            this.throwIfForkStopped(abortController.signal)
            return { nativeSessionId }
        }

        if (this.states.forkCurrent === 'unsupported') {
            throw new Error('Fork current is not supported')
        }
        const response = await this.forkThread(
            { threadId },
            'forkCurrent',
            deadline,
            abortController
        )
        this.throwIfForkStopped(abortController.signal)
        const nativeSessionId = asString(asRecord(response.thread)?.id)
        if (!nativeSessionId) throw new Error('thread/fork did not return thread.id')
        this.states = markSupported(this.states, 'forkCurrent')
        await this.publishCapabilitiesBy(deadline)
        this.throwIfForkStopped(abortController.signal)
        return { nativeSessionId }
    }

    async rewind(messageLocalId: string): Promise<RewindConversationRpcResult> {
        return this.runMutation((deadline) => this.performRewind(messageLocalId, deadline))
    }

    private async performRewind(
        messageLocalId: string,
        deadline: number
    ): Promise<RewindConversationRpcResult> {
        const timeoutError = new Error(
            `Codex rewind timed out after ${HISTORY_OPERATION_TIMEOUT_MS}ms total`
        )
        const abortController = new AbortController()
        if (this.busy) throw new Error('Session is busy')
        const client = this.getClient()
        const threadId = this.threadId
        if (!client || !threadId) throw new Error('Codex thread is not ready')
        if (this.states.rewindToMessage === 'unsupported') {
            throw new Error('Rewind is not supported')
        }

        const turns = await withDeadline(
            () => this.listTurns(abortController.signal),
            deadline,
            timeoutError,
            () => abortController.abort()
        )
        this.throwIfRewindStopped(deadline, timeoutError)
        const turnId = await this.resolveTurnId(messageLocalId, turns)
        this.throwIfRewindStopped(deadline, timeoutError)
        const index = turns.findIndex((turn) => turn.id === turnId)
        if (index < 0) throw new Error('Selected turn not found')
        if (turns[index]?.status === 'inProgress' || turns[index]?.status === 'in_progress') {
            throw new Error('Cannot rewind an in-progress turn')
        }
        const numTurns = turns.length - index
        if (numTurns <= 0) throw new Error('Invalid rewind count')

        this.throwIfRewindStopped(deadline, timeoutError)
        if (this.busy) throw new Error('Session is busy')
        try {
            const rawRollback = client.rollbackThread({ threadId, numTurns })
            this.rawRollbackInFlight = rawRollback
            const clearRawRollback = () => {
                if (this.rawRollbackInFlight === rawRollback) {
                    this.rawRollbackInFlight = null
                }
            }
            void rawRollback.then(clearRawRollback, clearRawRollback)
            await withDeadline(
                () => rawRollback,
                deadline,
                timeoutError
            )
        } catch (error) {
            this.throwIfRewindStopped(deadline, timeoutError)
            if (isMethodNotFound(error)) {
                this.states = markUnsupported(this.states, 'rewindToMessage')
                await this.publishCapabilitiesBy(deadline, timeoutError)
                this.throwIfRewindStopped(deadline, timeoutError)
                throw new Error('thread/rollback is unsupported')
            }
            throw error
        }
        this.throwIfRewindStopped(deadline, timeoutError)
        this.states = markSupported(this.states, 'rewindToMessage')
        await this.publishCapabilitiesBy(deadline, timeoutError)
        this.throwIfRewindStopped(deadline, timeoutError)

        // Re-read remaining turns for hydrate; return empty messages so hub truncates
        // and child clients reset via epoch. Native history is source of truth on resume.
        return {
            success: true,
            truncateFromLocalId: messageLocalId,
            messages: []
        }
    }

    private async resolveTurnId(localId: string, turns?: TurnInfo[]): Promise<string> {
        const cached = this.turnByLocalId.get(localId)
        if (cached) return cached

        const list = turns ?? await this.listTurns()
        for (const turn of list) {
            if (turn.clientIds.includes(localId)) {
                this.turnByLocalId.set(localId, turn.id)
                return turn.id
            }
        }
        throw new Error(`No native history point for message ${localId}`)
    }

    private async forkThread(
        params: Parameters<CodexAppServerClient['forkThread']>[0],
        capability: ForkCapability,
        deadline: number,
        abortController: AbortController
    ) {
        this.throwIfForkStopped(abortController.signal)
        const client = this.createForkClient()
        this.activeForkClient = client
        try {
            return await this.forkThreadWithClient(
                client,
                params,
                capability,
                deadline,
                abortController
            )
        } finally {
            if (this.activeForkClient === client) this.activeForkClient = null
        }
    }

    private async forkThreadWithClient(
        client: ForkClient,
        params: Parameters<CodexAppServerClient['forkThread']>[0],
        capability: ForkCapability,
        deadline: number,
        abortController: AbortController
    ) {
        const operationDeadline = deadline - FORK_CLEANUP_RESERVE_MS
        let methodUnsupported = false
        let operationFailed = false
        let operationError: unknown = null
        let response: Awaited<ReturnType<ForkClient['forkThread']>> | null = null

        try {
            const operationTimeout = new Error(
                `Codex fork timed out after ${HISTORY_OPERATION_TIMEOUT_MS - FORK_CLEANUP_RESERVE_MS}ms`
            )
            response = await withDeadline(async () => {
                this.throwIfForkStopped(abortController.signal)
                await client.connect({ requireVerifiedProcessIdentity: true })
                this.throwIfForkStopped(abortController.signal)
                await client.initialize({
                    clientInfo: {
                        name: 'hapi-codex-client',
                        version: '1.0.0'
                    },
                    capabilities: {
                        experimentalApi: true
                    }
                })
                this.throwIfForkStopped(abortController.signal)
                try {
                    const forked = await client.forkThread(params, {
                        signal: abortController.signal
                    })
                    this.throwIfForkStopped(abortController.signal)
                    return forked
                } catch (error) {
                    if (!abortController.signal.aborted && isMethodNotFound(error)) {
                        this.states = markUnsupported(this.states, capability)
                        methodUnsupported = true
                    }
                    throw error
                }
            }, operationDeadline, operationTimeout, () => abortController.abort())
        } catch (error) {
            operationFailed = true
            operationError = error
        }

        let cleanupFailed = false
        let cleanupError: unknown = null
        try {
            await withDeadline(
                () => client.disconnect({ deadline }),
                deadline,
                new Error(`Codex fork cleanup timed out after ${HISTORY_OPERATION_TIMEOUT_MS}ms total`)
            )
        } catch (error) {
            this.failedForkClient = client
            cleanupFailed = true
            cleanupError = error
        }

        if (!operationFailed) {
            try {
                this.throwIfForkStopped(abortController.signal)
            } catch (error) {
                operationFailed = true
                operationError = error
            }
        }

        if (methodUnsupported && !this.closing && !abortController.signal.aborted) {
            try {
                await this.publishCapabilitiesBy(deadline)
            } catch (error) {
                logger.debug(
                    `[Codex] Failed to publish fork capability update: ${error instanceof Error ? error.message : String(error)}`
                )
            }
        }

        if (operationFailed && cleanupFailed) {
            const operationMessage = operationError instanceof Error
                ? operationError.message
                : String(operationError)
            const cleanupMessage = cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError)
            throw new AggregateError(
                [operationError, cleanupError],
                `${operationMessage}; temporary app-server cleanup failed: ${cleanupMessage}`
            )
        }
        if (operationFailed) throw operationError
        if (cleanupFailed) throw cleanupError
        return response!
    }

    private throwIfClosing(): void {
        if (this.closing) throw new Error('Codex conversation history is shutting down')
    }

    private acquireMutationLease(): () => void {
        this.throwIfClosing()
        if (this.busy) throw new Error('Session is busy')
        if (this.leaseOwner) {
            throw new Error('Codex conversation history mutation is already in progress')
        }
        const token = Symbol('codex-history-mutation')
        this.leaseOwner = token
        return this.createLeaseRelease(token)
    }

    private waitForSourceLease(signal?: AbortSignal): Promise<() => void> {
        try {
            this.throwIfClosing()
        } catch (error) {
            return Promise.reject(error)
        }
        if (signal?.aborted) return Promise.reject(signal.reason)
        if (!this.leaseOwner) {
            const token = Symbol('codex-source')
            this.leaseOwner = token
            this.busy = true
            return Promise.resolve(this.createLeaseRelease(token))
        }

        return new Promise<() => void>((resolve, reject) => {
            const waiter: SourceLeaseWaiter = { signal, resolve, reject }
            if (signal) {
                waiter.onAbort = () => {
                    const index = this.sourceLeaseWaiters.indexOf(waiter)
                    if (index >= 0) this.sourceLeaseWaiters.splice(index, 1)
                    reject(signal.reason)
                }
                signal.addEventListener('abort', waiter.onAbort, { once: true })
            }
            this.sourceLeaseWaiters.push(waiter)
        })
    }

    private createLeaseRelease(token: symbol): () => void {
        let released = false
        return () => {
            if (released) return
            released = true
            if (this.leaseOwner !== token) return
            this.leaseOwner = null
            this.busy = false
            this.grantNextSourceLease()
        }
    }

    private grantNextSourceLease(): void {
        while (!this.leaseOwner) {
            const waiter = this.sourceLeaseWaiters.shift()
            if (!waiter) return
            if (waiter.onAbort && waiter.signal) {
                waiter.signal.removeEventListener('abort', waiter.onAbort)
            }
            if (this.closing) {
                waiter.reject(new Error('Codex conversation history is shutting down'))
                continue
            }
            if (waiter.signal?.aborted) {
                waiter.reject(waiter.signal.reason)
                continue
            }
            const token = Symbol('codex-source')
            this.leaseOwner = token
            this.busy = true
            waiter.resolve(this.createLeaseRelease(token))
        }
    }

    private rejectSourceLeaseWaiters(error: Error): void {
        for (const waiter of this.sourceLeaseWaiters.splice(0)) {
            if (waiter.onAbort && waiter.signal) {
                waiter.signal.removeEventListener('abort', waiter.onAbort)
            }
            waiter.reject(error)
        }
    }

    private throwIfForkStopped(signal: AbortSignal): void {
        this.throwIfClosing()
        if (signal.aborted) throw new Error('Codex fork was aborted')
    }

    private throwIfRewindStopped(deadline: number, timeoutError: Error): void {
        this.throwIfClosing()
        if (Date.now() >= deadline) throw timeoutError
    }

    private async retryFailedForkCleanupBy(deadline: number): Promise<void> {
        const client = this.failedForkClient
        if (!client) return
        await withDeadline(
            () => client.disconnect({ deadline }),
            deadline,
            new Error(`Codex fork cleanup timed out after ${HISTORY_OPERATION_TIMEOUT_MS}ms total`)
        )
        if (this.failedForkClient === client) this.failedForkClient = null
    }

    private async publishCapabilitiesBy(
        deadline: number,
        timeoutError = new Error(
            `Codex fork timed out after ${HISTORY_OPERATION_TIMEOUT_MS}ms total`
        )
    ): Promise<void> {
        if (!this.publishCapabilities) return
        await withDeadline(
            () => this.publishCapabilities!(),
            deadline,
            timeoutError
        )
    }

    private async listTurns(signal?: AbortSignal): Promise<TurnInfo[]> {
        const client = this.getClient()
        const threadId = this.threadId
        if (!client || !threadId) return []

        try {
            const response = await client.readThread(
                { threadId, includeTurns: true },
                { signal }
            )
            const thread = asRecord(response.thread)
            const turns = Array.isArray(thread?.turns) ? thread.turns : []
            return turns.flatMap((entry) => {
                const record = asRecord(entry)
                const id = asString(record?.id)
                if (!id) return []
                const clientIds: string[] = []
                const items = Array.isArray(record?.items) ? record.items : []
                for (const item of items) {
                    const itemRecord = asRecord(item)
                    const type = asString(itemRecord?.type) ?? asString(itemRecord?.itemType)
                    if (type === 'userMessage' || type === 'user_message') {
                        const clientId = asString(itemRecord?.clientId) ?? asString(itemRecord?.client_id)
                        if (clientId) clientIds.push(clientId)
                    }
                }
                return [{
                    id,
                    status: asString(record?.status) ?? undefined,
                    clientIds
                }]
            })
        } catch (error) {
            if (signal?.aborted) throw error
            logger.debug(`[Codex] thread/read failed: ${error instanceof Error ? error.message : String(error)}`)
            // Fall back to in-memory mapping only
            return Array.from(this.turnByLocalId.entries()).map(([localId, id]) => ({
                id,
                clientIds: [localId]
            }))
        }
    }
}
