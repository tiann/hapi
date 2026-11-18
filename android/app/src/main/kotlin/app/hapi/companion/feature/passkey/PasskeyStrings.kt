package app.hapi.companion.feature.passkey

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import app.hapi.companion.R
import app.hapi.protocol.wire.NativePasskeys

/** Localize a [PasskeyIssue] (pairing sign-in + settings management). */
@Composable
fun passkeyIssueText(issue: PasskeyIssue): String = when (issue) {
    PasskeyIssue.HubAddressRequired -> stringResource(R.string.passkey_hub_address_required)
    PasskeyIssue.WrongHub -> stringResource(R.string.passkey_error_wrong_hub)
    PasskeyIssue.NoCredentialOnDevice -> stringResource(R.string.passkey_error_no_credential)
    PasskeyIssue.Unavailable -> stringResource(R.string.passkey_error_unavailable)
    is PasskeyIssue.RpMismatch -> stringResource(
        R.string.passkey_error_rp_mismatch,
        issue.actual ?: "?",
        NativePasskeys.RP_ID,
    )
    PasskeyIssue.Revoked -> stringResource(R.string.passkey_error_revoked)
    PasskeyIssue.VerificationFailed -> stringResource(R.string.passkey_error_verification_failed)
    PasskeyIssue.AlreadyRegistered -> stringResource(R.string.passkey_error_already_registered)
    PasskeyIssue.Unreachable -> stringResource(R.string.passkey_error_unreachable)
    is PasskeyIssue.Http -> stringResource(R.string.passkey_error_http, issue.status)
    is PasskeyIssue.Failed -> issue.message?.takeIf { it.isNotBlank() }
        ?.let { stringResource(R.string.passkey_error_failed_detail, it) }
        ?: stringResource(R.string.passkey_error_failed)
}
