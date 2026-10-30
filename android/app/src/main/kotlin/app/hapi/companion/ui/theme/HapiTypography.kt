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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** sp delegates scaling (including Android 14's nonlinear scaling) to the platform. */
object HapiTypography {
    /** Primary reading style: chat bubbles and long-form markdown. */
    val body = TextStyle(fontSize = 16.sp, lineHeight = 24.sp)

    /**
     * Monospace style for code blocks and CLI output. Material has no code
     * slot, so views that render code consume this token directly; it never
     * leaks into the shared scale's reading slots.
     */
    val code = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 14.sp, lineHeight = 20.sp)

    /** Compact metadata style: timestamps, counters, table headers. */
    val caption = TextStyle(fontSize = 12.sp, lineHeight = 16.sp)

    /** Material's stock scale; the base the app scale derives every slot from. */
    private val platformDefaults = Typography()

    /**
     * The Material type scale the whole app renders with. It is anchored on
     * the reading tokens above instead of existing as an unrelated parallel
     * system: [body] drives `bodyLarge` (the chat reading size) and [caption]
     * drives `bodySmall` (the metadata size). Only size and leading come from
     * the tokens -- weight, tracking and family stay Material's -- and every
     * slot without a token copies its platform default verbatim, so the many
     * existing `MaterialTheme.typography` call sites stay pixel-identical
     * while future token changes propagate through one place.
     */
    val scale: Typography = Typography(
        bodyLarge = platformDefaults.bodyLarge.copy(
            fontSize = body.fontSize,
            lineHeight = body.lineHeight,
        ),
        bodySmall = platformDefaults.bodySmall.copy(
            fontSize = caption.fontSize,
            lineHeight = caption.lineHeight,
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
