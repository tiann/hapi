import { useCallback, useEffect, useState } from 'react'
import { applyColorTheme, getColorThemeStorageKey, getStoredColorTheme, type ColorScheme } from './useColorTheme'

/**
 * Per-appearance "key color" customization.
 *
 * Unlike {@link useChatSurfaceColors} (which tints two chat surfaces), this hook
 * exposes a curated set of key colors. Each key cascades to a small group of
 * `--app-*` tokens (and a couple of derived ones) so the whole palette stays
 * coherent without a 60-token editor. Overrides are scoped per appearance
 * (`light | dark | oled`) because a color that reads well on white will not on
 * pure black.
 */

export type ThemeScheme = 'light' | 'dark' | 'oled'

export type ThemeColorKeyId =
    | 'background'
    | 'surface'
    | 'text'
    | 'hint'
    | 'accent'
    | 'border'
    | 'userBubble'

interface ThemeColorKey {
    id: ThemeColorKeyId
    labelKey: string
    /** Tokens set directly to the chosen hex. */
    targets: readonly string[]
    /** Tokens computed from the chosen hex (cleared together with the base). */
    derivedTargets?: readonly string[]
    derive?: (hex: string, scheme: ThemeScheme) => Record<string, string>
}

const STORAGE_KEY = 'hapi-theme-colors'

export const THEME_COLOR_KEYS: readonly ThemeColorKey[] = [
    {
        id: 'background',
        labelKey: 'settings.display.themeColors.key.background',
        targets: ['--app-bg'],
    },
    {
        id: 'surface',
        labelKey: 'settings.display.themeColors.key.surface',
        targets: [
            '--app-secondary-bg',
            '--app-dialog-bg',
            '--app-tool-card-bg',
            '--app-reasoning-bg',
            '--app-md-table-bg',
            '--app-code-bg',
            '--app-inline-code-bg',
        ],
        derivedTargets: ['--app-tool-card-hover-bg'],
        derive: (hex, scheme) => ({
            '--app-tool-card-hover-bg': mixHex(hex, contrastColor(scheme), 0.08),
        }),
    },
    {
        id: 'text',
        labelKey: 'settings.display.themeColors.key.text',
        targets: ['--app-fg', '--app-chat-user-fg', '--app-inline-code-fg'],
    },
    {
        id: 'hint',
        labelKey: 'settings.display.themeColors.key.hint',
        targets: ['--app-hint', '--app-tool-card-subtitle'],
    },
    {
        id: 'accent',
        labelKey: 'settings.display.themeColors.key.accent',
        targets: ['--app-link', '--app-chat-user-chip-fg'],
    },
    {
        id: 'border',
        labelKey: 'settings.display.themeColors.key.border',
        targets: ['--app-border', '--app-divider'],
    },
    {
        id: 'userBubble',
        labelKey: 'settings.display.themeColors.key.userBubble',
        targets: ['--app-chat-user-bg'],
    },
]

/** Fallback swatch values that mirror the CSS theme defaults (no override set). */
const DEFAULT_HEX: Record<ThemeScheme, Record<ThemeColorKeyId, string>> = {
    light: {
        background: '#ffffff',
        surface: '#f2f4f6',
        text: '#111827',
        hint: '#6b7280',
        accent: '#111827',
        border: '#e2e8f0',
        userBubble: '#f2f4f6',
    },
    dark: {
        background: '#1c1c1e',
        surface: '#2b2f34',
        text: '#ffffff',
        hint: '#8e8e93',
        accent: '#ffffff',
        border: '#2a2a2c',
        userBubble: '#2b2f34',
    },
    oled: {
        background: '#000000',
        surface: '#0e0e10',
        text: '#f5f5f7',
        hint: '#8e8e93',
        accent: '#4ea1ff',
        border: '#1f1f22',
        userBubble: '#141414',
    },
}

type StoredThemeColors = Partial<Record<ThemeScheme, Partial<Record<ThemeColorKeyId, string>>>>

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

export function normalizeThemeColor(value: string): string | null {
    const normalized = value.trim().toLowerCase()
    return isHexColor(normalized) ? normalized : null
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

function contrastColor(scheme: ThemeScheme): string {
    return scheme === 'light' ? '#000000' : '#ffffff'
}

export function getThemeScheme(): ThemeScheme {
    if (!isBrowser()) return 'light'
    const theme = document.documentElement.getAttribute('data-theme')
    if (theme === 'dark' || theme === 'oled') return theme
    return 'light'
}

function getStoredThemeColors(): StoredThemeColors {
    const raw = safeGetItem(STORAGE_KEY)
    if (!raw) return {}

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return {}
    }
    if (typeof parsed !== 'object' || parsed === null) return {}

    const result: StoredThemeColors = {}
    for (const scheme of ['light', 'dark', 'oled'] as const) {
        const group = (parsed as Record<string, unknown>)[scheme]
        if (typeof group !== 'object' || group === null) continue

        const cleaned: Partial<Record<ThemeColorKeyId, string>> = {}
        for (const key of THEME_COLOR_KEYS) {
            const value = (group as Record<string, unknown>)[key.id]
            if (typeof value === 'string') {
                const normalized = normalizeThemeColor(value)
                if (normalized) cleaned[key.id] = normalized
            }
        }
        if (Object.keys(cleaned).length > 0) result[scheme] = cleaned
    }
    return result
}

function writeStoredThemeColors(value: StoredThemeColors): void {
    const hasAny = Object.values(value).some((group) => group && Object.keys(group).length > 0)
    if (!hasAny) {
        safeRemoveItem(STORAGE_KEY)
    } else {
        safeSetItem(STORAGE_KEY, JSON.stringify(value))
    }
}

/** Re-apply the stored overrides for the currently-active appearance. */
export function applyThemeColors(): void {
    if (!isBrowser()) return

    const scheme = getThemeScheme()
    applyColorTheme(getStoredColorTheme(), scheme as ColorScheme)

    const overrides = getStoredThemeColors()[scheme] ?? {}
    const rootStyle = document.documentElement.style

    for (const key of THEME_COLOR_KEYS) {
        const override = overrides[key.id]
        const hex = override && isHexColor(override) ? override : null
        if (!hex) continue

        for (const cssVar of key.targets) {
            rootStyle.setProperty(cssVar, hex)
        }

        if (key.derivedTargets && key.derive) {
            const derived = key.derive(hex, scheme)
            for (const cssVar of key.derivedTargets) {
                rootStyle.setProperty(cssVar, derived[cssVar]!)
            }
        }
    }
}

export function getThemeColorPickerValue(scheme: ThemeScheme, id: ThemeColorKeyId): string {
    const override = getStoredThemeColors()[scheme]?.[id]
    return override ?? DEFAULT_HEX[scheme][id]
}

export function initializeThemeColors(): void {
    if (!isBrowser()) return

    applyThemeColors()

    if (initialized) return
    initialized = true

    window.addEventListener('storage', (event: StorageEvent) => {
        if (event.key === STORAGE_KEY || event.key === getColorThemeStorageKey()) applyThemeColors()
    })
    window.addEventListener('hapi-color-theme-change', applyThemeColors)

    const themeObserver = new MutationObserver(() => {
        applyThemeColors()
    })
    themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
    })
}

export function useThemeColors(): {
    scheme: ThemeScheme
    keys: readonly ThemeColorKey[]
    getPickerValue: (id: ThemeColorKeyId) => string
    isCustomized: (id: ThemeColorKeyId) => boolean
    hasAnyCustom: boolean
    setColor: (id: ThemeColorKeyId, value: string) => void
    resetColor: (id: ThemeColorKeyId) => void
    resetAll: () => void
} {
    const [scheme, setScheme] = useState<ThemeScheme>(getThemeScheme)
    const [overrides, setOverrides] = useState<Partial<Record<ThemeColorKeyId, string>>>(
        () => getStoredThemeColors()[getThemeScheme()] ?? {},
    )

    useEffect(() => {
        if (!isBrowser()) return

        const refresh = () => {
            const next = getThemeScheme()
            setScheme(next)
            setOverrides(getStoredThemeColors()[next] ?? {})
        }

        const themeObserver = new MutationObserver(refresh)
        themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme'],
        })

        const onStorage = (event: StorageEvent) => {
            if (event.key === STORAGE_KEY || event.key === getColorThemeStorageKey()) refresh()
        }
        const onColorThemeChange = () => refresh()
        window.addEventListener('storage', onStorage)
        window.addEventListener('hapi-color-theme-change', onColorThemeChange)

        return () => {
            themeObserver.disconnect()
            window.removeEventListener('storage', onStorage)
            window.removeEventListener('hapi-color-theme-change', onColorThemeChange)
        }
    }, [])

    const setColor = useCallback((id: ThemeColorKeyId, value: string) => {
        const normalized = normalizeThemeColor(value)
        if (!normalized) return

        const activeScheme = getThemeScheme()
        const all = getStoredThemeColors()
        all[activeScheme] = { ...(all[activeScheme] ?? {}), [id]: normalized }
        writeStoredThemeColors(all)
        applyThemeColors()

        setScheme(activeScheme)
        setOverrides(all[activeScheme] ?? {})
    }, [])

    const resetColor = useCallback((id: ThemeColorKeyId) => {
        const activeScheme = getThemeScheme()
        const all = getStoredThemeColors()
        const group = all[activeScheme]
        if (group) {
            delete group[id]
            if (Object.keys(group).length === 0) delete all[activeScheme]
        }
        writeStoredThemeColors(all)
        applyThemeColors()

        setScheme(activeScheme)
        setOverrides(all[activeScheme] ?? {})
    }, [])

    const resetAll = useCallback(() => {
        const activeScheme = getThemeScheme()
        const all = getStoredThemeColors()
        delete all[activeScheme]
        writeStoredThemeColors(all)
        applyThemeColors()

        setScheme(activeScheme)
        setOverrides({})
    }, [])

    const getPickerValue = useCallback(
        (id: ThemeColorKeyId) => overrides[id] ?? DEFAULT_HEX[scheme][id],
        [overrides, scheme],
    )

    const isCustomized = useCallback((id: ThemeColorKeyId) => Boolean(overrides[id]), [overrides])

    return {
        scheme,
        keys: THEME_COLOR_KEYS,
        getPickerValue,
        isCustomized,
        hasAnyCustom: Object.keys(overrides).length > 0,
        setColor,
        resetColor,
        resetAll,
    }
}
