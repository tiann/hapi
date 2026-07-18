import type { InfiniteData } from '@tanstack/react-query'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'

export function makeClientSideId(prefix: string): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return `${prefix}-${crypto.randomUUID()}`
    }
    return `${prefix}-${Date.now()}-${Math.random()}`
}

export function isUserMessage(msg: DecryptedMessage): boolean {
    const content = msg.content
    if (content && typeof content === 'object' && 'role' in content) {
        return (content as { role: string }).role === 'user'
    }
    return false
}

function isOptimisticMessage(msg: DecryptedMessage): boolean {
    return Boolean(msg.localId && msg.id === msg.localId)
}

function compareMessages(a: DecryptedMessage, b: DecryptedMessage): number {
    const aSeq = typeof a.seq === 'number' ? a.seq : null
    const bSeq = typeof b.seq === 'number' ? b.seq : null

    if (aSeq !== bSeq) {
        if (aSeq === null) return 1
        if (bSeq === null) return -1
        return aSeq - bSeq
    }

    if (a.createdAt !== b.createdAt) {
        return a.createdAt - b.createdAt
    }
    return a.id.localeCompare(b.id)
}

export function mergeMessages(existing: DecryptedMessage[], incoming: DecryptedMessage[]): DecryptedMessage[] {
    const byId = new Map<string, DecryptedMessage>()
    for (const msg of existing) {
        byId.set(msg.id, msg)
    }
    for (const msg of incoming) {
        byId.set(msg.id, msg)
    }

    let merged = Array.from(byId.values())

    const storedLocalIds = new Set<string>()
    for (const msg of merged) {
        if (msg.localId && !isOptimisticMessage(msg)) {
            storedLocalIds.add(msg.localId)
        }
    }

    // A stored echo can arrive on either side of the merge. Drop any optimistic
    // bubble with the same localId regardless of operand ordering.
    if (storedLocalIds.size > 0) {
        merged = merged.filter((msg) => {
            if (!msg.localId || !storedLocalIds.has(msg.localId)) {
                return true
            }
            return !isOptimisticMessage(msg)
        })
    }

    // Do not reconcile by timestamp proximity: multiple user sends can occur in
    // the same interval, and only localId is a one-to-one acknowledgement.
    merged.sort(compareMessages)
    return merged
}

export function upsertMessagesInCache(
    data: InfiniteData<MessagesResponse> | undefined,
    incoming: DecryptedMessage[],
): InfiniteData<MessagesResponse> {
    const mergedIncoming = mergeMessages([], incoming)

    if (!data || data.pages.length === 0) {
        return {
            pages: [
                {
                    messages: mergedIncoming,
                    page: {
                        limit: 50,
                        direction: 'latest',
                        beforeSeq: null,
                        afterSeq: null,
                        nextBeforeSeq: null,
                        nextAfterSeq: null,
                        hasMore: false,
                        hasOlder: false,
                        hasNewer: false,
                        range: null,
                        startComplete: true,
                        endComplete: true,
                        continuation: null,
                    },
                },
            ],
            pageParams: [null],
        }
    }

    const pages = data.pages.slice()
    const first = pages[0]
    pages[0] = {
        ...first,
        messages: mergeMessages(first.messages, mergedIncoming),
    }

    return {
        ...data,
        pages,
    }
}
