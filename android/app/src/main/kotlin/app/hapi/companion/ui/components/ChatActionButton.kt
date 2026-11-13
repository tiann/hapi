package app.hapi.companion.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.hapi.companion.ui.theme.hapi

/** Visual weight of a [ChatActionButton]. */
enum class ChatActionProminence {
    /** The one filled action of a row (Allow, Submit answer, Implement plan). */
    Primary,

    /** Hairline-bordered companion actions (Deny, Previous, Continue planning). */
    Secondary,
}

/**
 * The single button style for inline transcript actions — approvals, question
 * navigation, plan actions and queued-message actions (iOS
 * `ChatActionButtonStyle`). It owns the full touch target (48dp minimum,
 * 10dp corners); callers must not add another minimum height or padding.
 * Only geometry is shared: each caller keeps its own submission semantics.
 */
@Composable
fun ChatActionButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    prominence: ChatActionProminence = ChatActionProminence.Secondary,
    enabled: Boolean = true,
    content: @Composable RowScope.() -> Unit,
) {
    val sized = modifier.defaultMinSize(minHeight = 48.dp)
    val textStyle = MaterialTheme.typography.labelLarge.copy(fontSize = 15.sp, letterSpacing = 0.sp, fontWeight = FontWeight.Medium)
    when (prominence) {
        ChatActionProminence.Primary -> Button(
            onClick = onClick,
            modifier = sized,
            enabled = enabled,
            shape = ChatActionShape,
            contentPadding = ChatActionPadding,
        ) { ProvideTextStyle(textStyle) { content() } }
        ChatActionProminence.Secondary -> OutlinedButton(
            onClick = onClick,
            modifier = sized,
            enabled = enabled,
            shape = ChatActionShape,
            contentPadding = ChatActionPadding,
            border = BorderStroke(1.dp, MaterialTheme.hapi.divider),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
        ) { ProvideTextStyle(textStyle) { content() } }
    }
}

private val ChatActionShape = RoundedCornerShape(10.dp)
private val ChatActionPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp)
