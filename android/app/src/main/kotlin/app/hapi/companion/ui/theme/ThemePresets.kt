package app.hapi.companion.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import kotlin.math.floor
import kotlin.math.pow

/**
 * Color theme presets — the Android twin of the web client's color-theme
 * picker (`web/src/hooks/useColorTheme.ts`). Each named preset carries five
 * seed colors per scheme (accent, background, foreground, hint, secondary);
 * every other tone derives from them deterministically with the same math
 * the web client uses, so a preset reads identically on both clients.
 *
 * [DEFAULT] is the absence of a preset: the built-in light/dark/OLED schemes
 * (plus Material You) stay in charge, exactly like the web client letting its
 * inline palette variables go so the base CSS tokens apply.
 */
enum class ColorThemePreset(val storageKey: String) {
    DEFAULT("default"),
    NOTION("notion"),
    ONE("one"),
    PROOF("proof"),
    RAYCAST("raycast"),
    ROSE_PINE("rose-pine"),
    SOLARIZED("solarized"),
    VERCEL("vercel"),
    VS_CODE_PLUS("vs-code-plus"),
    XCODE("xcode"),
    LINEAR("linear"),
    LOBSTER("lobster"),
    MATERIAL("material"),
    MATRIX("matrix"),
    MONOKAI("monokai"),
    NIGHT_OWL("night-owl"),
    NORD("nord");

    companion object {
        /** Unknown/corrupt stored values degrade to [DEFAULT]. */
        fun fromStorageKey(raw: String?): ColorThemePreset =
            entries.firstOrNull { it.storageKey == raw } ?: DEFAULT
    }
}

/**
 * The five seed colors a preset defines per scheme, in the web client's
 * order. Everything else the UI needs derives from these (see
 * [ThemePresetPalette]).
 */
@Immutable
data class ThemePresetSeeds(
    val accent: Color,
    val background: Color,
    val foreground: Color,
    val hint: Color,
    val secondary: Color,
)

/** A preset's two seed sets; the dark one also serves OLED (web parity). */
@Immutable
data class ThemePresetSeedPair(val light: ThemePresetSeeds, val dark: ThemePresetSeeds)

/** Light-theme hairline base the web client tints for borders/subtles. */
private val LightInk = Color(0xFF0F172A)

/** Text the web client puts on accent-colored surfaces when the accent is light. */
private val InkOnBrightAccent = Color(0xFF111827)

/** The 16 named presets' seeds, transcribed from the web `PALETTES` table. */
internal val themePresetSeeds: Map<ColorThemePreset, ThemePresetSeedPair> = mapOf(
    ColorThemePreset.NOTION to ThemePresetSeedPair(
        light = ThemePresetSeeds(Color(0xFF3183D8), Color(0xFFFAFAFA), Color(0xFF37352F), Color(0xFF787774), Color(0xFFF1F1EF)),
        dark = ThemePresetSeeds(Color(0xFF3183D8), Color(0xFF191919), Color(0xFFD9D9D8), Color(0xFF9B9A97), Color(0xFF252525)),
    ),
    ColorThemePreset.ONE to ThemePresetSeedPair(
        light = ThemePresetSeeds(Color(0xFF526FFF), Color(0xFFFBFBFF), Color(0xFF383A42), Color(0xFF696C77), Color(0xFFF0F2FF)),
        dark = ThemePresetSeeds(Color(0xFF7B8CFF), Color(0xFF1F2433), Color(0xFFD8DEE9), Color(0xFFAAB2C0), Color(0xFF2C3245)),
    ),
    ColorThemePreset.PROOF to ThemePresetSeedPair(
        light = ThemePresetSeeds(Color(0xFF2F7D5B), Color(0xFFF8F7F2), Color(0xFF26352F), Color(0xFF64706B), Color(0xFFEEF1EA)),
        dark = ThemePresetSeeds(Color(0xFF7FC8A6), Color(0xFF18231F), Color(0xFFD9E4DC), Color(0xFF9DAFAA), Color(0xFF23332D)),
    ),
    ColorThemePreset.RAYCAST to ThemePresetSeedPair(
        light = ThemePresetSeeds(Color(0xFFFF4D4D), Color(0xFFFFFFFF), Color(0xFF2B2B31), Color(0xFF72727A), Color(0xFFFFF0F0)),
        dark = ThemePresetSeeds(Color(0xFFFF6363), Color(0xFF201617), Color(0xFFF3EDED), Color(0xFFC9BFC0), Color(0xFF321F21)),
    ),
    ColorThemePreset.ROSE_PINE to ThemePresetSeedPair(
        light = ThemePresetSeeds(Color(0xFFD7827E), Color(0xFFFFFAF3), Color(0xFF575279), Color(0xFF797593), Color(0xFFF2E9E1)),
        dark = ThemePresetSeeds(Color(0xFFEBBCBA), Color(0xFF191724), Color(0xFFE0DEF4), Color(0xFF908CAA), Color(0xFF26233A)),
    ),
    ColorThemePreset.SOLARIZED to ThemePresetSeedPair(
        light = ThemePresetSeeds(Color(0xFFB58900), Color(0xFFFDF6E3), Color(0xFF586E75), Color(0xFF839496), Color(0xFFEEE8D5)),
        dark = ThemePresetSeeds(Color(0xFF268BD2), Color(0xFF002B36), Color(0xFF93A1A1), Color(0xFF839496), Color(0xFF073642)),
    ),
    ColorThemePreset.VERCEL to ThemePresetSeedPair(
        light = ThemePresetSeeds(Color(0xFF0070F3), Color(0xFFFFFFFF), Color(0xFF111111), Color(0xFF666666), Color(0xFFF5F5F5)),
        dark = ThemePresetSeeds(Color(0xFF3291FF), Color(0xFF000000), Color(0xFFEDEDED), Color(0xFFA1A1A1), Color(0xFF111111)),
    ),
    ColorThemePreset.VS_CODE_PLUS to ThemePresetSeedPair(
        light = ThemePresetSeeds(Color(0xFF007ACC), Color(0xFFFFFFFF), Color(0xFF24292F), Color(0xFF6E7781), Color(0xFFF3F6F8)),
        dark = ThemePresetSeeds(Color(0xFF3794FF), Color(0xFF1E1E1E), Color(0xFFD4D4D4), Color(0xFF9CDCFE), Color(0xFF252526)),
    ),
    ColorThemePreset.XCODE to ThemePresetSeedPair(
        light = ThemePresetSeeds(Color(0xFF0A84FF), Color(0xFFF7F9FF), Color(0xFF1F2328), Color(0xFF59636E), Color(0xFFEEF4FF)),
        dark = ThemePresetSeeds(Color(0xFF409CFF), Color(0xFF1F2024), Color(0xFFEEF2FF), Color(0xFFA9B0BD), Color(0xFF2A2C33)),
    ),
    ColorThemePreset.LINEAR to ThemePresetSeedPair(
        light = ThemePresetSeeds(Color(0xFF5E6AD2), Color(0xFFF7F7FB), Color(0xFF25262F), Color(0xFF70717D), Color(0xFFEEEEF8)),
        dark = ThemePresetSeeds(Color(0xFF8A91F6), Color(0xFF08090D), Color(0xFFF7F8FF), Color(0xFFA6A8B5), Color(0xFF151722)),
    ),
    ColorThemePreset.LOBSTER to ThemePresetSeedPair(
        light = ThemePresetSeeds(Color(0xFFE84D68), Color(0xFFFFF7F4), Color(0xFF33262B), Color(0xFF7D636A), Color(0xFFFFE9E2)),
        dark = ThemePresetSeeds(Color(0xFFFF5B6E), Color(0xFF161821), Color(0xFFF5D7DC), Color(0xFFBE9CA5), Color(0xFF242333)),
    ),
    ColorThemePreset.MATERIAL to ThemePresetSeedPair(
        light = ThemePresetSeeds(Color(0xFF6750A4), Color(0xFFFFFBFE), Color(0xFF1C1B1F), Color(0xFF6F6A73), Color(0xFFF2EDF7)),
        dark = ThemePresetSeeds(Color(0xFFD0BCFF), Color(0xFF1C1B1F), Color(0xFFE6E1E5), Color(0xFFCAC4CF), Color(0xFF2B2930)),
    ),
    ColorThemePreset.MATRIX to ThemePresetSeedPair(
        light = ThemePresetSeeds(Color(0xFF10883A), Color(0xFFF5FFF7), Color(0xFF102016), Color(0xFF55735F), Color(0xFFE8F8EC)),
        dark = ThemePresetSeeds(Color(0xFF00FF66), Color(0xFF030806), Color(0xFFD8FFE4), Color(0xFF6AFF9B), Color(0xFF07150D)),
    ),
    ColorThemePreset.MONOKAI to ThemePresetSeedPair(
        light = ThemePresetSeeds(Color(0xFF7A8F00), Color(0xFFF8F7EF), Color(0xFF3B3A32), Color(0xFF747065), Color(0xFFEFEEE4)),
        dark = ThemePresetSeeds(Color(0xFFA6E22E), Color(0xFF272822), Color(0xFFF8F8F2), Color(0xFFCFCFC2), Color(0xFF33342D)),
    ),
    ColorThemePreset.NIGHT_OWL to ThemePresetSeedPair(
        light = ThemePresetSeeds(Color(0xFF4876D9), Color(0xFFFBFDFF), Color(0xFF25354A), Color(0xFF60708A), Color(0xFFEEF6FF)),
        dark = ThemePresetSeeds(Color(0xFF82AAFF), Color(0xFF011627), Color(0xFFD6DEEB), Color(0xFF7FDBCA), Color(0xFF0B2942)),
    ),
    ColorThemePreset.NORD to ThemePresetSeedPair(
        light = ThemePresetSeeds(Color(0xFF5E81AC), Color(0xFFECEFF4), Color(0xFF2E3440), Color(0xFF667085), Color(0xFFE5E9F0)),
        dark = ThemePresetSeeds(Color(0xFF88C0D0), Color(0xFF2E3440), Color(0xFFECEFF4), Color(0xFFD8DEE9), Color(0xFF3B4252)),
    ),
)

/**
 * One preset's full palette for a single scheme: the five seeds plus the
 * derived tones, with the same names and formulas as the web client's
 * `palette()` so the two stay in lock-step. [isDark] follows the *palette's
 * own* background luminance (not the caller's scheme flag) — that is how the
 * web client decides which direction the elevation mixes go, which keeps the
 * derivation correct even for hypothetical palettes whose seeds disagree
 * with the scheme they are filed under.
 */
@Immutable
data class ThemePresetPalette(
    val isDark: Boolean,
    val accent: Color,
    val background: Color,
    val foreground: Color,
    val hint: Color,
    val secondary: Color,
    /** One elevation step up from the canvas — web `dialog` (5% / 1.5% mix). */
    val dialog: Color,
    /** Card/tool/quote surfaces — web `surface` (9% / 3.5% mix). */
    val surface: Color,
    /** Hovered surfaces and table/code headers — web `surfaceHover` (14% / 6.5%). */
    val surfaceHover: Color,
    /** Code blocks — web `code` (11% / 4.5% mix). */
    val code: Color,
    /** Hairline stroke — web `border` (white or slate ink at ~10% alpha). */
    val border: Color,
    /** Faint wash — web `subtle` (white or slate ink at ~5% alpha). */
    val subtle: Color,
    /** Text that stays readable on accent-filled surfaces — web `buttonText`. */
    val buttonText: Color,
)

/**
 * Derives the full palette from a seed set with the web client's exact math:
 * per-channel linear mixes (no gamma), WCAG relative luminance for the
 * dark/light call and for button-text contrast.
 */
internal fun ThemePresetSeedPair.palette(dark: Boolean): ThemePresetPalette {
    // `dark` (the scheme flag) shadows the receiver's `dark` seed set, so the
    // seed picks are explicitly qualified.
    val seeds = if (dark) this.dark else this.light
    val isDark = relativeLuminance(seeds.background) < 0.5
    val contrast = if (isDark) Color.White else Color.Black
    val ink = if (isDark) Color.White else LightInk
    return ThemePresetPalette(
        isDark = isDark,
        accent = seeds.accent,
        background = seeds.background,
        foreground = seeds.foreground,
        hint = seeds.hint,
        secondary = seeds.secondary,
        dialog = mix(seeds.background, contrast, if (isDark) 0.05 else 0.015),
        surface = mix(seeds.background, contrast, if (isDark) 0.09 else 0.035),
        surfaceHover = mix(seeds.background, contrast, if (isDark) 0.14 else 0.065),
        code = mix(seeds.background, contrast, if (isDark) 0.11 else 0.045),
        border = ink.copy(alpha = if (isDark) 0.11f else 0.10f),
        subtle = ink.copy(alpha = if (isDark) 0.06f else 0.045f),
        buttonText = if (relativeLuminance(seeds.accent) > 0.45) InkOnBrightAccent else Color.White,
    )
}

/**
 * Resolves [this] preset into a palette. OLED resolves to the dark seeds —
 * the web client maps oled onto the dark palette the same way — so the
 * caller passes `dark = darkTheme || oled`.
 */
fun ColorThemePreset.palette(dark: Boolean): ThemePresetPalette {
    val seeds = themePresetSeeds[this]
        ?: error("preset '$storageKey' has no palette; DEFAULT resolves through the built-in schemes")
    return seeds.palette(dark)
}

/**
 * Bridge from the web palette to Material's color roles. The canvas,
 * surfaces, and accent roles map 1:1 onto the web tokens; Material's
 * container ladder walks the web elevation steps (dialog → surface →
 * surfaceHover, then one further 19% step so `surfaceContainerHighest` keeps
 * its place in the ladder). Roles the web palette has no opinion about
 * (error tones and their containers) keep Material's scheme defaults.
 */
fun ThemePresetPalette.colorScheme(): ColorScheme {
    val base = if (isDark) darkColorScheme() else lightColorScheme()
    val contrast = if (isDark) Color.White else Color.Black
    return base.copy(
        primary = accent,
        onPrimary = buttonText,
        primaryContainer = accent,
        onPrimaryContainer = buttonText,
        secondary = hint,
        onSecondary = background,
        secondaryContainer = secondary,
        onSecondaryContainer = foreground,
        tertiary = hint,
        onTertiary = background,
        background = background,
        onBackground = foreground,
        surface = background,
        onSurface = foreground,
        surfaceVariant = surfaceHover,
        onSurfaceVariant = hint,
        surfaceContainerLowest = background,
        surfaceContainerLow = dialog,
        surfaceContainer = surface,
        surfaceContainerHigh = surfaceHover,
        surfaceContainerHighest = mix(background, contrast, 0.19),
        outline = hint,
        outlineVariant = border,
        inverseSurface = foreground,
        inverseOnSurface = background,
        inversePrimary = accent,
    )
}

/**
 * Overlays the tokens the web client re-skins per preset onto the base
 * extended set: code/quote/table surfaces, dividers, links, and hints.
 * Diff surfaces are *not* preset-tinted on the web client either — they
 * inherit from [base], along with [HapiExtendedColors.isDark], which keeps
 * driving syntax-highlight theme selection.
 */
fun ThemePresetPalette.extendedColors(base: HapiExtendedColors): HapiExtendedColors = base.copy(
    codeBackground = code,
    codeHeaderBackground = surfaceHover,
    codeHeaderForeground = hint,
    inlineCodeBackground = code,
    inlineCodeForeground = foreground,
    blockquoteBackground = surface,
    blockquoteBar = accent.copy(alpha = 0.35f),
    blockquoteForeground = foreground,
    tableBackground = surface,
    tableHeaderBackground = surfaceHover,
    divider = border,
    link = accent,
    hint = hint,
)

/** Card-face preview colors for the preset picker (web `COLOR_THEME_OPTIONS`). */
@Immutable
data class ThemePresetPreview(val light: Color, val dark: Color, val accent: Color)

private val DefaultPresetPreview = ThemePresetPreview(
    light = Color(0xFFFFFFFF),
    dark = Color(0xFF1C1C1E),
    accent = Color(0xFF111827),
)

/**
 * Fixed preview colors for the picker cards. Transcribed from the web
 * client's option table rather than derived from the seeds — a few accents
 * there deliberately differ from the seed values so every card reads well.
 */
fun ColorThemePreset.preview(): ThemePresetPreview = when (this) {
    ColorThemePreset.DEFAULT -> DefaultPresetPreview
    ColorThemePreset.NOTION -> ThemePresetPreview(Color(0xFFFAFAFA), Color(0xFF191919), Color(0xFF3183D8))
    ColorThemePreset.ONE -> ThemePresetPreview(Color(0xFFFBFBFF), Color(0xFF1F2433), Color(0xFF526FFF))
    ColorThemePreset.PROOF -> ThemePresetPreview(Color(0xFFF8F7F2), Color(0xFF18231F), Color(0xFF2F7D5B))
    ColorThemePreset.RAYCAST -> ThemePresetPreview(Color(0xFFFFFFFF), Color(0xFF201617), Color(0xFFFF5555))
    ColorThemePreset.ROSE_PINE -> ThemePresetPreview(Color(0xFFFFFAF3), Color(0xFF191724), Color(0xFFC65F7B))
    ColorThemePreset.SOLARIZED -> ThemePresetPreview(Color(0xFFFDF6E3), Color(0xFF002B36), Color(0xFFB58900))
    ColorThemePreset.VERCEL -> ThemePresetPreview(Color(0xFFFFFFFF), Color(0xFF000000), Color(0xFF0070F3))
    ColorThemePreset.VS_CODE_PLUS -> ThemePresetPreview(Color(0xFFFFFFFF), Color(0xFF1E1E1E), Color(0xFF007ACC))
    ColorThemePreset.XCODE -> ThemePresetPreview(Color(0xFFF7F9FF), Color(0xFF1F2024), Color(0xFF0A84FF))
    ColorThemePreset.LINEAR -> ThemePresetPreview(Color(0xFFF7F7FB), Color(0xFF08090D), Color(0xFF5E6AD2))
    ColorThemePreset.LOBSTER -> ThemePresetPreview(Color(0xFFFFF7F4), Color(0xFF161821), Color(0xFFFF5B6E))
    ColorThemePreset.MATERIAL -> ThemePresetPreview(Color(0xFFFFFBFE), Color(0xFF1C1B1F), Color(0xFF6750A4))
    ColorThemePreset.MATRIX -> ThemePresetPreview(Color(0xFFF5FFF7), Color(0xFF030806), Color(0xFF00FF66))
    ColorThemePreset.MONOKAI -> ThemePresetPreview(Color(0xFFF8F7EF), Color(0xFF272822), Color(0xFFA6E22E))
    ColorThemePreset.NIGHT_OWL -> ThemePresetPreview(Color(0xFFFBFDFF), Color(0xFF011627), Color(0xFF82AAFF))
    ColorThemePreset.NORD -> ThemePresetPreview(Color(0xFFECEFF4), Color(0xFF2E3440), Color(0xFF88C0D0))
}

// --------------------------------------------------------------- color math --
// Channel math mirrors the web client's `mix`/`relativeLuminance` helpers
// byte for byte, including its rounding: JS `Math.round` resolves exact .5
// ties upward, and at least one shipped seed hits such a tie (Notion dark
// background #191919 → dialog #252525), so plain banker's rounding would
// visibly drift from the web rendering.

private fun jsRound(x: Double): Int = floor(x + 0.5).toInt()

private fun mix(a: Color, b: Color, weight: Double): Color {
    val from = a.toArgbChannels()
    val to = b.toArgbChannels()
    fun channel(x: Int, y: Int): Int = jsRound(x * (1 - weight) + y * weight)
    return argb(channel(from[0], to[0]), channel(from[1], to[1]), channel(from[2], to[2]))
}

private fun argb(r: Int, g: Int, b: Int): Color {
    val packed = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
    return Color(packed)
}

private fun Color.toArgbChannels(): IntArray {
    val value = toArgb()
    return intArrayOf((value shr 16) and 0xFF, (value shr 8) and 0xFF, value and 0xFF)
}

/** WCAG relative luminance over the 8-bit channels — web parity. */
internal fun relativeLuminance(color: Color): Double {
    fun convert(value: Int): Double {
        val next = value / 255.0
        return if (next <= 0.03928) next / 12.92 else ((next + 0.055) / 1.055).pow(2.4)
    }
    val (r, g, b) = color.toArgbChannels()
    return 0.2126 * convert(r) + 0.7152 * convert(g) + 0.0722 * convert(b)
}
