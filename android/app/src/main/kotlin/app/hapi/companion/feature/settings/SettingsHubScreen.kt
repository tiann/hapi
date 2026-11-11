package app.hapi.companion.feature.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
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

/**
 * Settings hub (P2 IA): the category directory that replaced the former
 * single-column settings screen. Rows come from [SettingsHubCatalog] — the
 * owner-only Usage/Storage rows hide for non-owners exactly like the old
 * Insights section did (and like the web's owner-only nav categories).
 * Subpages are flat `settings/...` routes; back from a subpage lands here.
 */
@Composable
fun SettingsHubScreen(
    viewModel: SettingsViewModel,
    onOpenCategory: (String) -> Unit,
    onBack: () -> Unit,
) {
    val isOwner by viewModel.isOwner.collectAsState()
    SettingsHubContent(
        entries = SettingsHubCatalog.visibleEntries(SettingsHubState(isOwner = isOwner)),
        onOpenCategory = onOpenCategory,
        onBack = onBack,
    )
}

/** Entries-injected body of [SettingsHubScreen] — previewable without a VM. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SettingsHubContent(
    entries: List<SettingsHubEntry>,
    onOpenCategory: (String) -> Unit,
    onBack: () -> Unit,
) {
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
        ) {
            Surface(
                shape = MaterialTheme.shapes.medium,
                color = MaterialTheme.colorScheme.surfaceContainerLow,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column {
                    entries.forEachIndexed { index, entry ->
                        if (index > 0) {
                            SettingsHubDivider()
                        }
                        SettingsHubRow(entry = entry, onClick = { onOpenCategory(entry.route) })
                    }
                }
            }
        }
    }
}

/** M3-list-item-style row: leading icon, title + summary, trailing chevron. */
@Composable
private fun SettingsHubRow(entry: SettingsHubEntry, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            entry.icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Column(
            modifier = Modifier
                .weight(1f)
                .padding(start = 16.dp),
        ) {
            Text(
                text = stringResource(entry.titleRes),
                style = MaterialTheme.typography.bodyLarge,
            )
            entry.descriptionRes?.let { descriptionRes ->
                Text(
                    text = stringResource(descriptionRes),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun SettingsHubDivider() {
    HorizontalDivider(
        color = MaterialTheme.colorScheme.outlineVariant,
        modifier = Modifier.padding(horizontal = 16.dp),
    )
}
