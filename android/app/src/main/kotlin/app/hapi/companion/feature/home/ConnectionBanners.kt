package app.hapi.companion.feature.home

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.data.sse.DisconnectReason

/**
 * The global connection banner (slice C-①): a full-width strip at the top of
 * Home, mirroring the web's fixed-position banners. Rendered on Home only —
 * an open chat already surfaces its own session-pipe state (chat title
 * "Reconnecting… Tap to retry"), so the two never double up on one screen.
 */
@Composable
fun GlobalConnectionBanner(chrome: ConnectionChrome, modifier: Modifier = Modifier) {
    val notice by chrome.notice.collectAsState()
    when (val current = notice) {
        null -> Unit
        GlobalConnectionNotice.Syncing -> SyncingBanner(modifier)
        is GlobalConnectionNotice.Reconnecting -> ReconnectingBanner(current, modifier)
    }
}

/**
 * Amber "Reconnecting…" strip — the web `ReconnectingBanner.tsx` look:
 * spinner + message + dimmed reason label in parentheses.
 */
@Composable
private fun ReconnectingBanner(notice: GlobalConnectionNotice.Reconnecting, modifier: Modifier = Modifier) {
    BannerSurface(color = ConnectionAmber, contentColor = Color.White, modifier = modifier) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
            CircularProgressIndicator(
                color = Color.White,
                trackColor = Color.Transparent,
                strokeWidth = 2.dp,
                modifier = Modifier.size(14.dp),
            )
            Text(
                text = stringResource(R.string.connection_reconnecting),
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.padding(start = 8.dp),
            )
            notice.failure?.let { failure ->
                val reason = stringResource(reasonLabel(failure.reason))
                val label =
                    when (val code = failure.httpCode) {
                        null -> reason
                        else -> "$reason (${stringResource(R.string.connection_reason_http_code, code)})"
                    }
                Text(
                    text = "($label)",
                    style = MaterialTheme.typography.labelMedium,
                    color = Color.White.copy(alpha = 0.9f),
                    modifier = Modifier.padding(start = 6.dp),
                )
            }
        }
    }
}

/** Neutral "Syncing…" strip — the web `SyncingBanner.tsx` look. */
@Composable
private fun SyncingBanner(modifier: Modifier = Modifier) {
    BannerSurface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = MaterialTheme.colorScheme.onSurface,
        modifier = modifier,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
            CircularProgressIndicator(
                color = MaterialTheme.colorScheme.onSurface,
                trackColor = Color.Transparent,
                strokeWidth = 2.dp,
                modifier = Modifier.size(14.dp),
            )
            Text(
                text = stringResource(R.string.connection_syncing),
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.padding(start = 8.dp),
            )
        }
    }
}

@Composable
private fun BannerSurface(
    color: Color,
    contentColor: Color,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Surface(color = color, contentColor = contentColor, modifier = modifier.fillMaxWidth()) { content() }
}

/** Reason labels mirror the web locale keys (`reconnecting.reason.*`). */
private fun reasonLabel(reason: DisconnectReason): Int =
    when (reason) {
        DisconnectReason.HeartbeatTimeout -> R.string.connection_reason_heartbeat_timeout
        DisconnectReason.VisibilityRecovery -> R.string.connection_reason_visibility_recovery
        DisconnectReason.ConnectTimeout -> R.string.connection_reason_connect_timeout
        DisconnectReason.TransportError -> R.string.connection_reason_transport_error
        DisconnectReason.Closed -> R.string.connection_reason_closed
    }

/** Tailwind amber-500 — same anchor the scratchlist mode chrome uses. */
private val ConnectionAmber = Color(0xFFF59E0B)
