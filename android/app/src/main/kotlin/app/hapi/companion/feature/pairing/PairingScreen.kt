package app.hapi.companion.feature.pairing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.hapi.companion.R

/**
 * Pairing landing: explains the self-hosted model, offers Scan QR / Manual
 * entry, renders the deep-link confirm card ([prefill]) and the "why am I
 * here" [notice] banner (auth-terminal sign-outs, bad links).
 */
@Composable
fun PairingScreen(
    state: PairingUiState,
    prefill: BindPrefill?,
    notice: String?,
    onDismissNotice: () -> Unit,
    onScanQr: () -> Unit,
    onManualEntry: () -> Unit,
    onPairPrefill: () -> Unit,
    onSwitchToPrefilledHub: () -> Unit,
    onDismissPrefill: () -> Unit,
    onDismissError: () -> Unit,
) {
    Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            if (notice != null) {
                NoticeCard(text = notice, onDismiss = onDismissNotice)
                Spacer(modifier = Modifier.height(16.dp))
            }

            Text(
                text = stringResource(R.string.pairing_title),
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.primary,
            )
            Spacer(modifier = Modifier.height(12.dp))
            Text(
                text = stringResource(R.string.pairing_intro),
                style = MaterialTheme.typography.bodyLarge,
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = stringResource(R.string.pairing_hint),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(modifier = Modifier.height(24.dp))

            if (prefill != null) {
                PrefillConfirmCard(
                    prefill = prefill,
                    validating = state is PairingUiState.Validating,
                    onPair = onPairPrefill,
                    onSwitch = onSwitchToPrefilledHub,
                    onDismiss = onDismissPrefill,
                )
                Spacer(modifier = Modifier.height(16.dp))
            }

            PairingStatus(state = state, onDismissError = onDismissError)

            Button(
                onClick = onScanQr,
                enabled = state !is PairingUiState.Validating,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.pairing_scan_qr))
            }
            Spacer(modifier = Modifier.height(8.dp))
            OutlinedButton(
                onClick = onManualEntry,
                enabled = state !is PairingUiState.Validating,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.pairing_manual_entry))
            }
        }
    }
}

/** Shared "validating…" / error block used by all three pairing screens. */
@Composable
internal fun PairingStatus(
    state: PairingUiState,
    onDismissError: () -> Unit,
    modifier: Modifier = Modifier,
) {
    when (state) {
        is PairingUiState.Validating -> {
            Row(
                modifier = modifier
                    .fillMaxWidth()
                    .padding(bottom = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                Text(
                    text = stringResource(R.string.pairing_validating),
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(start = 12.dp),
                )
            }
        }
        is PairingUiState.Error -> {
            Card(
                modifier = modifier
                    .fillMaxWidth()
                    .padding(bottom = 16.dp),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.errorContainer,
                    contentColor = MaterialTheme.colorScheme.onErrorContainer,
                ),
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(text = pairingErrorText(state.error), style = MaterialTheme.typography.bodyMedium)
                    TextButton(onClick = onDismissError, modifier = Modifier.align(Alignment.End)) {
                        Text(stringResource(R.string.pairing_error_dismiss))
                    }
                }
            }
        }
        else -> Unit
    }
}

@Composable
private fun NoticeCard(text: String, onDismiss: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.tertiaryContainer,
            contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
        ),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(text = text, style = MaterialTheme.typography.bodyMedium)
            TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.End)) {
                Text(stringResource(R.string.pairing_notice_dismiss))
            }
        }
    }
}

@Composable
private fun PrefillConfirmCard(
    prefill: BindPrefill,
    validating: Boolean,
    onPair: () -> Unit,
    onSwitch: () -> Unit,
    onDismiss: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = stringResource(R.string.pairing_confirm_title),
                style = MaterialTheme.typography.titleMedium,
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = prefill.hubUrl,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.primary,
            )
            if (prefill.alreadyPaired) {
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = stringResource(R.string.pairing_confirm_already),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(modifier = Modifier.height(16.dp))
            if (prefill.alreadyPaired) {
                Button(onClick = onSwitch, enabled = !validating, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.pairing_confirm_switch))
                }
                Spacer(modifier = Modifier.height(8.dp))
                OutlinedButton(onClick = onPair, enabled = !validating, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.pairing_confirm_repair))
                }
            } else {
                Button(onClick = onPair, enabled = !validating, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.pairing_confirm_pair))
                }
            }
            TextButton(onClick = onDismiss, enabled = !validating, modifier = Modifier.align(Alignment.End)) {
                Text(stringResource(R.string.pairing_confirm_cancel))
            }
        }
    }
}

/** Localize a [PairingError] (B-M5a). */
@Composable
internal fun pairingErrorText(error: PairingError): String = when (error) {
    PairingError.InvalidUrl -> stringResource(R.string.pairing_error_invalid_url)
    PairingError.EmptyToken -> stringResource(R.string.pairing_error_empty_token)
    PairingError.TokenRejected -> stringResource(R.string.pairing_error_token_rejected)
    PairingError.HubGone -> stringResource(R.string.pairing_error_hub_gone)
    is PairingError.Unreachable -> stringResource(R.string.pairing_error_unreachable, error.hubUrl)
    is PairingError.NotAHub -> stringResource(R.string.pairing_error_not_a_hub, error.hubUrl)
    is PairingError.ProtocolMismatch -> stringResource(
        if (error.hubVersion > error.supportedVersion) {
            R.string.pairing_error_protocol_update_app
        } else {
            R.string.pairing_error_protocol_update_hub
        },
        error.hubVersion,
        error.supportedVersion,
    )
    is PairingError.AuthFailed -> stringResource(R.string.pairing_error_auth_failed, error.httpStatus)
}
