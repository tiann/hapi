// security-crypto 1.1.0 deprecated the whole artifact with no AndroidX
// replacement; it remains the sanctioned Keystore-backed prefs wrapper, and
// the CredentialStore seam is exactly the swap point when we outgrow it.
@file:Suppress("DEPRECATION")

package app.hapi.data.auth

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import app.hapi.protocol.wire.HapiJson
import kotlinx.serialization.encodeToString

/**
 * [CredentialStore] backed by `EncryptedSharedPreferences` (AES256-GCM values,
 * AES256-SIV keys, Keystore-held master key), per the contract's storage
 * guidance (`docs/api/client-contract/auth.md#credential-storage-guidance`).
 *
 * One preference entry per hub: key = normalized hub origin, value =
 * [HubCredentials] as JSON. Construction of the underlying prefs (Keystore
 * access + file decrypt) is deferred to first use and can block — like every
 * [CredentialStore] operation, call from a background thread.
 *
 * Writes use `commit()` (synchronous) on purpose: a lost credential write
 * costs a re-pair, which is far worse than the few ms of blocking on the
 * calling (already-background) thread.
 */
class EncryptedPrefsCredentialStore(
    context: Context,
    private val fileName: String = DEFAULT_FILE_NAME,
) : CredentialStore {

    private val appContext = context.applicationContext

    private val prefs: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            appContext,
            fileName,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    override fun get(hubUrl: String): HubCredentials? {
        val raw = prefs.getString(credentialKey(hubUrl), null) ?: return null
        return try {
            HapiJson.decodeFromString<HubCredentials>(raw)
        } catch (_: Exception) {
            null
        }
    }

    override fun set(credentials: HubCredentials) {
        prefs.edit()
            .putString(credentialKey(credentials.hubUrl), HapiJson.encodeToString(credentials))
            .commit()
    }

    override fun delete(hubUrl: String) {
        prefs.edit().remove(credentialKey(hubUrl)).commit()
    }

    companion object {
        const val DEFAULT_FILE_NAME: String = "hapi_credentials"
    }
}
