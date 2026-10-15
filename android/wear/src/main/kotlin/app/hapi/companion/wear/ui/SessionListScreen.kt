package app.hapi.companion.wear.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ListHeader
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import app.hapi.companion.wear.R
import app.hapi.companion.wear.data.WatchRepository
import app.hapi.companion.wear.data.WatchRequests
import app.hapi.companion.wear.data.WearLoadState
import app.hapi.companion.wear.data.WearSessionRow

private val StatusDotPending = Color(0xFFF59E0B)
private val StatusDotActive = Color(0xFF22C55E)
private val StatusDotIdle = Color(0xFF6B7280)

@Composable
fun SessionListScreen(onOpenSession: (String) -> Unit) {
    val context = LocalContext.current
    val state by WatchRepository.sessions.collectAsState()
    val listState = rememberScalingLazyListState()

    LaunchedEffect(Unit) { WatchRequests.requestSessions(context) }

    Scaffold(positionIndicator = { PositionIndicator(scalingLazyListState = listState) }) {
        when (val value = state) {
            is WearLoadState.Loading -> CenteredMessage("…")
            is WearLoadState.Error -> CenteredMessage(
                if (value.reason == "not_paired") stringResource(R.string.not_paired) else stringResource(R.string.sessions_error)
            )
            is WearLoadState.Loaded -> if (value.value.isEmpty()) {
                CenteredMessage(stringResource(R.string.sessions_empty))
            } else {
                ScalingLazyColumn(modifier = Modifier.fillMaxSize(), state = listState) {
                    item { ListHeader { Text(stringResource(R.string.app_name)) } }
                    items(value.value, key = { it.id }) { session ->
                        SessionRow(session, onClick = { onOpenSession(session.id) })
                    }
                }
            }
        }
    }
}

@Composable
private fun SessionRow(session: WearSessionRow, onClick: () -> Unit) {
    val dotColor = when {
        session.pendingRequestKinds.isNotEmpty() -> StatusDotPending
        session.active -> StatusDotActive
        else -> StatusDotIdle
    }
    val secondary = when {
        session.pendingRequestKinds.isNotEmpty() -> session.pendingRequestKinds.first()
        session.thinking -> "thinking"
        session.active -> "active"
        else -> "idle"
    }
    Chip(
        onClick = onClick,
        label = { Text(session.name, maxLines = 1) },
        secondaryLabel = { Text(secondary, maxLines = 1) },
        icon = { Box(modifier = Modifier.size(8.dp).background(dotColor, CircleShape)) },
        modifier = Modifier.padding(vertical = 2.dp),
    )
}

@Composable
internal fun CenteredMessage(text: String) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(text, textAlign = TextAlign.Center, modifier = Modifier.padding(16.dp))
    }
}
