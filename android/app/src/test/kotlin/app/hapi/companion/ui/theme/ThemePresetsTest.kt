package app.hapi.companion.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Color theme preset derivation, pinned to the web client's math
 * (`web/src/hooks/useColorTheme.ts`): seed transcription, the deterministic
 * palette formulas (including JS-style tie rounding), the Material role
 * bridge, and the extended-color overlay. Expected hexes were computed by
 * replaying the web formulas over the shipped seeds.
 */
class ThemePresetsTest {

    @Test
    fun `storage keys parse and unknown values degrade to default`() {
        ColorThemePreset.entries.forEach { preset ->
            assertEquals(preset, ColorThemePreset.fromStorageKey(preset.storageKey), preset.name)
        }
        assertEquals(ColorThemePreset.DEFAULT, ColorThemePreset.fromStorageKey("default"))
        assertEquals(ColorThemePreset.DEFAULT, ColorThemePreset.fromStorageKey(null))
        assertEquals(ColorThemePreset.DEFAULT, ColorThemePreset.fromStorageKey("windows-95"))
    }

    @Test
    fun `every named preset carries both seed sets and default carries none`() {
        val named = ColorThemePreset.entries.filter { it != ColorThemePreset.DEFAULT }.toSet()
        assertEquals(named, themePresetSeeds.keys)
    }

    @Test
    fun `notion light palette matches the web derivation`() {
        val palette = ColorThemePreset.NOTION.palette(dark = false)

        assertEquals(false, palette.isDark)
        assertEquals(Color(0xFF3183D8), palette.accent)
        assertEquals(Color(0xFFFAFAFA), palette.background)
        assertEquals(Color(0xFF37352F), palette.foreground)
        assertEquals(Color(0xFFF1F1EF), palette.secondary)
        // Elevation mixes shade toward black on light palettes.
        assertEquals(Color(0xFFF6F6F6), palette.dialog)
        assertEquals(Color(0xFFF1F1F1), palette.surface)
        assertEquals(Color(0xFFEAEAEA), palette.surfaceHover)
        assertEquals(Color(0xFFEFEFEF), palette.code)
        // Light hairlines are slate ink, not pure black.
        assertEquals(Color(0xFF0F172A).copy(alpha = 0.10f), palette.border)
        assertEquals(Color(0xFF0F172A).copy(alpha = 0.045f), palette.subtle)
        // Notion's accent is dark enough that button text stays white.
        assertEquals(Color(0xFFFFFFFF), palette.buttonText)
    }

    @Test
    fun `notion dark palette matches the web derivation including tie rounding`() {
        val palette = ColorThemePreset.NOTION.palette(dark = true)

        assertEquals(true, palette.isDark)
        // #191919 lifted 5% toward white lands every channel on an exact .5
        // tie; the web client's Math.round resolves ties upward (#252525),
        // so the twin must too — not banker's rounding (#242424).
        assertEquals(Color(0xFF252525), palette.dialog)
        assertEquals(Color(0xFF2E2E2E), palette.surface)
        assertEquals(Color(0xFF393939), palette.surfaceHover)
        assertEquals(Color(0xFF323232), palette.code)
        assertEquals(Color(0xFFFFFFFF).copy(alpha = 0.11f), palette.border)
        assertEquals(Color(0xFFFFFFFF).copy(alpha = 0.06f), palette.subtle)
        assertEquals(Color(0xFFFFFFFF), palette.buttonText)
    }

    @Test
    fun `bright accents switch button text to ink`() {
        // Material's dark accent #D0BCFF, Nord's #88C0D0 (luminance 0.475,
        // just over the 0.45 threshold), and Matrix's #00FF66 all read as
        // light enough for ink text; each preset's light accent stays white-text.
        assertEquals(Color(0xFF111827), ColorThemePreset.MATERIAL.palette(dark = true).buttonText)
        assertEquals(Color(0xFF111827), ColorThemePreset.NORD.palette(dark = true).buttonText)
        assertEquals(Color(0xFF111827), ColorThemePreset.MATRIX.palette(dark = true).buttonText)
        assertEquals(Color(0xFFFFFFFF), ColorThemePreset.MATERIAL.palette(dark = false).buttonText)
    }

    @Test
    fun `palette darkness follows the background luminance not the scheme flag`() {
        // A hypothetical seed set whose "dark" slot carries a bright canvas
        // must derive with light-palette directions — that is how the web
        // client picks its mix direction, so a misfiled future preset cannot
        // produce inverted elevation steps.
        val brightDarkSlot = ThemePresetSeeds(
            accent = Color(0xFF3183D8),
            background = Color(0xFFFAFAFA),
            foreground = Color(0xFF37352F),
            hint = Color(0xFF787774),
            secondary = Color(0xFFF1F1EF),
        )
        val inverted = ThemePresetSeedPair(
            light = ThemePresetSeeds(Color(0xFF3183D8), Color(0xFF191919), Color(0xFFD9D9D8), Color(0xFF9B9A97), Color(0xFF252525)),
            dark = brightDarkSlot,
        )

        assertEquals(false, inverted.palette(dark = true).isDark)
        assertEquals(true, inverted.palette(dark = false).isDark)
    }

    @Test
    fun `material roles paint from the nord dark palette`() {
        val palette = ColorThemePreset.NORD.palette(dark = true)
        val scheme = palette.colorScheme()

        assertEquals(Color(0xFF88C0D0), scheme.primary)
        assertEquals(Color(0xFF111827), scheme.onPrimary)
        assertEquals(Color(0xFF2E3440), scheme.background)
        assertEquals(Color(0xFF2E3440), scheme.surface)
        assertEquals(Color(0xFFECEFF4), scheme.onSurface)
        assertEquals(Color(0xFFD8DEE9), scheme.onSurfaceVariant)
        assertEquals(Color(0xFF3B4252), scheme.secondaryContainer)
        assertEquals(Color(0xFFECEFF4), scheme.onSecondaryContainer)
        // The container ladder walks the web elevation steps.
        assertEquals(palette.dialog, scheme.surfaceContainerLow)
        assertEquals(palette.surface, scheme.surfaceContainer)
        assertEquals(palette.surfaceHover, scheme.surfaceContainerHigh)
        assertEquals(Color(0xFF565B64), scheme.surfaceContainerHighest)
        assertEquals(palette.border, scheme.outlineVariant)
        assertEquals(palette.hint, scheme.outline)
        assertEquals(palette.foreground, scheme.inverseSurface)
    }

    @Test
    fun `container ladder continues one step past the hover tone`() {
        // Notion light: #FAFAFA shaded 19% toward black rounds the R/G/B tie
        // upward to #CBCBCB, keeping "highest" above the hover step.
        val scheme = ColorThemePreset.NOTION.palette(dark = false).colorScheme()

        assertEquals(Color(0xFFCBCBCB), scheme.surfaceContainerHighest)
    }

    @Test
    fun `extended colors overlay preset tokens and inherit diff tokens from the base`() {
        val palette = ColorThemePreset.NORD.palette(dark = true)
        val extended = palette.extendedColors(HapiDarkExtendedColors)

        assertEquals(palette.code, extended.codeBackground)
        assertEquals(palette.surfaceHover, extended.codeHeaderBackground)
        assertEquals(palette.hint, extended.codeHeaderForeground)
        assertEquals(palette.code, extended.inlineCodeBackground)
        assertEquals(palette.foreground, extended.inlineCodeForeground)
        assertEquals(palette.surface, extended.blockquoteBackground)
        assertEquals(palette.accent.copy(alpha = 0.35f), extended.blockquoteBar)
        assertEquals(palette.surface, extended.tableBackground)
        assertEquals(palette.surfaceHover, extended.tableHeaderBackground)
        assertEquals(palette.border, extended.divider)
        assertEquals(palette.accent, extended.link)
        assertEquals(palette.hint, extended.hint)
        // Diff surfaces and the syntax-theme flag are not preset-tinted on
        // the web client either — they always inherit from the base set.
        assertEquals(HapiDarkExtendedColors.diffAddBackground, extended.diffAddBackground)
        assertEquals(HapiDarkExtendedColors.diffRemoveBackground, extended.diffRemoveBackground)
        assertEquals(HapiDarkExtendedColors.diffHunkBackground, extended.diffHunkBackground)
        assertEquals(HapiDarkExtendedColors.isDark, extended.isDark)
    }

    @Test
    fun `default preset refuses a palette lookup`() {
        assertFailsWith<IllegalStateException> {
            ColorThemePreset.DEFAULT.palette(dark = false)
        }
    }

    @Test
    fun `preview triples are the web card colors including deliberate accent divergences`() {
        // The web option table pins a few accents that differ from the seed
        // values so every card reads well; the twin transcribes them as-is.
        assertEquals(Color(0xFF111827), ColorThemePreset.DEFAULT.preview().accent)
        assertEquals(Color(0xFFFF5555), ColorThemePreset.RAYCAST.preview().accent)
        assertEquals(Color(0xFFFF5B6E), ColorThemePreset.LOBSTER.preview().accent)
        assertEquals(Color(0xFF526FFF), ColorThemePreset.ONE.preview().accent)
        ColorThemePreset.entries.forEach { preset ->
            val preview = preset.preview()
            assertTrue(preview.light.luminance() > 0.5f, "${preset.name} light half must be light")
            assertTrue(preview.dark.luminance() < 0.5f, "${preset.name} dark half must be dark")
        }
    }
}
