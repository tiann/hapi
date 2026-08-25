package app.hapi.companion.feature.pairing

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import app.hapi.companion.R
import app.hapi.protocol.pairing.BindLink
import app.hapi.protocol.pairing.PairingLinks
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

/**
 * QR pairing via zxing-android-embedded's [ScanContract] (the full-screen
 * capture activity as an Activity Result — simpler than embedding
 * `DecoratedBarcodeView`). Entering the screen requests the CAMERA permission
 * through the Activity Result API and then launches the scanner; scans are
 * parsed with [PairingLinks.parse], so both the companion deeplink QR and the
 * hub's web-URL QR pair successfully, and anything else gets a friendly
 * "not a pairing code" retry card.
 */
@Composable
fun QrScanScreen(
    state: PairingUiState,
    onPairLink: (BindLink) -> Unit,
    onManualEntry: () -> Unit,
    onBack: () -> Unit,
    onDismissError: () -> Unit,
) {
    val context = LocalContext.current
    var notPairingQr by rememberSaveable { mutableStateOf(false) }
    var permissionDenied by rememberSaveable { mutableStateOf(false) }
    val scanPrompt = stringResource(R.string.pairing_scan_prompt)

    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        val contents = result.contents
        if (contents == null) {
            // Back/cancel inside the capture activity: leave the scan screen too.
            onBack()
        } else {
            val link = PairingLinks.parse(contents)
            if (link == null) notPairingQr = true else onPairLink(link)
        }
    }

    fun launchScanner() {
        notPairingQr = false
        scanLauncher.launch(
            ScanOptions().apply {
                setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                setPrompt(scanPrompt)
                setBeepEnabled(false)
                setOrientationLocked(true)
                setCaptureActivity(PortraitCaptureActivity::class.java)
            }
        )
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            permissionDenied = false
            launchScanner()
        } else {
            permissionDenied = true
        }
    }

    fun startScan() {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) launchScanner() else permissionLauncher.launch(Manifest.permission.CAMERA)
    }

    // Straight into the scanner on entry — unless something (an error card,
    // a denied permission, a running attempt) is already on screen.
    LaunchedEffect(Unit) {
        if (state is PairingUiState.Idle && !notPairingQr && !permissionDenied) startScan()
    }

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
                text = stringResource(R.string.pairing_scan_title),
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.primary,
            )
            Spacer(modifier = Modifier.height(24.dp))

            PairingStatus(state = state, onDismissError = onDismissError)

            if (notPairingQr) {
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 16.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer,
                        contentColor = MaterialTheme.colorScheme.onErrorContainer,
                    ),
                ) {
                    Text(
                        text = stringResource(R.string.pairing_scan_not_pairing_qr),
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(16.dp),
                    )
                }
            }
            if (permissionDenied) {
                Text(
                    text = stringResource(R.string.pairing_scan_permission_rationale),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = 16.dp),
                )
            }

            Button(
                onClick = ::startScan,
                enabled = state !is PairingUiState.Validating,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    stringResource(
                        if (permissionDenied) R.string.pairing_scan_grant_camera
                        else R.string.pairing_scan_again
                    )
                )
            }
            Spacer(modifier = Modifier.height(8.dp))
            OutlinedButton(
                onClick = onManualEntry,
                enabled = state !is PairingUiState.Validating,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.pairing_manual_entry))
            }
            TextButton(
                onClick = onBack,
                enabled = state !is PairingUiState.Validating,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.pairing_back))
            }
        }
    }
}
