package app.hapi.companion.feature.settings

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import app.hapi.companion.ui.theme.ColorThemePreset
import app.hapi.companion.ui.theme.preview
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Contract of the choice dialog's preview chips. The swatches are fixed
 * values that depict the mode they name (never derived from the active
 * scheme), so the tests pin the properties that make the chips readable:
 * one distinct look per mode, follow-system reading as a light/dark split,
 * and outlines exactly where a chip would otherwise vanish against a
 * same-colored dialog surface.
 */
class ChoiceDialogTest {

    @Test
    fun `every theme mode maps to a distinct swatch`() {
        val swatches = ThemeMode.entries.map(::themeModeSwatch)

        assertEquals(ThemeMode.entries.size, swatches.toSet().size)
    }

    @Test
    fun `follow-system swatch reads as a light and dark split`() {
        val swatch = themeModeSwatch(ThemeMode.SYSTEM)

        assertTrue(swatch.startColor.luminance() > 0.5f, "left half must be the light palette")
        assertTrue(swatch.endColor.luminance() < 0.5f, "right half must be the dark palette")
    }

    @Test
    fun `oled swatch is outlined pure black`() {
        val swatch = themeModeSwatch(ThemeMode.OLED)

        assertEquals(Color(0xFF000000), swatch.startColor)
        assertEquals(Color(0xFF000000), swatch.endColor)
        assertTrue(swatch.outline, "pure black needs a hairline to stay visible on dark dialogs")
    }

    @Test
    fun `light swatch is outlined so it survives light dialogs`() {
        val swatch = themeModeSwatch(ThemeMode.LIGHT)

        assertTrue(swatch.startColor.luminance() > 0.5f)
        assertTrue(swatch.outline, "a white chip needs a hairline to stay visible on light dialogs")
    }

    @Test
    fun `dark swatch is not black so dark stays distinguishable from oled`() {
        val dark = themeModeSwatch(ThemeMode.DARK)
        val oled = themeModeSwatch(ThemeMode.OLED)

        assertTrue(dark.startColor.luminance() > oled.startColor.luminance())
        assertEquals(dark.startColor, dark.endColor)
    }

    @Test
    fun `swatch is opt-in on choice options`() {
        val option = ChoiceOption(value = AppLanguage.ENGLISH, label = "English")

        assertNull(option.swatch)
        assertEquals(AppLanguage.ENGLISH, option.value)
    }

    @Test
    fun `every color theme preset carries an accent strip`() {
        ColorThemePreset.entries.forEach { preset ->
            val swatch = colorThemePresetSwatch(preset)
            assertNotNull(swatch.accentColor, "${preset.name} card must show its accent")
        }
    }

    @Test
    fun `preset swatches outline halves that would vanish against the dialog`() {
        // Every preset's canvases are near-white and near-black by design, so
        // each card carries the hairline — the web cards are all bordered too.
        ColorThemePreset.entries.forEach { preset ->
            assertTrue(colorThemePresetSwatch(preset).outline, preset.name)
        }
    }

    @Test
    fun `preset swatch halves are the preset's own canvases`() {
        val nord = colorThemePresetSwatch(ColorThemePreset.NORD)

        assertEquals(ColorThemePreset.NORD.preview().light, nord.startColor)
        assertEquals(ColorThemePreset.NORD.preview().dark, nord.endColor)
        assertEquals(ColorThemePreset.NORD.preview().accent, nord.accentColor)
    }
}
