package app.hapi.companion.feature.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.hapi.companion.R

/**
 * Display subpage of the settings hub (P2): the web `/settings/display` page
 * scoped to this roadmap slice — session-list preferences (preview limit,
 * active-only, pin-in-progress, status mode), the ten session-metadata
 * switches, and the font-scale tiers. Appearance (theme/Material You) stays
 * on the General subpage; fields whose Android consumption surface has not
 * landed on this branch still persist here, defaults aligned with the web.
 */
@Composable
fun SettingsDisplayScreen(
    viewModel: DisplayViewModel,
    onBack: () -> Unit,
) {
    val settings by viewModel.settings.collectAsState()

    SettingsDisplayContent(
        settings = settings,
        onSetSessionPreviewLimit = viewModel::setSessionPreviewLimit,
        onSetShowActiveSessionsOnly = viewModel::setShowActiveSessionsOnly,
        onSetPinInProgressSessions = viewModel::setPinInProgressSessions,
        onSetSessionListStatusMode = viewModel::setSessionListStatusMode,
        onSetFontScale = viewModel::setFontScale,
        onSetHeaderMetadata = viewModel::setHeaderMetadata,
        onBack = onBack,
    )
}

/** State-injected body of [SettingsDisplayScreen] — previewable without a VM. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SettingsDisplayContent(
    settings: DisplaySettings,
    onSetSessionPreviewLimit: (Int) -> Unit,
    onSetShowActiveSessionsOnly: (Boolean) -> Unit,
    onSetPinInProgressSessions: (Boolean) -> Unit,
    onSetSessionListStatusMode: (SessionListStatusMode) -> Unit,
    onSetFontScale: (AppFontScale) -> Unit,
    onSetHeaderMetadata: (SessionHeaderMetadata) -> Unit,
    onBack: () -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_category_display)) },
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
            DisplaySection(title = stringResource(R.string.settings_section_display_sessions)) {
                StepperRow(
                    label = stringResource(R.string.settings_display_preview_limit),
                    description = stringResource(R.string.settings_display_preview_limit_description),
                    value = settings.sessionPreviewLimit,
                    onValueChange = onSetSessionPreviewLimit,
                )
                DisplayDivider()
                SwitchRow(
                    label = stringResource(R.string.settings_display_active_only),
                    description = stringResource(R.string.settings_display_active_only_description),
                    checked = settings.showActiveSessionsOnly,
                    onCheckedChange = onSetShowActiveSessionsOnly,
                )
                DisplayDivider()
                SwitchRow(
                    label = stringResource(R.string.settings_display_pin_in_progress),
                    description = stringResource(R.string.settings_display_pin_in_progress_description),
                    checked = settings.pinInProgressSessions,
                    onCheckedChange = onSetPinInProgressSessions,
                )
                DisplayDivider()
                ChoiceRow(
                    label = stringResource(R.string.settings_display_status_mode),
                    options = SessionListStatusMode.entries.map {
                        ChoiceOption(label = stringResource(statusModeLabelRes(it)), value = it)
                    },
                    selected = settings.sessionListStatusMode,
                    onSelect = onSetSessionListStatusMode,
                )
            }

            DisplaySection(title = stringResource(R.string.settings_section_header_metadata)) {
                val meta = settings.headerMetadata
                SwitchRow(
                    label = stringResource(R.string.settings_display_meta_show_labels),
                    checked = meta.showLabels,
                    onCheckedChange = { onSetHeaderMetadata(meta.copy(showLabels = it)) },
                )
                DisplayDivider()
                SwitchRow(
                    label = stringResource(R.string.settings_display_meta_agent),
                    checked = meta.agent,
                    onCheckedChange = { onSetHeaderMetadata(meta.copy(agent = it)) },
                )
                DisplayDivider()
                SwitchRow(
                    label = stringResource(R.string.settings_display_meta_machine),
                    checked = meta.machine,
                    onCheckedChange = { onSetHeaderMetadata(meta.copy(machine = it)) },
                )
                DisplayDivider()
                SwitchRow(
                    label = stringResource(R.string.settings_display_meta_last_active),
                    checked = meta.lastActive,
                    onCheckedChange = { onSetHeaderMetadata(meta.copy(lastActive = it)) },
                )
                DisplayDivider()
                SwitchRow(
                    label = stringResource(R.string.settings_display_meta_model),
                    checked = meta.model,
                    onCheckedChange = { onSetHeaderMetadata(meta.copy(model = it)) },
                )
                DisplayDivider()
                SwitchRow(
                    label = stringResource(R.string.settings_display_meta_reasoning),
                    checked = meta.reasoning,
                    onCheckedChange = { onSetHeaderMetadata(meta.copy(reasoning = it)) },
                )
                DisplayDivider()
                SwitchRow(
                    label = stringResource(R.string.settings_display_meta_fast_mode),
                    checked = meta.fastMode,
                    onCheckedChange = { onSetHeaderMetadata(meta.copy(fastMode = it)) },
                )
                DisplayDivider()
                SwitchRow(
                    label = stringResource(R.string.settings_display_meta_created_at),
                    checked = meta.createdAt,
                    onCheckedChange = { onSetHeaderMetadata(meta.copy(createdAt = it)) },
                )
                DisplayDivider()
                SwitchRow(
                    label = stringResource(R.string.settings_display_meta_updated_at),
                    checked = meta.updatedAt,
                    onCheckedChange = { onSetHeaderMetadata(meta.copy(updatedAt = it)) },
                )
                DisplayDivider()
                SwitchRow(
                    label = stringResource(R.string.settings_display_meta_worktree),
                    checked = meta.worktree,
                    onCheckedChange = { onSetHeaderMetadata(meta.copy(worktree = it)) },
                )
            }

            DisplaySection(title = stringResource(R.string.settings_section_display_typography)) {
                ChoiceRow(
                    label = stringResource(R.string.settings_display_font_scale),
                    options = AppFontScale.entries.map { ChoiceOption(label = it.label, value = it) },
                    selected = settings.fontScale,
                    onSelect = onSetFontScale,
                )
            }
        }
    }
}

// ------------------------------------------------------------- primitives --
// Local twins of the SettingsScreen.kt private primitives: the subpage stays
// self-contained so later stacked branches can union these files without
// cross-file visibility churn.

@Composable
private fun DisplaySection(title: String, content: @Composable () -> Unit) {
    Column {
        Text(
            text = title,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(start = 4.dp, bottom = 6.dp),
        )
        Surface(
            shape = MaterialTheme.shapes.medium,
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column { content() }
        }
    }
}

@Composable
private fun DisplayDivider() {
    HorizontalDivider(
        color = MaterialTheme.colorScheme.outlineVariant,
        modifier = Modifier.padding(horizontal = 16.dp),
    )
}

@Composable
private fun SwitchRow(
    label: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    description: String? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(text = label, style = MaterialTheme.typography.bodyLarge)
            if (description != null) {
                Text(
                    text = description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }
        Spacer(modifier = Modifier.padding(start = 12.dp))
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

/**
 * Numeric stepper (web: number input + step buttons). Buttons disable at the
 * [SessionPreviewLimit] bounds; every click is clamped anyway so a racing
 * stale value can never escape the range.
 */
@Composable
private fun StepperRow(
    label: String,
    description: String,
    value: Int,
    onValueChange: (Int) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(text = label, style = MaterialTheme.typography.bodyLarge)
            Text(
                text = description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        val decrease = stringResource(R.string.settings_display_preview_limit_decrease)
        TextButton(
            onClick = { onValueChange(value - 1) },
            enabled = value > SessionPreviewLimit.MIN,
            modifier = Modifier.semantics { contentDescription = decrease },
        ) {
            Text(text = "−", style = MaterialTheme.typography.titleMedium)
        }
        Text(
            text = value.toString(),
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.padding(horizontal = 6.dp),
        )
        val increase = stringResource(R.string.settings_display_preview_limit_increase)
        TextButton(
            onClick = { onValueChange(value + 1) },
            enabled = value < SessionPreviewLimit.MAX,
            modifier = Modifier.semantics { contentDescription = increase },
        ) {
            Text(text = "+", style = MaterialTheme.typography.titleMedium)
        }
    }
}

private data class ChoiceOption<T>(val label: String, val value: T)

/** One-of-N segmented picker under its label (web SettingsChoiceGroup twin). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun <T> ChoiceRow(
    label: String,
    options: List<ChoiceOption<T>>,
    selected: T,
    onSelect: (T) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Text(text = label, style = MaterialTheme.typography.bodyLarge)
        Spacer(modifier = Modifier.height(8.dp))
        SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
            options.forEachIndexed { index, option ->
                SegmentedButton(
                    selected = option.value == selected,
                    onClick = { onSelect(option.value) },
                    shape = SegmentedButtonDefaults.itemShape(index = index, count = options.size),
                ) {
                    Text(
                        text = option.label,
                        style = MaterialTheme.typography.labelSmall,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

private fun statusModeLabelRes(mode: SessionListStatusMode): Int = when (mode) {
    SessionListStatusMode.STANDARD -> R.string.settings_display_status_standard
    SessionListStatusMode.DETAILED -> R.string.settings_display_status_detailed
}
