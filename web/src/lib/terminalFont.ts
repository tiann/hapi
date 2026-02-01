/**
 * Terminal Font Provider
 *
 * Provides font configuration for terminal rendering with Nerd Font support.
 * Loads Nerd Font from CDN to ensure icons display correctly on all devices.
 */

const BUILTIN_FONT_NAME = 'MesloLGLDZ Nerd Font Mono'
const CDN_FONT_URL = 'https://cdn.jsdelivr.net/gh/mshaugh/nerdfont-webfonts@v3.3.0/build/fonts/MesloLGLDZNerdFontMono-Regular.woff2'

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
 * Load Nerd Font from CDN
 */
async function loadBuiltinFont(): Promise<void> {
    const font = new FontFace(
        BUILTIN_FONT_NAME,
        `url(${CDN_FONT_URL}) format("woff2")`,
        { style: 'normal', weight: '400', display: 'swap' }
    )
    await font.load()
    document.fonts.add(font)
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

/**
 * Factory function to create font provider
 * Always loads builtin font, placed first to ensure Nerd Font icons work
 */
async function createFontProvider(): Promise<ITerminalFontProvider> {
    const localFontFamily = LOCAL_NERD_FONTS.map(f => `"${f}"`).join(', ')

    try {
        await loadBuiltinFont()
        console.log('[TerminalFont] CDN font loaded')
    } catch (err) {
        console.error('[TerminalFont] Failed to load CDN font:', err)
    }

    // Local fonts first (better rendering if available), then builtin font as fallback, then system fonts
    const parts = [localFontFamily, `"${BUILTIN_FONT_NAME}"`, ...SYSTEM_FALLBACKS, ...GENERIC_FAMILIES]
    return new FontProvider(parts.join(', '))
}

// 单例：确保字体只加载一次
let fontProviderPromise: Promise<ITerminalFontProvider> | null = null

/**
 * 获取字体 Provider（懒加载，只加载一次）
 */
export function getFontProvider(): Promise<ITerminalFontProvider> {
    if (!fontProviderPromise) {
        fontProviderPromise = createFontProvider()
    }
    return fontProviderPromise
}
