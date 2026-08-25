package app.hapi.companion.feature.newsession

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.directorybrowser.RemoteDirectoryBrowserSheet
import app.hapi.companion.ui.components.AgentFlavorIcon
import app.hapi.companion.ui.theme.HapiTheme

/**
 * NEW SESSION (B-M3d): machine → directory → agent/options → spawn. State
 * and behavior live in [NewSessionViewModel]; this screen renders
 * [NewSessionUiState] and forwards intents. Successful spawns surface
 * through [NewSessionViewModel.spawned] → [onCreated] (navigate-replace to
 * the chat).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewSessionScreen(
    viewModel: NewSessionViewModel,
    onBack: () -> Unit,
    onCreated: (sessionId: String) -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val directoryBrowser by viewModel.directoryBrowser.state.collectAsState()

    LaunchedEffect(viewModel) {
        viewModel.spawned.collect(onCreated)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.new_session_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.new_session_back),
                        )
                    }
                },
            )
        },
    ) { padding ->
        NewSessionContent(
            state = state,
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            onMachineSelected = viewModel::setMachine,
            onDirectoryChange = viewModel::setDirectory,
            onSuggestionPicked = viewModel::pickSuggestion,
            onRecentPathPicked = viewModel::pickRecentPath,
            onBrowseDirectory = viewModel::openDirectoryBrowser,
            onSessionTypeChange = viewModel::setSessionType,
            onWorktreeNameChange = viewModel::setWorktreeName,
            onAgentSelected = viewModel::setAgent,
            onRetryAgentAvailability = viewModel::retryAgentAvailability,
            onModelSelected = viewModel::setModel,
            onEffortSelected = viewModel::setEffort,
            onReasoningEffortSelected = viewModel::setModelReasoningEffort,
            onPermissionModeSelected = viewModel::setPermissionMode,
            onYoloToggle = viewModel::setYolo,
            onCollaborationModeSelected = viewModel::setCollaborationMode,
            onCopilotAgentModeSelected = viewModel::setCopilotAgentMode,
            onServiceTierSelected = viewModel::setServiceTier,
            onCreate = viewModel::create,
        )
    }
    if (directoryBrowser.open) {
        RemoteDirectoryBrowserSheet(
            state = directoryBrowser,
            onDismiss = viewModel.directoryBrowser::close,
            onNavigate = viewModel.directoryBrowser::navigate,
            onNavigateEntry = viewModel.directoryBrowser::navigateEntry,
            onNavigateUp = viewModel.directoryBrowser::navigateUp,
            onRefresh = viewModel.directoryBrowser::refresh,
            onIncludeHiddenChange = viewModel.directoryBrowser::setIncludeHidden,
            onSelect = viewModel::selectBrowsedDirectory,
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun NewSessionContent(
    state: NewSessionUiState,
    modifier: Modifier = Modifier,
    onMachineSelected: (String) -> Unit,
    onDirectoryChange: (String) -> Unit,
    onSuggestionPicked: (String) -> Unit,
    onRecentPathPicked: (String) -> Unit,
    onBrowseDirectory: () -> Unit = {},
    onSessionTypeChange: (String) -> Unit,
    onWorktreeNameChange: (String) -> Unit,
    onAgentSelected: (String) -> Unit,
    onRetryAgentAvailability: () -> Unit = {},
    onModelSelected: (String) -> Unit,
    onEffortSelected: (String) -> Unit,
    onReasoningEffortSelected: (String) -> Unit,
    onPermissionModeSelected: (String) -> Unit,
    onYoloToggle: (Boolean) -> Unit,
    onCollaborationModeSelected: (String) -> Unit,
    onCopilotAgentModeSelected: (String) -> Unit,
    onServiceTierSelected: (String) -> Unit,
    onCreate: () -> Unit,
) {
    val form = state.form
    Column(
        modifier = modifier
            .verticalScroll(rememberScrollState())
            .imePadding()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        MachineSection(state, onMachineSelected)
        DirectorySection(
            state = state,
            onDirectoryChange = onDirectoryChange,
            onSuggestionPicked = onSuggestionPicked,
            onRecentPathPicked = onRecentPathPicked,
            onBrowseDirectory = onBrowseDirectory,
        )
        SessionTypeSection(state, onSessionTypeChange, onWorktreeNameChange)
        AgentSection(state, onAgentSelected, onRetryAgentAvailability)

        state.modelOptions?.let { options ->
            OptionDropdown(
                label = stringResource(R.string.new_session_model),
                options = options,
                selected = form.model,
                enabled = !state.isSpawning && !state.modelsLoading && state.modelsError == null,
                loading = state.modelsLoading,
                supportingError = state.modelsError,
                onSelect = onModelSelected,
            )
        }
        state.effortOptions?.let { options ->
            OptionDropdown(
                label = stringResource(R.string.new_session_effort),
                options = options,
                selected = form.effort,
                enabled = !state.isSpawning,
                onSelect = onEffortSelected,
            )
        }
        state.reasoningEffortOptions?.let { options ->
            OptionDropdown(
                label = stringResource(R.string.new_session_reasoning_effort),
                options = options,
                selected = form.modelReasoningEffort,
                enabled = !state.isSpawning && !state.modelsLoading,
                onSelect = onReasoningEffortSelected,
            )
        }

        PermissionSection(state, onPermissionModeSelected, onYoloToggle)

        if (state.showCollaborationMode) {
            OptionDropdown(
                label = stringResource(R.string.new_session_collaboration_mode),
                options = state.collaborationModeOptions,
                selected = form.collaborationMode,
                enabled = !state.isSpawning,
                onSelect = onCollaborationModeSelected,
            )
        }
        if (state.showCopilotAgentMode) {
            OptionDropdown(
                label = stringResource(R.string.new_session_copilot_agent_mode),
                options = state.copilotAgentModeOptions,
                selected = form.copilotAgentMode,
                enabled = !state.isSpawning,
                onSelect = onCopilotAgentModeSelected,
            )
        }
        if (state.showFastMode) {
            OptionDropdown(
                label = stringResource(R.string.new_session_fast_mode),
                options = listOf(
                    OptionItem("standard", stringResource(R.string.new_session_fast_mode_standard)),
                    OptionItem("fast", stringResource(R.string.new_session_fast_mode_fast)),
                ),
                selected = form.serviceTier,
                enabled = !state.isSpawning,
                onSelect = onServiceTierSelected,
            )
        }

        state.spawnError?.let { error ->
            Text(
                text = error,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        Button(
            onClick = onCreate,
            enabled = state.canCreate,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (state.isSpawning) {
                CircularProgressIndicator(
                    modifier = Modifier.padding(end = 8.dp),
                    strokeWidth = 2.dp,
                )
            }
            Text(
                text = stringResource(
                    when {
                        state.isSpawning -> R.string.new_session_creating
                        state.confirmCreateDirectory -> R.string.new_session_create_and_make_directory
                        else -> R.string.new_session_create
                    },
                ),
            )
        }
    }
}

// ---------------------------------------------------------------- machine --

@Composable
private fun MachineSection(state: NewSessionUiState, onMachineSelected: (String) -> Unit) {
    val selected = state.machines.firstOrNull { it.id == state.form.machineId }
    OptionDropdown(
        label = stringResource(R.string.new_session_machine),
        options = state.machines.map { OptionItem(it.id, it.label) },
        selected = state.form.machineId.orEmpty(),
        selectedLabelFallback = when {
            state.machinesLoading -> stringResource(R.string.new_session_machines_loading)
            state.machines.isEmpty() -> stringResource(R.string.new_session_no_machines)
            else -> ""
        },
        enabled = !state.isSpawning && state.machines.isNotEmpty(),
        onSelect = onMachineSelected,
    )
    selected?.healthLabel?.let { health ->
        Text(
            text = health,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    state.runnerSpawnError?.let { error ->
        Text(
            text = stringResource(R.string.new_session_runner_spawn_error, error),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error,
        )
    }
}

// -------------------------------------------------------------- directory --

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DirectorySection(
    state: NewSessionUiState,
    onDirectoryChange: (String) -> Unit,
    onSuggestionPicked: (String) -> Unit,
    onRecentPathPicked: (String) -> Unit,
    onBrowseDirectory: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        OutlinedTextField(
            value = state.form.directory,
            onValueChange = onDirectoryChange,
            label = { Text(stringResource(R.string.new_session_directory)) },
            placeholder = { Text(stringResource(R.string.new_session_directory_placeholder)) },
            singleLine = true,
            enabled = !state.isSpawning,
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                imeAction = ImeAction.Done,
            ),
            trailingIcon = {
                IconButton(onClick = onBrowseDirectory, enabled = !state.isSpawning) {
                    Icon(Icons.Default.Search, contentDescription = stringResource(R.string.new_session_browse))
                }
            },
            modifier = Modifier.fillMaxWidth(),
        )

        // Server-side autocomplete (list-directory on the parent path).
        if (state.suggestions.isNotEmpty()) {
            Surface(
                tonalElevation = 2.dp,
                shape = MaterialTheme.shapes.small,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column {
                    state.suggestions.forEachIndexed { index, suggestion ->
                        if (index > 0) HorizontalDivider()
                        DropdownMenuItem(
                            text = {
                                Text(
                                    text = suggestion,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            },
                            onClick = { onSuggestionPicked(suggestion) },
                        )
                    }
                }
            }
        }

        if (state.recentPaths.isNotEmpty()) {
            Text(
                text = stringResource(R.string.new_session_recent_paths),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(0.dp),
            ) {
                state.recentPaths.forEach { path ->
                    AssistChip(
                        onClick = { onRecentPathPicked(path) },
                        enabled = !state.isSpawning,
                        label = {
                            Text(
                                // Chips get crowded fast; lead with the tail.
                                text = path,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        },
                    )
                }
            }
        }

        state.directoryStatus?.let { status ->
            Text(
                text = status.message,
                style = MaterialTheme.typography.bodySmall,
                color = if (status.isError) {
                    MaterialTheme.colorScheme.error
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
        }
    }
}

// ----------------------------------------------------------- session type --

@Composable
private fun SessionTypeSection(
    state: NewSessionUiState,
    onSessionTypeChange: (String) -> Unit,
    onWorktreeNameChange: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        SectionLabel(stringResource(R.string.new_session_type))
        Row(verticalAlignment = Alignment.CenterVertically) {
            RadioButton(
                selected = state.form.sessionType == SESSION_TYPE_SIMPLE,
                onClick = { onSessionTypeChange(SESSION_TYPE_SIMPLE) },
                enabled = !state.isSpawning,
            )
            Column {
                Text(stringResource(R.string.new_session_type_simple), style = MaterialTheme.typography.bodyMedium)
                Text(
                    text = stringResource(R.string.new_session_type_simple_desc),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            RadioButton(
                selected = state.form.sessionType == SESSION_TYPE_WORKTREE,
                onClick = { onSessionTypeChange(SESSION_TYPE_WORKTREE) },
                enabled = !state.isSpawning,
            )
            Column {
                Text(stringResource(R.string.new_session_type_worktree), style = MaterialTheme.typography.bodyMedium)
                Text(
                    text = stringResource(R.string.new_session_type_worktree_desc),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (state.form.sessionType == SESSION_TYPE_WORKTREE) {
            OutlinedTextField(
                value = state.form.worktreeName,
                onValueChange = onWorktreeNameChange,
                label = { Text(stringResource(R.string.new_session_worktree_name)) },
                placeholder = { Text(stringResource(R.string.new_session_worktree_name_placeholder)) },
                singleLine = true,
                enabled = !state.isSpawning,
                isError = state.worktreeNameError != null,
                supportingText = state.worktreeNameError?.let { { Text(it) } },
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 12.dp),
            )
        }
    }
}

// ------------------------------------------------------------------ agent --

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AgentSection(
    state: NewSessionUiState,
    onAgentSelected: (String) -> Unit,
    onRetryAvailability: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        SectionLabel(stringResource(R.string.new_session_agent))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            state.agents.forEach { agent ->
                FilterChip(
                    selected = state.form.agent == agent.value,
                    onClick = { onAgentSelected(agent.value) },
                    enabled = !state.isSpawning && !state.agentAvailabilityLoading && state.agentAvailabilityError == null,
                    leadingIcon = { AgentFlavorIcon(agent.value, modifier = Modifier.size(16.dp)) },
                    label = { Text(agent.label) },
                )
            }
        }
        if (state.agentAvailabilityLoading) {
            Text(
                stringResource(R.string.new_session_agent_availability_loading),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        state.agentAvailabilityError?.let { error ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    error,
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
                TextButton(onClick = onRetryAvailability) {
                    Text(stringResource(R.string.new_session_retry))
                }
            }
        }
    }
}

// ------------------------------------------------------------- permission --

@Composable
private fun PermissionSection(
    state: NewSessionUiState,
    onPermissionModeSelected: (String) -> Unit,
    onYoloToggle: (Boolean) -> Unit,
) {
    when (val permission = state.permission) {
        is PermissionUi.NativeSelect -> OptionDropdown(
            label = stringResource(R.string.new_session_permission_mode),
            options = permission.options,
            selected = state.form.permissionMode,
            enabled = !state.isSpawning,
            onSelect = onPermissionModeSelected,
        )

        is PermissionUi.YoloToggle -> Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            SectionLabel(stringResource(R.string.new_session_yolo))
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = stringResource(R.string.new_session_yolo_title),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        text = stringResource(R.string.new_session_yolo_desc),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    permission.nativeModeLabel?.let { mode ->
                        Text(
                            text = stringResource(R.string.new_session_yolo_maps_to, mode),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                Switch(
                    checked = state.form.yolo,
                    onCheckedChange = onYoloToggle,
                    enabled = !state.isSpawning,
                )
            }
        }

        PermissionUi.Managed -> Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            SectionLabel(stringResource(R.string.new_session_permission_mode))
            Text(
                text = stringResource(R.string.new_session_permission_managed),
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                text = stringResource(R.string.new_session_permission_managed_desc),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

// ---------------------------------------------------------------- helpers --

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OptionDropdown(
    label: String,
    options: List<OptionItem>,
    selected: String,
    enabled: Boolean,
    onSelect: (String) -> Unit,
    loading: Boolean = false,
    supportingError: String? = null,
    selectedLabelFallback: String = "",
) {
    var expanded by remember { mutableStateOf(false) }
    val selectedLabel = options.firstOrNull { it.value == selected }?.label ?: selectedLabelFallback

    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        ExposedDropdownMenuBox(
            expanded = expanded && enabled,
            onExpandedChange = { if (enabled) expanded = it },
        ) {
            OutlinedTextField(
                value = if (loading) stringResource(R.string.new_session_loading) else selectedLabel,
                onValueChange = {},
                readOnly = true,
                enabled = enabled,
                label = { Text(label) },
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded && enabled) },
                modifier = Modifier
                    .fillMaxWidth()
                    .menuAnchor(MenuAnchorType.PrimaryNotEditable, enabled),
            )
            ExposedDropdownMenu(
                expanded = expanded && enabled,
                onDismissRequest = { expanded = false },
            ) {
                options.forEach { option ->
                    DropdownMenuItem(
                        text = { Text(option.label) },
                        onClick = {
                            expanded = false
                            onSelect(option.value)
                        },
                    )
                }
            }
        }
        supportingError?.let { error ->
            Text(
                text = error,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

// ---------------------------------------------------------------- preview --

private fun previewState(form: NewSessionForm): NewSessionUiState = NewSessionUiState(
    form = form,
    machines = listOf(
        MachineOptionUi("m1", "devbox (linux) · CLI 0.42.0", "CPU 12% · Mem 45%"),
        MachineOptionUi("m2", "mac-mini (darwin) · CLI 0.42.0", null),
    ),
    machinesLoading = false,
    runnerSpawnError = null,
    suggestions = listOf("/data/github/hapi", "/data/github/hub"),
    recentPaths = listOf("/data/github/hapi", "/home/dev/scratch"),
    directoryStatus = DirectoryStatusUi(
        NewSessionViewModel.MSG_DIRECTORY_MISSING,
        isError = false,
    ),
    agents = listOf(
        OptionItem("claude", "Claude"),
        OptionItem("codex", "Codex"),
        OptionItem("grok", "Grok Build"),
    ),
    agentAvailabilityLoading = false,
    agentAvailabilityError = null,
    modelOptions = NewSessionCatalogs.CLAUDE_MODELS,
    modelsLoading = false,
    modelsError = null,
    effortOptions = NewSessionCatalogs.CLAUDE_EFFORTS,
    reasoningEffortOptions = null,
    permission = PermissionUi.YoloToggle("Yolo"),
    showCollaborationMode = false,
    collaborationModeOptions = emptyList(),
    showFastMode = false,
    showCopilotAgentMode = false,
    copilotAgentModeOptions = emptyList(),
    worktreeNameError = null,
    isSpawning = false,
    spawnError = null,
    canCreate = true,
    confirmCreateDirectory = false,
)

@Preview(showBackground = true)
@Composable
private fun NewSessionPreviewClaude() {
    HapiTheme {
        Surface {
            NewSessionContent(
                state = previewState(
                    NewSessionForm(machineId = "m1", directory = "/data/github/hap", agent = "claude"),
                ),
                onMachineSelected = {},
                onDirectoryChange = {},
                onSuggestionPicked = {},
                onRecentPathPicked = {},
                onSessionTypeChange = {},
                onWorktreeNameChange = {},
                onAgentSelected = {},
                onModelSelected = {},
                onEffortSelected = {},
                onReasoningEffortSelected = {},
                onPermissionModeSelected = {},
                onYoloToggle = {},
                onCollaborationModeSelected = {},
                onCopilotAgentModeSelected = {},
                onServiceTierSelected = {},
                onCreate = {},
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun NewSessionPreviewCodexWorktree() {
    HapiTheme {
        Surface {
            NewSessionContent(
                state = previewState(
                    NewSessionForm(
                        machineId = "m1",
                        directory = "/data/github/hapi",
                        agent = "codex",
                        sessionType = SESSION_TYPE_WORKTREE,
                        worktreeName = "feature-x",
                    ),
                ).copy(
                    modelOptions = listOf(OptionItem("auto", "Default"), OptionItem("gpt-5.2-codex", "GPT-5.2 Codex")),
                    effortOptions = null,
                    reasoningEffortOptions = NewSessionCatalogs.CODEX_REASONING_EFFORTS,
                    permission = PermissionUi.NativeSelect(
                        listOf(
                            OptionItem("default", "Default"),
                            OptionItem("read-only", "Read Only"),
                            OptionItem("safe-yolo", "Safe Yolo"),
                            OptionItem("yolo", "Yolo"),
                        ),
                    ),
                    showCollaborationMode = true,
                    collaborationModeOptions = listOf(OptionItem("default", "Default"), OptionItem("plan", "Plan")),
                    showFastMode = true,
                    directoryStatus = null,
                ),
                onMachineSelected = {},
                onDirectoryChange = {},
                onSuggestionPicked = {},
                onRecentPathPicked = {},
                onSessionTypeChange = {},
                onWorktreeNameChange = {},
                onAgentSelected = {},
                onModelSelected = {},
                onEffortSelected = {},
                onReasoningEffortSelected = {},
                onPermissionModeSelected = {},
                onYoloToggle = {},
                onCollaborationModeSelected = {},
                onCopilotAgentModeSelected = {},
                onServiceTierSelected = {},
                onCreate = {},
            )
        }
    }
}
