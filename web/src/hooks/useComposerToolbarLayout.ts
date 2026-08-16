import { useCallback, useEffect, useState } from 'react'

export const COMPOSER_TOOLBAR_ITEM_IDS = [
    'attachment',
    'settings',
    'expand',
    'model',
    'effort',
    'terminal',
    'abort',
    'switch',
    'voiceMic',
    'scratchlist',
    'schedule',
] as const

export type ComposerToolbarItemId = typeof COMPOSER_TOOLBAR_ITEM_IDS[number]
export type ComposerToolbarLayoutMode = 'left' | 'center' | 'right' | 'split'
export type ComposerToolbarGroup = 'left' | 'right' | 'hidden'

export type ComposerToolbarLayout = {
    mode: ComposerToolbarLayoutMode
    left: ComposerToolbarItemId[]
    right: ComposerToolbarItemId[]
    hidden: ComposerToolbarItemId[]
}

export const DEFAULT_COMPOSER_TOOLBAR_LAYOUT: ComposerToolbarLayout = {
    mode: 'left',
    left: [
        ...COMPOSER_TOOLBAR_ITEM_IDS.filter((item) => item !== 'abort'),
        'abort',
    ],
    right: [],
    hidden: [],
}

export function moveComposerToolbarItem(
    layout: ComposerToolbarLayout,
    item: ComposerToolbarItemId,
    targetGroup: ComposerToolbarGroup,
    targetIndex: number,
): ComposerToolbarLayout {
    const left = layout.left.filter((entry) => entry !== item)
    const right = layout.right.filter((entry) => entry !== item)
    const hidden = layout.hidden.filter((entry) => entry !== item)
    const target = targetGroup === 'left' ? left : targetGroup === 'right' ? right : hidden
    target.splice(Math.max(0, Math.min(targetIndex, target.length)), 0, item)
    return { ...layout, left, right, hidden }
}

export function moveComposerToolbarItemInSingleLayout(
    layout: ComposerToolbarLayout,
    item: ComposerToolbarItemId,
    targetIndex: number,
): ComposerToolbarLayout {
    const leftCount = layout.left.length
    const items = [...layout.left, ...layout.right].filter((entry) => entry !== item)
    const hidden = layout.hidden.filter((entry) => entry !== item)
    items.splice(Math.max(0, Math.min(targetIndex, items.length)), 0, item)
    return {
        ...layout,
        left: items.slice(0, leftCount),
        right: items.slice(leftCount),
        hidden,
    }
}

const STORAGE_KEY = 'hapi-composer-toolbar-layout'
const CHANGE_EVENT = 'hapi-composer-toolbar-layout-change'

function isItemId(value: unknown): value is ComposerToolbarItemId {
    return typeof value === 'string' && (COMPOSER_TOOLBAR_ITEM_IDS as readonly string[]).includes(value)
}

function isLayoutMode(value: unknown): value is ComposerToolbarLayoutMode {
    return value === 'left' || value === 'center' || value === 'right' || value === 'split'
}

export function normalizeComposerToolbarLayout(value: unknown): ComposerToolbarLayout {
    if (!value || typeof value !== 'object') {
        return DEFAULT_COMPOSER_TOOLBAR_LAYOUT
    }

    const candidate = value as Partial<ComposerToolbarLayout>
    const seen = new Set<ComposerToolbarItemId>()
    const normalizeGroup = (group: unknown): ComposerToolbarItemId[] => {
        if (!Array.isArray(group)) {
            return []
        }
        return group.filter((item): item is ComposerToolbarItemId => {
            if (!isItemId(item) || seen.has(item)) {
                return false
            }
            seen.add(item)
            return true
        })
    }

    const left = normalizeGroup(candidate.left)
    const right = normalizeGroup(candidate.right)
    const hidden = normalizeGroup(candidate.hidden)
    for (const item of COMPOSER_TOOLBAR_ITEM_IDS) {
        if (!seen.has(item)) {
            left.push(item)
        }
    }

    return {
        mode: isLayoutMode(candidate.mode) ? candidate.mode : DEFAULT_COMPOSER_TOOLBAR_LAYOUT.mode,
        left,
        right,
        hidden,
    }
}

function readLayout(): ComposerToolbarLayout {
    if (typeof window === 'undefined') {
        return DEFAULT_COMPOSER_TOOLBAR_LAYOUT
    }
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        return raw ? normalizeComposerToolbarLayout(JSON.parse(raw)) : DEFAULT_COMPOSER_TOOLBAR_LAYOUT
    } catch {
        return DEFAULT_COMPOSER_TOOLBAR_LAYOUT
    }
}

export function useComposerToolbarLayout(): {
    layout: ComposerToolbarLayout
    setLayout: (layout: ComposerToolbarLayout) => void
    resetLayout: () => void
} {
    const [layout, setLayoutState] = useState<ComposerToolbarLayout>(readLayout)

    useEffect(() => {
        const sync = () => setLayoutState(readLayout())
        window.addEventListener('storage', sync)
        window.addEventListener(CHANGE_EVENT, sync)
        return () => {
            window.removeEventListener('storage', sync)
            window.removeEventListener(CHANGE_EVENT, sync)
        }
    }, [])

    const setLayout = useCallback((next: ComposerToolbarLayout) => {
        const normalized = normalizeComposerToolbarLayout(next)
        setLayoutState(normalized)
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
            window.dispatchEvent(new Event(CHANGE_EVENT))
        } catch {
            // Keep the in-memory preference when storage is unavailable.
        }
    }, [])

    const resetLayout = useCallback(() => {
        setLayoutState(DEFAULT_COMPOSER_TOOLBAR_LAYOUT)
        try {
            window.localStorage.removeItem(STORAGE_KEY)
            window.dispatchEvent(new Event(CHANGE_EVENT))
        } catch {
            // Keep the in-memory default when storage is unavailable.
        }
    }, [])

    return { layout, setLayout, resetLayout }
}
