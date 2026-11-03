package app.hapi.companion.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

private val LightColorScheme = lightColorScheme(
    primary = Color(0xFF3D6837),
    secondary = Color(0xFF54634D),
    tertiary = Color(0xFF386569),
)

private val DarkColorScheme = darkColorScheme(
    primary = Color(0xFFA3D397),
    secondary = Color(0xFFBCCBB2),
    tertiary = Color(0xFFA0CFD2),
)

/**
 * Pure-black scheme for OLED panels (mirrors the web `[data-theme="oled"]`
 * token set): the canvas is #000000 and containers stay near-black so
 * elevation comes from hairlines, not gray fills. Never combined with
 * dynamic color -- Material You surfaces would defeat the point.
 */
private val OledColorScheme = darkColorScheme(
    primary = Color(0xFF4EA1FF),
    onPrimary = Color(0xFF000000),
    secondary = Color(0xFFBCCBB2),
    tertiary = Color(0xFFA0CFD2),
    background = Color(0xFF000000),
    onBackground = Color(0xFFF5F5F7),
    surface = Color(0xFF000000),
    onSurface = Color(0xFFF5F5F7),
    surfaceVariant = Color(0xFF131316),
    onSurfaceVariant = Color(0xFFC4CBD6),
    surfaceContainerLowest = Color(0xFF000000),
    surfaceContainerLow = Color(0xFF0A0A0C),
    surfaceContainer = Color(0xFF0E0E10),
    surfaceContainerHigh = Color(0xFF131316),
    surfaceContainerHighest = Color(0xFF161618),
    outline = Color(0xFF3A3A40),
    outlineVariant = Color(0xFF26262A),
)

/**
 * Material3 theme for the HAPI companion app.
 *
 * Dynamic color (Material You) on Android 12+, static fallback schemes below.
 * Also provides [LocalHapiExtendedColors] (markdown/code/diff semantic tokens,
 * see [HapiExtendedColors]) mirroring the web light/dark/OLED token sets.
 *
 * [oled] selects the pure-black variant (implies dark, disables dynamic
 * color); the settings screen wires it up later -- callers default to the
 * regular schemes. [preset] selects a named color theme (web parity, see
 * [ColorThemePreset]): a preset overrides the dynamic and OLED schemes --
 * it never derives from the wallpaper -- and OLED mode renders its dark
 * palette, exactly how the web client layers `data-color-theme` over
 * `data-theme`. [typography] defaults to the app-wide scale derived from
 * [HapiTypography]'s reading tokens, so every Material widget and every
 * direct token consumer share one type system.
 */
/**
 * Which color scheme [HapiTheme] should paint, resolved from the settings
 * before any Android framework type (context, Build constants) enters the
 * picture so the ordering itself stays JVM-testable.
 */
internal sealed interface ThemeSchemeSource {
    /**
     * A named preset's palette. A preset wins over OLED, dynamic color, and
     * the static schemes — it never derives from the wallpaper — and under
     * OLED it resolves to its *dark* seed set, exactly how the web client
     * layers `data-color-theme` over `data-theme` (oled maps onto the dark
     * palette there too).
     */
    data class Preset(val palette: ThemePresetPalette) : ThemeSchemeSource

    /** The built-in pure-black OLED scheme (never combined with dynamic color). */
    data object Oled : ThemeSchemeSource

    /** Material You; [dark] picks the tone set. */
    data class Dynamic(val dark: Boolean) : ThemeSchemeSource

    /** The built-in static schemes. */
    data object StaticDark : ThemeSchemeSource
    data object StaticLight : ThemeSchemeSource
}

/**
 * The theme resolution order: `preset > oled > dynamic color > static
 * light/dark`. [supportsDynamic] stands in for
 * `Build.VERSION.SDK_INT >= Build.VERSION_CODES.S` so tests can drive the
 * full settings matrix on the JVM.
 */
internal fun resolveThemeSchemeSource(
    preset: ColorThemePreset,
    darkTheme: Boolean,
    dynamicColor: Boolean,
    oled: Boolean,
    supportsDynamic: Boolean,
): ThemeSchemeSource = when {
    preset != ColorThemePreset.DEFAULT -> ThemeSchemeSource.Preset(
        preset.palette(dark = darkTheme || oled),
    )
    oled -> ThemeSchemeSource.Oled
    dynamicColor && supportsDynamic -> ThemeSchemeSource.Dynamic(darkTheme)
    darkTheme -> ThemeSchemeSource.StaticDark
    else -> ThemeSchemeSource.StaticLight
}

@Composable
fun HapiTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true,
    oled: Boolean = false,
    preset: ColorThemePreset = ColorThemePreset.DEFAULT,
    typography: Typography = HapiTypography.scale,
    content: @Composable () -> Unit,
) {
    val schemeSource = resolveThemeSchemeSource(
        preset = preset,
        darkTheme = darkTheme,
        dynamicColor = dynamicColor,
        oled = oled,
        supportsDynamic = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S,
    )
    val presetPalette = (schemeSource as? ThemeSchemeSource.Preset)?.palette
    val colorScheme = when (val source = schemeSource) {
        is ThemeSchemeSource.Preset -> source.palette.colorScheme()
        ThemeSchemeSource.Oled -> OledColorScheme
        is ThemeSchemeSource.Dynamic ->
            // The resolver only emits Dynamic when the passed SDK gate says
            // the device runs Android 12+, but that guard crosses a function
            // boundary lint cannot track — keep the check local to the branch.
            // The static arms are unreachable today and fail safe if the two
            // ever disagree.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val context = LocalContext.current
                if (source.dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
            } else if (source.dark) {
                DarkColorScheme
            } else {
                LightColorScheme
            }
        ThemeSchemeSource.StaticDark -> DarkColorScheme
        ThemeSchemeSource.StaticLight -> LightColorScheme
    }
    val baseExtendedColors = when {
        oled -> HapiOledExtendedColors
        darkTheme -> HapiDarkExtendedColors
        else -> HapiLightExtendedColors
    }
    val extendedColors = presetPalette?.extendedColors(baseExtendedColors) ?: baseExtendedColors

    CompositionLocalProvider(LocalHapiExtendedColors provides extendedColors) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = typography,
            content = content,
        )
    }
}
