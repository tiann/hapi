package app.hapi.data.push

import java.security.SecureRandom
import java.util.Base64
import java.util.UUID
import kotlinx.serialization.Serializable

/** One install identity shared with every paired hub; independent of FCM token rotation. */
@Serializable
data class PushIdentity(val deviceId: String, val pushKey: String) {
    fun keyBytes(): ByteArray? = try {
        Base64.getDecoder().decode(pushKey).takeIf { it.size == 32 }
    } catch (_: IllegalArgumentException) {
        null
    }

    companion object {
        fun generate(): PushIdentity {
            val key = ByteArray(32).also { SecureRandom().nextBytes(it) }
            return PushIdentity(UUID.randomUUID().toString(), Base64.getEncoder().encodeToString(key))
        }
    }
}

interface PushIdentityStore {
    fun read(): PushIdentity?
    /** Must persist before returning; failure must throw so no unpersisted key is registered. */
    fun write(identity: PushIdentity)
}

fun interface PushIdentitySource {
    suspend fun identity(): PushIdentity
}

/** Registration may create an identity. Notification handling only reads an existing key. */
class PushIdentityManager(private val store: PushIdentityStore) {
    private var pendingIdentity: PushIdentity? = null

    @Synchronized
    fun getOrCreate(): PushIdentity {
        if (pendingIdentity == null) {
            val existing = store.read()
            if (existing != null && existing.deviceId.isNotBlank() && existing.deviceId.length <= 128 && existing.keyBytes() != null) {
                return existing
            }
        }
        // SharedPreferences can update its cache even when commit fails.
        // Retry persistence before trusting that cached identity on registration.
        val identity = pendingIdentity ?: PushIdentity.generate()
        pendingIdentity = identity
        store.write(identity)
        pendingIdentity = null
        return identity
    }

    @Synchronized
    fun existingKey(): ByteArray? = if (pendingIdentity == null) store.read()?.keyBytes() else null
}
