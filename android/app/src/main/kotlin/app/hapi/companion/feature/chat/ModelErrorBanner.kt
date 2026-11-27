package app.hapi.companion.feature.chat

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.protocol.wire.ModelError

internal enum class ModelErrorStatus(@StringRes val title: Int) {
    Unrecovered(R.string.chat_model_error),
    Recovered(R.string.chat_model_error_recovered),
    BridgeFailed(R.string.chat_model_error_retry_failed),
}

internal val ModelError.recoveryStatus: ModelErrorStatus?
    get() = when {
        acknowledgedAt != null -> null
        retriedAndFailed == true -> ModelErrorStatus.BridgeFailed
        bridgedForEventId == eventId -> ModelErrorStatus.Recovered
        else -> ModelErrorStatus.Unrecovered
    }

internal val ModelError.isBridgeable: Boolean
    get() = recoveryStatus == ModelErrorStatus.Unrecovered && transient &&
        supersededByUserTurn != true && bridgeable != false && eventId.isNotBlank()

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ModelErrorBanner(
    error: ModelError?,
    canBridge: Boolean,
    bridging: Boolean,
    busy: Boolean,
    failureReason: String?,
    onBridge: (String) -> Unit,
    onDismiss: (String) -> Unit,
) {
    if (error == null) return
    val status = error.recoveryStatus ?: return
    var showRaw by remember(error.eventId) { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme
    val recovered = status == ModelErrorStatus.Recovered
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = if (recovered) colors.surfaceContainerHigh else colors.errorContainer,
        contentColor = if (recovered) colors.onSurface else colors.onErrorContainer,
    ) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
            Text(
                stringResource(status.title, error.kind),
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
            if (status == ModelErrorStatus.Unrecovered && error.priorAssistantClaimsDone) {
                Text(stringResource(R.string.chat_model_error_claimed_done), style = MaterialTheme.typography.bodySmall)
            }
            if (showRaw) {
                Text(
                    error.rawSnippet,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.heightIn(max = 88.dp).verticalScroll(rememberScrollState()),
                )
            }
            failureReason?.let {
                val message = when (it) {
                    "model_error_changed" -> stringResource(R.string.model_error_reason_model_error_changed)
                    "no_model_error" -> stringResource(R.string.model_error_reason_no_model_error)
                    "prompt_in_flight" -> stringResource(R.string.model_error_reason_prompt_in_flight)
                    "superseded_by_newer_turn" -> stringResource(R.string.model_error_reason_superseded_by_newer_turn)
                    "not_bridgeable" -> stringResource(R.string.model_error_reason_not_bridgeable)
                    "missing_last_user_message" -> stringResource(R.string.model_error_reason_missing_last_user_message)
                    else -> it
                }
                Text(
                    message,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
            FlowRow {
                if ((canBridge || bridging) && error.isBridgeable) {
                    TextButton(onClick = { onBridge(error.eventId) }, enabled = canBridge && !busy && !bridging) {
                        Text(stringResource(if (bridging) R.string.chat_model_error_bridging else R.string.chat_model_error_bridge))
                    }
                }
                TextButton(onClick = { onDismiss(error.eventId) }, enabled = !busy && error.eventId.isNotBlank()) {
                    Text(stringResource(R.string.notif_action_dismiss))
                }
                if (error.rawSnippet.isNotBlank()) {
                    TextButton(onClick = { showRaw = !showRaw }) {
                        Text(stringResource(if (showRaw) R.string.chat_model_error_hide_details else R.string.chat_question_details))
                    }
                }
            }
        }
    }
}
