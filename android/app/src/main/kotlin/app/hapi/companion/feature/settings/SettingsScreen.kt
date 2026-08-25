package app.hapi.companion.feature.settings

import android.os.Build
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.appcompat.app.AppCompatDelegate
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.os.LocaleListCompat
import app.hapi.companion.BuildConfig
import app.hapi.companion.R
import app.hapi.protocol.wire.SUPPORTED_PROTOCOL_VERSION

/**
 * Settings home (B-M4e scaffold): Appearance (theme mode + Material You),
 * Language (persist-only until M5), the owner-only Usage/Storage entries, and
 * About (app/protocol versions + hub health).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    viewModel: SettingsViewModel,
    onOpenUsage: () -> Unit,
    onOpenStorage: () -> Unit,
    onBack: () -> Unit,
) {
    val theme by viewModel.themeSettings.collectAsState()
    val language by viewModel.language.collectAsState()
    val isOwner by viewModel.isOwner.collectAsState()
    val hubInfo by viewModel.hubInfo.collectAsState()

    var showThemeDialog by rememberSaveable { mutableStateOf(false) }
    var showLanguageDialog by rememberSaveable { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_title)) },
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
            SettingsSection(title = stringResource(R.string.settings_section_appearance)) {
                SettingsRow(
                    label = stringResource(R.string.settings_theme),
                    value = stringResource(themeModeLabelRes(theme.mode)),
                    onClick = { showThemeDialog = true },
                )
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    SettingsDivider()
                    SwitchRow(
                        label = stringResource(R.string.settings_dynamic_color),
                        description = stringResource(
                            if (theme.mode == ThemeMode.OLED) R.string.settings_dynamic_color_oled_note
                            else R.string.settings_dynamic_color_description
                        ),
                        checked = theme.dynamicColor && theme.mode != ThemeMode.OLED,
                        enabled = theme.mode != ThemeMode.OLED,
                        onCheckedChange = viewModel::setDynamicColor,
                    )
                }
            }

            SettingsSection(title = stringResource(R.string.settings_section_language)) {
                SettingsRow(
                    label = stringResource(R.string.settings_language),
                    value = languageLabel(language),
                    onClick = { showLanguageDialog = true },
                )
            }

            if (isOwner) {
                SettingsSection(title = stringResource(R.string.settings_section_insights)) {
                    SettingsRow(
                        label = stringResource(R.string.settings_usage),
                        description = stringResource(R.string.settings_usage_summary),
                        onClick = onOpenUsage,
                    )
                    SettingsDivider()
                    SettingsRow(
                        label = stringResource(R.string.settings_storage),
                        description = stringResource(R.string.settings_storage_summary),
                        onClick = onOpenStorage,
                    )
                }
            }

            SettingsSection(title = stringResource(R.string.settings_section_about)) {
                SettingsRow(
                    label = stringResource(R.string.settings_app_version),
                    value = BuildConfig.VERSION_NAME,
                )
                SettingsDivider()
                SettingsRow(
                    label = stringResource(R.string.settings_protocol_version),
                    value = SUPPORTED_PROTOCOL_VERSION.toString(),
                )
                SettingsDivider()
                SettingsRow(
                    label = stringResource(R.string.settings_hub),
                    value = viewModel.hubUrl,
                    description = when (val info = hubInfo) {
                        is HubInfoState.Loading -> stringResource(R.string.settings_hub_checking)
                        is HubInfoState.Loaded -> stringResource(
                            R.string.settings_hub_health,
                            info.health.status,
                            info.health.protocolVersion,
                        )
                        is HubInfoState.Failed -> stringResource(R.string.settings_hub_unreachable)
                    },
                    onClick = if (hubInfo is HubInfoState.Failed) viewModel::retryHubInfo else null,
                )
            }
        }
    }

    if (showThemeDialog) {
        ThemeModeDialog(
            selected = theme.mode,
            onSelect = { mode ->
                showThemeDialog = false
                viewModel.setThemeMode(mode)
            },
            onDismiss = { showThemeDialog = false },
        )
    }

    if (showLanguageDialog) {
        LanguageDialog(
            selected = language,
            onSelect = { choice ->
                showLanguageDialog = false
                viewModel.setLanguage(choice)
                // Apply immediately (B-M5a): appcompat recreates the activity
                // with the new locale and, thanks to autoStoreLocales in the
                // manifest, re-applies it on every cold start. The DataStore
                // write above keeps the settings row in sync.
                AppCompatDelegate.setApplicationLocales(
                    LocaleListCompat.forLanguageTags(choice.localeTags),
                )
            },
            onDismiss = { showLanguageDialog = false },
        )
    }
}

// ------------------------------------------------------------- primitives --

@Composable
private fun SettingsSection(title: String, content: @Composable () -> Unit) {
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
private fun SettingsDivider() {
    HorizontalDivider(
        color = MaterialTheme.colorScheme.outlineVariant,
        modifier = Modifier.padding(horizontal = 16.dp),
    )
}

@Composable
private fun SettingsRow(
    label: String,
    value: String? = null,
    description: String? = null,
    onClick: (() -> Unit)? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }
            .padding(horizontal = 16.dp, vertical = 14.dp),
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
        if (value != null) {
            Text(
                text = value,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 12.dp),
            )
        }
    }
}

@Composable
private fun SwitchRow(
    label: String,
    description: String,
    checked: Boolean,
    enabled: Boolean,
    onCheckedChange: (Boolean) -> Unit,
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
        Spacer(modifier = Modifier.padding(start = 12.dp))
        Switch(checked = checked, onCheckedChange = onCheckedChange, enabled = enabled)
    }
}

// ---------------------------------------------------------------- dialogs --

@Composable
private fun ThemeModeDialog(
    selected: ThemeMode,
    onSelect: (ThemeMode) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.settings_theme)) },
        text = {
            Column {
                ThemeMode.entries.forEach { mode ->
                    RadioRow(
                        label = stringResource(themeModeLabelRes(mode)),
                        selected = mode == selected,
                        onClick = { onSelect(mode) },
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.settings_cancel)) }
        },
    )
}

@Composable
private fun LanguageDialog(
    selected: AppLanguage,
    onSelect: (AppLanguage) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.settings_language)) },
        text = {
            Column {
                AppLanguage.entries.forEach { language ->
                    RadioRow(
                        label = languageLabel(language),
                        selected = language == selected,
                        onClick = { onSelect(language) },
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.settings_cancel)) }
        },
    )
}

@Composable
private fun RadioRow(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onClick)
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(start = 4.dp),
        )
    }
}

private fun themeModeLabelRes(mode: ThemeMode): Int = when (mode) {
    ThemeMode.SYSTEM -> R.string.settings_theme_system
    ThemeMode.LIGHT -> R.string.settings_theme_light
    ThemeMode.DARK -> R.string.settings_theme_dark
    ThemeMode.OLED -> R.string.settings_theme_oled
}

/**
 * Language names are shown in their own language (standard picker
 * convention), so they are string literals, not resources; only the
 * follow-system row translates with the app language.
 */
@Composable
private fun languageLabel(language: AppLanguage): String = when (language) {
    AppLanguage.SYSTEM -> stringResource(R.string.settings_language_system)
    AppLanguage.ENGLISH -> "English"
    AppLanguage.SIMPLIFIED_CHINESE -> "简体中文"
}
