package app.hapi.companion.feature.passkey

import app.hapi.data.api.ApiError
import app.hapi.protocol.wire.PasskeyRpMismatchException
import java.io.IOException

/**
 * Platform passkey ceremony seam. Production is
 * [CredentialManagerPasskeyPlatform] (needs an Activity); JVM tests script a
 * fake. Both methods take validated, whitelisted WebAuthn options JSON and return
 * the platform's response JSON, or throw [PasskeyCeremonyException].
 */
interface PasskeyPlatform {
    /** `PublicKeyCredentialCreationOptionsJSON` → `RegistrationResponseJSON`. */
    suspend fun createPasskey(requestJson: String): String

    /** `PublicKeyCredentialRequestOptionsJSON` → `AuthenticationResponseJSON`. */
    suspend fun getPasskey(requestJson: String): String
}

/** Platform ceremony failures, normalized away from Credential Manager types. */
sealed class PasskeyCeremonyException(message: String?) : Exception(message) {
    /** The user dismissed the sheet — silent, not an error. */
    class Cancelled : PasskeyCeremonyException("cancelled")

    /** No passkey on this device matches the hub's `allowCredentials`. */
    class NoCredential : PasskeyCeremonyException("no credential")

    /** No passkey provider / unsupported device configuration. */
    class Unavailable(message: String?) : PasskeyCeremonyException(message)

    /** Anything else the provider reported (incl. WebAuthn DOM errors). */
    class Failed(message: String?) : PasskeyCeremonyException(message)
}

/**
 * User-facing passkey failure, shared by pairing (sign-in) and settings
 * (add/delete). String-free so ViewModel tests assert it directly; screens
 * localize via `passkeyIssueText`.
 */
sealed interface PasskeyIssue {
    /** `404 no_passkeys` — the hub has no app passkeys yet. */
    data object NoneRegistered : PasskeyIssue

    /** The device has no passkey for this hub. */
    data object NoCredentialOnDevice : PasskeyIssue

    /** No passkey provider is available on this device. */
    data object Unavailable : PasskeyIssue

    /** The hub's options target another relying party; ceremony refused. */
    data class RpMismatch(val actual: String?) : PasskeyIssue

    /** `401 passkey_revoked` — registered under a rotated `CLI_API_TOKEN`. */
    data object Revoked : PasskeyIssue

    /** Challenge expired / unknown passkey / signature check failed: retry. */
    data object VerificationFailed : PasskeyIssue

    /** `409` — this authenticator is already registered with the hub. */
    data object AlreadyRegistered : PasskeyIssue

    /** The hub could not be reached. */
    data object Unreachable : PasskeyIssue

    /** Other HTTP failure. */
    data class Http(val status: Int) : PasskeyIssue

    /** Platform ceremony failure with the provider's message, if any. */
    data class Failed(val message: String?) : PasskeyIssue
}

/**
 * Maps a failure of any passkey step (options → ceremony → verify) to a
 * [PasskeyIssue]; null for a user cancellation, which must stay silent.
 */
fun passkeyIssueOf(error: Throwable): PasskeyIssue? = when (error) {
    is PasskeyCeremonyException.Cancelled -> null
    is PasskeyCeremonyException.NoCredential -> PasskeyIssue.NoCredentialOnDevice
    is PasskeyCeremonyException.Unavailable -> PasskeyIssue.Unavailable
    is PasskeyCeremonyException.Failed -> PasskeyIssue.Failed(error.message)
    is PasskeyRpMismatchException -> PasskeyIssue.RpMismatch(error.actual)
    is ApiError -> when {
        error.status == 404 && error.code == NO_PASSKEYS -> PasskeyIssue.NoneRegistered
        error.status == 401 && error.code == PASSKEY_REVOKED -> PasskeyIssue.Revoked
        error.status == 401 || error.status == 400 -> PasskeyIssue.VerificationFailed
        error.status == 409 -> PasskeyIssue.AlreadyRegistered
        else -> PasskeyIssue.Http(error.status)
    }
    is IOException -> PasskeyIssue.Unreachable
    else -> PasskeyIssue.Failed(error.message)
}

private const val NO_PASSKEYS = "no_passkeys"
private const val PASSKEY_REVOKED = "passkey_revoked"
