/**
 * Terminal Font Provider
 *
 * Provides font configuration for terminal rendering with Nerd Font support.
 * Loads Nerd Font from CDN to ensure icons display correctly on all devices.
 */

const BUILTIN_FONT_NAME = 'MesloLGLDZ Nerd Font Mono'
const CDN_FONT_URLS = [
    'https://cdn.jsdmirror.com/gh/mshaugh/nerdfont-webfonts@v3.3.0/build/fonts/MesloLGLDZNerdFontMono-Regular.woff2',
    'https://cdn.jsdelivr.net/gh/mshaugh/nerdfont-webfonts@v3.3.0/build/fonts/MesloLGLDZNerdFontMono-Regular.woff2'
]

/**
 * Terminal font provider interface
 */
export interface ITerminalFontProvider {
    /**
     * Get CSS fontFamily string for terminal
     */
    getFontFamily(): string
}

/**
 * Common local Nerd Fonts (prioritized by popularity)
 * These are checked first, so users with local fonts get better rendering
 */
const LOCAL_NERD_FONTS = [
    'JetBrainsMono Nerd Font',
    'JetBrainsMonoNerdFont',
    'FiraCode Nerd Font',
    'FiraCodeNerdFont',
    'Hack Nerd Font',
    'HackNerdFont',
    'MapleMono NF',
    'Maple Mono NF',
    'Iosevka Nerd Font',
    'IosevkaNerdFont',
    'CaskaydiaCove Nerd Font',
    'MesloLGS Nerd Font',
    'SourceCodePro Nerd Font',
    'UbuntuMono Nerd Font'
]

/**
 * Generic CSS font families must be unquoted; quoted names are specific font families
 */
const GENERIC_FAMILIES = ['ui-monospace', 'monospace']

const SYSTEM_FALLBACKS = [
    '"SFMono-Regular"',
    '"Menlo"',
    '"Monaco"',
    '"Consolas"',
    '"Liberation Mono"',
    '"Courier New"'
]

/**
 * Load Nerd Font from CDN with fallback
 */
async function loadBuiltinFont(): Promise<void> {
    let lastError: Error | null = null
    for (const url of CDN_FONT_URLS) {
        try {
            const font = new FontFace(
                BUILTIN_FONT_NAME,
                `url(${url}) format("woff2")`,
                { style: 'normal', weight: '400', display: 'swap' }
            )
            await font.load()
            document.fonts.add(font)
            return
        } catch (err) {
            lastError = err as Error
            if (isDev) {
                console.warn(`[TerminalFont] Failed to load from ${url}, trying next...`)
            }
        }
    }
    throw lastError ?? new Error('All CDN URLs failed')
}

/**
 * Font provider implementation
 */
class FontProvider implements ITerminalFontProvider {
    private fontFamily: string

    constructor(fontFamily: string) {
        this.fontFamily = fontFamily
    }

    getFontFamily(): string {
        return this.fontFamily
    }
}

const LOCAL_FONT_FAMILY = LOCAL_NERD_FONTS.map(f => `"${f}"`).join(', ')
const FONT_FAMILY_PARTS = [LOCAL_FONT_FAMILY, `"${BUILTIN_FONT_NAME}"`, ...SYSTEM_FALLBACKS, ...GENERIC_FAMILIES]
const FONT_FAMILY = FONT_FAMILY_PARTS.join(', ')

const fontProvider = new FontProvider(FONT_FAMILY)

let fontLoadPromise: Promise<boolean> | null = null
const isDev = typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV)

function isFontAvailable(fontName: string): boolean {
    if (typeof document === 'undefined') return false

    // Use canvas width comparison for reliable font detection
    // document.fonts.check() is unreliable on some mobile browsers
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return false

    const testString = 'mmmmmmmmmmlli'
    ctx.font = '72px "__nonexistent_font_test__", monospace'
    const baseWidth = ctx.measureText(testString).width
    ctx.font = `72px "${fontName}", monospace`
    const testWidth = ctx.measureText(testString).width

    return testWidth !== baseWidth
}

function hasLocalNerdFont(): boolean {
    return [BUILTIN_FONT_NAME, ...LOCAL_NERD_FONTS].some(isFontAvailable)
}

/**
 * 获取字体 Provider（懒加载，只加载一次）
 */
export function getFontProvider(): ITerminalFontProvider {
    return fontProvider
}

export function ensureBuiltinFontLoaded(): Promise<boolean> {
    if (!fontLoadPromise) {
        if (hasLocalNerdFont()) {
            if (isDev) {
                console.log('[TerminalFont] Local Nerd Font detected; skip CDN load')
            }
            fontLoadPromise = Promise.resolve(false)
        } else {
            fontLoadPromise = loadBuiltinFont()
                .then(() => {
                    if (isDev) {
                        console.log('[TerminalFont] CDN font loaded')
                    }
                    return true
                })
                .catch(err => {
                    if (isDev) {
                        console.error('[TerminalFont] Failed to load CDN font:', err)
                    }
                    return false
                })
        }
    }
    return fontLoadPromise
}
