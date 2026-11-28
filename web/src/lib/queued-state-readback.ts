import type { ApiClient } from '@/api/client'
import type { QueuedStateResponse } from '@hapi/protocol/apiTypes'

const QUEUED_STATE_BATCH_SIZE = 1000
const pending = new Map<string, number>()

export function hasPendingQueuedStateReadback(sessionId: string): boolean {
    return pending.has(sessionId)
}

export async function trackQueuedStateReadback(sessionId: string, read: () => Promise<void>): Promise<void> {
    pending.set(sessionId, (pending.get(sessionId) ?? 0) + 1)
    try {
        await read()
    } finally {
        const count = pending.get(sessionId) ?? 0
        if (count > 1) pending.set(sessionId, count - 1)
        else pending.delete(sessionId)
    }
}

export async function readQueuedState(api: ApiClient, sessionId: string, localIds: readonly string[]) {
    const result = {
        queuedLocalIds: [] as string[],
        dispatchingLocalIds: [] as string[],
        indeterminateLocalIds: [] as string[],
        invokedLocalMessages: [] as QueuedStateResponse['invokedLocalMessages']
    }
    for (let index = 0; index < localIds.length; index += QUEUED_STATE_BATCH_SIZE) {
        const state = await api.getQueuedState(sessionId, localIds.slice(index, index + QUEUED_STATE_BATCH_SIZE))
        result.queuedLocalIds.push(...state.queuedLocalIds)
        result.dispatchingLocalIds.push(...(state.dispatchingLocalIds ?? []))
        result.indeterminateLocalIds.push(...(state.indeterminateLocalIds ?? []))
        result.invokedLocalMessages.push(...state.invokedLocalMessages)
    }
    return result
}

export function applyInvokedQueuedState(
    messages: QueuedStateResponse['invokedLocalMessages'],
    consume: (localIds: string[], invokedAt: number, steered?: boolean) => void
): void {
    const invokedByTimestamp = new Map<number, { ordinary: string[]; steered: string[] }>()
    for (const message of messages) {
        const group = invokedByTimestamp.get(message.invokedAt) ?? { ordinary: [], steered: [] }
        group[message.steered ? 'steered' : 'ordinary'].push(message.localId)
        invokedByTimestamp.set(message.invokedAt, group)
    }
    for (const [invokedAt, { ordinary, steered }] of invokedByTimestamp) {
        if (ordinary.length) consume(ordinary, invokedAt)
        if (steered.length) consume(steered, invokedAt, true)
    }
}
