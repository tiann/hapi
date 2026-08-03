import type { CodexAppServerClient } from './codexAppServerClient'
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

type TurnInfo = {
    id: string
    status?: string
    clientIds: string[]
}

export class CodexConversationHistory {
    private states: ConversationHistoryCapabilityStates = { ...CODEX_CONVERSATION_HISTORY_INITIAL }
    private threadId: string | null = null
    private readonly turnByLocalId = new Map<string, string>()
    private busy = false
    private publishCapabilities: (() => Promise<void>) | null = null

    constructor(private readonly getClient: () => CodexAppServerClient | null) {}

    setPublishCapabilities(fn: () => Promise<void>): void {
        this.publishCapabilities = fn
    }

    setBusy(busy: boolean): void {
        this.busy = busy
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

    /** Probe fork/rollback once thread is live. Never optimistic. */
    async probeCapabilities(): Promise<void> {
        const client = this.getClient()
        const threadId = this.threadId
        if (!client || !threadId) return

        if (this.states.forkCurrent === 'unknown' || this.states.forkAtMessage === 'unknown') {
            if (await client.supportsMethod('thread/fork')) {
                this.states = markSupported(this.states, 'forkCurrent')
                this.states = markSupported(this.states, 'forkAtMessage')
            } else {
                this.states = markUnsupported(this.states, 'forkCurrent')
                this.states = markUnsupported(this.states, 'forkAtMessage')
            }
        }

        if (this.states.rewindToMessage === 'unknown') {
            this.states = await client.supportsMethod('thread/rollback')
                ? markSupported(this.states, 'rewindToMessage')
                : markUnsupported(this.states, 'rewindToMessage')
        }

        await this.publishCapabilities?.()
    }

    async fork(messageLocalId?: string): Promise<ForkConversationRpcResult> {
        if (this.busy) throw new Error('Session is busy')
        const client = this.getClient()
        const threadId = this.threadId
        if (!client || !threadId) throw new Error('Codex thread is not ready')

        if (messageLocalId) {
            if (this.states.forkAtMessage === 'unsupported') {
                throw new Error('Historical fork is not supported')
            }
            // HAPI historical fork excludes the selected boundary turn. Prefer the
            // stable inclusive `lastTurnId` of the previous turn over experimental
            // `beforeTurnId`, so native context matches the hydrated transcript.
            const turns = await this.listTurns()
            const selectedTurnId = await this.resolveTurnId(messageLocalId, turns)
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
            try {
                const response = await client.forkThread({
                    threadId,
                    ...boundary
                })
                const nativeSessionId = asString(asRecord(response.thread)?.id)
                if (!nativeSessionId) throw new Error('thread/fork did not return thread.id')
                this.states = markSupported(this.states, 'forkAtMessage')
                this.states = markSupported(this.states, 'forkCurrent')
                await this.publishCapabilities?.()
                return { nativeSessionId }
            } catch (error) {
                if (isMethodNotFound(error)) {
                    this.states = markUnsupported(this.states, 'forkAtMessage')
                    await this.publishCapabilities?.()
                }
                throw error
            }
        }

        if (this.states.forkCurrent === 'unsupported') {
            throw new Error('Fork current is not supported')
        }
        try {
            const response = await client.forkThread({ threadId })
            const nativeSessionId = asString(asRecord(response.thread)?.id)
            if (!nativeSessionId) throw new Error('thread/fork did not return thread.id')
            this.states = markSupported(this.states, 'forkCurrent')
            await this.publishCapabilities?.()
            return { nativeSessionId }
        } catch (error) {
            if (isMethodNotFound(error)) {
                this.states = markUnsupported(this.states, 'forkCurrent')
                await this.publishCapabilities?.()
            }
            throw error
        }
    }

    async rewind(messageLocalId: string): Promise<RewindConversationRpcResult> {
        if (this.busy) throw new Error('Session is busy')
        const client = this.getClient()
        const threadId = this.threadId
        if (!client || !threadId) throw new Error('Codex thread is not ready')
        if (this.states.rewindToMessage === 'unsupported') {
            throw new Error('Rewind is not supported')
        }

        const turns = await this.listTurns()
        const turnId = await this.resolveTurnId(messageLocalId, turns)
        const index = turns.findIndex((turn) => turn.id === turnId)
        if (index < 0) throw new Error('Selected turn not found')
        if (turns[index]?.status === 'inProgress' || turns[index]?.status === 'in_progress') {
            throw new Error('Cannot rewind an in-progress turn')
        }
        const numTurns = turns.length - index
        if (numTurns <= 0) throw new Error('Invalid rewind count')

        try {
            await client.rollbackThread({ threadId, numTurns })
            this.states = markSupported(this.states, 'rewindToMessage')
            await this.publishCapabilities?.()
        } catch (error) {
            if (isMethodNotFound(error)) {
                this.states = markUnsupported(this.states, 'rewindToMessage')
                await this.publishCapabilities?.()
                throw new Error('thread/rollback is unsupported')
            }
            throw error
        }

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

    private async listTurns(): Promise<TurnInfo[]> {
        const client = this.getClient()
        const threadId = this.threadId
        if (!client || !threadId) return []

        try {
            const response = await client.readThread({ threadId, includeTurns: true })
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
            logger.debug(`[Codex] thread/read failed: ${error instanceof Error ? error.message : String(error)}`)
            // Fall back to in-memory mapping only
            return Array.from(this.turnByLocalId.entries()).map(([localId, id]) => ({
                id,
                clientIds: [localId]
            }))
        }
    }
}
