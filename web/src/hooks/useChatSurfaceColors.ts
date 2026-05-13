import { useCallback, useEffect, useState } from 'react'

type ThemeMode = 'light' | 'dark'
type SurfaceKey = 'tool-group' | 'user-message'

export type ChatSurfaceColorPreset = 'default' | 'soft-blue' | 'soft-green' | 'soft-yellow'
export type ChatSurfaceColorPreference = 'default' | 'preset:soft-blue' | 'preset:soft-green' | 'preset:soft-yellow' | `custom:#${string}`

export const DEFAULT_CHAT_SURFACE_COLOR_PREFERENCE: ChatSurfaceColorPreference = 'default'

const TOOL_GROUP_BG_STORAGE_KEY = 'hapi-tool-group-bg'
const USER_MESSAGE_BG_STORAGE_KEY = 'hapi-user-message-bg'
const TOOL_GROUP_BG_CSS_VAR = '--app-tool-group-bg'
const USER_MESSAGE_BG_CSS_VAR = '--app-chat-user-surface-bg'
const DEFAULT_PICKER_COLOR = '#f2f4f6'

const PRESET_ACCENTS: Record<Exclude<ChatSurfaceColorPreset, 'default'>, string> = {
    'soft-blue': '#7db7ff',
    'soft-green': '#8fd19e',
    'soft-yellow': '#f0d77a',
}

const THEME_BASES: Record<ThemeMode, Record<SurfaceKey, string>> = {
    light: {
        'tool-group': '#f2f4f6',
        'user-message': '#f2f4f6',
    },
    dark: {
        'tool-group': '#2b2f34',
        'user-message': '#2b2f34',
    },
}

let initialized = false

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

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

function isHexColor(value: string): boolean {
    return /^#[0-9a-f]{6}$/i.test(value)
}

function normalizeHexColor(value: string): string | null {
    const normalized = value.trim().toLowerCase()
    return isHexColor(normalized) ? normalized : null
}

function parseChatSurfaceColorPreference(raw: string | null): ChatSurfaceColorPreference {
    if (raw === 'default' || raw === 'preset:soft-blue' || raw === 'preset:soft-green' || raw === 'preset:soft-yellow') {
        return raw
    }

    if (typeof raw === 'string' && raw.startsWith('custom:')) {
        const normalized = normalizeHexColor(raw.slice('custom:'.length))
        if (normalized) {
            return `custom:${normalized}` as ChatSurfaceColorPreference
        }
    }

    return DEFAULT_CHAT_SURFACE_COLOR_PREFERENCE
}

function getThemeMode(): ThemeMode {
    if (!isBrowser()) return 'light'
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

function hexToRgb(hex: string): [number, number, number] {
    const normalized = hex.replace('#', '')
    return [
        Number.parseInt(normalized.slice(0, 2), 16),
        Number.parseInt(normalized.slice(2, 4), 16),
        Number.parseInt(normalized.slice(4, 6), 16),
    ]
}

function clampChannel(value: number): number {
    return Math.max(0, Math.min(255, value))
}

function rgbToHex(r: number, g: number, b: number): string {
    return `#${[r, g, b]
        .map((channel) => clampChannel(channel).toString(16).padStart(2, '0'))
        .join('')}`
}

function mixHex(base: string, accent: string, ratio: number): string {
    const [br, bg, bb] = hexToRgb(base)
    const [ar, ag, ab] = hexToRgb(accent)
    return rgbToHex(
        Math.round(br + (ar - br) * ratio),
        Math.round(bg + (ag - bg) * ratio),
        Math.round(bb + (ab - bb) * ratio),
    )
}

function getAccentColor(pref: ChatSurfaceColorPreference): string | null {
    if (pref === 'default') return null
    if (pref.startsWith('preset:')) {
        return PRESET_ACCENTS[pref.slice('preset:'.length) as keyof typeof PRESET_ACCENTS] ?? null
    }
    return normalizeHexColor(pref.slice('custom:'.length))
}

function resolveSurfaceColor(pref: ChatSurfaceColorPreference, theme: ThemeMode, surface: SurfaceKey): string | null {
    const accent = getAccentColor(pref)
    if (!accent) return null

    const base = THEME_BASES[theme][surface]
    const ratio = pref.startsWith('custom:') ? (theme === 'dark' ? 0.22 : 0.34) : (theme === 'dark' ? 0.2 : 0.3)
    return mixHex(base, accent, ratio)
}

function readStoredToolGroupBackground(): ChatSurfaceColorPreference {
    return parseChatSurfaceColorPreference(safeGetItem(TOOL_GROUP_BG_STORAGE_KEY))
}

function readStoredUserMessageBackground(): ChatSurfaceColorPreference {
    return parseChatSurfaceColorPreference(safeGetItem(USER_MESSAGE_BG_STORAGE_KEY))
}

function applyChatSurfaceVariables(): void {
    if (!isBrowser()) return

    const theme = getThemeMode()
    const rootStyle = document.documentElement.style
    const toolGroupColor = resolveSurfaceColor(readStoredToolGroupBackground(), theme, 'tool-group')
    const userMessageColor = resolveSurfaceColor(readStoredUserMessageBackground(), theme, 'user-message')

    if (toolGroupColor) rootStyle.setProperty(TOOL_GROUP_BG_CSS_VAR, toolGroupColor)
    else rootStyle.removeProperty(TOOL_GROUP_BG_CSS_VAR)

    if (userMessageColor) rootStyle.setProperty(USER_MESSAGE_BG_CSS_VAR, userMessageColor)
    else rootStyle.removeProperty(USER_MESSAGE_BG_CSS_VAR)
}

function writePreference(key: string, value: ChatSurfaceColorPreference): void {
    if (value === DEFAULT_CHAT_SURFACE_COLOR_PREFERENCE) {
        safeRemoveItem(key)
    } else {
        safeSetItem(key, value)
    }
    applyChatSurfaceVariables()
}

export function getChatSurfaceColorPresetOptions(): ReadonlyArray<{ value: ChatSurfaceColorPreset; labelKey: string }> {
    return [
        { value: 'default', labelKey: 'settings.chat.surfaceColor.default' },
        { value: 'soft-blue', labelKey: 'settings.chat.surfaceColor.softBlue' },
        { value: 'soft-green', labelKey: 'settings.chat.surfaceColor.softGreen' },
        { value: 'soft-yellow', labelKey: 'settings.chat.surfaceColor.softYellow' },
    ]
}

export function toPresetChatSurfaceColorPreference(preset: ChatSurfaceColorPreset): ChatSurfaceColorPreference {
    return preset === 'default' ? 'default' : (`preset:${preset}` as ChatSurfaceColorPreference)
}

export function toCustomChatSurfaceColorPreference(value: string): ChatSurfaceColorPreference {
    const normalized = normalizeHexColor(value) ?? DEFAULT_PICKER_COLOR
    return `custom:${normalized}` as ChatSurfaceColorPreference
}

export function getToolGroupBackgroundPreference(): ChatSurfaceColorPreference {
    return readStoredToolGroupBackground()
}

export function getUserMessageBackgroundPreference(): ChatSurfaceColorPreference {
    return readStoredUserMessageBackground()
}

export function getChatSurfaceColorPickerValue(pref: ChatSurfaceColorPreference): string {
    return getAccentColor(pref) ?? DEFAULT_PICKER_COLOR
}

export function initializeChatSurfaceColors(): void {
    if (!isBrowser()) return

    applyChatSurfaceVariables()

    if (initialized) return
    initialized = true

    window.addEventListener('storage', applyChatSurfaceVariables)

    const themeObserver = new MutationObserver(() => {
        applyChatSurfaceVariables()
    })
    themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
    })
}

export function useChatSurfaceColors(): {
    toolGroupBackground: ChatSurfaceColorPreference
    userMessageBackground: ChatSurfaceColorPreference
    setToolGroupBackground: (value: ChatSurfaceColorPreference) => void
    setUserMessageBackground: (value: ChatSurfaceColorPreference) => void
} {
    const [toolGroupBackground, setToolGroupBackgroundState] = useState<ChatSurfaceColorPreference>(getToolGroupBackgroundPreference)
    const [userMessageBackground, setUserMessageBackgroundState] = useState<ChatSurfaceColorPreference>(getUserMessageBackgroundPreference)

    useEffect(() => {
        if (!isBrowser()) return

        const onStorage = (event: StorageEvent) => {
            if (event.key !== TOOL_GROUP_BG_STORAGE_KEY && event.key !== USER_MESSAGE_BG_STORAGE_KEY) {
                return
            }
            setToolGroupBackgroundState(readStoredToolGroupBackground())
            setUserMessageBackgroundState(readStoredUserMessageBackground())
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setToolGroupBackground = useCallback((value: ChatSurfaceColorPreference) => {
        setToolGroupBackgroundState(value)
        writePreference(TOOL_GROUP_BG_STORAGE_KEY, value)
    }, [])

    const setUserMessageBackground = useCallback((value: ChatSurfaceColorPreference) => {
        setUserMessageBackgroundState(value)
        writePreference(USER_MESSAGE_BG_STORAGE_KEY, value)
    }, [])

    return {
        toolGroupBackground,
        userMessageBackground,
        setToolGroupBackground,
        setUserMessageBackground,
    }
}
