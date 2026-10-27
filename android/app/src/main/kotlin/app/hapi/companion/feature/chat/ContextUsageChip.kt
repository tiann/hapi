package app.hapi.companion.feature.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hapi.companion.R

/**
 * Context-remaining indicator in the composer status strip. With a known
 * window it shows the budget and the free share; without one, just the
 * current context size. The color escalates from neutral to amber to red as
 * the window fills — the text itself stays the same in every band.
 */
@Composable
internal fun ContextUsageChip(
    indicator: ContextUsageIndicator?,
    modifier: Modifier = Modifier,
) {
    val value = indicator ?: return
    val label = if (value.remainingPercent != null && value.budget != null) {
        stringResource(R.string.chat_context_usage, value.budget, value.remainingPercent)
    } else {
        stringResource(R.string.chat_context_usage_no_window, value.used)
    }
    val detailsLabel = stringResource(R.string.chat_context_details)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.End,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = when (value.warning) {
                ContextUsageWarning.NORMAL -> MaterialTheme.colorScheme.onSurfaceVariant
                ContextUsageWarning.ELEVATED -> MaterialTheme.colorScheme.tertiary
                ContextUsageWarning.CRITICAL -> MaterialTheme.colorScheme.error
            },
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.semantics { contentDescription = detailsLabel },
        )
    }
}
