/**
 * Terminal Font Provider
 *
 * Provides font configuration for terminal rendering with Nerd Font support.
 * Always loads builtin Nerd Font to ensure icons display correctly on all devices.
 */

const BUILTIN_FONT_NAME = 'BuiltinNerdFont'

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
 * System monospace fallbacks
 */
const SYSTEM_FALLBACKS = [
    'ui-monospace',
    'SFMono-Regular',
    'Menlo',
    'Monaco',
    'Consolas',
    'Liberation Mono',
    'Courier New',
    'monospace'
]

/**
 * Load the builtin Nerd Font
 */
async function loadBuiltinFont(): Promise<void> {
    const fontUrl = `${import.meta.env.BASE_URL}fonts/MesloLGLDZNerdFontMono-Regular.woff2`
    const font = new FontFace(
        BUILTIN_FONT_NAME,
        `url(${fontUrl}) format("woff2")`,
        { style: 'normal', weight: '400', display: 'swap' }
    )
    await font.load()
    document.fonts.add(font)
    await document.fonts.ready
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
export async function createFontProvider(): Promise<ITerminalFontProvider> {
    const localFontFamily = LOCAL_NERD_FONTS.map(f => `"${f}"`).join(', ')
    const systemFallbacks = SYSTEM_FALLBACKS.map(f => `"${f}"`).join(', ')

    try {
        await loadBuiltinFont()
        console.log('[TerminalFont] Builtin font loaded')
    } catch (err) {
        console.error('[TerminalFont] Failed to load builtin font:', err)
    }

    // Builtin font first to ensure icons work, then local fonts, then system fallbacks
    return new FontProvider(`"${BUILTIN_FONT_NAME}", ${localFontFamily}, ${systemFallbacks}`)
}
