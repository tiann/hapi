package app.hapi.companion.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * Semantic color tokens that Material3's scheme does not cover: markdown,
 * code, and diff surfaces. Values mirror the web client's CSS custom
 * properties (`web/src/index.css`) for its light / dark / OLED themes so both
 * clients read the same.
 */
@Immutable
data class HapiExtendedColors(
    /** True for the dark and OLED sets -- drives syntax highlight themes. */
    val isDark: Boolean,
    val codeBackground: Color,
    val codeHeaderBackground: Color,
    val codeHeaderForeground: Color,
    val inlineCodeBackground: Color,
    val inlineCodeForeground: Color,
    val blockquoteBackground: Color,
    val blockquoteBar: Color,
    val blockquoteForeground: Color,
    val tableBackground: Color,
    val tableHeaderBackground: Color,
    val divider: Color,
    val diffAddBackground: Color,
    val diffAddText: Color,
    val diffRemoveBackground: Color,
    val diffRemoveText: Color,
    val diffHunkBackground: Color,
    val link: Color,
    val hint: Color,
)

/** Mirrors `:root` (light) tokens in web/src/index.css. */
val HapiLightExtendedColors = HapiExtendedColors(
    isDark = false,
    codeBackground = Color(0xFFF5F6F7),
    codeHeaderBackground = Color(0xFFECEFF2),
    codeHeaderForeground = Color(0xFF717784),
    inlineCodeBackground = Color(0xFFEBECEF),
    inlineCodeForeground = Color(0xFF2D333B),
    blockquoteBackground = Color(0xFFF1F3F5),
    blockquoteBar = Color(0xFFC9D0D8),
    blockquoteForeground = Color(0xFF525965),
    tableBackground = Color(0xFFF5F6F7),
    tableHeaderBackground = Color(0xFFECEFF2),
    divider = Color(0xFFE2E5E9),
    diffAddBackground = Color(0xFFE6FFED),
    diffAddText = Color(0xFF24292E),
    diffRemoveBackground = Color(0xFFFFEEF0),
    diffRemoveText = Color(0xFF24292E),
    diffHunkBackground = Color(0xFFECEFF2),
    link = Color(0xFF111827),
    hint = Color(0xFF6B7280),
)

/** Mirrors `[data-theme="dark"]` tokens in web/src/index.css. */
val HapiDarkExtendedColors = HapiExtendedColors(
    isDark = true,
    codeBackground = Color(0xFF2A2F35),
    codeHeaderBackground = Color(0xFF353B43),
    codeHeaderForeground = Color(0xFFC4CBD6),
    inlineCodeBackground = Color(0xFF383E47),
    inlineCodeForeground = Color(0xFFF5F7FA),
    blockquoteBackground = Color(0xFF31363D),
    blockquoteBar = Color(0xFF6B7481),
    blockquoteForeground = Color(0xFFD7DDE6),
    tableBackground = Color(0xFF2A2F35),
    tableHeaderBackground = Color(0xFF353B43),
    divider = Color(0xFF3A3F45),
    diffAddBackground = Color(0xFF0D2E1F),
    diffAddText = Color(0xFFC9D1D9),
    diffRemoveBackground = Color(0xFF3F1B23),
    diffRemoveText = Color(0xFFC9D1D9),
    diffHunkBackground = Color(0xFF353B43),
    link = Color(0xFFFFFFFF),
    hint = Color(0xFF8E8E93),
)

/**
 * Mirrors `[data-theme="oled"]` tokens: pure-black canvas, elevation from
 * borders instead of gray fills.
 */
val HapiOledExtendedColors = HapiExtendedColors(
    isDark = true,
    codeBackground = Color(0xFF0E0E10),
    codeHeaderBackground = Color(0xFF161618),
    codeHeaderForeground = Color(0xFFC4CBD6),
    inlineCodeBackground = Color(0xFF1A1A1D),
    inlineCodeForeground = Color(0xFFF5F7FA),
    blockquoteBackground = Color(0xFF131316),
    blockquoteBar = Color(0xFF3A3A40),
    blockquoteForeground = Color(0xFFD7DDE6),
    tableBackground = Color(0xFF0E0E10),
    tableHeaderBackground = Color(0xFF161618),
    divider = Color(0xFF26262A),
    diffAddBackground = Color(0xFF07251A),
    diffAddText = Color(0xFFC9D1D9),
    diffRemoveBackground = Color(0xFF2C1217),
    diffRemoveText = Color(0xFFC9D1D9),
    diffHunkBackground = Color(0xFF161618),
    link = Color(0xFF4EA1FF),
    hint = Color(0xFF8E8E93),
)

val LocalHapiExtendedColors = staticCompositionLocalOf { HapiLightExtendedColors }

/** `MaterialTheme.hapi.codeBackground` etc. -- provided by [HapiTheme]. */
val MaterialTheme.hapi: HapiExtendedColors
    @Composable
    @ReadOnlyComposable
    get() = LocalHapiExtendedColors.current
