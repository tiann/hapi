package app.hapi.companion.di

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import app.hapi.data.auth.HubRegistryStorage
import java.io.IOException
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first

/**
 * [HubRegistryStorage] backed by the app's Preferences DataStore: the
 * registry's serialized snapshot lives under one string key. The blob is
 * opaque here — `HubRegistry` owns its schema.
 *
 * A corrupt/unreadable preferences file degrades to "no snapshot" (empty
 * roster → pairing screen) instead of crashing; credentials are unaffected
 * (they live in the [app.hapi.data.auth.EncryptedPrefsCredentialStore]).
 */
class DataStoreHubRegistryStorage(
    private val dataStore: DataStore<Preferences>,
) : HubRegistryStorage {

    override suspend fun read(): String? =
        dataStore.data
            .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
            .first()[KEY]

    override suspend fun write(value: String) {
        dataStore.edit { preferences -> preferences[KEY] = value }
    }

    companion object {
        /** Single-key layout: the registry snapshot JSON. */
        val KEY: Preferences.Key<String> = stringPreferencesKey("hub_registry")
    }
}
