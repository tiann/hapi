import { useCallback, useEffect, useLayoutEffect, useState } from 'react'

export type ChatSurfaceColorTarget = 'aggregateToolCard' | 'userMessage'

type TintState = string | null

const AGGREGATE_TOOL_CARD_TINT_KEY = 'hapi-aggregate-tool-card-tint'
const USER_MESSAGE_TINT_KEY = 'hapi-user-message-tint'

const PRESET_TINTS = ['#4F7CFF', '#7C5CFF', '#14B8A6', '#22C55E', '#F59E0B'] as const
const COLOR_PICKER_FALLBACK = PRESET_TINTS[0]

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

const useIsomorphicLayoutEffect = isBrowser() ? useLayoutEffect : useEffect

function safeGetItem(key: string): string | null {
    if (!isBrowser()) return null
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

function safeSetItem(key: string, value: string): void {
    if (!isBrowser()) return
    try {
        localStorage.setItem(key, value)
    } catch {
        // Ignore storage errors
    }
}

function safeRemoveItem(key: string): void {
    if (!isBrowser()) return
    try {
        localStorage.removeItem(key)
    } catch {
        // Ignore storage errors
    }
}

export function normalizeChatSurfaceTint(raw: string | null): string | null {
    if (!raw) return null
    const trimmed = raw.trim()
    if (!trimmed) return null

    const expanded = trimmed.match(/^#([0-9a-fA-F]{3})$/)
    if (expanded) {
        const [, short] = expanded
        return `#${short.split('').map((part) => `${part}${part}`).join('').toUpperCase()}`
    }

    const full = trimmed.match(/^#([0-9a-fA-F]{6})$/)
    if (!full) return null
    return `#${full[1].toUpperCase()}`
}

function getDefaultCssVarName(target: ChatSurfaceColorTarget): string {
    return target === 'aggregateToolCard'
        ? '--app-tool-card-aggregate-bg-default'
        : '--app-chat-user-bg-default'
}

function getResolvedCssVarName(target: ChatSurfaceColorTarget): string {
    return target === 'aggregateToolCard'
        ? '--app-tool-card-aggregate-bg'
        : '--app-chat-user-bg'
}

function getStorageKey(target: ChatSurfaceColorTarget): string {
    return target === 'aggregateToolCard'
        ? AGGREGATE_TOOL_CARD_TINT_KEY
        : USER_MESSAGE_TINT_KEY
}

function getMixRatio(target: ChatSurfaceColorTarget): string {
    return target === 'aggregateToolCard' ? '16%' : '18%'
}

export function buildChatSurfaceBackgroundValue(target: ChatSurfaceColorTarget, tint: string | null): string {
    const defaultVar = `var(${getDefaultCssVarName(target)})`
    if (!tint) return defaultVar
    return `color-mix(in srgb, ${defaultVar} ${100 - Number.parseInt(getMixRatio(target), 10)}%, ${tint} ${getMixRatio(target)})`
}

function applyChatSurfaceTint(target: ChatSurfaceColorTarget, tint: string | null): void {
    if (!isBrowser()) return
    document.documentElement.style.setProperty(
        getResolvedCssVarName(target),
        buildChatSurfaceBackgroundValue(target, tint),
    )
}

function getStoredTint(target: ChatSurfaceColorTarget): string | null {
    return normalizeChatSurfaceTint(safeGetItem(getStorageKey(target)))
}

function applyAllStoredTints(): void {
    applyChatSurfaceTint('aggregateToolCard', getStoredTint('aggregateToolCard'))
    applyChatSurfaceTint('userMessage', getStoredTint('userMessage'))
}

export function getChatSurfaceColorPresets(): ReadonlyArray<string> {
    return PRESET_TINTS
}

export function getColorPickerFallback(): string {
    return COLOR_PICKER_FALLBACK
}

export function initializeChatSurfaceColors(): void {
    applyAllStoredTints()
}

export function useChatSurfaceColors(): {
    aggregateToolCardTint: TintState
    userMessageTint: TintState
    setAggregateToolCardTint: (tint: string | null) => void
    setUserMessageTint: (tint: string | null) => void
} {
    const [aggregateToolCardTint, setAggregateToolCardTintState] = useState<TintState>(() => getStoredTint('aggregateToolCard'))
    const [userMessageTint, setUserMessageTintState] = useState<TintState>(() => getStoredTint('userMessage'))

    useIsomorphicLayoutEffect(() => {
        applyChatSurfaceTint('aggregateToolCard', aggregateToolCardTint)
    }, [aggregateToolCardTint])

    useIsomorphicLayoutEffect(() => {
        applyChatSurfaceTint('userMessage', userMessageTint)
    }, [userMessageTint])

    useEffect(() => {
        if (!isBrowser()) return

        const onStorage = (event: StorageEvent) => {
            if (event.key === AGGREGATE_TOOL_CARD_TINT_KEY) {
                setAggregateToolCardTintState(normalizeChatSurfaceTint(event.newValue))
            }
            if (event.key === USER_MESSAGE_TINT_KEY) {
                setUserMessageTintState(normalizeChatSurfaceTint(event.newValue))
            }
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setAggregateToolCardTint = useCallback((nextTint: string | null) => {
        const normalized = normalizeChatSurfaceTint(nextTint)
        setAggregateToolCardTintState(normalized)
        if (normalized) {
            safeSetItem(AGGREGATE_TOOL_CARD_TINT_KEY, normalized)
        } else {
            safeRemoveItem(AGGREGATE_TOOL_CARD_TINT_KEY)
        }
    }, [])

    const setUserMessageTint = useCallback((nextTint: string | null) => {
        const normalized = normalizeChatSurfaceTint(nextTint)
        setUserMessageTintState(normalized)
        if (normalized) {
            safeSetItem(USER_MESSAGE_TINT_KEY, normalized)
        } else {
            safeRemoveItem(USER_MESSAGE_TINT_KEY)
        }
    }, [])

    return {
        aggregateToolCardTint,
        userMessageTint,
        setAggregateToolCardTint,
        setUserMessageTint,
    }
}
