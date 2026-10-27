package app.hapi.companion.feature.home

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.RunnerSkew
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * Folded view of one skewed machine for [RunnerSkewBanner] — the row shape of
 * the web `RunnerVersionSkewBanner.tsx` list items.
 */
data class RunnerSkewRowUi(
    val machineId: String,
    /** `displayName ?? host ?? id` (web `machineDisplayHost`). */
    val host: String,
    val cliVersion: String?,
    /** Newer CLI already on disk (mtime drift) — restart becomes meaningful. */
    val newerBinaryOnDisk: Boolean,
    /** Restart enabled only when newer-on-disk AND supervised. */
    val canRestart: Boolean,
    val restarting: Boolean,
)

/** Snapshot the banner renders. */
data class RunnerSkewUiState(
    val rows: List<RunnerSkewRowUi> = emptyList(),
    val minimized: Boolean = false,
    val snoozed: Boolean = false,
    val restartError: String? = null,
) {
    val visible: Boolean get() = rows.isNotEmpty() && !snoozed
}

/**
 * Runner version-skew banner state (slice C-②): folds the machine list into
 * skewed rows (missing [RunnerSkew.REQUIRED_MACHINE_CAPABILITIES]) plus
 * minimize / snooze-1h / manual-restart chrome.
 *
 * The store feeding [machines] already drops inactive rows (web filters
 * `machine.active &&` on its side of the same contract). Minimize/snooze are
 * process-lifetime memory, matching the web's sessionStorage scope; the
 * snooze un-dismisses itself via a delayed clear.
 */
class RunnerSkewChrome(
    machines: StateFlow<List<Machine>>,
    private val restartRunner: suspend (machineId: String) -> Unit,
    private val scope: CoroutineScope,
    private val nowMs: () -> Long = { System.currentTimeMillis() },
) {
    private val minimized = MutableStateFlow(false)
    private val dismissedUntilMs = MutableStateFlow(0L)
    private val restartingId = MutableStateFlow<String?>(null)
    private val restartError = MutableStateFlow<String?>(null)

    val state: StateFlow<RunnerSkewUiState> =
        combine(machines, minimized, dismissedUntilMs, restartingId, restartError) { list, isMin, until, restarting, error ->
                RunnerSkewUiState(
                    rows = list
                        .filter { RunnerSkew.isMachineCapabilitySkewed(it.metadata?.capabilities) }
                        .map { machine ->
                            val metadata = machine.metadata
                            val newerOnDisk = RunnerSkew.cliBinaryUpdatedOnDisk(metadata)
                            RunnerSkewRowUi(
                                machineId = machine.id,
                                host = metadata?.displayName ?: metadata?.host ?: machine.id,
                                cliVersion = metadata?.happyCliVersion,
                                newerBinaryOnDisk = newerOnDisk,
                                canRestart = newerOnDisk && metadata?.supervisedRestart == true,
                                restarting = restarting == machine.id,
                            )
                        },
                    minimized = isMin,
                    snoozed = until > nowMs(),
                    restartError = error,
                )
            }
            .stateIn(scope, SharingStarted.Eagerly, RunnerSkewUiState())

    fun minimize() {
        minimized.value = true
    }

    fun expand() {
        minimized.value = false
    }

    /** Web `tempDismissRunnerSkew`: hide for 1 h, then self-un-dismiss. */
    fun snooze() {
        val until = nowMs() + RUNNER_SKEW_TEMP_DISMISS_MS
        dismissedUntilMs.value = until
        scope.launch {
            delay(RUNNER_SKEW_TEMP_DISMISS_MS)
            if (dismissedUntilMs.value == until) dismissedUntilMs.value = 0L
        }
    }

    /** `POST /api/machines/:id/restart-runner` via [restartRunner]. */
    fun restart(machineId: String) {
        if (restartingId.value != null) return
        scope.launch {
            restartingId.value = machineId
            restartError.value = null
            try {
                restartRunner(machineId)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                restartError.value = error.message ?: ""
            } finally {
                if (restartingId.value == machineId) restartingId.value = null
            }
        }
    }

    private companion object {
        /** Web `RUNNER_SKEW_TEMP_DISMISS_MS`. */
        const val RUNNER_SKEW_TEMP_DISMISS_MS = 60L * 60_000
    }
}

/**
 * The skew banner (slice C-②): expanded amber card listing skewed hosts with
 * a manual restart exit, or a one-line minimized chip. Hidden entirely while
 * snoozed or when nothing is skewed.
 */
@Composable
fun RunnerSkewBanner(chrome: RunnerSkewChrome, modifier: Modifier = Modifier) {
    val state by chrome.state.collectAsState()
    when {
        !state.visible -> Unit

        state.minimized -> Surface(
            color = SkewAmber.copy(alpha = 0.10f),
            contentColor = skewAmberText(),
            border = BorderStroke(2.dp, SkewAmber),
            shape = MaterialTheme.shapes.small,
            modifier = modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 2.dp)
                .clickable(onClick = chrome::expand),
        ) {
            Text(
                text = stringResource(
                    R.string.runner_skew_minimized,
                    state.rows.size,
                    state.rows.joinToString { it.host },
                ),
                style = MaterialTheme.typography.labelSmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }

        else -> Surface(
            color = SkewAmber.copy(alpha = 0.10f),
            contentColor = skewAmberText(),
            border = BorderStroke(2.dp, SkewAmber),
            shape = MaterialTheme.shapes.medium,
            modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        ) {
            Column(modifier = Modifier.padding(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = stringResource(R.string.runner_skew_summary_title, state.rows.size),
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = chrome::minimize) {
                        Text(stringResource(R.string.runner_skew_minimize))
                    }
                    TextButton(onClick = chrome::snooze) {
                        Text(stringResource(R.string.runner_skew_dismiss_temp))
                    }
                }
                Text(
                    text = stringResource(R.string.runner_skew_summary_body),
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(bottom = 4.dp),
                )
                state.rows.forEach { row ->
                    RunnerSkewRowCard(row, onRestart = { chrome.restart(row.machineId) })
                }
                state.restartError?.let { error ->
                    val detail = error.takeIf { it.isNotBlank() }?.let { ": $it" }.orEmpty()
                    Text(
                        text = stringResource(R.string.runner_skew_restart_failed) + detail,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun RunnerSkewRowCard(row: RunnerSkewRowUi, onRestart: () -> Unit) {
    Surface(
        color = SkewAmber.copy(alpha = 0.08f),
        contentColor = skewAmberText(),
        shape = MaterialTheme.shapes.small,
        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp)) {
            Column(modifier = Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(row.host, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    row.cliVersion?.let { version ->
                        Text(
                            text = " · CLI $version",
                            style = MaterialTheme.typography.labelMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                Text(
                    text = stringResource(
                        if (row.newerBinaryOnDisk) R.string.runner_skew_binary_updated_hint
                        else R.string.runner_skew_upgrade_cli_first,
                    ),
                    style = MaterialTheme.typography.labelSmall,
                    color = skewAmberHint(),
                )
            }
            TextButton(onClick = onRestart, enabled = row.canRestart && !row.restarting) {
                Text(
                    text = stringResource(
                        when {
                            row.restarting -> R.string.runner_skew_restarting
                            row.canRestart -> R.string.runner_skew_restart
                            else -> R.string.runner_skew_restart_unavailable
                        },
                    ),
                    maxLines = 1,
                )
            }
        }
    }
}

/** Tailwind amber-500 border, the web banner's `border-amber-500`. */
private val SkewAmber = Color(0xFFF59E0B)

/**
 * Text on the banner card. Light themes keep the web's amber-950; dark
 * themes switch to amber-100 — the 10%-alpha amber tint sits on whatever
 * the app background is, so contrast is derived from that background
 * (works for every theme incl. OLED) rather than the system dark flag.
 */
@Composable
private fun skewAmberText(): Color =
    if (MaterialTheme.colorScheme.background.luminance() < 0.5f) Color(0xFFFEF3C7) else Color(0xFF451A03)

/** Hint text: amber-800 light / amber-200 dark, same derivation as above. */
@Composable
private fun skewAmberHint(): Color =
    if (MaterialTheme.colorScheme.background.luminance() < 0.5f) Color(0xFFFDE68A) else Color(0xFF92400E)
