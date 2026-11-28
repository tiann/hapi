package app.hapi.companion.feature.settings

import android.text.format.DateFormat
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.data.api.ApiError
import app.hapi.protocol.catalog.AgentFlavor
import app.hapi.protocol.catalog.Flavors
import app.hapi.protocol.wire.AgentQuotaAccount
import java.text.SimpleDateFormat
import java.util.Date
import kotlin.math.roundToInt

@Composable
internal fun UsageQuotasSection(state: QuotaUiState, onRefresh: () -> Unit) {
    val status = (state.failure as? ApiError)?.status
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.quota_title),
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.titleSmall,
                )
                if (status != 403) {
                    TextButton(onClick = onRefresh, enabled = !state.loading) {
                        val label = if (state.loading) R.string.settings_storage_refreshing else R.string.settings_storage_refresh
                        Text(stringResource(label))
                    }
                }
            }
            if (state.failure != null) {
                val message = when (status) {
                    403 -> R.string.settings_owner_only
                    404 -> R.string.quota_older_hub
                    else -> if (state.snapshot == null) R.string.quota_error else R.string.quota_stale
                }
                Text(stringResource(message), style = MaterialTheme.typography.bodyMedium)
            }

            val machines = state.snapshot?.machines ?: return@Column
            var shown = false
            for (machine in machines) {
                val accounts = machine.accounts.filter { it.available || it.status != "unavailable" }
                val unsupported = !machine.supported || (machine.accounts.isEmpty() &&
                    machine.error?.contains("RPC method not available") == true)
                if (!unsupported && accounts.isEmpty() && machine.error.isNullOrBlank()) continue
                if (shown) HorizontalDivider()
                shown = true
                if (machines.size > 1 || unsupported || machine.error != null) {
                    Text(machine.machineName.ifBlank { machine.machineId }, style = MaterialTheme.typography.labelMedium)
                }
                if (unsupported) {
                    Text(stringResource(R.string.quota_runner), style = MaterialTheme.typography.bodyMedium)
                } else {
                    machine.error?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                    accounts.forEach { QuotaAccount(it) }
                }
            }
            if (!shown && state.failure == null) {
                Text(stringResource(R.string.quota_empty), style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

@Composable
private fun QuotaAccount(account: AgentQuotaAccount) {
    val name = if (AgentFlavor.isKnown(account.agent)) Flavors.label(account.agent) else account.agent
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(name, style = MaterialTheme.typography.titleSmall)
        val details = listOfNotNull(account.accountLabel, account.planLabel, account.creditsLabel)
            .filter { it.isNotBlank() }.joinToString(" · ")
        if (details.isNotEmpty()) Text(details, style = MaterialTheme.typography.bodySmall)
        val context = LocalContext.current
        account.buckets.forEach { bucket ->
            Text(bucket.label, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 4.dp))
            Text(
                stringResource(R.string.quota_remaining, bucket.remainingPercent.roundToInt(), bucket.usedPercent.roundToInt()),
                style = MaterialTheme.typography.bodySmall,
            )
            LinearProgressIndicator(
                progress = { (bucket.remainingPercent / 100).toFloat().coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth(),
            )
            bucket.resetsAt?.takeIf { it != 0L }?.let { timestamp ->
                val locale = LocalConfiguration.current.locales[0]
                val skeleton = if (DateFormat.is24HourFormat(context)) "MMMdHm" else "MMMdhm"
                val pattern = DateFormat.getBestDateTimePattern(locale, skeleton)
                val date = SimpleDateFormat(pattern, locale).format(Date(timestamp))
                Text(stringResource(R.string.quota_resets, date), style = MaterialTheme.typography.bodySmall)
            }
        }
        val note = account.note?.takeIf { it.isNotBlank() } ?: when (account.status) {
            "unauthenticated" -> stringResource(R.string.quota_unauthenticated)
            "custom_provider" -> stringResource(R.string.quota_custom_provider)
            "ok" -> if (account.buckets.isEmpty() && account.creditsLabel.isNullOrBlank()) stringResource(R.string.quota_error) else null
            else -> stringResource(R.string.quota_error)
        }
        note?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    }
}
