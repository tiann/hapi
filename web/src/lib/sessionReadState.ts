import type { SessionSummary } from '@/types/api'

const SESSION_READ_STATE_KEY = 'hapi-session-read-state'
const MAX_STORED_SESSIONS = 500

export type SessionReadState = Record<string, number>

function safeParseJson(value: string): unknown {
    try {
        return JSON.parse(value) as unknown
    } catch {
        return null
    }
}

export function getSessionReadState(): SessionReadState {
    if (typeof window === 'undefined') return {}
    try {
        const raw = localStorage.getItem(SESSION_READ_STATE_KEY)
        if (!raw) return {}
        const parsed = safeParseJson(raw)
        if (!parsed || typeof parsed !== 'object') return {}

        const result: SessionReadState = {}
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof key !== 'string' || key.trim().length === 0) continue
            if (typeof value !== 'number' || !Number.isFinite(value)) continue
            result[key] = value
        }
        return result
    } catch {
        return {}
    }
}

export function markSessionReadInState(
    state: SessionReadState,
    sessionId: string,
    updatedAt: number
): SessionReadState {
    if (!sessionId || !Number.isFinite(updatedAt)) return state
    const current = state[sessionId] ?? 0
    if (current >= updatedAt) return state

    const next = {
        ...state,
        [sessionId]: updatedAt
    }

    return Object.fromEntries(
        Object.entries(next)
            .sort((left, right) => right[1] - left[1])
            .slice(0, MAX_STORED_SESSIONS)
    )
}

export function persistSessionReadState(state: SessionReadState): void {
    if (typeof window === 'undefined') return
    try {
        localStorage.setItem(SESSION_READ_STATE_KEY, JSON.stringify(state))
    } catch {
        // Ignore storage errors
    }
}

export function isSessionUnread(session: SessionSummary, readState: SessionReadState): boolean {
    const readAt = readState[session.id] ?? 0
    return session.updatedAt > readAt
}
