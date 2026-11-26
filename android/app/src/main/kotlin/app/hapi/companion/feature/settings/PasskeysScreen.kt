package app.hapi.companion.feature.settings

import android.os.Build
import android.text.format.DateUtils
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.passkey.CredentialManagerPasskeyPlatform
import app.hapi.companion.feature.passkey.findActivity
import app.hapi.companion.feature.passkey.passkeyIssueText
import app.hapi.protocol.wire.NativePasskeys
import app.hapi.protocol.wire.PasskeySummary

/**
 * Settings → Passkeys (hub-scoped): this namespace's passkeys with
 * created/last-used dates, an "inactive" tag for passkeys invalidated by a
 * `CLI_API_TOKEN` rotation or an unsupported RP ID.
 * Add registers an `auth.hapi.run` passkey for both Web and App through
 * Credential Manager; delete asks for confirmation first.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PasskeysScreen(
    viewModel: PasskeysViewModel,
    onBack: () -> Unit,
) {
    LaunchedEffect(viewModel) { viewModel.start() }
    val state by viewModel.state.collectAsState()
    val busy by viewModel.busy.collectAsState()
    val notice by viewModel.notice.collectAsState()
    val context = LocalContext.current

    var showAddDialog by rememberSaveable { mutableStateOf(false) }
    var pendingDeleteId by rememberSaveable { mutableStateOf<String?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_passkeys)) },
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
                text = stringResource(R.string.settings_passkeys_description),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            notice?.let { current ->
                PasskeysNoticeCard(notice = current, onDismiss = viewModel::dismissNotice)
            }

            Button(
                onClick = { showAddDialog = true },
                enabled = busy == null,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (busy == PasskeysBusy.Adding) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Text(stringResource(R.string.settings_passkeys_add))
                }
            }

            when (val current = state) {
                is PasskeysUiState.Loading -> Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 48.dp),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator() }

                is PasskeysUiState.Error -> DashboardError(
                    isForbidden = false,
                    message = current.message,
                    onRetry = viewModel::refresh,
                )

                is PasskeysUiState.Data -> if (current.passkeys.isEmpty()) {
                    Text(
                        text = stringResource(R.string.settings_passkeys_empty),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    Surface(
                        shape = MaterialTheme.shapes.medium,
                        color = MaterialTheme.colorScheme.surfaceContainerLow,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column {
                            current.passkeys.forEachIndexed { index, passkey ->
                                if (index > 0) {
                                    HorizontalDivider(
                                        color = MaterialTheme.colorScheme.outlineVariant,
                                        modifier = Modifier.padding(horizontal = 16.dp),
                                    )
                                }
                                PasskeyRow(
                                    passkey = passkey,
                                    deleting = busy == PasskeysBusy.Deleting(passkey.id),
                                    enabled = busy == null,
                                    onDelete = { pendingDeleteId = passkey.id },
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (showAddDialog) {
        AddPasskeyDialog(
            onConfirm = { name ->
                showAddDialog = false
                // The system sheet needs the hosting Activity.
                context.findActivity()?.let { activity ->
                    viewModel.addPasskey(name, CredentialManagerPasskeyPlatform(activity))
                }
            },
            onDismiss = { showAddDialog = false },
        )
    }

    val deleteTarget = pendingDeleteId?.let { id ->
        (state as? PasskeysUiState.Data)?.passkeys?.firstOrNull { it.id == id }
    }
    if (deleteTarget != null) {
        AlertDialog(
            onDismissRequest = { pendingDeleteId = null },
            title = { Text(stringResource(R.string.settings_passkeys_delete_title)) },
            text = {
                Text(
                    stringResource(
                        R.string.settings_passkeys_delete_message,
                        passkeyDisplayName(deleteTarget),
                    ),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        pendingDeleteId = null
                        viewModel.deletePasskey(deleteTarget.id)
                    },
                ) {
                    Text(
                        stringResource(R.string.settings_passkeys_delete_confirm),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingDeleteId = null }) {
                    Text(stringResource(R.string.settings_cancel))
                }
            },
        )
    }
}

@Composable
private fun PasskeyRow(
    passkey: PasskeySummary,
    deleting: Boolean,
    enabled: Boolean,
    onDelete: () -> Unit,
) {
    val context = LocalContext.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 4.dp, top = 12.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(text = passkeyDisplayName(passkey), style = MaterialTheme.typography.bodyLarge)
            val created = DateUtils.formatDateTime(context, passkey.createdAt, DATE_FLAGS)
            val lastUsed = passkey.lastUsedAt?.let { DateUtils.formatDateTime(context, it, DATE_FLAGS) }
            Text(
                text = if (lastUsed != null) {
                    stringResource(R.string.settings_passkeys_dates, created, lastUsed)
                } else {
                    stringResource(R.string.settings_passkeys_dates_unused, created)
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 2.dp),
            )
            val tags = buildList {
                if (!passkey.valid) add(stringResource(R.string.settings_passkeys_tag_inactive))
            }
            if (tags.isNotEmpty()) {
                Text(
                    text = tags.joinToString(" · "),
                    style = MaterialTheme.typography.labelMedium,
                    color = if (!passkey.valid) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.tertiary,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
        if (deleting) {
            Box(modifier = Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
            }
        } else {
            IconButton(onClick = onDelete, enabled = enabled) {
                Icon(
                    Icons.Default.Delete,
                    contentDescription = stringResource(R.string.settings_passkeys_delete_title),
                )
            }
        }
    }
}

@Composable
private fun AddPasskeyDialog(
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var name by rememberSaveable { mutableStateOf(defaultPasskeyName()) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.settings_passkeys_add)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = stringResource(R.string.settings_passkeys_add_message),
                    style = MaterialTheme.typography.bodyMedium,
                )
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it.take(NativePasskeys.MAX_NAME_LENGTH) },
                    label = { Text(stringResource(R.string.settings_passkeys_name_label)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(name) }) {
                Text(stringResource(R.string.settings_passkeys_add_confirm))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.settings_cancel))
            }
        },
    )
}

@Composable
private fun PasskeysNoticeCard(notice: PasskeysNotice, onDismiss: () -> Unit) {
    val isError = notice is PasskeysNotice.Failed
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (isError) {
                MaterialTheme.colorScheme.errorContainer
            } else {
                MaterialTheme.colorScheme.secondaryContainer
            },
            contentColor = if (isError) {
                MaterialTheme.colorScheme.onErrorContainer
            } else {
                MaterialTheme.colorScheme.onSecondaryContainer
            },
        ),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = when (notice) {
                    PasskeysNotice.Added -> stringResource(R.string.settings_passkeys_added)
                    PasskeysNotice.Deleted -> stringResource(R.string.settings_passkeys_deleted)
                    is PasskeysNotice.Failed -> passkeyIssueText(notice.issue)
                },
                style = MaterialTheme.typography.bodyMedium,
            )
            TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.End)) {
                Text(stringResource(R.string.pairing_notice_dismiss))
            }
        }
    }
}

@Composable
private fun passkeyDisplayName(passkey: PasskeySummary): String =
    passkey.name?.takeIf { it.isNotBlank() } ?: stringResource(R.string.settings_passkeys_unnamed)

/** Default passkey name: the device model (e.g. "Pixel 9"), clamped to the hub limit. */
internal fun defaultPasskeyName(model: String? = Build.MODEL): String =
    model?.trim()?.take(NativePasskeys.MAX_NAME_LENGTH).orEmpty()

private const val DATE_FLAGS = DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_YEAR or DateUtils.FORMAT_ABBREV_MONTH
