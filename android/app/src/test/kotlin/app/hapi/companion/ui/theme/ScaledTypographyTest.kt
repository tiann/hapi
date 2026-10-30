package app.hapi.companion.ui.theme

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.isUnspecified
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Pure JVM tests for the P2 font-scale tier math: factor 1 is the stock
 * [HapiTypography], factors scale size + line height only (family/weight pass
 * through), sp typing survives, and unspecified units stay unspecified.
 */
class ScaledTypographyTest {

    private fun assertSp(expected: Float, actual: TextUnit, what: String) {
        assertTrue(actual.isSp, "$what must stay sp-typed (was ${actual.type})")
        assertTrue(
            abs(expected - actual.value) < 0.001f,
            "$what expected ~$expected sp, was ${actual.value}",
        )
    }

    @Test
    fun `factor 1 reproduces the stock typography exactly`() {
        val styles = HapiTypeScale.stylesFor(1f)
        assertEquals(HapiTypography.body, styles.body)
        assertEquals(HapiTypography.code, styles.code)
        assertEquals(HapiTypography.caption, styles.caption)
    }

    @Test
    fun `stock tiers are the documented sizes`() {
        // Pins the base the factors multiply: 16/24 body, 14/20 code, 12/16 caption.
        assertSp(16f, HapiTypography.body.fontSize, "body size")
        assertSp(24f, HapiTypography.body.lineHeight, "body leading")
        assertSp(14f, HapiTypography.code.fontSize, "code size")
        assertSp(20f, HapiTypography.code.lineHeight, "code leading")
        assertSp(12f, HapiTypography.caption.fontSize, "caption size")
        assertSp(16f, HapiTypography.caption.lineHeight, "caption leading")
    }

    @Test
    fun `factor 1_3 scales every tier size and line height`() {
        val styles = HapiTypeScale.stylesFor(1.3f)
        assertSp(20.8f, styles.body.fontSize, "body size at 130%")
        assertSp(31.2f, styles.body.lineHeight, "body leading at 130%")
        assertSp(18.2f, styles.code.fontSize, "code size at 130%")
        assertSp(26.0f, styles.code.lineHeight, "code leading at 130%")
        assertSp(15.6f, styles.caption.fontSize, "caption size at 130%")
        assertSp(20.8f, styles.caption.lineHeight, "caption leading at 130%")
    }

    @Test
    fun `factor 0_8 downscales without collapsing the ratios`() {
        val styles = HapiTypeScale.stylesFor(0.8f)
        assertSp(12.8f, styles.body.fontSize, "body size at 80%")
        assertSp(19.2f, styles.body.lineHeight, "body leading at 80%")
        assertSp(11.2f, styles.code.fontSize, "code size at 80%")
        assertSp(16.0f, styles.code.lineHeight, "code leading at 80%")
    }

    @Test
    fun `font family and other attributes pass through untouched`() {
        val styles = HapiTypeScale.stylesFor(1.2f)
        assertEquals(HapiTypography.code.fontFamily, styles.code.fontFamily)
        assertEquals(HapiTypography.body.fontFamily, styles.body.fontFamily)
        assertEquals(HapiTypography.body.fontWeight, styles.body.fontWeight)
        assertEquals(HapiTypography.code.letterSpacing, styles.code.letterSpacing)
    }

    @Test
    fun `unspecified units stay unspecified instead of scaling to zero`() {
        val bare = TextStyle()
        val scaled = HapiTypeScale.scaled(bare, 1.5f)
        assertTrue(scaled.fontSize.isUnspecified, "absent size must stay unspecified")
        assertTrue(scaled.lineHeight.isUnspecified, "absent leading must stay unspecified")
    }

    @Test
    fun `every preference factor maps to whole scaled styles`() {
        // The six Display tiers all produce styles; exactness of each factor's
        // arithmetic is covered above for the extremes.
        val factors = listOf(0.8f, 0.9f, 1.0f, 1.1f, 1.2f, 1.3f)
        factors.forEach { factor ->
            val styles = HapiTypeScale.stylesFor(factor)
            assertSp(16f * factor, styles.body.fontSize, "body size at $factor")
            assertSp(14f * factor, styles.code.fontSize, "code size at $factor")
            assertSp(12f * factor, styles.caption.fontSize, "caption size at $factor")
        }
    }
}
