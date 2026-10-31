package app.hapi.companion.feature.terminal

/**
 * Terminal cell color (pure Kotlin — no UI types; the render layer resolves
 * these through [TerminalPalette] plus the active theme).
 *
 * Mirrors the color model xterm.js feeds its renderer: the ANSI palette slot
 * ([Indexed], 0..255), a direct 24-bit value ([Rgb]) from SGR 38;2/48;2, or
 * the theme default for the slot. "Bright by bold" (`bold` + indexed 0..7 →
 * 8..15, xterm's `drawBoldTextInBrightColors`) is applied at resolve time so
 * the buffer stores exactly what the stream said.
 */
sealed interface TerminalColor {
    /** Theme foreground in the fg slot, theme background in the bg slot. */
    data object Default : TerminalColor

    /** ANSI palette index (0..15 the classic set, 16..255 the 256-color map). */
    data class Indexed(val index: Int) : TerminalColor

    /** 24-bit color as `0xRRGGBB` (alpha-less). */
    data class Rgb(val rgb: Int) : TerminalColor
}

/**
 * Attributes one cell carries. Instances are immutable and shared: the parser
 * holds a single "current" instance and stamps it onto every printed cell, so
 * a screen full of default-styled text references one object.
 *
 * Fields map 1:1 onto the SGR subsets the hub PTY is guaranteed to emit
 * (TERM=xterm-256color, COLORTERM=truecolor — see the web `xtermSurface`
 * notes): bold/faint/italic/underline/strikethrough/blink/inverse/invisible
 * plus fg/bg colors. `inverse` swaps fg/bg at render time (xterm behavior),
 * not at parse time, so SGR 27 cleanly restores.
 */
data class TerminalStyle(
    val foreground: TerminalColor = TerminalColor.Default,
    val background: TerminalColor = TerminalColor.Default,
    val bold: Boolean = false,
    val faint: Boolean = false,
    val italic: Boolean = false,
    val underline: Boolean = false,
    val strikethrough: Boolean = false,
    val blink: Boolean = false,
    val inverse: Boolean = false,
    val invisible: Boolean = false,
)

/**
 * The 256-entry color table xterm.js uses when the web terminal does not
 * override it (the web theme only sets background/foreground/cursor/selection,
 * so these ARE the production colors on web — parity means shipping the same
 * table here).
 *
 * - 0..15: the classic VGA set xterm.js seeds (`DEFAULT_ANSI_COLORS` values).
 * - 16..231: the 6×6×6 color cube over levels 0/95/135/175/215/255.
 * - 232..255: grayscale ramp 8..238.
 */
object TerminalPalette {

    /** Classic 16 colors (`0xRRGGBB`). */
    val BASIC: IntArray = intArrayOf(
        0x000000, 0x800000, 0x008000, 0x808000,
        0x000080, 0x800080, 0x008080, 0xC0C0C0,
        0x808080, 0xFF0000, 0x00FF00, 0xFFFF00,
        0x0000FF, 0xFF00FF, 0x00FFFF, 0xFFFFFF,
    )

    /** Full 256-entry table; index 0..255. */
    val COLORS_256: IntArray = IntArray(256).also { table ->
        BASIC.copyInto(table)
        val levels = intArrayOf(0, 95, 135, 175, 215, 255)
        var i = 16
        for (r in levels) {
            for (g in levels) {
                for (b in levels) {
                    table[i++] = (r shl 16) or (g shl 8) or b
                }
            }
        }
        var gray = 8
        while (i < 256) {
            table[i++] = (gray shl 16) or (gray shl 8) or gray
            gray += 10
        }
    }

    /**
     * Resolve an indexed color for rendering, applying xterm's
     * bold-implies-bright rule (indexed 0..7 + bold → +8). Out-of-range
     * indexes clamp to the table (defensive: SGR params are untrusted).
     */
    fun resolveIndexed(index: Int, bold: Boolean): Int {
        val bright = if (bold && index in 0..7) index + 8 else index
        return COLORS_256[bright.coerceIn(0, 255)]
    }
}
