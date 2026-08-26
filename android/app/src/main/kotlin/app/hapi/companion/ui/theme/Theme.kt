package app.hapi.companion.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
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
 * regular schemes.
 */
@Composable
fun HapiTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true,
    oled: Boolean = false,
    content: @Composable () -> Unit,
) {
    val colorScheme = when {
        oled -> OledColorScheme
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkColorScheme
        else -> LightColorScheme
    }
    val extendedColors = when {
        oled -> HapiOledExtendedColors
        darkTheme -> HapiDarkExtendedColors
        else -> HapiLightExtendedColors
    }

    CompositionLocalProvider(LocalHapiExtendedColors provides extendedColors) {
        MaterialTheme(
            colorScheme = colorScheme,
            content = content,
        )
    }
}
