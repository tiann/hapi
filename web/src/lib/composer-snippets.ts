const STORAGE_KEY = 'hapi:composer-snippets:v1'
const SLOT_COUNT = 5
const MAX_TEXT_LENGTH = 4_000

export type ComposerSnippet = {
    id: string
    text: string
    updatedAt: number
}

export type ComposerSnippetSlot = ComposerSnippet | null

type StoredComposerSnippets = {
    version: 1
    slots: unknown[]
}

let cache: ComposerSnippetSlot[] | null = null

function safeParseJson(value: string): unknown {
    try {
        return JSON.parse(value) as unknown
    } catch {
        return null
    }
}

function emptySlots(): ComposerSnippetSlot[] {
    return Array.from({ length: SLOT_COUNT }, () => null)
}

function normalizeSlot(value: unknown, index: number): ComposerSnippetSlot {
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    if (typeof record.text !== 'string') return null
    const text = record.text.slice(0, MAX_TEXT_LENGTH)
    if (text.trim().length === 0) return null
    return {
        id: `slot-${index}`,
        text,
        updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
            ? record.updatedAt
            : 0
    }
}

function hydrate(): ComposerSnippetSlot[] {
    if (cache) return cache
    if (typeof window === 'undefined') {
        cache = emptySlots()
        return cache
    }

    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) {
            cache = emptySlots()
            return cache
        }
        const parsed = safeParseJson(raw)
        if (!parsed || typeof parsed !== 'object') {
            cache = emptySlots()
            return cache
        }
        const record = parsed as Partial<StoredComposerSnippets>
        if (record.version !== 1 || !Array.isArray(record.slots)) {
            cache = emptySlots()
            return cache
        }

        const slots = emptySlots()
        for (let index = 0; index < SLOT_COUNT; index += 1) {
            slots[index] = normalizeSlot(record.slots[index], index)
        }
        cache = slots
        return cache
    } catch {
        cache = emptySlots()
        return cache
    }
}

function persist(): void {
    if (typeof window === 'undefined') return
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            version: 1,
            slots: hydrate()
        }))
    } catch {
        // Ignore storage errors/quota issues.
    }
}

function assertSlotIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= SLOT_COUNT) {
        throw new Error('Snippet slot index out of range')
    }
}

export function getComposerSnippets(): ComposerSnippetSlot[] {
    return [...hydrate()]
}

export function saveComposerSnippet(index: number, text: string, updatedAt: number = Date.now()): ComposerSnippetSlot[] {
    assertSlotIndex(index)
    const slots = hydrate()
    const normalizedText = text.slice(0, MAX_TEXT_LENGTH)
    slots[index] = normalizedText.trim().length === 0
        ? null
        : {
            id: `slot-${index}`,
            text: normalizedText,
            updatedAt
        }
    persist()
    return [...slots]
}

export function clearComposerSnippet(index: number): ComposerSnippetSlot[] {
    assertSlotIndex(index)
    const slots = hydrate()
    slots[index] = null
    persist()
    return [...slots]
}

export function resetComposerSnippetsCacheForTests(): void {
    cache = null
}
