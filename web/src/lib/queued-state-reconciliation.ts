import type { ApiClient } from '@/api/client'
import {
    getQueuedReconcileCandidateLocalIds,
    markMessagesConsumed,
    markMessagesIndeterminate,
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
    const queuedLocalIds: string[] = []
    const indeterminateLocalIds: string[] = []
    const invokedLocalMessages: Array<{ localId: string; invokedAt: number }> = []
    for (let index = 0; index < candidateLocalIds.length; index += QUEUED_STATE_BATCH_SIZE) {
        const batch = candidateLocalIds.slice(index, index + QUEUED_STATE_BATCH_SIZE)
        const state = await api.getQueuedState(sessionId, batch)
        queuedLocalIds.push(...state.queuedLocalIds)
        indeterminateLocalIds.push(...(state.indeterminateLocalIds ?? []))
        invokedLocalMessages.push(...state.invokedLocalMessages)
    }
    const invokedByTimestamp = new Map<number, string[]>()
    for (const message of invokedLocalMessages) {
        const localIds = invokedByTimestamp.get(message.invokedAt) ?? []
        localIds.push(message.localId)
        invokedByTimestamp.set(message.invokedAt, localIds)
    }
    for (const [invokedAt, localIds] of invokedByTimestamp) {
        markMessagesConsumed(sessionId, localIds, invokedAt)
    }
    markMessagesIndeterminate(sessionId, indeterminateLocalIds)
    reconcileQueuedLocalIds(sessionId, candidateLocalIds, [...queuedLocalIds, ...indeterminateLocalIds])
}
