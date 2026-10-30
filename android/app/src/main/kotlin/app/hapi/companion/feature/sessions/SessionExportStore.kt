package app.hapi.companion.feature.sessions

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import app.hapi.protocol.chat.SessionExportFormat
import java.io.IOException
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first

/**
 * Export-format persistence — the web twin keeps the last choice in
 * `localStorage['hapi.sessionExportFormat']` (invalid values fall back to
 * JSON); the Android divergence is the app-wide Preferences DataStore
 * (`hapi_prefs`), same as every other small setting in this app.
 */
interface SessionExportFormatStore {
    suspend fun read(): SessionExportFormat
    suspend fun write(format: SessionExportFormat)
}

class DataStoreSessionExportFormatStore(
    private val dataStore: DataStore<Preferences>,
) : SessionExportFormatStore {

    override suspend fun read(): SessionExportFormat =
        SessionExportFormat.fromStorageValue(
            dataStore.data
                .catch { if (it is IOException) emit(emptyPreferences()) else throw it }
                .first()[KEY],
        )

    override suspend fun write(format: SessionExportFormat) {
        dataStore.edit { it[KEY] = format.storageValue }
    }

    private companion object {
        val KEY = stringPreferencesKey("session_export_format")
    }
}
