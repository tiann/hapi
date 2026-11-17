package app.hapi.companion.feature.passkey

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialNoCreateOptionException
import androidx.credentials.exceptions.CreateCredentialProviderConfigurationException
import androidx.credentials.exceptions.CreateCredentialUnsupportedException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialUnsupportedException
import androidx.credentials.exceptions.NoCredentialException

/**
 * [PasskeyPlatform] over Jetpack Credential Manager. Validated, whitelisted
 * options go in as `requestJson`; `registrationResponseJson` /
 * `authenticationResponseJson` come back for the verify call.
 *
 * Passkeys need Android 9+ (API 28); older devices get
 * [PasskeyCeremonyException.Unavailable]. Needs an [Activity]: the system sheet is launched on top of it. Ceremonies
 * for RP ID `auth.hapi.run` only succeed when `https://auth.hapi.run/.well-known/assetlinks.json`
 * lists this build's package + signing-certificate SHA-256 (see the Android
 * README, "Passkeys").
 */
class CredentialManagerPasskeyPlatform(private val activity: Activity) : PasskeyPlatform {

    private val manager: CredentialManager = CredentialManager.create(activity)

    override suspend fun createPasskey(requestJson: String): String {
        // Credential Manager supports passkeys from Android 9 (minSdk is 26).
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            throw PasskeyCeremonyException.Unavailable("Passkeys require Android 9 or newer")
        }
        val result = try {
            manager.createCredential(activity, CreatePublicKeyCredentialRequest(requestJson))
        } catch (_: CreateCredentialCancellationException) {
            throw PasskeyCeremonyException.Cancelled()
        } catch (e: CreateCredentialNoCreateOptionException) {
            throw PasskeyCeremonyException.Unavailable(e.errorMessage?.toString())
        } catch (e: CreateCredentialProviderConfigurationException) {
            throw PasskeyCeremonyException.Unavailable(e.errorMessage?.toString())
        } catch (e: CreateCredentialUnsupportedException) {
            throw PasskeyCeremonyException.Unavailable(e.errorMessage?.toString())
        } catch (e: CreateCredentialException) {
            throw PasskeyCeremonyException.Failed(e.errorMessage?.toString() ?: e.type)
        }
        val response = result as? CreatePublicKeyCredentialResponse
            ?: throw PasskeyCeremonyException.Failed("Unexpected credential type: ${result.type}")
        return response.registrationResponseJson
    }

    override suspend fun getPasskey(requestJson: String): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            throw PasskeyCeremonyException.Unavailable("Passkeys require Android 9 or newer")
        }
        val result = try {
            manager.getCredential(
                activity,
                GetCredentialRequest(listOf(GetPublicKeyCredentialOption(requestJson))),
            )
        } catch (_: GetCredentialCancellationException) {
            throw PasskeyCeremonyException.Cancelled()
        } catch (_: NoCredentialException) {
            throw PasskeyCeremonyException.NoCredential()
        } catch (e: GetCredentialProviderConfigurationException) {
            throw PasskeyCeremonyException.Unavailable(e.errorMessage?.toString())
        } catch (e: GetCredentialUnsupportedException) {
            throw PasskeyCeremonyException.Unavailable(e.errorMessage?.toString())
        } catch (e: GetCredentialException) {
            throw PasskeyCeremonyException.Failed(e.errorMessage?.toString() ?: e.type)
        }
        val credential = result.credential as? PublicKeyCredential
            ?: throw PasskeyCeremonyException.Failed("Unexpected credential type: ${result.credential.type}")
        return credential.authenticationResponseJson
    }
}

/** The hosting [Activity] behind a (possibly wrapped) Compose context, or null. */
tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
