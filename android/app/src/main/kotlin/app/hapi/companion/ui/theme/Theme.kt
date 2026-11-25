package app.hapi.companion.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

/**
 * Neutral (hue-free) surface ladders mirroring iOS `HapiTheme.light/.dark`.
 * Material's baseline schemes tint every surface lavender; HAPI keeps
 * surfaces gray and lets only the accent roles carry color. [NeutralChatSurfaces]
 * reapplies these over Material You so wallpaper hues never tint the transcript.
 */
private fun ColorScheme.withNeutralSurfaces(dark: Boolean): ColorScheme = if (dark) {
    copy(
        background = Color(0xFF0F1115),
        onBackground = Color(0xFFE8EAED),
        surface = Color(0xFF0F1115),
        onSurface = Color(0xFFE8EAED),
        surfaceVariant = Color(0xFF23272F),
        onSurfaceVariant = Color(0xFFA8ADB8),
        surfaceTint = Color(0xFF6E7481),
        surfaceBright = Color(0xFF2A2E37),
        surfaceDim = Color(0xFF0F1115),
        surfaceContainerLowest = Color(0xFF0B0D10),
        surfaceContainerLow = Color(0xFF14171C),
        surfaceContainer = Color(0xFF181B22),
        surfaceContainerHigh = Color(0xFF1E2129),
        surfaceContainerHighest = Color(0xFF262A33),
        outline = Color(0xFF6E7481),
        outlineVariant = Color(0xFF2A2E37),
        inverseSurface = Color(0xFFE8EAED),
        inverseOnSurface = Color(0xFF1C1D22),
    )
} else {
    copy(
        background = Color(0xFFFFFFFF),
        onBackground = Color(0xFF1C1D22),
        surface = Color(0xFFFFFFFF),
        onSurface = Color(0xFF1C1D22),
        surfaceVariant = Color(0xFFEEF0F3),
        onSurfaceVariant = Color(0xFF52555E),
        surfaceTint = Color(0xFF8A8D96),
        surfaceBright = Color(0xFFFFFFFF),
        surfaceDim = Color(0xFFE2E4E8),
        surfaceContainerLowest = Color(0xFFFFFFFF),
        surfaceContainerLow = Color(0xFFF6F7F9),
        surfaceContainer = Color(0xFFF1F3F5),
        surfaceContainerHigh = Color(0xFFECEEF1),
        surfaceContainerHighest = Color(0xFFE5E7EB),
        outline = Color(0xFF8A8D96),
        outlineVariant = Color(0xFFE5E7EB),
        inverseSurface = Color(0xFF2B2D33),
        inverseOnSurface = Color(0xFFF1F3F5),
    )
}

// Full accent role sets for the green seed (Material theme builder). Unset
// roles would fall back to Material's baseline purple: date-range bands
// (secondaryContainer), tonal buttons and chips all read those containers.
private val LightColorScheme = lightColorScheme(
    primary = Color(0xFF3D6837),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFBEF0B1),
    onPrimaryContainer = Color(0xFF002201),
    inversePrimary = Color(0xFFA3D397),
    secondary = Color(0xFF54634D),
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFD7E8CD),
    onSecondaryContainer = Color(0xFF121F0E),
    tertiary = Color(0xFF386569),
    onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFBCEBEE),
    onTertiaryContainer = Color(0xFF002022),
).withNeutralSurfaces(dark = false)

private val DarkColorScheme = darkColorScheme(
    primary = Color(0xFFA3D397),
    // Ink on the light-green accent.
    onPrimary = Color(0xFF0F1115),
    primaryContainer = Color(0xFF25501F),
    onPrimaryContainer = Color(0xFFBEF0B1),
    inversePrimary = Color(0xFF3D6837),
    secondary = Color(0xFFBCCBB2),
    onSecondary = Color(0xFF263422),
    secondaryContainer = Color(0xFF3C4B37),
    onSecondaryContainer = Color(0xFFD7E8CD),
    tertiary = Color(0xFFA0CFD2),
    onTertiary = Color(0xFF00373A),
    tertiaryContainer = Color(0xFF1F4D51),
    onTertiaryContainer = Color(0xFFBCEBEE),
).withNeutralSurfaces(dark = true)

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

    CompositionLocalProvider(
        LocalHapiExtendedColors provides extendedColors,
        LocalThemeSchemeSource provides schemeSource,
    ) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = typography,
            content = content,
        )
    }
}

internal val LocalThemeSchemeSource = staticCompositionLocalOf<ThemeSchemeSource> { ThemeSchemeSource.StaticLight }

/**
 * Keeps conversation surfaces neutral under Material You: the wallpaper still
 * drives accent roles, but the canvas, containers and on-surface text use the
 * same gray ladder as the static schemes. Presets and OLED are deliberate
 * palette choices and pass through unchanged.
 */
@Composable
fun NeutralChatSurfaces(content: @Composable () -> Unit) {
    val source = LocalThemeSchemeSource.current
    if (source !is ThemeSchemeSource.Dynamic) {
        content()
        return
    }
    MaterialTheme(
        colorScheme = MaterialTheme.colorScheme.withNeutralSurfaces(source.dark),
        typography = MaterialTheme.typography,
        shapes = MaterialTheme.shapes,
        content = content,
    )
}
