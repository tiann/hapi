import type { ApiClient } from '@/api/client'
import type { QueuedStateResponse } from '@hapi/protocol/apiTypes'
import {
    getQueuedReconcileCandidateLocalIds,
    markMessagesConsumed,
    markMessagesIndeterminate,
    markMessagesDispatching,
    getMessageWindowState,
    markMessagesRequeued,
    reconcileQueuedLocalIds,
    syncTailMessages,
} from './message-window-store'

const QUEUED_STATE_BATCH_SIZE = 1000

export async function reconcileQueuedStateAfterConnect(
    api: ApiClient,
    sessionId: string
): Promise<void> {
    await syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
    const candidateLocalIds = getQueuedReconcileCandidateLocalIds(sessionId)
    if (candidateLocalIds.length === 0) {
        return
    }
    const baseline = new Map(getMessageWindowState(sessionId).messages.map(message => [message.localId, message]))
    const queuedLocalIds: string[] = []
    const dispatchingLocalIds: string[] = []
    const indeterminateLocalIds: string[] = []
    const invokedLocalMessages: QueuedStateResponse['invokedLocalMessages'] = []
    for (let index = 0; index < candidateLocalIds.length; index += QUEUED_STATE_BATCH_SIZE) {
        const batch = candidateLocalIds.slice(index, index + QUEUED_STATE_BATCH_SIZE)
        const state = await api.getQueuedState(sessionId, batch)
        queuedLocalIds.push(...state.queuedLocalIds)
        dispatchingLocalIds.push(...(state.dispatchingLocalIds ?? []))
        indeterminateLocalIds.push(...(state.indeterminateLocalIds ?? []))
        invokedLocalMessages.push(...state.invokedLocalMessages)
    }
    const invokedByTimestamp = new Map<number, { ordinary: string[]; steered: string[] }>()
    for (const message of invokedLocalMessages) {
        const group = invokedByTimestamp.get(message.invokedAt) ?? { ordinary: [], steered: [] }
        group[message.steered ? 'steered' : 'ordinary'].push(message.localId)
        invokedByTimestamp.set(message.invokedAt, group)
    }
    for (const [invokedAt, { ordinary, steered }] of invokedByTimestamp) {
        if (ordinary.length) markMessagesConsumed(sessionId, ordinary, invokedAt)
        if (steered.length) markMessagesConsumed(sessionId, steered, invokedAt, true)
    }
    // Nonterminal snapshots must not overwrite newer SSE or local operations.
    const current = new Map(getMessageWindowState(sessionId).messages.map(message => [message.localId, message]))
    const unchanged = (id: string) => baseline.get(id) === current.get(id)
    const dispatching = new Set(dispatchingLocalIds)
    markMessagesRequeued(sessionId, queuedLocalIds.filter(unchanged))
    markMessagesIndeterminate(sessionId, indeterminateLocalIds.filter(id => !dispatching.has(id) && unchanged(id)))
    markMessagesDispatching(sessionId, dispatchingLocalIds.filter(unchanged))
    reconcileQueuedLocalIds(sessionId, candidateLocalIds.filter(unchanged), [...queuedLocalIds, ...indeterminateLocalIds, ...dispatchingLocalIds])
}
