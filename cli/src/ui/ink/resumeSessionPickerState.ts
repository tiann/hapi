import type { ResumableSession } from '@hapi/protocol'
import { getSessionTitle } from '@hapi/protocol/sessionTitle'

export type PickerState = {
    query: string
    selectedIndex: number
    scrollOffset: number
}

export type PickerKey =
    | 'up'
    | 'down'
    | 'pageUp'
    | 'pageDown'
    | 'home'
    | 'end'
    | 'backspace'
    | 'escape'

export function getResumeSessionName(session: ResumableSession): string {
    return getSessionTitle({
        id: session.sessionId,
        metadata: {
            name: session.name,
            summary: session.summary === undefined ? undefined : { text: session.summary },
            promptTitle: session.promptTitle,
            path: session.directory
        }
    })
}

export function getResumeSessionState(session: ResumableSession): string {
    if (!session.active) return 'inactive'
    return session.controlledByUser ? 'local' : 'remote'
}

export function formatResumeSessionRelativeTime(value: number, now: number = Date.now()): string {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    if (!Number.isFinite(ms)) return 'unknown'

    const delta = Math.max(0, now - ms)
    if (delta < 60_000) return 'now'

    const minutes = Math.floor(delta / 60_000)
    if (minutes < 60) return `${minutes}m ago`

    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`

    const days = Math.floor(hours / 24)
    if (days < 7) return `${days}d ago`

    return new Date(ms).toLocaleDateString()
}

export function filterResumeSessions(
    sessions: ResumableSession[],
    query: string
): ResumableSession[] {
    const normalized = query.trim().toLowerCase()
    if (normalized.length === 0) return sessions

    return sessions.filter((session) => {
        const fields = [
            session.name,
            session.summary,
            session.promptTitle,
            session.firstUserMessage,
            session.sessionId,
            session.agentSessionId,
            session.directory,
            session.flavor,
            getResumeSessionState(session)
        ]
        return fields.some((field) => field?.toLowerCase().includes(normalized))
    })
}

export function clampSelectedIndex(index: number, itemCount: number): number {
    if (itemCount <= 0) return 0
    return Math.max(0, Math.min(index, itemCount - 1))
}

export function normalizeScrollOffset(
    selectedIndex: number,
    scrollOffset: number,
    visibleCount: number,
    itemCount: number
): number {
    if (itemCount <= 0) return 0

    const safeVisibleCount = Math.max(1, visibleCount)
    const maxOffset = Math.max(0, itemCount - safeVisibleCount)
    let nextOffset = Math.max(0, Math.min(scrollOffset, maxOffset))

    if (selectedIndex < nextOffset) {
        nextOffset = selectedIndex
    } else if (selectedIndex >= nextOffset + safeVisibleCount) {
        nextOffset = selectedIndex - safeVisibleCount + 1
    }

    return Math.max(0, Math.min(nextOffset, maxOffset))
}

export function reducePickerState(
    state: PickerState,
    event: { type: 'char'; value: string } | { type: 'key'; key: PickerKey },
    opts: {
        itemCount: number
        visibleCount: number
    }
): PickerState {
    const { itemCount, visibleCount } = opts

    if (event.type === 'char') {
        return {
            query: state.query + event.value,
            selectedIndex: 0,
            scrollOffset: 0
        }
    }

    if (event.key === 'backspace') {
        if (state.query.length === 0) return state
        return {
            query: state.query.slice(0, -1),
            selectedIndex: 0,
            scrollOffset: 0
        }
    }

    if (event.key === 'escape') {
        if (state.query.length === 0) return state
        return {
            query: '',
            selectedIndex: 0,
            scrollOffset: 0
        }
    }

    const currentIndex = clampSelectedIndex(state.selectedIndex, itemCount)
    const pageSize = Math.max(1, visibleCount)
    const nextSelectedIndex = (() => {
        switch (event.key) {
            case 'up':
                return currentIndex - 1
            case 'down':
                return currentIndex + 1
            case 'pageUp':
                return currentIndex - pageSize
            case 'pageDown':
                return currentIndex + pageSize
            case 'home':
                return 0
            case 'end':
                return itemCount - 1
            default:
                return currentIndex
        }
    })()

    const selectedIndex = clampSelectedIndex(nextSelectedIndex, itemCount)
    return {
        ...state,
        selectedIndex,
        scrollOffset: normalizeScrollOffset(
            selectedIndex,
            state.scrollOffset,
            visibleCount,
            itemCount
        )
    }
}
