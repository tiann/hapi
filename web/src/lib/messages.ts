import type { DecryptedMessage } from '@/types/api'
import { randomId } from '@/lib/randomId'

export function makeClientSideId(prefix: string): string {
    return `${prefix}-${randomId()}`
}

export function isUserMessage(msg: DecryptedMessage): boolean {
    const content = msg.content
    if (content && typeof content === 'object' && 'role' in content) {
        return (content as { role: string }).role === 'user'
    }
    return false
}

/** A user message that is still waiting for the CLI ack (messages-consumed).
 *  Strict null on `invokedAt` so a pre-V8 hub response that omits the field
 *  (`undefined`) is treated as already-invoked; only optimistic / V8-loaded
 *  rows that explicitly carry `invokedAt: null` are queued. `failed` rows are
 *  not queued either — they're surfaced as send errors, not pending work. */
export function isQueuedForInvocation(msg: DecryptedMessage): boolean {
    return isUserMessage(msg) && msg.invokedAt === null && msg.status !== 'failed'
}

function isOptimisticMessage(msg: DecryptedMessage): boolean {
    return Boolean(msg.localId && msg.id === msg.localId)
}

function compareMessages(a: DecryptedMessage, b: DecryptedMessage): number {
    const aTime = a.invokedAt ?? a.createdAt
    const bTime = b.invokedAt ?? b.createdAt

    if (aTime !== bTime) {
        return aTime - bTime
    }

    const aSeq = typeof a.seq === 'number' ? a.seq : null
    const bSeq = typeof b.seq === 'number' ? b.seq : null

    if (aSeq !== null && bSeq !== null && aSeq !== bSeq) {
        return aSeq - bSeq
    }
    return a.id.localeCompare(b.id)
}

export function mergeMessages(existing: DecryptedMessage[], incoming: DecryptedMessage[]): DecryptedMessage[] {
    if (existing.length === 0) {
        return [...incoming].sort(compareMessages)
    }
    if (incoming.length === 0) {
        return [...existing].sort(compareMessages)
    }

    const byId = new Map<string, DecryptedMessage>()
    for (const msg of existing) {
        byId.set(msg.id, msg)
    }
    for (const msg of incoming) {
        byId.set(msg.id, msg)
    }

    let merged = Array.from(byId.values())

    const incomingStoredLocalIds = new Set<string>()
    for (const msg of incoming) {
        if (msg.localId && !isOptimisticMessage(msg)) {
            incomingStoredLocalIds.add(msg.localId)
        }
    }

    // If we received stored messages with a localId, drop any optimistic bubbles with the same localId.
    // Preserve client-side status (e.g. 'queued') and invokedAt on the replacing server message.
    if (incomingStoredLocalIds.size > 0) {
        const optimisticStatusByLocalId = new Map<string, DecryptedMessage['status']>()
        const optimisticInvokedAtByLocalId = new Map<string, number | null | undefined>()
        for (const msg of merged) {
            if (msg.localId && isOptimisticMessage(msg) && incomingStoredLocalIds.has(msg.localId)) {
                if (msg.status) {
                    optimisticStatusByLocalId.set(msg.localId, msg.status)
                }
                if (msg.invokedAt !== undefined) {
                    optimisticInvokedAtByLocalId.set(msg.localId, msg.invokedAt)
                }
            }
        }
        merged = merged.filter((msg) => {
            if (!msg.localId || !incomingStoredLocalIds.has(msg.localId)) {
                return true
            }
            return !isOptimisticMessage(msg)
        })
        if (optimisticStatusByLocalId.size > 0 || optimisticInvokedAtByLocalId.size > 0) {
            merged = merged.map((msg) => {
                if (!msg.localId) return msg
                const update: Partial<DecryptedMessage> = {}
                if (optimisticStatusByLocalId.has(msg.localId) && !msg.status) {
                    update.status = optimisticStatusByLocalId.get(msg.localId)
                }
                if (optimisticInvokedAtByLocalId.has(msg.localId) && msg.invokedAt == null) {
                    const optimisticInvokedAt = optimisticInvokedAtByLocalId.get(msg.localId)
                    if (optimisticInvokedAt != null) {
                        update.invokedAt = optimisticInvokedAt
                    }
                }
                if (Object.keys(update).length > 0) {
                    return { ...msg, ...update }
                }
                return msg
            })
        }
    }

    // Fallback: if an optimistic message was marked as sent but we didn't get a localId echo,
    // drop it when a server user message appears close in time.
    const optimisticMessages = merged.filter((m) => isOptimisticMessage(m))
    const nonOptimisticMessages = merged.filter((m) => !isOptimisticMessage(m))
    const result: DecryptedMessage[] = [...nonOptimisticMessages]

    for (const optimistic of optimisticMessages) {
        if (optimistic.status === 'sent') {
            // Compare by the position key (invokedAt ?? createdAt). A late ack can
            // attach `invokedAt` long after `createdAt`, so the optimistic copy and
            // the server echo end up at the same byPosition slot — using
            // `createdAt` alone misses that match and renders both as duplicates.
            const optimisticTime = optimistic.invokedAt ?? optimistic.createdAt
            const hasServerUserMessage = nonOptimisticMessages.some((m) =>
                isUserMessage(m) &&
                Math.abs((m.invokedAt ?? m.createdAt) - optimisticTime) < 10_000
            )
            if (hasServerUserMessage) {
                continue
            }
        }
        result.push(optimistic)
    }

    result.sort(compareMessages)
    return result
}
