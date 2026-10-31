@file:Suppress("DEPRECATION")

package app.hapi.data.push

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import app.hapi.protocol.wire.HapiJson
import java.io.IOException
import kotlinx.serialization.encodeToString

/** Dedicated Keystore alias and preferences, excluded from cloud backup and device transfer. */
class EncryptedPrefsPushIdentityStore(context: Context) : PushIdentityStore {
    private val appContext = context.applicationContext
    private val prefs: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(appContext, "hapi_push_identity_master_key")
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            appContext, FILE_NAME, masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    override fun read(): PushIdentity? {
        val raw = prefs.getString("identity", null) ?: return null
        return try { HapiJson.decodeFromString<PushIdentity>(raw) } catch (_: Exception) { null }
    }

    override fun write(identity: PushIdentity) {
        if (!prefs.edit().putString("identity", HapiJson.encodeToString(identity)).commit()) {
            throw IOException("Could not persist push identity")
        }
    }

    companion object {
        // Keep the two backup rule XML files in sync with this filename.
        const val FILE_NAME = "hapi_push_identity"
    }
}
