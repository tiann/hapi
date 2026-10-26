package app.hapi.companion.feature.agentterminal

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.terminal.MODIFIER_ALT
import app.hapi.companion.feature.terminal.MODIFIER_CTRL
import app.hapi.companion.feature.terminal.ModifierState
import app.hapi.companion.feature.terminal.TerminalStatus
import app.hapi.companion.feature.terminal.TerminalGrid
import app.hapi.companion.feature.terminal.TerminalUiState
import app.hapi.companion.feature.terminal.applyModifierState
import app.hapi.companion.feature.terminal.shouldResetModifiers

/** Status dot colors mirror the web indicator (emerald / amber / red / hint). */
private val AgentTerminalConnectedColor = Color(0xFF10B981)
private val AgentTerminalConnectingColor = Color(0xFBBF24)
private val AgentTerminalErrorColor = Color(0xFFEF4444)

/**
 * One agent-panel quick key: raw sequence, optional long-press alternate (web
 * `popup`), or a sticky modifier toggle (web `QuickInput`, `QUICK_INPUT_ROWS`).
 */
private data class AgentQuickKey(
    val label: String,
    /** Bytes sent on tap; null for modifier toggles. */
    val sequence: String? = null,
    /** Content description / accessibility label (English, like the web table). */
    val description: String,
    /** Present ⇒ the key toggles a sticky modifier instead of sending. */
    val modifier: String? = null,
    /** Long-press alternate (web long-press popup): label + sequence. */
    val longPress: Pair<String, String>? = null,
)

/**
 * Web `QUICK_INPUT_ROWS` (AgentTerminalView's compact touch input): two rows
 * of seven keys, with long-press alternates on `/` → `?` and `-` → `|`.
 */
private val AGENT_QUICK_KEY_ROWS: List<List<AgentQuickKey>> = listOf(
    listOf(
        AgentQuickKey("Esc", "\u001b", "Escape"),
        AgentQuickKey("/", "/", "Forward slash", longPress = "?" to "?"),
        AgentQuickKey("-", "-", "Hyphen", longPress = "|" to "|"),
        AgentQuickKey("Home", "\u001b[H", "Home"),
        AgentQuickKey("↑", "\u001b[A", "Arrow up"),
        AgentQuickKey("End", "\u001b[F", "End"),
        AgentQuickKey("PgUp", "\u001b[5~", "Page up"),
    ),
    listOf(
        AgentQuickKey("Tab", "\t", "Tab"),
        AgentQuickKey("Ctrl", description = "Control", modifier = MODIFIER_CTRL),
        AgentQuickKey("Alt", description = "Alternate", modifier = MODIFIER_ALT),
        AgentQuickKey("←", "\u001b[D", "Arrow left"),
        AgentQuickKey("↓", "\u001b[B", "Arrow down"),
        AgentQuickKey("→", "\u001b[C", "Arrow right"),
        AgentQuickKey("PgDn", "\u001b[6~", "Page down"),
    ),
)

/**
 * Chat-embedded agent PTY view, the Android twin of the web
 * `AgentTerminalView`: status strip, shared [TerminalGrid] cell rendering with
 * auto-scroll, and the web quick-key rows (input is interactive — the panel is
 * NOT read-only). Composition drives the subscription lifecycle: entering
 * composition subscribes, leaving unsubscribes (the hub idles the CLI when the
 * last viewer goes), exactly like the web `visible` effect.
 */
@Composable
internal fun AgentTerminalPanel(
    viewModel: AgentTerminalViewModel,
    onHide: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.uiState.collectAsState()

    // Web visible-effect: (re)entry resubscribes + repaints; leaving (hidden
    // or unmounted) unsubscribes so the CLI can stop streaming. onDispose also
    // covers screen destroy and session switch (holder close() is the final
    // belt-and-braces stop).
    DisposableEffect(viewModel) {
        viewModel.setVisible(true)
        onDispose { viewModel.setVisible(false) }
    }

    Column(modifier = modifier.fillMaxSize()) {
        AgentTerminalStrip(state = state, onHide = onHide)
        when (state.gate) {
            AgentTerminalGate.LOADING -> GateBody(text = stringResource(R.string.agent_terminal_gate_loading))
            AgentTerminalGate.NOT_PTY -> GateBody(text = stringResource(R.string.agent_terminal_gate_not_pty))
            AgentTerminalGate.INACTIVE -> GateBody(text = stringResource(R.string.agent_terminal_gate_inactive))
            AgentTerminalGate.OK -> {
                val status = state.status
                if (status is TerminalStatus.Error) {
                    AgentTerminalErrorBanner(message = status.message, onRetry = viewModel::retry)
                }
                TerminalGrid(
                    // Synthesized slice-B state: the grid is a pure function of
                    // the snapshot + font (web hardcodes fontSize 13).
                    state = TerminalUiState(
                        snapshot = state.snapshot,
                        fontSizeSp = viewModel.fontSizeSp,
                    ),
                    onGridMeasured = viewModel::onGridMeasured,
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f),
                )
                AgentQuickKeys(
                    // Web QuickKeyRows: disabled unless the socket is connected.
                    enabled = status == TerminalStatus.Connected,
                    onSend = viewModel::sendInput,
                )
            }
        }
    }
}

// ------------------------------------------------------------------- strip --

@Composable
private fun AgentTerminalStrip(state: AgentTerminalUiState, onHide: () -> Unit) {
    val status = state.status
    val (color, text) = when {
        status == TerminalStatus.Connected && state.subscribed ->
            AgentTerminalConnectedColor to stringResource(R.string.agent_terminal_status_connected)
        status == TerminalStatus.Connecting ->
            AgentTerminalConnectingColor to stringResource(R.string.agent_terminal_status_connecting)
        status is TerminalStatus.Error ->
            AgentTerminalErrorColor to stringResource(R.string.agent_terminal_status_error, status.message)
        else ->
            // Socket idle / not subscribed: the viewer is NOT attached to the
            // PTY stream (the required idle indication — web has no such state
            // because an unsubscribed panel is display:none).
            MaterialTheme.colorScheme.onSurfaceVariant to stringResource(R.string.agent_terminal_status_idle)
    }
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(start = 16.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(10.dp)
                    .background(color, CircleShape),
            )
            Text(
                text = text,
                style = MaterialTheme.typography.labelMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 10.dp),
            )
            TextButton(onClick = onHide) { Text(stringResource(R.string.agent_terminal_hide)) }
        }
    }
}

/** Gate refusal / still-loading body: the reason instead of a silent blank. */
@Composable
private fun GateBody(text: String, modifier: Modifier = Modifier) {
    Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 24.dp),
        )
    }
}

@Composable
private fun AgentTerminalErrorBanner(message: String, onRetry: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = message,
                style = MaterialTheme.typography.labelMedium,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 16.dp, top = 8.dp, bottom = 8.dp),
            )
            TextButton(onClick = onRetry) { Text(stringResource(R.string.terminal_retry)) }
        }
    }
}

// -------------------------------------------------------------- quick keys --

/**
 * Web `QuickKeyRows` + `useQuickKeyInput`: sticky Ctrl/Alt shared by every key
 * (toggling one clears the other), consumed by the first real send. There is
 * no command box — the web agent panel's only input surfaces are the xterm
 * itself (desktop) and these rows; on Android the rows are the input surface.
 */
@Composable
private fun AgentQuickKeys(
    enabled: Boolean,
    onSend: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    // Sticky Ctrl/Alt (panel-local; leaving the panel resets them, like the
    // web component unmounting its modifier state).
    var ctrlActive by remember { mutableStateOf(false) }
    var altActive by remember { mutableStateOf(false) }

    fun resetModifiers() {
        ctrlActive = false
        altActive = false
    }

    /** Quick-key dispatch: apply sticky modifiers, send, consume them. */
    fun dispatch(sequence: String) {
        if (!enabled || sequence.isEmpty()) return
        val modifierState = ModifierState(ctrl = ctrlActive, alt = altActive)
        onSend(applyModifierState(sequence, modifierState))
        if (shouldResetModifiers(sequence, modifierState)) resetModifiers()
    }

    val rowLabel = stringResource(R.string.agent_terminal_quick_keys)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 4.dp)
            .semantics { contentDescription = rowLabel },
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        AGENT_QUICK_KEY_ROWS.forEach { row ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                row.forEach { key ->
                    val sticky = key.modifier
                    val active = (sticky == MODIFIER_CTRL && ctrlActive) ||
                        (sticky == MODIFIER_ALT && altActive)
                    if (sticky != null) {
                        ModifierKeyButton(
                            label = key.label,
                            enabled = enabled,
                            active = active,
                            onToggle = {
                                // Web toggleModifier: enabling one clears the other.
                                if (sticky == MODIFIER_CTRL) {
                                    ctrlActive = !ctrlActive
                                    altActive = false
                                } else {
                                    altActive = !altActive
                                    ctrlActive = false
                                }
                            },
                            description = key.description,
                            // weight lives here: the button itself is not in RowScope.
                            modifier = Modifier.weight(1f),
                        )
                    } else {
                        SequenceKeyButton(
                            label = key.label,
                            enabled = enabled,
                            onSend = { dispatch(key.sequence.orEmpty()) },
                            onLongPress = key.longPress?.second?.let { alternate -> { dispatch(alternate) } },
                            description = if (key.longPress != null) {
                                stringResource(
                                    R.string.agent_terminal_long_press_format,
                                    key.description,
                                    key.longPress.first,
                                )
                            } else {
                                key.description
                            },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
        }
    }
}

/** Sticky modifier toggle: filled while active (web aria-pressed styling). */
@Composable
private fun ModifierKeyButton(
    label: String,
    enabled: Boolean,
    active: Boolean,
    onToggle: () -> Unit,
    description: String,
    modifier: Modifier = Modifier,
) {
    Button(
        onClick = onToggle,
        enabled = enabled,
        modifier = modifier
            .heightIn(min = 36.dp)
            .semantics { contentDescription = description },
        colors = if (active) {
            ButtonDefaults.buttonColors()
        } else {
            ButtonDefaults.buttonColors(
                containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                contentColor = MaterialTheme.colorScheme.onSurface,
            )
        },
    ) {
        Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * Sequence key with an optional long-press alternate (web popup keys: tap `/`
 * sends `/`, long-press sends `?`). combinedClickable — not Button+pointerInput
 * — so a long press never double-fires the tap action.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SequenceKeyButton(
    label: String,
    enabled: Boolean,
    onSend: () -> Unit,
    onLongPress: (() -> Unit)?,
    description: String,
    modifier: Modifier = Modifier,
) {
    Surface(
        shape = MaterialTheme.shapes.extraSmall,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = MaterialTheme.colorScheme.onSurface,
        modifier = modifier
            .heightIn(min = 36.dp)
            .semantics { contentDescription = description }
            // Web disabled styling (opacity-50) for the non-button key flavor.
            .alpha(if (enabled) 1f else 0.5f)
            .combinedClickable(
                enabled = enabled,
                onClick = onSend,
                onLongClick = onLongPress,
            ),
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(horizontal = 4.dp)) {
            Text(
                label,
                style = MaterialTheme.typography.labelMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
