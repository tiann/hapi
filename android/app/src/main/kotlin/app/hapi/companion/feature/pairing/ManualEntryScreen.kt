package app.hapi.companion.feature.pairing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.hapi.companion.R

/**
 * Manual fallback for `--relay`-less local hubs: hub URL + access token,
 * paste-friendly (plain single-line fields, no autocorrect/capitalization,
 * the token is not masked — it is a pairing code, not a password).
 */
@Composable
fun ManualEntryScreen(
    state: PairingUiState,
    onPair: (hubUrl: String, accessToken: String) -> Unit,
    onBack: () -> Unit,
    onDismissError: () -> Unit,
) {
    var hubUrl by rememberSaveable { mutableStateOf("") }
    var accessToken by rememberSaveable { mutableStateOf("") }
    val validating = state is PairingUiState.Validating

    Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = stringResource(R.string.pairing_manual_title),
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.primary,
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = stringResource(R.string.pairing_manual_hint),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(modifier = Modifier.height(24.dp))

            OutlinedTextField(
                value = hubUrl,
                onValueChange = { hubUrl = it },
                label = { Text(stringResource(R.string.pairing_hub_url_label)) },
                placeholder = { Text(stringResource(R.string.pairing_hub_url_placeholder)) },
                singleLine = true,
                enabled = !validating,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Uri,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(modifier = Modifier.height(12.dp))
            OutlinedTextField(
                value = accessToken,
                onValueChange = { accessToken = it },
                label = { Text(stringResource(R.string.pairing_token_label)) },
                placeholder = { Text(stringResource(R.string.pairing_token_placeholder)) },
                singleLine = true,
                enabled = !validating,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Ascii,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(modifier = Modifier.height(24.dp))

            PairingStatus(state = state, onDismissError = onDismissError)

            Button(
                onClick = { onPair(hubUrl, accessToken) },
                enabled = !validating && hubUrl.isNotBlank() && accessToken.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.pairing_pair_button))
            }
            Spacer(modifier = Modifier.height(8.dp))
            TextButton(onClick = onBack, enabled = !validating, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.pairing_back))
            }
        }
    }
}
