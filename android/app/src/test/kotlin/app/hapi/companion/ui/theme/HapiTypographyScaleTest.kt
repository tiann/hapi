package app.hapi.companion.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Contract of the app-wide Material type scale: the reading tokens drive
 * their anchored slots, every other slot stays byte-for-byte at the Material
 * platform default, and the monospace code token never reaches a reading slot.
 */
class HapiTypographyScaleTest {

    private val platformDefaults = Typography()

    @Test
    fun `body token drives the large reading slot`() {
        val scale = HapiTypography.scale
        assertEquals(HapiTypography.body.fontSize, scale.bodyLarge.fontSize)
        assertEquals(HapiTypography.body.lineHeight, scale.bodyLarge.lineHeight)
    }

    @Test
    fun `caption token drives the small reading slot`() {
        val scale = HapiTypography.scale
        assertEquals(HapiTypography.caption.fontSize, scale.bodySmall.fontSize)
        assertEquals(HapiTypography.caption.lineHeight, scale.bodySmall.lineHeight)
    }

    @Test
    fun `anchored slots keep Material weight, tracking and family`() {
        val scale = HapiTypography.scale
        assertEquals(platformDefaults.bodyLarge.fontWeight, scale.bodyLarge.fontWeight)
        assertEquals(platformDefaults.bodyLarge.letterSpacing, scale.bodyLarge.letterSpacing)
        assertEquals(platformDefaults.bodyLarge.fontFamily, scale.bodyLarge.fontFamily)
        assertEquals(platformDefaults.bodySmall.fontWeight, scale.bodySmall.fontWeight)
        assertEquals(platformDefaults.bodySmall.letterSpacing, scale.bodySmall.letterSpacing)
        assertEquals(platformDefaults.bodySmall.fontFamily, scale.bodySmall.fontFamily)
    }

    @Test
    fun `slots without a token stay exactly at the platform default`() {
        val scale = HapiTypography.scale
        val untouched: Map<String, Pair<TextStyle, TextStyle>> = mapOf(
            "displayLarge" to (platformDefaults.displayLarge to scale.displayLarge),
            "displayMedium" to (platformDefaults.displayMedium to scale.displayMedium),
            "displaySmall" to (platformDefaults.displaySmall to scale.displaySmall),
            "headlineLarge" to (platformDefaults.headlineLarge to scale.headlineLarge),
            "headlineMedium" to (platformDefaults.headlineMedium to scale.headlineMedium),
            "headlineSmall" to (platformDefaults.headlineSmall to scale.headlineSmall),
            "titleLarge" to (platformDefaults.titleLarge to scale.titleLarge),
            "titleMedium" to (platformDefaults.titleMedium to scale.titleMedium),
            "titleSmall" to (platformDefaults.titleSmall to scale.titleSmall),
            "bodyMedium" to (platformDefaults.bodyMedium to scale.bodyMedium),
            "labelLarge" to (platformDefaults.labelLarge to scale.labelLarge),
            "labelMedium" to (platformDefaults.labelMedium to scale.labelMedium),
            "labelSmall" to (platformDefaults.labelSmall to scale.labelSmall),
        )
        untouched.forEach { (slot, pair) ->
            assertEquals(pair.first, pair.second, "slot $slot drifted from the platform default")
        }
    }

    @Test
    fun `code token stays monospaced and out of the reading slots`() {
        assertEquals(FontFamily.Monospace, HapiTypography.code.fontFamily)
        // Reading slots keep whatever family Material ships with (SansSerif
        // in this version); the monospace family lives only in the code token.
        assertEquals(platformDefaults.bodyLarge.fontFamily, HapiTypography.scale.bodyLarge.fontFamily)
        assertEquals(platformDefaults.bodyMedium.fontFamily, HapiTypography.scale.bodyMedium.fontFamily)
        assertEquals(platformDefaults.bodySmall.fontFamily, HapiTypography.scale.bodySmall.fontFamily)
    }
}
