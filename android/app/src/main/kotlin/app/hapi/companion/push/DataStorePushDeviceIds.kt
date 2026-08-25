package app.hapi.companion.push

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import app.hapi.data.push.PushDeviceIdSource
import java.util.UUID
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Stable install id for device registration (`deviceId` in
 * `POST /api/devices/register`): a UUID minted on first use and persisted in
 * the app-wide Preferences DataStore, so the hub's
 * `(namespace, deviceId, platform)` upsert always hits the same row for this
 * install. Cleared only by app data wipe / reinstall — which also rotates the
 * FCM token, so a fresh id is correct then.
 */
class DataStorePushDeviceIds(
    private val dataStore: DataStore<Preferences>,
) : PushDeviceIdSource {

    private val mutex = Mutex()

    override suspend fun deviceId(): String = mutex.withLock {
        dataStore.data.first()[KEY]?.takeIf { it.isNotBlank() }
            ?: UUID.randomUUID().toString().also { minted ->
                dataStore.edit { prefs -> prefs[KEY] = minted }
            }
    }

    private companion object {
        val KEY = stringPreferencesKey("push_device_id")
    }
}
