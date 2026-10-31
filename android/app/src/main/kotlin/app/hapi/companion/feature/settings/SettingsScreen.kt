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
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
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
 * General subpage of the settings hub (P2 IA): the catch-all category for
 * everything without a dedicated category on this branch — Appearance (theme
 * mode + Material You), Language, and About (app/protocol versions + hub
 * health). The former owner-only Usage/Storage rows moved hub-level (see
 * [SettingsHubCatalog]); their owner gate is unchanged.
 */
@Composable
fun SettingsGeneralScreen(
    viewModel: SettingsViewModel,
    onBack: () -> Unit,
) {
    val theme by viewModel.themeSettings.collectAsState()
    val language by viewModel.language.collectAsState()
    val hubInfo by viewModel.hubInfo.collectAsState()

    SettingsGeneralContent(
        theme = theme,
        language = language,
        hubUrl = viewModel.hubUrl,
        hubInfo = hubInfo,
        onSetThemeMode = viewModel::setThemeMode,
        onSetDynamicColor = viewModel::setDynamicColor,
        onSetLanguage = viewModel::setLanguage,
        onRetryHubInfo = viewModel::retryHubInfo,
        onBack = onBack,
    )
}

/** State-injected body of [SettingsGeneralScreen] — previewable without a VM. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SettingsGeneralContent(
    theme: ThemeSettings,
    language: AppLanguage,
    hubUrl: String,
    hubInfo: HubInfoState,
    onSetThemeMode: (ThemeMode) -> Unit,
    onSetDynamicColor: (Boolean) -> Unit,
    onSetLanguage: (AppLanguage) -> Unit,
    onRetryHubInfo: () -> Unit,
    onBack: () -> Unit,
) {
    var showThemeDialog by rememberSaveable { mutableStateOf(false) }
    var showLanguageDialog by rememberSaveable { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_category_general)) },
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
                        onCheckedChange = onSetDynamicColor,
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
                    value = hubUrl,
                    description = when (val info = hubInfo) {
                        is HubInfoState.Loading -> stringResource(R.string.settings_hub_checking)
                        is HubInfoState.Loaded -> stringResource(
                            R.string.settings_hub_health,
                            info.health.status,
                            info.health.protocolVersion,
                        )
                        is HubInfoState.Failed -> stringResource(R.string.settings_hub_unreachable)
                    },
                    onClick = if (hubInfo is HubInfoState.Failed) onRetryHubInfo else null,
                )
                SettingsDivider()
                app.hapi.companion.ui.components.PrivacyPolicyLink()
            }
        }
    }

    if (showThemeDialog) {
        ThemeModeDialog(
            selected = theme.mode,
            onSelect = { mode ->
                showThemeDialog = false
                onSetThemeMode(mode)
            },
            onDismiss = { showThemeDialog = false },
        )
    }

    if (showLanguageDialog) {
        LanguageDialog(
            selected = language,
            onSelect = { choice ->
                showLanguageDialog = false
                onSetLanguage(choice)
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

/** Expressive theme picker: choice cards with fixed light/dark preview swatches. */
@Composable
private fun ThemeModeDialog(
    selected: ThemeMode,
    onSelect: (ThemeMode) -> Unit,
    onDismiss: () -> Unit,
) {
    ChoiceDialog(
        title = stringResource(R.string.settings_theme),
        options = ThemeMode.entries.map { mode ->
            ChoiceOption(
                value = mode,
                label = stringResource(themeModeLabelRes(mode)),
                swatch = themeModeSwatch(mode),
            )
        },
        selected = selected,
        onSelect = onSelect,
        onDismiss = onDismiss,
        dismissLabel = stringResource(R.string.settings_cancel),
    )
}

/** Expressive language picker: choice cards; names render in their own language. */
@Composable
private fun LanguageDialog(
    selected: AppLanguage,
    onSelect: (AppLanguage) -> Unit,
    onDismiss: () -> Unit,
) {
    ChoiceDialog(
        title = stringResource(R.string.settings_language),
        options = AppLanguage.entries.map { language ->
            ChoiceOption(
                value = language,
                label = languageLabel(language),
            )
        },
        selected = selected,
        onSelect = onSelect,
        onDismiss = onDismiss,
        dismissLabel = stringResource(R.string.settings_cancel),
    )
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
    AppLanguage.RUSSIAN -> "Русский"
}
