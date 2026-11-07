package app.hapi.companion.feature.chat

import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import app.hapi.companion.feature.settings.ChatSettings
import app.hapi.companion.feature.settings.ChatSurfaceColor
import kotlin.math.roundToInt

/**
 * Chat settings as presentation state (P2 Chat subpage, LocalHapiTypeStyles
 * pattern): [LocalChatSettings] carries the persisted preferences and
 * [LocalChatSurfaceColors] the already-mixed surface colors, both provided by
 * `MainActivity` inside the theme so every consumer — the composer, the
 * reasoning and tool-card blocks, the user bubble — reads one snapshot
 * without parameter threading through the transcript tree. Defaults render
 * the pre-settings behavior, so previews and tests need no setup.
 */
val LocalChatSettings = staticCompositionLocalOf { ChatSettings() }

/**
 * Resolved chat surface colors; `null` means "keep the theme default" for
 * that surface (the web twin removes its CSS variable instead).
 */
data class ChatSurfaceColors(
    val toolGroup: Color?,
    val userMessage: Color?,
)

/**
 * Pure preset→surface mixing, JVM-testable (web `useChatSurfaceColors.ts`).
 * The web mixes a preset accent into fixed per-theme neutral bases
 * (`#f2f4f6` light / `#2b2f34` dark / oled `#0e0e10`·`#141414`) at ratio 0.3
 * light / 0.2 dark; Android mixes the same accents and ratios into the live
 * themed neutral (`surfaceContainerLow`) so dynamic-color schemes keep
 * working. Free custom hexes are web-only (fixed preset enum on Android).
 */
object ChatSurfaces {

    /** Web `PRESET_ACCENTS`: soft-blue `#7db7ff`. */
    val SOFT_BLUE_ACCENT: Color = Color(0xFF7DB7FF)

    /** Web `PRESET_ACCENTS`: soft-green `#8fd19e`. */
    val SOFT_GREEN_ACCENT: Color = Color(0xFF8FD19E)

    /** Web `PRESET_ACCENTS`: soft-yellow `#f0d77a`. */
    val SOFT_YELLOW_ACCENT: Color = Color(0xFFF0D77A)

    /** Web preset mix ratio for light bases. */
    const val LIGHT_RATIO: Float = 0.3f

    /** Web preset mix ratio for dark bases. */
    const val DARK_RATIO: Float = 0.2f

    /**
     * Mixes [preference] onto [base]; null for the default preference (caller
     * keeps its theme color), otherwise the web `mixHex` twin: per-channel sRGB
     * mixing at the web's preset ratio, each channel rounded to its 8-bit step.
     * (Deliberately NOT `androidx.compose.ui.graphics.lerp` — that interpolates
     * in OkLab and lands on visibly different colors than the web.)
     */
    fun resolve(preference: ChatSurfaceColor, base: Color, isDark: Boolean): Color? {
        val accent = when (preference) {
            ChatSurfaceColor.DEFAULT -> return null
            ChatSurfaceColor.SOFT_BLUE -> SOFT_BLUE_ACCENT
            ChatSurfaceColor.SOFT_GREEN -> SOFT_GREEN_ACCENT
            ChatSurfaceColor.SOFT_YELLOW -> SOFT_YELLOW_ACCENT
        }
        val ratio = if (isDark) DARK_RATIO else LIGHT_RATIO
        return Color(
            red = mixChannel(base.red, accent.red, ratio),
            green = mixChannel(base.green, accent.green, ratio),
            blue = mixChannel(base.blue, accent.blue, ratio),
        )
    }

    /** Web `mixHex` per channel: `round(base + (accent - base) * ratio)` in 0..255. */
    private fun mixChannel(base: Float, accent: Float, ratio: Float): Int =
        ((base + (accent - base) * ratio) * 255f).roundToInt().coerceIn(0, 255)

    /** Both surfaces for [settings] over one [base] (same web neutral per theme). */
    fun resolveAll(settings: ChatSettings, base: Color, isDark: Boolean): ChatSurfaceColors =
        ChatSurfaceColors(
            toolGroup = resolve(settings.toolGroupBackground, base, isDark),
            userMessage = resolve(settings.userMessageBackground, base, isDark),
        )
}

/** Current surface colors; default keeps every theme surface untouched. */
val LocalChatSurfaceColors = staticCompositionLocalOf { ChatSurfaceColors(toolGroup = null, userMessage = null) }
