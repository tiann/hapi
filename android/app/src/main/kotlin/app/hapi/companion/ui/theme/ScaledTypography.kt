package app.hapi.companion.ui.theme

import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.isUnspecified

/**
 * The three [HapiTypography] tiers with the in-app font-scale factor applied
 * (P2 Display settings, web `--app-font-scale` twin). Call sites that scaled
 * with the platform only (`HapiTypography.body`) read [LocalHapiTypeStyles]
 * instead, so a persisted factor resizes chat text while Material chrome
 * stays at platform scale; the factor composes with (not replaces) the
 * system sp scaling, including Android 14's nonlinear curve.
 */
data class HapiTypeStyles(
    val body: TextStyle,
    val code: TextStyle,
    val caption: TextStyle,
)

/** Pure scaling helpers — JVM-testable, no composition dependency. */
object HapiTypeScale {

    /**
     * Scales one tier's size and line height by [factor]; font family, weight,
     * and spacing pass through untouched. Unspecified units (line height is
     * optional on arbitrary styles) stay unspecified rather than collapsing
     * to a scaled zero.
     */
    fun scaled(style: TextStyle, factor: Float): TextStyle = style.copy(
        fontSize = if (style.fontSize.isUnspecified) style.fontSize else style.fontSize * factor,
        lineHeight = if (style.lineHeight.isUnspecified) style.lineHeight else style.lineHeight * factor,
    )

    /** All three tiers scaled by [factor] (1f = the stock [HapiTypography] values). */
    fun stylesFor(factor: Float): HapiTypeStyles = HapiTypeStyles(
        body = scaled(HapiTypography.body, factor),
        code = scaled(HapiTypography.code, factor),
        caption = scaled(HapiTypography.caption, factor),
    )
}

/**
 * Scaled tiers for the current display settings; `MainActivity` provides the
 * persisted factor (LocalHapiExtendedColors is the same pattern). Default =
 * unscaled, so previews and tests render stock sizes without setup.
 */
val LocalHapiTypeStyles = staticCompositionLocalOf { HapiTypeScale.stylesFor(1f) }
