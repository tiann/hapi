import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import type { ConversationOutlineItem } from '@/chat/outline'
import {
    decryptedMessageToOutlineItem,
    mergeConversationOutlineItems,
} from '@/chat/outline'

export type ConversationOutlineStatus = 'idle' | 'loading' | 'ready' | 'error'

export type ConversationOutlineState = {
    sessionId: string
    items: ConversationOutlineItem[]
    status: ConversationOutlineStatus
    complete: boolean
    hasMore: boolean
    cursorBeforeAt: number | null
    cursorBeforeSeq: number | null
    error: string | null
    locateError: string | null
    isLocating: boolean
    locatingTargetMessageId: string | null
}

type InternalConversationOutlineState = ConversationOutlineState & {
    loadedTargetMessageIds: Set<string>
    hydratePromise: Promise<void> | null
    generation: number
}

const PAGE_SIZE = 50
const states = new Map<string, InternalConversationOutlineState>()
const listeners = new Map<string, Set<() => void>>()

function createState(sessionId: string): InternalConversationOutlineState {
    return {
        sessionId,
        items: [],
        status: 'idle',
        complete: false,
        hasMore: true,
        cursorBeforeAt: null,
        cursorBeforeSeq: null,
        error: null,
        locateError: null,
        isLocating: false,
        locatingTargetMessageId: null,
        loadedTargetMessageIds: new Set<string>(),
        hydratePromise: null,
        generation: 0,
    }
}

function getState(sessionId: string): InternalConversationOutlineState {
    const existing = states.get(sessionId)
    if (existing) {
        return existing
    }
    const created = createState(sessionId)
    states.set(sessionId, created)
    return created
}

function notify(sessionId: string): void {
    const subs = listeners.get(sessionId)
    if (!subs) {
        return
    }
    for (const listener of subs) {
        listener()
    }
}

function setState(sessionId: string, next: InternalConversationOutlineState): void {
    states.set(sessionId, next)
    notify(sessionId)
}

function updateState(
    sessionId: string,
    updater: (prev: InternalConversationOutlineState) => InternalConversationOutlineState
): InternalConversationOutlineState {
    const prev = getState(sessionId)
    const next = updater(prev)
    if (next !== prev) {
        setState(sessionId, next)
        return next
    }
    return prev
}

function extractOutlineItems(messages: readonly DecryptedMessage[]): ConversationOutlineItem[] {
    const items: ConversationOutlineItem[] = []
    for (const message of messages) {
        const item = decryptedMessageToOutlineItem(message)
        if (item) {
            items.push(item)
        }
    }
    return items
}

function mergeItems(
    prev: InternalConversationOutlineState,
    incoming: readonly ConversationOutlineItem[]
): { items: ConversationOutlineItem[]; loadedTargetMessageIds: Set<string> } {
    if (incoming.length === 0) {
        return {
            items: prev.items,
            loadedTargetMessageIds: prev.loadedTargetMessageIds,
        }
    }

    const filtered = incoming.filter((item) => !prev.loadedTargetMessageIds.has(item.targetMessageId))
    if (filtered.length === 0) {
        return {
            items: prev.items,
            loadedTargetMessageIds: prev.loadedTargetMessageIds,
        }
    }

    const nextIds = new Set(prev.loadedTargetMessageIds)
    for (const item of filtered) {
        nextIds.add(item.targetMessageId)
    }

    return {
        items: mergeConversationOutlineItems(prev.items, filtered),
        loadedTargetMessageIds: nextIds,
    }
}

export function getConversationOutlineState(sessionId: string): ConversationOutlineState {
    return getState(sessionId)
}

export function subscribeConversationOutline(sessionId: string, listener: () => void): () => void {
    const subs = listeners.get(sessionId) ?? new Set()
    subs.add(listener)
    listeners.set(sessionId, subs)
    return () => {
        const current = listeners.get(sessionId)
        if (!current) {
            return
        }
        current.delete(listener)
        if (current.size === 0) {
            listeners.delete(sessionId)
        }
    }
}

export function seedConversationOutline(sessionId: string, items: readonly ConversationOutlineItem[]): void {
    if (items.length === 0) {
        return
    }

    updateState(sessionId, (prev) => {
        const merged = mergeItems(prev, items)
        if (merged.items === prev.items) {
            return prev
        }
        return {
            ...prev,
            items: merged.items,
            loadedTargetMessageIds: merged.loadedTargetMessageIds,
            status: prev.status === 'idle' ? 'ready' : prev.status,
        }
    })
}

export function resetConversationOutline(sessionId: string): void {
    const prev = getState(sessionId)
    setState(sessionId, {
        ...createState(sessionId),
        generation: prev.generation + 1,
    })
}

export function ingestConversationOutlineMessage(sessionId: string, message: DecryptedMessage): void {
    const item = decryptedMessageToOutlineItem(message)
    if (!item) {
        return
    }

    updateState(sessionId, (prev) => {
        const merged = mergeItems(prev, [item])
        if (merged.items === prev.items) {
            return prev
        }
        return {
            ...prev,
            items: merged.items,
            loadedTargetMessageIds: merged.loadedTargetMessageIds,
            status: prev.status === 'idle' ? 'ready' : prev.status,
            error: prev.status === 'error' ? null : prev.error,
        }
    })
}

export function setConversationOutlineLocating(
    sessionId: string,
    locatingTargetMessageId: string | null,
    locateError: string | null = null
): void {
    updateState(sessionId, (prev) => ({
        ...prev,
        isLocating: locatingTargetMessageId !== null,
        locatingTargetMessageId,
        locateError,
    }))
}

export async function hydrateConversationOutline(
    api: ApiClient,
    sessionId: string
): Promise<void> {
    const initial = getState(sessionId)
    if (initial.complete) {
        return
    }
    if (initial.hydratePromise) {
        return await initial.hydratePromise
    }

    const generation = initial.generation

    const run = (async () => {
        updateState(sessionId, (prev) => ({
            ...prev,
            status: 'loading',
            error: null,
        }))

        try {
            for (;;) {
                const current = getState(sessionId)
                if (current.generation !== generation) {
                    return
                }
                if (current.complete || !current.hasMore) {
                    updateState(sessionId, (prev) => ({
                        ...prev,
                        status: 'ready',
                        complete: true,
                        hasMore: false,
                        hydratePromise: null,
                    }))
                    return
                }

                const response = await api.getMessages(sessionId, {
                    byPosition: true,
                    limit: PAGE_SIZE,
                    beforeAt: current.cursorBeforeAt,
                    beforeSeq: current.cursorBeforeSeq,
                })

                const pageItems = extractOutlineItems(response.messages)
                const hasMore = response.page.hasMore
                const nextBeforeAt = response.page.nextBeforeAt ?? null
                const nextBeforeSeq = response.page.nextBeforeSeq ?? null

                updateState(sessionId, (prev) => {
                    if (prev.generation !== generation) {
                        return prev
                    }
                    const merged = mergeItems(prev, pageItems)
                    return {
                        ...prev,
                        items: merged.items,
                        loadedTargetMessageIds: merged.loadedTargetMessageIds,
                        status: 'ready',
                        complete: !hasMore,
                        hasMore,
                        cursorBeforeAt: hasMore ? nextBeforeAt : prev.cursorBeforeAt,
                        cursorBeforeSeq: hasMore ? nextBeforeSeq : prev.cursorBeforeSeq,
                    }
                })

                if (!hasMore) {
                    return
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to hydrate outline'
            updateState(sessionId, (prev) => ({
                ...prev,
                status: 'error',
                error: message,
                hydratePromise: null,
            }))
        }
    })()

    updateState(sessionId, (prev) => ({
        ...prev,
        hydratePromise: run,
    }))

    await run
}
