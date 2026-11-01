package app.hapi.companion.feature.files

import androidx.compose.runtime.Immutable
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import java.io.IOException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive

/**
 * A download that was in flight when the process died — just its identity:
 * the bytes are never persisted (DataStore must not carry file payloads);
 * recovery re-fetches them, the same lossless `readSessionFile` read the
 * original request made (review: pending-download recovery across process
 * recreation).
 */
@Immutable
data class PendingDownloadRequest(
    /** Session-root-relative path of the file being downloaded. */
    val path: String,
    /** Suggested save name (the SAF picker's `EXTRA_TITLE`). */
    val fileName: String,
)

/**
 * Persists the files feature's pending download across process recreation —
 * the download-pipeline twin of the files foundation's other DataStore seams
 * (`DirectorySortPrefs`, `DirectoryExpandPrefs`): a Flow the ViewModels
 * collect on start and a suspend write hook they invoke as the pipeline
 * progresses. Both download entry points (directory rows and the single-file
 * viewer) record a request the moment a fetch starts and clear it once the
 * flow reaches a user decision (SAF picker consumed) or a reported failure;
 * a fresh ViewModel that sees a surviving request re-launches the fetch, so
 * a download interrupted by process death resumes/reports instead of
 * vanishing. Keys carry an opaque owner string (`"files:$hub:$session"` /
 * `"viewer:$hub:$session:$path"`) so the two surfaces never collide. Corrupt
 * values degrade to "no pending download".
 */
class PendingDownloadPrefs(private val dataStore: DataStore<Preferences>) {

    fun pendingDownload(owner: String): Flow<PendingDownloadRequest?> = dataStore.data
        .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
        .map { prefs -> decode(prefs[key(owner)]) }
        .distinctUntilChanged()

    suspend fun setPendingDownload(owner: String, request: PendingDownloadRequest?) {
        dataStore.edit { prefs ->
            if (request == null) prefs.remove(key(owner)) else prefs[key(owner)] = encode(request)
        }
    }

    private fun key(owner: String): Preferences.Key<String> = stringPreferencesKey("pending_download:$owner")

    companion object {
        fun encode(request: PendingDownloadRequest): String = JsonObject(
            mapOf(
                "path" to JsonPrimitive(request.path),
                "fileName" to JsonPrimitive(request.fileName),
            ),
        ).toString()

        /** Non-object or non-string payloads degrade to no pending download. */
        fun decode(raw: String?): PendingDownloadRequest? {
            if (raw == null) return null
            val element = try {
                Json.parseToJsonElement(raw)
            } catch (_: Exception) {
                return null
            }
            if (element !is JsonObject) return null
            val path = element["path"]
            val fileName = element["fileName"]
            if (path !is JsonPrimitive || !path.isString || path.content.isEmpty()) return null
            if (fileName !is JsonPrimitive || !fileName.isString || fileName.content.isEmpty()) return null
            return PendingDownloadRequest(path.content, fileName.content)
        }
    }
}
