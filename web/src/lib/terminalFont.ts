/**
 * Terminal Font Provider
 *
 * Provides font configuration for terminal rendering with Nerd Font support.
 * Follows SOLID principles for easy extensibility.
 */

/**
 * Terminal font provider interface
 */
export interface ITerminalFontProvider {
    /**
     * Get CSS fontFamily string for terminal
     */
    getFontFamily(): string

    /**
     * Optional async initialization (for future smart detection)
     */
    initialize?(): Promise<void>
}

/**
 * Default font provider with hardcoded Nerd Font fallback list
 * 
 * Includes common Nerd Fonts and system fallbacks.
 * Zero runtime overhead - uses browser's native font fallback mechanism.
 */
export class DefaultFontProvider implements ITerminalFontProvider {
    private static readonly NERD_FONTS = [
        // Common Nerd Fonts (prioritized by popularity)
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

    private static readonly SYSTEM_FALLBACKS = [
        'ui-monospace',
        'SFMono-Regular',
        'Menlo',
        'Monaco',
        'Consolas',
        '"Liberation Mono"',
        '"Courier New"',
        'monospace'
    ]

    getFontFamily(): string {
        return [
            ...DefaultFontProvider.NERD_FONTS.map(f => `"${f}"`),
            ...DefaultFontProvider.SYSTEM_FALLBACKS
        ].join(', ')
    }
}

/**
 * Factory function to create font provider
 * 
 * @param mode - Provider mode (currently only 'default', extensible for future)
 * @returns Font provider instance
 */
export async function createFontProvider(
    mode: 'default' = 'default'
): Promise<ITerminalFontProvider> {
    switch (mode) {
        case 'default':
        default:
            return new DefaultFontProvider()
    }
}
