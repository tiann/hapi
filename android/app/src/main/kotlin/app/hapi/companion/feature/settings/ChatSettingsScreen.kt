package app.hapi.companion.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.chat.ChatSurfaces

/**
 * Chat subpage of the settings hub (P2): the web `/settings/chat` page scoped
 * to this roadmap slice — the composer Enter behavior, the reasoning and
 * tool-card collapse defaults, and the tool-card / user-bubble surface
 * presets. The web's toolbar-layout and terminal-display fields have no
 * Android surface on this branch and stay out (web-only custom hex pickers
 * likewise; Android offers the shared presets).
 */
@Composable
fun SettingsChatScreen(
    viewModel: ChatSettingsViewModel,
    onBack: () -> Unit,
) {
    val settings by viewModel.settings.collectAsState()

    SettingsChatContent(
        settings = settings,
        onSetEnterBehavior = viewModel::setEnterBehavior,
        onSetReasoningCollapsed = viewModel::setReasoningCollapsed,
        onSetToolCardsCollapsed = viewModel::setToolCardsCollapsed,
        onSetToolGroupBackground = viewModel::setToolGroupBackground,
        onSetUserMessageBackground = viewModel::setUserMessageBackground,
        onBack = onBack,
    )
}

/** State-injected body of [SettingsChatScreen] — previewable without a VM. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SettingsChatContent(
    settings: ChatSettings,
    onSetEnterBehavior: (ComposerEnterBehavior) -> Unit,
    onSetReasoningCollapsed: (Boolean) -> Unit,
    onSetToolCardsCollapsed: (Boolean) -> Unit,
    onSetToolGroupBackground: (ChatSurfaceColor) -> Unit,
    onSetUserMessageBackground: (ChatSurfaceColor) -> Unit,
    onBack: () -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_category_chat)) },
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
            ChatSection(title = stringResource(R.string.settings_section_chat_input)) {
                ChoiceRow(
                    label = stringResource(R.string.settings_chat_enter_behavior),
                    options = ComposerEnterBehavior.entries.map {
                        ChatChoiceOption(label = stringResource(enterBehaviorLabelRes(it)), value = it)
                    },
                    selected = settings.enterBehavior,
                    onSelect = onSetEnterBehavior,
                )
            }

            ChatSection(title = stringResource(R.string.settings_section_chat_tools)) {
                SwitchRow(
                    label = stringResource(R.string.settings_chat_reasoning_collapsed),
                    description = stringResource(R.string.settings_chat_reasoning_collapsed_description),
                    checked = settings.reasoningCollapsed,
                    onCheckedChange = onSetReasoningCollapsed,
                )
                ChatDivider()
                SwitchRow(
                    label = stringResource(R.string.settings_chat_tool_cards_collapsed),
                    description = stringResource(R.string.settings_chat_tool_cards_collapsed_description),
                    checked = settings.toolCardsCollapsed,
                    onCheckedChange = onSetToolCardsCollapsed,
                )
            }

            ChatSection(title = stringResource(R.string.settings_section_chat_colors)) {
                ColorChoiceRow(
                    label = stringResource(R.string.settings_chat_tool_group_background),
                    selected = settings.toolGroupBackground,
                    onSelect = onSetToolGroupBackground,
                )
                ChatDivider()
                ColorChoiceRow(
                    label = stringResource(R.string.settings_chat_user_message_background),
                    selected = settings.userMessageBackground,
                    onSelect = onSetUserMessageBackground,
                )
            }
        }
    }
}

// ------------------------------------------------------------- primitives --
// Local twins of the SettingsScreen.kt private primitives (DisplayScreen
// precedent): the subpage stays self-contained so later stacked branches can
// union these files without cross-file visibility churn.

@Composable
private fun ChatSection(title: String, content: @Composable () -> Unit) {
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
private fun ChatDivider() {
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

private data class ChatChoiceOption<T>(val label: String, val value: T)

/** One-of-N segmented picker under its label (web SettingsChoiceGroup twin). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun <T> ChoiceRow(
    label: String,
    options: List<ChatChoiceOption<T>>,
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

/**
 * Surface-color picker: the segmented options of [ChoiceRow], each with the
 * preset's swatch dot (web renders the same preset swatches; the default
 * option shows the themed neutral).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ColorChoiceRow(
    label: String,
    selected: ChatSurfaceColor,
    onSelect: (ChatSurfaceColor) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Text(text = label, style = MaterialTheme.typography.bodyLarge)
        Spacer(modifier = Modifier.height(8.dp))
        SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
            ChatSurfaceColor.entries.forEachIndexed { index, option ->
                SegmentedButton(
                    selected = option == selected,
                    onClick = { onSelect(option) },
                    shape = SegmentedButtonDefaults.itemShape(index = index, count = ChatSurfaceColor.entries.size),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            modifier = Modifier
                                .size(10.dp)
                                .background(
                                    color = swatchColor(option),
                                    shape = CircleShape,
                                ),
                        )
                        Text(
                            text = stringResource(surfaceColorLabelRes(option)),
                            style = MaterialTheme.typography.labelSmall,
                            maxLines = 1,
                            modifier = Modifier.padding(start = 6.dp),
                        )
                    }
                }
            }
        }
    }
}

/** Fixed swatch per preset; the default option previews the themed neutral. */
@Composable
private fun swatchColor(option: ChatSurfaceColor) = when (option) {
    ChatSurfaceColor.DEFAULT -> MaterialTheme.colorScheme.surfaceContainerHigh
    ChatSurfaceColor.SOFT_BLUE -> ChatSurfaces.SOFT_BLUE_ACCENT
    ChatSurfaceColor.SOFT_GREEN -> ChatSurfaces.SOFT_GREEN_ACCENT
    ChatSurfaceColor.SOFT_YELLOW -> ChatSurfaces.SOFT_YELLOW_ACCENT
}

private fun enterBehaviorLabelRes(behavior: ComposerEnterBehavior): Int = when (behavior) {
    ComposerEnterBehavior.SEND -> R.string.settings_chat_enter_send
    ComposerEnterBehavior.NEWLINE -> R.string.settings_chat_enter_newline
}

private fun surfaceColorLabelRes(option: ChatSurfaceColor): Int = when (option) {
    ChatSurfaceColor.DEFAULT -> R.string.settings_chat_surface_default
    ChatSurfaceColor.SOFT_BLUE -> R.string.settings_chat_surface_soft_blue
    ChatSurfaceColor.SOFT_GREEN -> R.string.settings_chat_surface_soft_green
    ChatSurfaceColor.SOFT_YELLOW -> R.string.settings_chat_surface_soft_yellow
}
