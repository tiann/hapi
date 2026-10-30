const STORAGE_KEY = 'hapi:ask-user-question-drafts'
const MAX_DRAFTS = 50

export type AskUserQuestionDraft = {
    step: number
    selectedByQuestion: number[][]
    otherSelectedByQuestion: boolean[]
    otherTextByQuestion: string[]
    fallbackText: string
}

type DraftsMap = Record<string, AskUserQuestionDraft>

let cache: DraftsMap | null = null

function safeParseJson(value: string): unknown {
    try {
        return JSON.parse(value) as unknown
    } catch {
        return null
    }
}

function isDraft(value: unknown): value is AskUserQuestionDraft {
    if (!value || typeof value !== 'object') return false
    const draft = value as Record<string, unknown>
    return typeof draft.step === 'number'
        && Array.isArray(draft.selectedByQuestion)
        && Array.isArray(draft.otherSelectedByQuestion)
        && Array.isArray(draft.otherTextByQuestion)
        && typeof draft.fallbackText === 'string'
}

function hydrate(): DraftsMap {
    if (cache) return cache
    if (typeof window === 'undefined') {
        cache = {}
        return cache
    }
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY)
        if (!raw) {
            cache = {}
            return cache
        }
        const parsed = safeParseJson(raw)
        if (!parsed || typeof parsed !== 'object') {
            cache = {}
            return cache
        }
        const record = parsed as Record<string, unknown>
        const result: DraftsMap = {}
        for (const [key, value] of Object.entries(record)) {
            if (key.trim().length === 0) continue
            if (!isDraft(value)) continue
            result[key] = value
        }
        cache = result
        return cache
    } catch {
        cache = {}
        return cache
    }
}

function evict(drafts: DraftsMap): void {
    const keys = Object.keys(drafts)
    if (keys.length <= MAX_DRAFTS) return
    // Remove oldest entries (first inserted) to stay under the cap
    const excess = keys.length - MAX_DRAFTS
    for (let i = 0; i < excess; i++) {
        delete drafts[keys[i]!]
    }
}

function persist(): void {
    if (typeof window === 'undefined') return
    try {
        const drafts = hydrate()
        evict(drafts)
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(drafts))
    } catch {
        // Ignore storage errors
    }
}

function isBlank(draft: AskUserQuestionDraft): boolean {
    return draft.step === 0
        && draft.fallbackText.trim().length === 0
        && draft.selectedByQuestion.every(selected => selected.length === 0)
        && draft.otherSelectedByQuestion.every(selected => !selected)
        && draft.otherTextByQuestion.every(text => text.trim().length === 0)
}

/** Key drafts by session and tool call so a past question's answer never leaks into a new one. */
export function askUserQuestionDraftKey(sessionId: string, toolId: string): string {
    return `${sessionId}:${toolId}`
}

export function getAskUserQuestionDraft(key: string): AskUserQuestionDraft | null {
    return hydrate()[key] ?? null
}

export function saveAskUserQuestionDraft(key: string, draft: AskUserQuestionDraft): void {
    const drafts = hydrate()
    if (isBlank(draft)) {
        delete drafts[key]
    } else {
        // Delete before re-inserting to refresh Object.keys() order for eviction
        delete drafts[key]
        drafts[key] = draft
    }
    persist()
}

export function clearAskUserQuestionDraft(key: string): void {
    const drafts = hydrate()
    delete drafts[key]
    persist()
}
