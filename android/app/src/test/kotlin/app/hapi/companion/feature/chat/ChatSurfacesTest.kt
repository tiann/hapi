package app.hapi.companion.feature.chat

import androidx.compose.ui.graphics.Color
import app.hapi.companion.feature.settings.ChatSettings
import app.hapi.companion.feature.settings.ChatSurfaceColor
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Pure JVM tests for the P2 chat surface-color mixing (web
 * `useChatSurfaceColors.ts` port): DEFAULT stays unset, preset accents match
 * the web hexes, and the lerp matches the web's hand-checkable mix points —
 * soft-blue over the web light neutral `#f2f4f6` at ratio 0.3 and over the web
 * dark neutral `#2b2f34` at ratio 0.2. Expected channels are the exact web
 * `mixHex` outputs: `round(base·(1-ratio) + accent·ratio)` per 8-bit channel.
 */
class ChatSurfacesTest {

    private fun assertChannel(expected: Float, actual: Float, what: String) {
        assertTrue(
            abs(expected - actual) < 1e-6f,
            "$what expected ~$expected, was $actual",
        )
    }

    private fun assertColor(expected: Triple<Float, Float, Float>, actual: Color, what: String) {
        assertChannel(expected.first, actual.red, "$what red")
        assertChannel(expected.second, actual.green, "$what green")
        assertChannel(expected.third, actual.blue, "$what blue")
    }

    @Test
    fun `default preference resolves to null so callers keep theme colors`() {
        val base = Color(0xFFABCDEF)
        assertNull(ChatSurfaces.resolve(ChatSurfaceColor.DEFAULT, base, isDark = false))
        assertNull(ChatSurfaces.resolve(ChatSurfaceColor.DEFAULT, base, isDark = true))
    }

    @Test
    fun `preset accents carry the web hex values`() {
        assertColor(Triple(125 / 255f, 183 / 255f, 255 / 255f), ChatSurfaces.SOFT_BLUE_ACCENT, "soft-blue")
        assertColor(Triple(143 / 255f, 209 / 255f, 158 / 255f), ChatSurfaces.SOFT_GREEN_ACCENT, "soft-green")
        assertColor(Triple(240 / 255f, 215 / 255f, 122 / 255f), ChatSurfaces.SOFT_YELLOW_ACCENT, "soft-yellow")
    }

    @Test
    fun `soft blue mixes the web light neutral at the 0_3 ratio`() {
        // Web light base #f2f4f6 (242, 244, 246), accent #7db7ff, ratio 0.3:
        // round(242·0.7+125·0.3)=207, round(244·0.7+183·0.3)=226,
        // round(246·0.7+255·0.3)=249 — the exact values the web `mixHex`
        // produces. (compose's OkLab lerp would land elsewhere.)
        val base = Color(0xFFF2F4F6)
        val mixed = assertNotNull(ChatSurfaces.resolve(ChatSurfaceColor.SOFT_BLUE, base, isDark = false))
        assertColor(Triple(207 / 255f, 226 / 255f, 249 / 255f), mixed, "light soft-blue")
    }

    @Test
    fun `soft blue mixes the web dark neutral at the 0_2 ratio`() {
        // Web dark base #2b2f34 (43, 47, 52), accent #7db7ff, ratio 0.2:
        // round(43·0.8+125·0.2)=59, round(47·0.8+183·0.2)=74,
        // round(52·0.8+255·0.2)=93 — the exact web `mixHex` outputs.
        val base = Color(0xFF2B2F34)
        val mixed = assertNotNull(ChatSurfaces.resolve(ChatSurfaceColor.SOFT_BLUE, base, isDark = true))
        assertColor(Triple(59 / 255f, 74 / 255f, 93 / 255f), mixed, "dark soft-blue")
    }

    @Test
    fun `every preset lands between the base and its accent per channel`() {
        // A fraction strictly inside (0,1) puts each channel between the base
        // and the accent regardless of direction — light presets can darken a
        // channel (soft-yellow green 215 < light base green 244), so "must
        // rise" would be wrong; "must move toward the accent" is the property.
        val lightBase = Color(0xFFF2F4F6)
        val darkBase = Color(0xFF2B2F34)
        listOf(
            ChatSurfaceColor.SOFT_BLUE to ChatSurfaces.SOFT_BLUE_ACCENT,
            ChatSurfaceColor.SOFT_GREEN to ChatSurfaces.SOFT_GREEN_ACCENT,
            ChatSurfaceColor.SOFT_YELLOW to ChatSurfaces.SOFT_YELLOW_ACCENT,
        ).forEach { (preference, accent) ->
            ChatSurfaces.resolve(preference, lightBase, isDark = false)?.let { mixed ->
                assertBetween(lightBase, accent, mixed, "$preference light")
            }
            ChatSurfaces.resolve(preference, darkBase, isDark = true)?.let { mixed ->
                assertBetween(darkBase, accent, mixed, "$preference dark")
            }
        }
    }

    private fun assertBetween(base: Color, accent: Color, mixed: Color, what: String) {
        listOf(
            Triple(base.red, accent.red, mixed.red) to "red",
            Triple(base.green, accent.green, mixed.green) to "green",
            Triple(base.blue, accent.blue, mixed.blue) to "blue",
        ).forEach { (ends, channel) ->
            val lo = minOf(ends.first, ends.second)
            val hi = maxOf(ends.first, ends.second)
            assertTrue(
                ends.third >= lo - 1e-6f && ends.third <= hi + 1e-6f,
                "$what $channel ${ends.third} escaped [$lo, $hi]",
            )
        }
        assertTrue(mixed != base, "$what must differ from the base")
    }

    @Test
    fun `resolveAll keeps the two surfaces independent`() {
        val base = Color(0xFFF2F4F6)
        val colors = ChatSurfaces.resolveAll(
            ChatSettings(
                toolGroupBackground = ChatSurfaceColor.DEFAULT,
                userMessageBackground = ChatSurfaceColor.SOFT_GREEN,
            ),
            base,
            isDark = false,
        )
        assertNull(colors.toolGroup)
        assertNotNull(colors.userMessage)

        val both = ChatSurfaces.resolveAll(
            ChatSettings(
                toolGroupBackground = ChatSurfaceColor.SOFT_YELLOW,
                userMessageBackground = ChatSurfaceColor.SOFT_BLUE,
            ),
            base,
            isDark = false,
        )
        assertNotNull(both.toolGroup)
        assertNotNull(both.userMessage)
        // Different accents over the same base must land on different colors.
        assertTrue(both.toolGroup != both.userMessage)
    }
}
