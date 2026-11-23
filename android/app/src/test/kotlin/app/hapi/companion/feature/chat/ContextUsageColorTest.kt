package app.hapi.companion.feature.chat

import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import app.hapi.companion.ui.theme.HapiDarkExtendedColors
import app.hapi.companion.ui.theme.HapiLightExtendedColors
import app.hapi.companion.ui.theme.HapiOledExtendedColors
import kotlin.math.max
import kotlin.math.min
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * Band-color contract of the context indicator: the elevated band is the
 * semantic warning amber, independent of Material tertiary (which the static
 * themes define as teal and dynamic color derives from the wallpaper), and
 * the amber keeps WCAG-AA text contrast in every theme variant.
 */
class ContextUsageColorTest {

    /** The static themes' teal tertiary — what ELEVATED must not resolve to. */
    private val tealTertiary = Color(0xFF386569)
    private val tealTertiaryDark = Color(0xFFA0CFD2)

    @Test fun elevatedUsesTheWarningAmberNotTheSchemeTertiary() {
        for ((hapi, scheme) in listOf(
            HapiLightExtendedColors to lightColorScheme(),
            HapiDarkExtendedColors to darkColorScheme(),
            HapiOledExtendedColors to darkColorScheme(),
        )) {
            val color = contextUsageColor(ContextUsageWarning.ELEVATED, hapi, scheme)
            assertEquals(hapi.warning, color)
            assertNotEquals(scheme.tertiary, color)
        }
    }

    @Test fun elevatedStaysAmberUnderWallpaperDerivedTertiaries() {
        // Dynamic color swaps tertiary per wallpaper (teal, or anything else);
        // the band color must not follow it.
        val dynamicLike = lightColorScheme(tertiary = tealTertiary)
        assertEquals(
            HapiLightExtendedColors.warning,
            contextUsageColor(ContextUsageWarning.ELEVATED, HapiLightExtendedColors, dynamicLike),
        )
        assertNotEquals(
            tealTertiary,
            contextUsageColor(ContextUsageWarning.ELEVATED, HapiLightExtendedColors, dynamicLike),
        )
        val dynamicLikeDark = darkColorScheme(tertiary = tealTertiaryDark)
        assertEquals(
            HapiDarkExtendedColors.warning,
            contextUsageColor(ContextUsageWarning.ELEVATED, HapiDarkExtendedColors, dynamicLikeDark),
        )
    }

    @Test fun warningAmberKeepsAAContrastInEveryThemeVariant() {
        // The chip renders small label text directly on the themed surface.
        assertTrue(contrast(HapiLightExtendedColors.warning, lightColorScheme().surface) >= 4.5)
        assertTrue(contrast(HapiDarkExtendedColors.warning, darkColorScheme().surface) >= 4.5)
        // OLED canvas is pure black.
        assertTrue(contrast(HapiOledExtendedColors.warning, Color(0xFF000000)) >= 4.5)
    }

    @Test fun neutralAndCriticalKeepTheirSchemeRoles() {
        val hapi = HapiLightExtendedColors
        val scheme = lightColorScheme()
        assertEquals(scheme.onSurfaceVariant, contextUsageColor(ContextUsageWarning.NORMAL, hapi, scheme))
        assertEquals(scheme.error, contextUsageColor(ContextUsageWarning.CRITICAL, hapi, scheme))
    }

    // -------------------------------------------------- WCAG contrast math --

    private fun linear(channel: Float): Double {
        val c = channel.toDouble()
        return if (c <= 0.03928) c / 12.92 else Math.pow((c + 0.055) / 1.055, 2.4)
    }

    private fun luminance(color: Color): Double =
        0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue)

    private fun contrast(a: Color, b: Color): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }
}
