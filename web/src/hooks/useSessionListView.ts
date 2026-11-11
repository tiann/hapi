import { useCallback, useSyncExternalStore } from 'react'

/**
 * Session list view preferences: sort key, status filter and whether
 * connected sessions sort ahead of archived ones. One store shared by every
 * consumer (sidebar menu, settings page) and synced across tabs.
 */
export type SessionListSort = 'last-message' | 'created'
export type SessionListStatus = 'all' | 'active' | 'archived'

export type SessionListView = {
    sort: SessionListSort
    status: SessionListStatus
    activeFirst: boolean
    unreadOnly: boolean
}

export const DEFAULT_SESSION_LIST_VIEW: SessionListView = {
    sort: 'last-message',
    status: 'all',
    activeFirst: true,
    unreadOnly: false
}

const SORT_KEY = 'hapi-session-list-sort'
const STATUS_KEY = 'hapi-session-list-status'
const ACTIVE_FIRST_KEY = 'hapi-session-list-active-first'
const UNREAD_ONLY_KEY = 'hapi-session-list-unread-only'
// Pre-status "Show active sessions only" setting; read once as the default status.
const LEGACY_ACTIVE_ONLY_KEY = 'hapi-show-active-sessions-only'

const SORTS: readonly SessionListSort[] = ['last-message', 'created']
const STATUSES: readonly SessionListStatus[] = ['all', 'active', 'archived']

function safeGetItem(key: string): string | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
    } catch {
        return null
    }
}

function safeSetItem(key: string, value: string | null): boolean {
    try {
        if (typeof localStorage === 'undefined') return false
        if (value === null) localStorage.removeItem(key)
        else localStorage.setItem(key, value)
        return true
    } catch {
        return false
    }
}

export function readSessionListView(): SessionListView {
    const sort = safeGetItem(SORT_KEY)
    const status = safeGetItem(STATUS_KEY)
    const activeFirst = safeGetItem(ACTIVE_FIRST_KEY)
    const unreadOnly = safeGetItem(UNREAD_ONLY_KEY)
    return {
        sort: SORTS.includes(sort as SessionListSort) ? sort as SessionListSort : DEFAULT_SESSION_LIST_VIEW.sort,
        status: STATUSES.includes(status as SessionListStatus)
            ? status as SessionListStatus
            : safeGetItem(LEGACY_ACTIVE_ONLY_KEY) === 'true' ? 'active' : DEFAULT_SESSION_LIST_VIEW.status,
        activeFirst: activeFirst === null ? DEFAULT_SESSION_LIST_VIEW.activeFirst : activeFirst === 'true',
        unreadOnly: unreadOnly === null ? DEFAULT_SESSION_LIST_VIEW.unreadOnly : unreadOnly === 'true'
    }
}

// Snapshots are cached per raw storage value so useSyncExternalStore sees a
// stable object, while any storage change (another tab, a cleared store) is
// still picked up on the next read.
let current: { raw: string; view: SessionListView } | null = null
// Choices made while storage is unavailable still apply for this page.
let unsaved: SessionListView | null = null
const listeners = new Set<() => void>()

function getSnapshot(): SessionListView {
    if (unsaved) return unsaved
    const raw = [SORT_KEY, STATUS_KEY, ACTIVE_FIRST_KEY, UNREAD_ONLY_KEY, LEGACY_ACTIVE_ONLY_KEY].map(safeGetItem).join('\u0000')
    if (current?.raw !== raw) current = { raw, view: readSessionListView() }
    return current.view
}

function emit(): void {
    for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    const onStorage = (event: StorageEvent) => {
        if (event.key !== null && event.key !== SORT_KEY && event.key !== STATUS_KEY
            && event.key !== ACTIVE_FIRST_KEY && event.key !== UNREAD_ONLY_KEY && event.key !== LEGACY_ACTIVE_ONLY_KEY) return
        emit()
    }
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
    return () => {
        listeners.delete(listener)
        if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
    }
}

export function updateSessionListView(patch: Partial<SessionListView>): void {
    const next = { ...getSnapshot(), ...patch }
    // Defaults are stored as absent keys, like the other display preferences.
    let saved = true
    if (patch.sort !== undefined) {
        saved = safeSetItem(SORT_KEY, next.sort === DEFAULT_SESSION_LIST_VIEW.sort ? null : next.sort) && saved
    }
    if (patch.status !== undefined) {
        saved = safeSetItem(STATUS_KEY, next.status === DEFAULT_SESSION_LIST_VIEW.status ? null : next.status) && saved
        saved = safeSetItem(LEGACY_ACTIVE_ONLY_KEY, null) && saved
    }
    if (patch.activeFirst !== undefined) {
        saved = safeSetItem(ACTIVE_FIRST_KEY, next.activeFirst === DEFAULT_SESSION_LIST_VIEW.activeFirst ? null : String(next.activeFirst)) && saved
    }
    if (patch.unreadOnly !== undefined) {
        saved = safeSetItem(UNREAD_ONLY_KEY, next.unreadOnly === DEFAULT_SESSION_LIST_VIEW.unreadOnly ? null : String(next.unreadOnly)) && saved
    }
    unsaved = saved ? null : next
    emit()
}

export function isDefaultSessionListView(view: SessionListView): boolean {
    return view.sort === DEFAULT_SESSION_LIST_VIEW.sort
        && view.status === DEFAULT_SESSION_LIST_VIEW.status
        && view.activeFirst === DEFAULT_SESSION_LIST_VIEW.activeFirst
        && view.unreadOnly === DEFAULT_SESSION_LIST_VIEW.unreadOnly
}

export function useSessionListView(): {
    view: SessionListView
    setView: (patch: Partial<SessionListView>) => void
} {
    const view = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    const setView = useCallback((patch: Partial<SessionListView>) => updateSessionListView(patch), [])
    return { view, setView }
}
