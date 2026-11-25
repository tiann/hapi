import type { ApiClient } from '@/api/client'
import { applyInvokedQueuedState, readQueuedState, trackQueuedStateReadback } from './queued-state-readback'
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

export function reconcileQueuedStateAfterConnect(api: ApiClient, sessionId: string): Promise<void> {
    return trackQueuedStateReadback(sessionId, () => reconcileQueuedState(api, sessionId))
}

async function reconcileQueuedState(api: ApiClient, sessionId: string): Promise<void> {
    await syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
    const candidateLocalIds = getQueuedReconcileCandidateLocalIds(sessionId)
    if (candidateLocalIds.length === 0) {
        return
    }
    const window = getMessageWindowState(sessionId)
    const baseline = new Map(window.messages.map(message => [message.localId, message]))
    const { queuedLocalIds, dispatchingLocalIds, indeterminateLocalIds, invokedLocalMessages } =
        await readQueuedState(api, sessionId, candidateLocalIds)
    const currentWindow = getMessageWindowState(sessionId)
    // Historical context deliberately keeps requiresLatestReset set until a
    // return to tail. Only a change during this request invalidates it.
    if (currentWindow.epoch !== window.epoch || (!window.requiresLatestReset && currentWindow.requiresLatestReset)) return
    applyInvokedQueuedState(invokedLocalMessages, (ids, invokedAt, steered) => {
        if (steered) markMessagesConsumed(sessionId, ids, invokedAt, true)
        else markMessagesConsumed(sessionId, ids, invokedAt)
    })
    // Nonterminal snapshots must not overwrite newer SSE or local operations.
    const current = new Map(getMessageWindowState(sessionId).messages.map(message => [message.localId, message]))
    const unchanged = (id: string) => baseline.get(id) === current.get(id)
    const dispatching = new Set(dispatchingLocalIds)
    markMessagesRequeued(sessionId, queuedLocalIds.filter(unchanged))
    markMessagesIndeterminate(sessionId, indeterminateLocalIds.filter(id => !dispatching.has(id) && unchanged(id)))
    markMessagesDispatching(sessionId, dispatchingLocalIds.filter(unchanged))
    reconcileQueuedLocalIds(sessionId, candidateLocalIds.filter(unchanged), [...queuedLocalIds, ...indeterminateLocalIds, ...dispatchingLocalIds])
}
