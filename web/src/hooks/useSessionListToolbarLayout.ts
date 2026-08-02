import { useCallback, useEffect, useState } from 'react'

export const SESSION_LIST_TOOLBAR_ITEM_IDS = [
    'search',
    'dateFilter',
    'machineFilter',
    'codexImport',
    'refresh',
    'browse',
] as const

export type SessionListToolbarItemId = typeof SESSION_LIST_TOOLBAR_ITEM_IDS[number]
export type SessionListToolbarGroup = 'left' | 'right' | 'hidden'
export type SessionListSearchPresentation = 'icon' | 'field'

export type SessionListToolbarLayout = {
    left: SessionListToolbarItemId[]
    right: SessionListToolbarItemId[]
    hidden: SessionListToolbarItemId[]
    searchPresentation: SessionListSearchPresentation
}

export const DEFAULT_SESSION_LIST_TOOLBAR_LAYOUT: SessionListToolbarLayout = {
    left: ['search', 'dateFilter'],
    right: ['machineFilter', 'browse'],
    // These entry points were intentionally removed upstream. Keep the current
    // toolbar as the default while allowing operators to restore either action.
    hidden: ['codexImport', 'refresh'],
    searchPresentation: 'icon',
}

const STORAGE_KEY = 'hapi-session-list-toolbar-layout'
const CHANGE_EVENT = 'hapi-session-list-toolbar-layout-change'

function isItemId(value: unknown): value is SessionListToolbarItemId {
    return typeof value === 'string'
        && (SESSION_LIST_TOOLBAR_ITEM_IDS as readonly string[]).includes(value)
}

function isSearchPresentation(value: unknown): value is SessionListSearchPresentation {
    return value === 'icon' || value === 'field'
}

export function normalizeSessionListToolbarLayout(value: unknown): SessionListToolbarLayout {
    if (!value || typeof value !== 'object') {
        return DEFAULT_SESSION_LIST_TOOLBAR_LAYOUT
    }

    const candidate = value as Partial<SessionListToolbarLayout>
    const seen = new Set<SessionListToolbarItemId>()
    const normalizeGroup = (group: unknown): SessionListToolbarItemId[] => {
        if (!Array.isArray(group)) return []
        return group.filter((item): item is SessionListToolbarItemId => {
            if (!isItemId(item) || seen.has(item)) return false
            seen.add(item)
            return true
        })
    }

    const left = normalizeGroup(candidate.left)
    const right = normalizeGroup(candidate.right)
    const hidden = normalizeGroup(candidate.hidden)

    for (const item of SESSION_LIST_TOOLBAR_ITEM_IDS) {
        if (seen.has(item)) continue
        if (DEFAULT_SESSION_LIST_TOOLBAR_LAYOUT.hidden.includes(item)) {
            hidden.push(item)
        } else if (DEFAULT_SESSION_LIST_TOOLBAR_LAYOUT.left.includes(item)) {
            left.push(item)
        } else {
            right.push(item)
        }
    }

    return {
        left,
        right,
        hidden,
        searchPresentation: isSearchPresentation(candidate.searchPresentation)
            ? candidate.searchPresentation
            : DEFAULT_SESSION_LIST_TOOLBAR_LAYOUT.searchPresentation,
    }
}

export function moveSessionListToolbarItem(
    layout: SessionListToolbarLayout,
    item: SessionListToolbarItemId,
    targetGroup: SessionListToolbarGroup,
    targetIndex: number,
): SessionListToolbarLayout {
    const left = layout.left.filter((entry) => entry !== item)
    const right = layout.right.filter((entry) => entry !== item)
    const hidden = layout.hidden.filter((entry) => entry !== item)
    const target = targetGroup === 'left' ? left : targetGroup === 'right' ? right : hidden
    target.splice(Math.max(0, Math.min(targetIndex, target.length)), 0, item)
    return { ...layout, left, right, hidden }
}

function readLayout(): SessionListToolbarLayout {
    if (typeof window === 'undefined') return DEFAULT_SESSION_LIST_TOOLBAR_LAYOUT
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        return raw ? normalizeSessionListToolbarLayout(JSON.parse(raw)) : DEFAULT_SESSION_LIST_TOOLBAR_LAYOUT
    } catch {
        return DEFAULT_SESSION_LIST_TOOLBAR_LAYOUT
    }
}

export function useSessionListToolbarLayout(): {
    layout: SessionListToolbarLayout
    setLayout: (layout: SessionListToolbarLayout) => void
    resetLayout: () => void
} {
    const [layout, setLayoutState] = useState<SessionListToolbarLayout>(readLayout)

    useEffect(() => {
        const sync = () => setLayoutState(readLayout())
        window.addEventListener('storage', sync)
        window.addEventListener(CHANGE_EVENT, sync)
        return () => {
            window.removeEventListener('storage', sync)
            window.removeEventListener(CHANGE_EVENT, sync)
        }
    }, [])

    const setLayout = useCallback((next: SessionListToolbarLayout) => {
        const normalized = normalizeSessionListToolbarLayout(next)
        setLayoutState(normalized)
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
            window.dispatchEvent(new Event(CHANGE_EVENT))
        } catch {
            // Keep the in-memory preference when storage is unavailable.
        }
    }, [])

    const resetLayout = useCallback(() => {
        setLayoutState(DEFAULT_SESSION_LIST_TOOLBAR_LAYOUT)
        try {
            window.localStorage.removeItem(STORAGE_KEY)
            window.dispatchEvent(new Event(CHANGE_EVENT))
        } catch {
            // Keep the in-memory default when storage is unavailable.
        }
    }, [])

    return { layout, setLayout, resetLayout }
}
