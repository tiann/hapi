package app.hapi.companion.feature.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import app.hapi.companion.ui.theme.HapiTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/**
 * Device verification of the composer context readout: the indicator stays
 * hidden until measurable usage exists, known vs unknown windows render their
 * distinct labels, and every warning band displays in the light, dark and
 * dynamic theme variants (band COLOR independence and contrast are covered by
 * [ContextUsageColorTest]; dynamic only swaps the M3 scheme).
 */
class ContextUsageChipTest {
    @get:Rule val compose = createComposeRule()

    private enum class ThemeKind(val dark: Boolean, val dynamic: Boolean) {
        LIGHT(dark = false, dynamic = false),
        DARK(dark = true, dynamic = false),
        DYNAMIC(dark = false, dynamic = true),
    }

    private fun knownWindowNormal() = ContextUsage.indicator(90_000.0, 190_000.0)
    private fun knownWindowElevated() = ContextUsage.indicator(140_000.0, 190_000.0)
    private fun knownWindowCritical() = ContextUsage.indicator(180_000.0, 190_000.0)
    private fun unknownWindow() = ContextUsage.indicator(90_000.0, null)

    @Test fun windowsAndBandsRenderAcrossLightDarkAndDynamicThemes() {
        val theme = mutableStateOf(ThemeKind.LIGHT)
        compose.setContent {
            val kind = theme.value
            HapiTheme(darkTheme = kind.dark, dynamicColor = kind.dynamic) {
                Column {
                    ContextUsageChip(indicator = knownWindowNormal())
                    ContextUsageChip(indicator = knownWindowElevated())
                    ContextUsageChip(indicator = knownWindowCritical())
                    ContextUsageChip(indicator = unknownWindow())
                    // No measurable usage yet: renders nothing at all.
                    ContextUsageChip(indicator = null)
                }
            }
        }
        for (kind in ThemeKind.entries) {
            compose.runOnIdle { theme.value = kind }
            compose.waitForIdle()
            compose.onNodeWithText("ctx 190k · 53% left").assertExists("${kind.name} normal band")
            compose.onNodeWithText("ctx 190k · 26% left").assertExists("${kind.name} elevated band")
            compose.onNodeWithText("ctx 190k · 5% left").assertExists("${kind.name} critical band")
            // Unknown window: size-only readout, no percentage share.
            compose.onNodeWithText("ctx 90k").assertExists("${kind.name} unknown window")
            // Exactly the four measured chips render; the null indicator
            // contributes no node.
            val measured = compose.onAllNodesWithText("ctx", substring = true)
                .fetchSemanticsNodes()
            assertEquals(4, measured.size)
        }
    }
}
