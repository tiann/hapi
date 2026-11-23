package app.hapi.companion.ui.theme

import androidx.compose.ui.graphics.Color
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * The [HapiTheme] resolution order — `preset > oled > dynamic color > static
 * light/dark`, with a preset under OLED resolving to its dark seeds — pinned
 * by an exhaustive matrix over the settings booleans. This is the Android
 * twin of the web client's layering (`data-color-theme` over `data-theme`;
 * see `useColorTheme.test.ts` "uses dark palette contrast values for OLED").
 * The order resolves through [resolveThemeSchemeSource] precisely so it can
 * be exercised on the JVM: reordering those branches (a stack-conflict
 * surgery hazard) or dropping the `|| oled` seed fallback must turn this
 * suite red.
 */
class ThemeResolutionOrderTest {

    @Test
    fun `a named preset wins over oled, dynamic color, and the static schemes`() {
        // All 16 named presets x every darkTheme/oled/dynamicColor/sdk
        // combination (256 cases): the preset always takes the scheme.
        val named = ColorThemePreset.entries.filter { it != ColorThemePreset.DEFAULT }
        for (preset in named) {
            for (darkTheme in listOf(false, true)) {
                for (oled in listOf(false, true)) {
                    for (dynamicColor in listOf(false, true)) {
                        for (supportsDynamic in listOf(false, true)) {
                            val label = "${preset.name} dark=$darkTheme oled=$oled " +
                                "dyn=$dynamicColor sdk=$supportsDynamic"
                            val source = resolveThemeSchemeSource(
                                preset = preset,
                                darkTheme = darkTheme,
                                dynamicColor = dynamicColor,
                                oled = oled,
                                supportsDynamic = supportsDynamic,
                            )
                            val resolved = assertIs<ThemeSchemeSource.Preset>(source, label)
                            assertEquals(preset.palette(dark = darkTheme || oled), resolved.palette, label)
                        }
                    }
                }
            }
        }
    }

    @Test
    fun `oled with a light system theme still renders the preset's dark seeds`() {
        // If the resolver ever passes `darkTheme` alone (dropping `|| oled`),
        // Nord would paint its light canvas here and these concrete pins go
        // red — the equality loop above alone would not show *why*.
        val source = resolveThemeSchemeSource(
            preset = ColorThemePreset.NORD,
            darkTheme = false,
            dynamicColor = true,
            oled = true,
            supportsDynamic = true,
        )
        val palette = assertIs<ThemeSchemeSource.Preset>(source).palette
        assertTrue(palette.isDark)
        assertEquals(Color(0xFF2E3440), palette.background)
        assertEquals(Color(0xFF88C0D0), palette.accent)
    }

    @Test
    fun `default with oled paints pure black ahead of dynamic color`() {
        // OLED never combines with Material You — surfaces would defeat the
        // pure-black canvas — regardless of the dark/dynamic flags.
        for (darkTheme in listOf(false, true)) {
            for (dynamicColor in listOf(false, true)) {
                for (supportsDynamic in listOf(false, true)) {
                    val label = "dark=$darkTheme dyn=$dynamicColor sdk=$supportsDynamic"
                    val source = resolveThemeSchemeSource(
                        preset = ColorThemePreset.DEFAULT,
                        darkTheme = darkTheme,
                        dynamicColor = dynamicColor,
                        oled = true,
                        supportsDynamic = supportsDynamic,
                    )
                    assertEquals(ThemeSchemeSource.Oled, source, label)
                }
            }
        }
    }

    @Test
    fun `default on android twelve plus follows dynamic color when enabled`() {
        assertEquals(
            ThemeSchemeSource.Dynamic(dark = true),
            resolveThemeSchemeSource(
                preset = ColorThemePreset.DEFAULT,
                darkTheme = true,
                dynamicColor = true,
                oled = false,
                supportsDynamic = true,
            ),
        )
        assertEquals(
            ThemeSchemeSource.Dynamic(dark = false),
            resolveThemeSchemeSource(
                preset = ColorThemePreset.DEFAULT,
                darkTheme = false,
                dynamicColor = true,
                oled = false,
                supportsDynamic = true,
            ),
        )
    }

    @Test
    fun `dynamic color yields below android twelve even when enabled`() {
        // Pre-S devices have no Material You to ask for; the enabled flag
        // must not matter and the static schemes take over.
        for (darkTheme in listOf(false, true)) {
            val source = resolveThemeSchemeSource(
                preset = ColorThemePreset.DEFAULT,
                darkTheme = darkTheme,
                dynamicColor = true,
                oled = false,
                supportsDynamic = false,
            )
            assertEquals(
                if (darkTheme) ThemeSchemeSource.StaticDark else ThemeSchemeSource.StaticLight,
                source,
                "dark=$darkTheme",
            )
        }
    }

    @Test
    fun `default without dynamic color falls back to the static schemes`() {
        for (darkTheme in listOf(false, true)) {
            for (supportsDynamic in listOf(false, true)) {
                val source = resolveThemeSchemeSource(
                    preset = ColorThemePreset.DEFAULT,
                    darkTheme = darkTheme,
                    dynamicColor = false,
                    oled = false,
                    supportsDynamic = supportsDynamic,
                )
                assertEquals(
                    if (darkTheme) ThemeSchemeSource.StaticDark else ThemeSchemeSource.StaticLight,
                    source,
                    "dark=$darkTheme sdk=$supportsDynamic",
                )
            }
        }
    }
}
