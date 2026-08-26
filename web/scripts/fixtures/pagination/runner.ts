import type { ApiClient } from '@/api/client'
import {
    clearMessageWindow,
    fetchOlderMessages,
    getMessageWindowState,
    getQueuedReconcileCandidateLocalIds,
    ingestIncomingMessages,
    appendOptimisticMessage,
    markMessagesConsumed,
    reconcileQueuedLocalIds,
    removeOptimisticMessage,
    setMessageViewMode,
    syncTailMessages,
    updateMessageStatus,
    type MessageWindowState,
    type OlderLoadOutcome
} from '@/lib/message-window-store'
import { isQueuedForInvocation } from '@/lib/messages'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import { toCanonicalJson } from '../serialize'
import type {
    PageRequest,
    PaginationOp,
    PaginationOpObservation,
    ProjectedOlderOutcome,
    ProjectedWindowMessage,
    ProjectedWindowState
} from './types'

/**
 * The op-script harness: drives the REAL web message-window store with a
 * scripted ApiClient and records what the store did (requests issued, older
 * -load outcomes, reconcile candidates) plus the final normative projection.
 * Shared by the fixture generator and the self-conformance vitest so the
 * stored expectations can never diverge from a fresh replay.
 *
 * Ops run strictly sequentially (each awaited to completion). Determinism:
 * the store's only wall-clock reads (`Date.now`) gate notification
 * throttling, which never touches the state this harness observes.
 */

export function paginationFixtureSessionId(name: string): string {
    return `fixture-pagination-${name}`
}

type ScriptedApi = {
    api: ApiClient
    requests: PageRequest[]
    queue: MessagesResponse[]
}

function createScriptedApi(responses: MessagesResponse[]): ScriptedApi {
    const scripted: ScriptedApi = {
        requests: [],
        queue: [...responses],
        api: undefined as unknown as ApiClient
    }
    const getMessages: ApiClient['getMessages'] = async (_sessionId, options) => {
        scripted.requests.push(JSON.parse(toCanonicalJson(options ?? {})) as PageRequest)
        const next = scripted.queue.shift()
        if (!next) {
            throw new Error('scripted ApiClient exhausted: unexpected getMessages request')
        }
        return next
    }
    scripted.api = { getMessages } as ApiClient
    return scripted
}

function projectOutcome(outcome: OlderLoadOutcome): ProjectedOlderOutcome {
    if (outcome.kind === 'applied') {
        return {
            kind: 'applied',
            hasMore: outcome.hasMore,
            addedRenderableCount: outcome.addedRenderableCount
        }
    }
    if (outcome.kind === 'stopped') {
        return { kind: 'stopped', reason: outcome.reason }
    }
    throw new Error(`older-page load failed: ${outcome.error.message}`)
}

function projectMessage(message: DecryptedMessage): ProjectedWindowMessage {
    return {
        id: message.id,
        localId: message.localId ?? null,
        seq: message.seq ?? null,
        createdAt: message.createdAt,
        ...(message.invokedAt !== undefined ? { invokedAt: message.invokedAt } : {}),
        ...(message.scheduledAt !== undefined ? { scheduledAt: message.scheduledAt } : {}),
        ...(message.status !== undefined ? { status: message.status } : {}),
        queued: isQueuedForInvocation(message),
        optimistic: Boolean(message.localId && message.id === message.localId)
    }
}

/** The store's compound paging cursors live on the internal state object
 *  behind `MessageWindowState`. The `in` guards fail loudly if the web store
 *  renames them, so the fixtures cannot silently pin nulls. */
type InternalCursorFields = {
    oldestPositionAt: number | null
    oldestPositionSeq: number | null
    newestPositionAt: number | null
    newestPositionSeq: number | null
}

function projectCursor(at: unknown, seq: unknown): { at: number; seq: number } | null {
    return typeof at === 'number' && typeof seq === 'number' ? { at, seq } : null
}

export function projectWindowState(sessionId: string): ProjectedWindowState {
    const state = getMessageWindowState(sessionId) as MessageWindowState & Partial<InternalCursorFields>
    if (!('oldestPositionAt' in state) || !('newestPositionAt' in state)) {
        throw new Error('message-window-store internals renamed: update the pagination fixture runner')
    }
    return {
        messages: state.messages.map(projectMessage),
        hasMore: state.hasMore,
        epoch: state.epoch,
        viewMode: state.viewMode,
        olderCursor: projectCursor(state.oldestPositionAt, state.oldestPositionSeq),
        newestCursor: projectCursor(state.newestPositionAt, state.newestPositionSeq)
    }
}

function assertSettled(sessionId: string, opIndex: number, scripted: ScriptedApi): void {
    if (scripted.queue.length > 0) {
        throw new Error(`ops[${opIndex}]: ${scripted.queue.length} scripted response(s) left unconsumed`)
    }
    const state = getMessageWindowState(sessionId)
    if (state.warning !== null) {
        throw new Error(`ops[${opIndex}]: store reported a warning: ${state.warning}`)
    }
    if (state.isSyncingTail || state.isLoadingMore) {
        throw new Error(`ops[${opIndex}]: store still busy after the op settled`)
    }
}

async function executeOp(
    sessionId: string,
    op: PaginationOp,
    opIndex: number
): Promise<PaginationOpObservation> {
    switch (op.op) {
        case 'sync-tail': {
            const scripted = createScriptedApi(op.responses)
            await syncTailMessages(scripted.api, sessionId)
            assertSettled(sessionId, opIndex, scripted)
            return { requests: scripted.requests }
        }
        case 'fetch-older': {
            const scripted = createScriptedApi(op.responses)
            const outcome = await fetchOlderMessages(scripted.api, sessionId)
            assertSettled(sessionId, opIndex, scripted)
            return { requests: scripted.requests, outcome: projectOutcome(outcome) }
        }
        case 'sse-messages':
            ingestIncomingMessages(sessionId, op.messages)
            return {}
        case 'append-optimistic':
            appendOptimisticMessage(sessionId, op.message)
            return {}
        case 'update-status':
            updateMessageStatus(sessionId, op.localId, op.status)
            return {}
        case 'messages-consumed':
            markMessagesConsumed(sessionId, op.localIds, op.invokedAt)
            return {}
        case 'message-cancelled':
            removeOptimisticMessage(sessionId, op.localId)
            return {}
        case 'cancel-invoked':
            // Mirrors useCancelQueuedMessage: optimistic removal on mutate,
            // then the invoked-race response re-ingests the server row as
            // status 'sent' so the chip lands in the thread, not the bar.
            removeOptimisticMessage(sessionId, op.localId)
            appendOptimisticMessage(sessionId, { ...op.message, status: 'sent' })
            return {}
        case 'set-view-mode':
            setMessageViewMode(sessionId, op.mode)
            return {}
        case 'queued-state': {
            // Mirrors reconcileQueuedStateAfterConnect (post tail-sync half):
            // collect candidates, apply invoked verdicts grouped by
            // timestamp, then drop candidates in neither list.
            const candidates = getQueuedReconcileCandidateLocalIds(sessionId)
            const invokedByTimestamp = new Map<number, string[]>()
            for (const entry of op.invoked) {
                const localIds = invokedByTimestamp.get(entry.invokedAt) ?? []
                localIds.push(entry.localId)
                invokedByTimestamp.set(entry.invokedAt, localIds)
            }
            for (const [invokedAt, localIds] of invokedByTimestamp) {
                markMessagesConsumed(sessionId, localIds, invokedAt)
            }
            reconcileQueuedLocalIds(sessionId, candidates, op.queuedLocalIds)
            return { candidates }
        }
        default: {
            const exhaustive: never = op
            throw new Error(`unknown op: ${JSON.stringify(exhaustive)}`)
        }
    }
}

export async function runPaginationScript(
    sessionId: string,
    ops: PaginationOp[]
): Promise<{ observations: PaginationOpObservation[]; expectedState: ProjectedWindowState }> {
    clearMessageWindow(sessionId)
    const observations: PaginationOpObservation[] = []
    for (const [opIndex, op] of ops.entries()) {
        observations.push(await executeOp(sessionId, op, opIndex))
    }
    return { observations, expectedState: projectWindowState(sessionId) }
}

/** Fill the machine-generated `expected*` fields into the authored ops. */
export function mergeOpObservations(
    ops: PaginationOp[],
    observations: PaginationOpObservation[]
): PaginationOp[] {
    return ops.map((op, index) => {
        const observation = observations[index] ?? {}
        return {
            ...op,
            ...(observation.requests !== undefined ? { expectedRequests: observation.requests } : {}),
            ...(observation.outcome !== undefined ? { expectedOutcome: observation.outcome } : {}),
            ...(observation.candidates !== undefined ? { expectedCandidates: observation.candidates } : {})
        } as PaginationOp
    })
}

/** Read the stored `expected*` fields back out, shaped like fresh
 *  observations, for exact-match comparison in the conformance tests. */
export function extractOpExpectations(ops: PaginationOp[]): PaginationOpObservation[] {
    return ops.map((op) => {
        const record = op as Record<string, unknown>
        return {
            ...(record.expectedRequests !== undefined
                ? { requests: record.expectedRequests as PageRequest[] }
                : {}),
            ...(record.expectedOutcome !== undefined
                ? { outcome: record.expectedOutcome as ProjectedOlderOutcome }
                : {}),
            ...(record.expectedCandidates !== undefined
                ? { candidates: record.expectedCandidates as string[] }
                : {})
        }
    })
}
