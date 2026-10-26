package app.hapi.companion.feature.chat.blocks

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.chat.ChatInteractions

/** Client actions, not permissions. Folding the document never discards operation state. */
@Composable
internal fun CodexPlanActionsView(planId: String, interactions: ChatInteractions) {
    val state = interactions.codexPlanActions.forPlan(planId)
    if (!state.isVisible) return
    Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        state.error?.let { error ->
            Text(
                error.detail ?: stringResource(R.string.chat_notice_request_failed),
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.testTag("plan-error-$planId").semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
        if (state.available || state.pending) {
            // Stacked, untruncated labels work on narrow phones and large fonts.
            Button(
                onClick = { interactions.implementCodexPlan(planId) }, enabled = state.canAct,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("plan-implement-$planId"),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (state.pending) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    Text(stringResource(R.string.chat_plan_implement))
                }
            }
            OutlinedButton(
                onClick = { interactions.continueCodexPlan(planId) }, enabled = state.canAct,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("plan-continue-$planId"),
            ) {
                Text(stringResource(R.string.chat_plan_continue))
            }
        }
    }
}
