import { useCallback, useEffect, useState } from 'react'

export type ColorScheme = 'light' | 'dark' | 'oled'
export type ColorThemePreset =
    | 'default'
    | 'notion'
    | 'one'
    | 'proof'
    | 'raycast'
    | 'rose-pine'
    | 'solarized'
    | 'vercel'
    | 'vs-code-plus'
    | 'xcode'
    | 'linear'
    | 'lobster'
    | 'material'
    | 'matrix'
    | 'monokai'
    | 'night-owl'
    | 'nord'

export type ColorThemeOption = {
    value: ColorThemePreset
    label: string
    preview: {
        light: string
        dark: string
        accent: string
    }
}

type ThemePalette = {
    accent: string
    background: string
    foreground: string
    hint: string
    secondary: string
    dialog: string
    surface: string
    surfaceHover: string
    code: string
    border: string
    subtle: string
    buttonText: string
}

const COLOR_THEME_KEY = 'hapi-color-theme'

const COLOR_THEME_OPTIONS: ReadonlyArray<ColorThemeOption> = [
    { value: 'default', label: 'Default', preview: { light: '#ffffff', dark: '#1c1c1e', accent: '#111827' } },
    { value: 'notion', label: 'Notion', preview: { light: '#fafafa', dark: '#191919', accent: '#3183d8' } },
    { value: 'one', label: 'One', preview: { light: '#fbfbff', dark: '#1f2433', accent: '#526fff' } },
    { value: 'proof', label: 'Proof', preview: { light: '#f8f7f2', dark: '#18231f', accent: '#2f7d5b' } },
    { value: 'raycast', label: 'Raycast', preview: { light: '#ffffff', dark: '#201617', accent: '#ff5555' } },
    { value: 'rose-pine', label: 'Rose Pine', preview: { light: '#fffaf3', dark: '#191724', accent: '#c65f7b' } },
    { value: 'solarized', label: 'Solarized', preview: { light: '#fdf6e3', dark: '#002b36', accent: '#b58900' } },
    { value: 'vercel', label: 'Vercel', preview: { light: '#ffffff', dark: '#000000', accent: '#0070f3' } },
    { value: 'vs-code-plus', label: 'VS Code Plus', preview: { light: '#ffffff', dark: '#1e1e1e', accent: '#007acc' } },
    { value: 'xcode', label: 'Xcode', preview: { light: '#f7f9ff', dark: '#1f2024', accent: '#0a84ff' } },
    { value: 'linear', label: 'Linear', preview: { light: '#f7f7fb', dark: '#08090d', accent: '#5e6ad2' } },
    { value: 'lobster', label: 'Lobster', preview: { light: '#fff7f4', dark: '#161821', accent: '#ff5b6e' } },
    { value: 'material', label: 'Material', preview: { light: '#fffbfe', dark: '#1c1b1f', accent: '#6750a4' } },
    { value: 'matrix', label: 'Matrix', preview: { light: '#f5fff7', dark: '#030806', accent: '#00ff66' } },
    { value: 'monokai', label: 'Monokai', preview: { light: '#f8f7ef', dark: '#272822', accent: '#a6e22e' } },
    { value: 'night-owl', label: 'Night Owl', preview: { light: '#fbfdff', dark: '#011627', accent: '#82aaff' } },
    { value: 'nord', label: 'Nord', preview: { light: '#eceff4', dark: '#2e3440', accent: '#88c0d0' } },
]

const PALETTES: Record<Exclude<ColorThemePreset, 'default'>, Record<'light' | 'dark', ThemePalette>> = {
    notion: {
        light: palette('#3183d8', '#fafafa', '#37352f', '#787774', '#f1f1ef'),
        dark: palette('#3183d8', '#191919', '#d9d9d8', '#9b9a97', '#252525'),
    },
    one: {
        light: palette('#526fff', '#fbfbff', '#383a42', '#696c77', '#f0f2ff'),
        dark: palette('#7b8cff', '#1f2433', '#d8dee9', '#aab2c0', '#2c3245'),
    },
    proof: {
        light: palette('#2f7d5b', '#f8f7f2', '#26352f', '#64706b', '#eef1ea'),
        dark: palette('#7fc8a6', '#18231f', '#d9e4dc', '#9dafaa', '#23332d'),
    },
    raycast: {
        light: palette('#ff4d4d', '#ffffff', '#2b2b31', '#72727a', '#fff0f0'),
        dark: palette('#ff6363', '#201617', '#f3eded', '#c9bfc0', '#321f21'),
    },
    'rose-pine': {
        light: palette('#d7827e', '#fffaf3', '#575279', '#797593', '#f2e9e1'),
        dark: palette('#ebbcba', '#191724', '#e0def4', '#908caa', '#26233a'),
    },
    solarized: {
        light: palette('#b58900', '#fdf6e3', '#586e75', '#839496', '#eee8d5'),
        dark: palette('#268bd2', '#002b36', '#93a1a1', '#839496', '#073642'),
    },
    vercel: {
        light: palette('#0070f3', '#ffffff', '#111111', '#666666', '#f5f5f5'),
        dark: palette('#3291ff', '#000000', '#ededed', '#a1a1a1', '#111111'),
    },
    'vs-code-plus': {
        light: palette('#007acc', '#ffffff', '#24292f', '#6e7781', '#f3f6f8'),
        dark: palette('#3794ff', '#1e1e1e', '#d4d4d4', '#9cdcfe', '#252526'),
    },
    xcode: {
        light: palette('#0a84ff', '#f7f9ff', '#1f2328', '#59636e', '#eef4ff'),
        dark: palette('#409cff', '#1f2024', '#eef2ff', '#a9b0bd', '#2a2c33'),
    },
    linear: {
        light: palette('#5e6ad2', '#f7f7fb', '#25262f', '#70717d', '#eeeeF8'),
        dark: palette('#8a91f6', '#08090d', '#f7f8ff', '#a6a8b5', '#151722'),
    },
    lobster: {
        light: palette('#e84d68', '#fff7f4', '#33262b', '#7d636a', '#ffe9e2'),
        dark: palette('#ff5b6e', '#161821', '#f5d7dc', '#be9ca5', '#242333'),
    },
    material: {
        light: palette('#6750a4', '#fffbfe', '#1c1b1f', '#6f6a73', '#f2edf7'),
        dark: palette('#d0bcff', '#1c1b1f', '#e6e1e5', '#cac4cf', '#2b2930'),
    },
    matrix: {
        light: palette('#10883a', '#f5fff7', '#102016', '#55735f', '#e8f8ec'),
        dark: palette('#00ff66', '#030806', '#d8ffe4', '#6aff9b', '#07150d'),
    },
    monokai: {
        light: palette('#7a8f00', '#f8f7ef', '#3b3a32', '#747065', '#efeee4'),
        dark: palette('#a6e22e', '#272822', '#f8f8f2', '#cfcfc2', '#33342d'),
    },
    'night-owl': {
        light: palette('#4876d9', '#fbfdff', '#25354a', '#60708a', '#eef6ff'),
        dark: palette('#82aaff', '#011627', '#d6deeb', '#7fdbca', '#0b2942'),
    },
    nord: {
        light: palette('#5e81ac', '#eceff4', '#2e3440', '#667085', '#e5e9f0'),
        dark: palette('#88c0d0', '#2e3440', '#eceff4', '#d8dee9', '#3b4252'),
    },
}

function palette(accent: string, background: string, foreground: string, hint: string, secondary: string): ThemePalette {
    const isDark = relativeLuminance(background) < 0.5
    return {
        accent,
        background,
        foreground,
        hint,
        secondary,
        dialog: isDark ? mix(background, '#ffffff', 0.05) : mix(background, '#000000', 0.015),
        surface: isDark ? mix(background, '#ffffff', 0.09) : mix(background, '#000000', 0.035),
        surfaceHover: isDark ? mix(background, '#ffffff', 0.14) : mix(background, '#000000', 0.065),
        code: isDark ? mix(background, '#ffffff', 0.11) : mix(background, '#000000', 0.045),
        border: withAlpha(isDark ? '#ffffff' : '#0f172a', isDark ? 0.11 : 0.10),
        subtle: withAlpha(isDark ? '#ffffff' : '#0f172a', isDark ? 0.06 : 0.045),
        buttonText: readableText(accent),
    }
}

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

export function parseColorTheme(raw: string | null): ColorThemePreset {
    return COLOR_THEME_OPTIONS.some((option) => option.value === raw) ? raw as ColorThemePreset : 'default'
}

export function getStoredColorTheme(): ColorThemePreset {
    return parseColorTheme(safeGetItem(COLOR_THEME_KEY))
}

export function getColorThemeOptions(): ReadonlyArray<ColorThemeOption> {
    return COLOR_THEME_OPTIONS
}

export function getColorThemeLabel(theme: ColorThemePreset): string {
    return COLOR_THEME_OPTIONS.find((option) => option.value === theme)?.label ?? 'Default'
}

export function getColorThemePreview(theme: ColorThemePreset): ColorThemeOption['preview'] {
    return COLOR_THEME_OPTIONS.find((option) => option.value === theme)?.preview ?? COLOR_THEME_OPTIONS[0]!.preview
}

export function getColorThemeStorageKey(): string {
    return COLOR_THEME_KEY
}

export function getColorThemeBackground(theme: ColorThemePreset, scheme: ColorScheme): string | null {
    return theme === 'default' ? null : PALETTES[theme][toPaletteScheme(scheme)].background
}

export function applyColorTheme(theme: ColorThemePreset = getStoredColorTheme(), scheme: ColorScheme): void {
    if (!isBrowser()) return

    const root = document.documentElement
    root.setAttribute('data-color-theme', theme)

    if (theme === 'default') {
        removeThemeProperties(root)
        return
    }

    const values = PALETTES[theme][toPaletteScheme(scheme)]
    const properties: Record<string, string> = {
        '--app-bg': values.background,
        '--app-fg': values.foreground,
        '--app-hint': values.hint,
        '--app-link': values.accent,
        '--app-button': values.accent,
        '--app-button-text': values.buttonText,
        '--app-banner-bg': values.accent,
        '--app-banner-text': values.buttonText,
        '--app-secondary-bg': values.secondary,
        '--app-dialog-bg': values.dialog,
        '--app-chat-user-bg': values.surface,
        '--app-chat-user-fg': values.foreground,
        '--app-chat-user-chip-bg': withAlpha(values.accent, scheme === 'dark' ? 0.24 : 0.15),
        '--app-chat-user-chip-fg': values.accent,
        '--app-tool-card-bg': values.surface,
        '--app-tool-card-hover-bg': values.surfaceHover,
        '--app-tool-card-accent': values.hint,
        '--app-tool-card-muted-action-fg': withAlpha(values.hint, 0.72),
        '--app-tool-card-subtitle': values.hint,
        '--app-code-header-bg': values.surfaceHover,
        '--app-code-header-fg': values.hint,
        '--app-code-bg': values.code,
        '--app-inline-code-bg': values.code,
        '--app-inline-code-fg': values.foreground,
        '--app-md-quote-bg': values.surface,
        '--app-md-quote-border': withAlpha(values.accent, 0.35),
        '--app-md-quote-fg': values.foreground,
        '--app-md-table-bg': values.surface,
        '--app-md-table-head-bg': values.surfaceHover,
        '--app-reasoning-bg': values.surface,
        '--app-border': values.border,
        '--app-divider': values.border,
        '--app-subtle-bg': values.subtle,
        '--app-scrollbar-thumb': withAlpha(values.hint, 0.38),
        '--app-scrollbar-thumb-hover': withAlpha(values.hint, 0.56),
    }

    for (const [key, value] of Object.entries(properties)) {
        root.style.setProperty(key, value)
    }
}

function removeThemeProperties(root: HTMLElement): void {
    const properties = [
        '--app-bg', '--app-fg', '--app-hint', '--app-link', '--app-button', '--app-button-text', '--app-banner-bg', '--app-banner-text',
        '--app-secondary-bg', '--app-dialog-bg', '--app-chat-user-bg', '--app-chat-user-fg', '--app-chat-user-chip-bg',
        '--app-chat-user-chip-fg', '--app-tool-card-bg', '--app-tool-card-hover-bg', '--app-tool-card-accent',
        '--app-tool-card-muted-action-fg', '--app-tool-card-subtitle', '--app-code-header-bg', '--app-code-header-fg', '--app-code-bg',
        '--app-inline-code-bg', '--app-inline-code-fg', '--app-md-quote-bg', '--app-md-quote-border', '--app-md-quote-fg', '--app-md-table-bg',
        '--app-md-table-head-bg', '--app-reasoning-bg', '--app-border', '--app-divider', '--app-subtle-bg', '--app-scrollbar-thumb', '--app-scrollbar-thumb-hover',
    ]
    for (const property of properties) root.style.removeProperty(property)
}


function getDocumentColorScheme(): ColorScheme {
    if (!isBrowser()) return 'light'
    const theme = document.documentElement.getAttribute('data-theme')
    return theme === 'dark' || theme === 'oled' ? theme : 'light'
}

function toPaletteScheme(scheme: ColorScheme): 'light' | 'dark' {
    return scheme === 'light' ? 'light' : 'dark'
}

export function useColorTheme(): { colorTheme: ColorThemePreset; setColorTheme: (theme: ColorThemePreset) => void } {
    const [colorTheme, setColorThemeState] = useState<ColorThemePreset>(getStoredColorTheme)

    useEffect(() => {
        if (!isBrowser()) return
        const onStorage = (event: StorageEvent) => {
            if (event.key !== COLOR_THEME_KEY) return
            const nextTheme = parseColorTheme(event.newValue)
            setColorThemeState(nextTheme)
            applyColorTheme(nextTheme, getDocumentColorScheme())
            window.dispatchEvent(new CustomEvent('hapi-color-theme-change', { detail: nextTheme }))
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setColorTheme = useCallback((theme: ColorThemePreset) => {
        setColorThemeState(theme)
        applyColorTheme(theme, getDocumentColorScheme())
        if (theme === 'default') {
            safeRemoveItem(COLOR_THEME_KEY)
        } else {
            safeSetItem(COLOR_THEME_KEY, theme)
        }
        window.dispatchEvent(new CustomEvent('hapi-color-theme-change', { detail: theme }))
    }, [])

    return { colorTheme, setColorTheme }
}

function mix(a: string, b: string, weight: number): string {
    const ca = parseHex(a)
    const cb = parseHex(b)
    const channel = (x: number, y: number) => Math.round(x * (1 - weight) + y * weight)
    return toHex(channel(ca.r, cb.r), channel(ca.g, cb.g), channel(ca.b, cb.b))
}

function withAlpha(hex: string, alpha: number): string {
    const color = parseHex(hex)
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`
}

function readableText(hex: string): string {
    return relativeLuminance(hex) > 0.45 ? '#111827' : '#ffffff'
}

function relativeLuminance(hex: string): number {
    const { r, g, b } = parseHex(hex)
    const convert = (value: number) => {
        const next = value / 255
        return next <= 0.03928 ? next / 12.92 : ((next + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * convert(r) + 0.7152 * convert(g) + 0.0722 * convert(b)
}

function parseHex(hex: string): { r: number; g: number; b: number } {
    const clean = hex.replace('#', '')
    const value = clean.length === 3
        ? clean.split('').map((char) => `${char}${char}`).join('')
        : clean
    return {
        r: parseInt(value.slice(0, 2), 16),
        g: parseInt(value.slice(2, 4), 16),
        b: parseInt(value.slice(4, 6), 16),
    }
}

function toHex(r: number, g: number, b: number): string {
    return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}
