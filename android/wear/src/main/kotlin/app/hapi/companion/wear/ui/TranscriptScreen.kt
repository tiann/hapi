package app.hapi.companion.wear.ui

import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.app.RemoteInput
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.input.RemoteInputIntentHelper
import app.hapi.companion.wear.R
import app.hapi.companion.wear.data.WatchRepository
import app.hapi.companion.wear.data.WatchRequests
import app.hapi.companion.wear.data.WearLoadState
import app.hapi.companion.wear.data.WearMessageRow

private const val REPLY_KEY = "wear_reply"

@Composable
fun TranscriptScreen(sessionId: String) {
    val context = LocalContext.current
    val transcript by WatchRepository.transcript.collectAsState()
    val listState = rememberScalingLazyListState()

    LaunchedEffect(sessionId) { WatchRequests.requestMessages(context, sessionId) }

    val replyLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val text = result.data?.let { RemoteInput.getResultsFromIntent(it) }
            ?.getCharSequence(REPLY_KEY)?.toString()?.trim()
        if (!text.isNullOrEmpty()) WatchRequests.reply(context, sessionId, text, rawType = null)
    }

    Scaffold(positionIndicator = { PositionIndicator(scalingLazyListState = listState) }) {
        val (forSession, state) = transcript ?: (sessionId to WearLoadState.Loading)
        if (forSession != sessionId) {
            CenteredMessage("…")
            return@Scaffold
        }
        when (state) {
            is WearLoadState.Loading -> CenteredMessage("…")
            is WearLoadState.Error -> CenteredMessage(stringResource(R.string.sessions_error))
            is WearLoadState.Loaded -> {
                if (state.value.isEmpty()) {
                    CenteredMessage(stringResource(R.string.transcript_empty))
                } else {
                    ScalingLazyColumn(modifier = Modifier.fillMaxSize(), state = listState) {
                        items(state.value, key = { "${it.createdAt}-${it.text.hashCode()}" }) { line ->
                            MessageBubble(line)
                        }
                        item {
                            Chip(
                                onClick = { replyLauncher.launch(replyIntent(context)) },
                                label = { Text(stringResource(R.string.action_reply)) },
                                colors = ChipDefaults.primaryChipColors(),
                                modifier = Modifier.padding(vertical = 4.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MessageBubble(line: WearMessageRow) {
    Chip(
        onClick = {},
        label = { Text(line.text, maxLines = 4) },
        secondaryLabel = { Text(if (line.role == "user") "you" else "agent") },
        colors = if (line.role == "user") ChipDefaults.secondaryChipColors() else ChipDefaults.childChipColors(),
    )
}

private fun replyIntent(context: android.content.Context): Intent {
    val intent = RemoteInputIntentHelper.createActionRemoteInputIntent()
    // RemoteInputIntentHelper (the system mic/keyboard sheet) is a framework
    // API and wants framework android.app.RemoteInput here — androidx.core's
    // compat RemoteInput is only for NotificationCompat.Action (see
    // WearNotifications.kt). Reading the result back uses the compat
    // RemoteInput.getResultsFromIntent, which understands both.
    val remoteInputs = listOf(
        android.app.RemoteInput.Builder(REPLY_KEY).setLabel(context.getString(R.string.action_reply)).build()
    )
    RemoteInputIntentHelper.putRemoteInputsExtra(intent, remoteInputs)
    return intent
}
