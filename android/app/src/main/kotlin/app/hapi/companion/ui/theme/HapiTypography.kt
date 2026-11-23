package app.hapi.companion.ui.theme

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.hapi.companion.R

/**
 * Reading metrics shared with iOS `HapiTypography`: 16/24 body, 15 inline
 * code, 14/20 code, 12/16 captions, 24/20/18/17 headings. sp delegates
 * scaling (including Android 14's nonlinear scaling) to the platform.
 */
object HapiTypography {
    /**
     * JetBrains Mono NL (SIL OFL 1.1; license in the font's name table). The
     * no-ligature cut keeps `!=`/`->` in agent output literal, like SF Mono.
     */
    val monoFamily = FontFamily(
        Font(R.font.jetbrains_mono_regular, FontWeight.Normal),
        Font(R.font.jetbrains_mono_bold, FontWeight.Bold),
    )

    /**
     * Leading is distributed between lines only (iOS `lineSpacing`): the first
     * line's ascent and the last line's descent are trimmed, so block spacing
     * tokens measure the visible gap instead of hidden half-leading.
     */
    private val trimmedLeading = LineHeightStyle(
        alignment = LineHeightStyle.Alignment.Center,
        trim = LineHeightStyle.Trim.Both,
    )

    /** Primary reading style: chat bubbles and long-form markdown. */
    val body = TextStyle(
        fontSize = 16.sp,
        lineHeight = 24.sp,
        letterSpacing = 0.sp,
        lineHeightStyle = trimmedLeading,
        // Strict CJK breaking rules and high-quality line filling.
        lineBreak = LineBreak.Paragraph,
    )

    /**
     * Monospace style for code blocks, CLI output and diffs. Material has no
     * code slot, so views that render code consume this token directly.
     */
    val code = TextStyle(
        fontFamily = monoFamily,
        fontSize = 14.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.sp,
        lineHeightStyle = trimmedLeading,
    )

    /** Compact metadata style: timestamps, counters, tool subtitles. */
    val caption = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = 0.sp)

    /** Tool summary titles and similar one-line labels (iOS 15pt medium). */
    val rowTitle = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, letterSpacing = 0.sp, fontWeight = FontWeight.Medium)

    /** Tool summary subtitles and secondary row text (iOS 13pt). */
    val rowSubtitle = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, letterSpacing = 0.sp)

    /** Markdown heading by level; matches iOS `headingSize`. */
    fun heading(level: Int): TextStyle {
        val size = when (level) {
            1 -> 24
            2 -> 20
            3 -> 18
            else -> 17
        }
        return body.copy(
            fontSize = size.sp,
            lineHeight = (size * 1.3f).sp,
            fontWeight = FontWeight.SemiBold,
        )
    }

    /** Material's stock scale; the base the app scale derives every slot from. */
    private val platformDefaults = Typography()

    /**
     * The Material type scale the whole app renders with. [body] drives
     * `bodyLarge` and [caption] drives `bodySmall`. Body slots drop Material's
     * 0.25–0.5sp tracking, which reads loose next to CJK and system UI text;
     * title and label slots keep their platform defaults.
     */
    val scale: Typography = Typography(
        bodyLarge = platformDefaults.bodyLarge.copy(
            fontSize = body.fontSize,
            lineHeight = body.lineHeight,
            letterSpacing = 0.sp,
        ),
        bodyMedium = platformDefaults.bodyMedium.copy(letterSpacing = 0.sp),
        bodySmall = platformDefaults.bodySmall.copy(
            fontSize = caption.fontSize,
            lineHeight = caption.lineHeight,
            letterSpacing = 0.sp,
        ),
    )
}

/** Owns the minimum margins; children measure against this column, not the display. */
@Composable
fun ReadingColumn(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    Box(modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
        Box(Modifier.widthIn(max = 752.dp).fillMaxWidth().padding(horizontal = 16.dp), content = content)
    }
}
