package app.hapi.companion.feature.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.catalog.CatalogOption
import app.hapi.protocol.catalog.ModelCatalog
import app.hapi.protocol.catalog.PermissionMode
import app.hapi.protocol.catalog.PermissionModeTone
import app.hapi.protocol.catalog.PermissionModes

/**
 * Session config sheet (B-M3b): permission mode / model / effort sections,
 * catalog-driven per flavor. Pickers apply optimistically through the
 * ViewModel ([ChatViewModel.setPermissionMode] & co.); a flavor without a
 * known model catalog simply hides that section.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionConfigSheet(
    config: SessionConfigUi,
    onDismiss: () -> Unit,
    onSetPermissionMode: (PermissionMode) -> Unit,
    onSetModel: (String?) -> Unit,
    onSetEffort: (String?) -> Unit,
    onLoadModelOptions: () -> Unit,
) {
    LaunchedEffect(Unit) { onLoadModelOptions() }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        SessionConfigSheetContent(
            config = config,
            onSetPermissionMode = onSetPermissionMode,
            onSetModel = onSetModel,
            onSetEffort = onSetEffort,
        )
    }
}

@Composable
internal fun SessionConfigSheetContent(
    config: SessionConfigUi,
    onSetPermissionMode: (PermissionMode) -> Unit,
    onSetModel: (String?) -> Unit,
    onSetEffort: (String?) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
            .padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (!config.active) {
            Notice(stringResource(R.string.chat_config_offline_note))
        } else if (config.controlledByUser) {
            Notice(stringResource(R.string.chat_config_terminal_note))
        }

        if (config.permissionModes.isNotEmpty()) {
            SectionTitle(stringResource(R.string.chat_config_permission_mode))
            config.permissionModes.forEach { mode ->
                OptionRow(
                    label = mode.label,
                    selected = mode.wireId == (config.permissionMode ?: "default"),
                    tone = mode.tone,
                    onClick = { onSetPermissionMode(mode) },
                )
            }
        }

        val modelOptions = config.modelOptions
        if (modelOptions != null || config.modelOptionsLoading) {
            SectionTitle(stringResource(R.string.chat_config_model))
            if (config.modelOptionsLoading) {
                Row(
                    modifier = Modifier.padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                    Text(
                        text = stringResource(R.string.chat_config_loading_models),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.hapi.hint,
                        modifier = Modifier.padding(start = 8.dp),
                    )
                }
            } else if (modelOptions.isNullOrEmpty()) {
                Text(
                    text = stringResource(R.string.chat_config_models_unavailable),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.hapi.hint,
                )
            } else {
                val currentModel = normalizedCurrentModel(config)
                modelOptions.forEach { option ->
                    OptionRow(
                        label = option.label,
                        selected = option.value == currentModel,
                        onClick = { onSetModel(option.value) },
                    )
                }
            }
        }

        config.effortOptions?.let { effortOptions ->
            SectionTitle(stringResource(R.string.chat_config_effort))
            val currentEffort = normalizedCurrentEffort(config)
            effortOptions.forEach { option ->
                OptionRow(
                    label = option.label,
                    selected = option.value == currentEffort,
                    onClick = { onSetEffort(option.value) },
                )
            }
        }
    }
}

/** Claude models normalize `auto`/`default` to the null Default row. */
private fun normalizedCurrentModel(config: SessionConfigUi): String? =
    if (config.flavor == "claude") ModelCatalog.normalizeClaudeModel(config.model) else config.model

private fun normalizedCurrentEffort(config: SessionConfigUi): String? =
    if (config.flavor == "claude") ModelCatalog.normalizeClaudeEffort(config.effort) else config.effort

@Composable
private fun SectionTitle(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelLarge,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(top = 10.dp, bottom = 2.dp),
    )
}

@Composable
private fun OptionRow(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    tone: PermissionModeTone? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .selectable(selected = selected, onClick = onClick)
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null)
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = when (tone) {
                PermissionModeTone.Danger -> MaterialTheme.colorScheme.error
                PermissionModeTone.Warning -> MaterialTheme.colorScheme.tertiary
                else -> MaterialTheme.colorScheme.onSurface
            },
            modifier = Modifier.padding(start = 8.dp),
        )
    }
}

@Composable
private fun Notice(text: String) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = MaterialTheme.shapes.small,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.hapi.hint,
            modifier = Modifier.padding(8.dp),
        )
    }
}

// -------------------------------------------------------------- previews --

@Preview(showBackground = true)
@Composable
private fun SessionConfigSheetPreview() {
    HapiTheme {
        Surface {
            SessionConfigSheetContent(
                config = SessionConfigUi(
                    flavor = "claude",
                    active = true,
                    controlledByUser = false,
                    permissionMode = "acceptEdits",
                    permissionModes = PermissionModes.forFlavor("claude"),
                    model = "opus",
                    modelOptions = ModelCatalog.claudeModelOptions("opus"),
                    modelOptionsLoading = false,
                    effort = "high",
                    effortOptions = ModelCatalog.claudeEffortOptions("high"),
                ),
                onSetPermissionMode = {},
                onSetModel = {},
                onSetEffort = {},
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun SessionConfigSheetCodexLoadingPreview() {
    HapiTheme {
        Surface {
            SessionConfigSheetContent(
                config = SessionConfigUi(
                    flavor = "codex",
                    active = true,
                    controlledByUser = false,
                    permissionMode = "read-only",
                    permissionModes = PermissionModes.forFlavor("codex"),
                    model = null,
                    modelOptions = emptyList<CatalogOption>(),
                    modelOptionsLoading = true,
                    effort = null,
                    effortOptions = null,
                ),
                onSetPermissionMode = {},
                onSetModel = {},
                onSetEffort = {},
            )
        }
    }
}
