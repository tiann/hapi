package app.hapi.companion.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.protocol.wire.MACHINE_DISPLAY_NAME_MAX_LENGTH
import app.hapi.protocol.wire.Machine
import kotlinx.coroutines.launch

/**
 * Machines settings screen (web `/settings/machines` twin): online runners
 * from the live machine store, tap-a-name inline rename with the web save
 * semantics (unchanged draft = no request, empty name = back to hostname,
 * failure keeps the editor open with an inline error). The online badge reads
 * the in-memory machine payload, never a DB snapshot.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MachinesScreen(
    viewModel: MachinesViewModel,
    onBack: () -> Unit,
) {
    val machines by viewModel.machines.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_machines)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.settings_back),
                        )
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = stringResource(R.string.settings_machines_summary),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            MachineListContent(
                machines = machines,
                onRename = viewModel::rename,
            )
        }
    }
}

/** The section card with rows (or the empty state) — also the preview body. */
@Composable
internal fun MachineListContent(
    machines: List<Machine>,
    onRename: suspend (machineId: String, draft: String) -> RenameOutcome,
) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column {
            Text(
                text = stringResource(R.string.machines_your),
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp),
            )
            if (machines.isEmpty()) {
                Text(
                    text = stringResource(R.string.machines_empty),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                )
            } else {
                machines.forEachIndexed { index, machine ->
                    if (index > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    key(machine.id) {
                        MachineRow(machine = machine, onRename = onRename)
                    }
                }
            }
        }
    }
}

/**
 * One machine row. Tap the name to swap in the editor (web `MachineRow`);
 * IME Done or the check saves, the ✕ or leaving the row's edit discards.
 */
@Composable
internal fun MachineRow(
    machine: Machine,
    onRename: suspend (machineId: String, draft: String) -> RenameOutcome,
) {
    var editing by rememberSaveable(machine.id) { mutableStateOf(false) }
    var draft by rememberSaveable(machine.id) { mutableStateOf("") }
    var error by rememberSaveable(machine.id) { mutableStateOf(false) }
    var saving by remember(machine.id) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun startEditing() {
        draft = machine.metadata?.displayName ?: ""
        error = false
        editing = true
    }

    fun save() {
        // Guard against a double submit while the request is in flight (the
        // web twin's savingRef): the field and buttons disable under `saving`,
        // but IME events can still race the recomposition.
        if (saving) return
        scope.launch {
            saving = true
            try {
                when (onRename(machine.id, draft)) {
                    RenameOutcome.Saved, RenameOutcome.Unchanged -> {
                        editing = false
                        error = false
                    }
                    RenameOutcome.Failed -> error = true
                }
            } finally {
                saving = false
            }
        }
    }

    fun cancelEditing() {
        editing = false
        error = false
    }

    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                if (editing) {
                    OutlinedTextField(
                        value = draft,
                        onValueChange = { draft = it.take(MACHINE_DISPLAY_NAME_MAX_LENGTH) },
                        enabled = !saving,
                        singleLine = true,
                        isError = error,
                        placeholder = {
                            Text(
                                machine.metadata?.host
                                    ?: stringResource(R.string.machines_name_hint)
                            )
                        },
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { save() }),
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    val title = MachinesUi.title(machine)
                    val renameLabel = stringResource(R.string.machines_rename, title)
                    Text(
                        text = title,
                        style = MaterialTheme.typography.bodyLarge,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable(enabled = !saving, onClick = ::startEditing)
                            .semantics { contentDescription = renameLabel },
                    )
                }
                MachinesUi.subtitle(machine)?.let { subtitle ->
                    Text(
                        text = subtitle,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(top = 2.dp),
                    )
                }
                if (editing && error) {
                    Text(
                        text = stringResource(R.string.machines_rename_error),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(top = 2.dp),
                    )
                }
            }
            if (editing) {
                IconButton(onClick = ::save, enabled = !saving) {
                    Icon(
                        Icons.Filled.Check,
                        contentDescription = stringResource(R.string.machines_save),
                    )
                }
                IconButton(onClick = ::cancelEditing) {
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = stringResource(R.string.settings_cancel),
                    )
                }
            } else {
                MachineStatus(active = machine.active)
            }
        }
    }
}

/** Trailing online badge: dot + label, colored from the live payload. */
@Composable
private fun MachineStatus(active: Boolean) {
    val label = stringResource(
        if (active) R.string.machines_status_online else R.string.machines_status_offline
    )
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(start = 12.dp),
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .background(
                    color = if (active) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.outlineVariant
                    },
                    shape = CircleShape,
                ),
        )
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 6.dp),
        )
    }
}
