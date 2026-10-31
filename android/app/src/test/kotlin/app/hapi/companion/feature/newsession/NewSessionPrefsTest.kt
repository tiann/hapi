package app.hapi.companion.feature.newsession

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import app.hapi.protocol.wire.HapiJson
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runTest
import org.junit.Rule
import org.junit.rules.TemporaryFolder

/**
 * Launch-preference storage round-trips against a real temp-file Preferences
 * DataStore (pure JVM), including the cold-start reload, legacy-blob
 * tolerance (stored JSON without the new field) and corrupt-blob fallback —
 * the same degradation contract as the roster/theme prefs.
 */
class NewSessionPrefsTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun newScope(): CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private fun storeFile(name: String): File = File(tmp.root, "$name.preferences_pb")

    private fun sampleLaunchSettings(): Map<String, Map<String, PreferredLaunchSettings>> = mapOf(
        "m1" to mapOf(
            "claude" to PreferredLaunchSettings(model = "opus", effort = "high", permissionMode = "plan"),
            "codex" to PreferredLaunchSettings(
                model = "gpt-5.2-codex",
                modelReasoningEffort = "high",
                permissionMode = "read-only",
            ),
        ),
        "m2" to mapOf(
            "claude" to PreferredLaunchSettings(), // dimension isolation: m2 has no opinion yet
        ),
    )

    @Test
    fun `launch settings round-trip per machine and agent and survive a cold start`() = runTest {
        val file = storeFile("launch")
        val data = NewSessionPrefsData(
            lastMachineId = "m1",
            recentPaths = mapOf("m1" to listOf("/data/github/hapi")),
            launchSettings = sampleLaunchSettings(),
        )

        val firstScope = newScope()
        try {
            val prefs = DataStoreNewSessionPrefs(PreferenceDataStoreFactory.create(scope = firstScope) { file })
            prefs.writePrefs(data)
            assertEquals(data, prefs.readPrefs())
        } finally {
            firstScope.coroutineContext[Job]?.cancelAndJoin()
        }

        // "Second process": a fresh DataStore over the same file.
        val secondScope = newScope()
        try {
            val prefs = DataStoreNewSessionPrefs(PreferenceDataStoreFactory.create(scope = secondScope) { file })
            assertEquals(data, prefs.readPrefs())
        } finally {
            secondScope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `legacy blob without launch settings decodes with empty defaults`() = runTest {
        val scope = newScope()
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = scope) { storeFile("legacy") }
            // The pre-launch-prefs shape: no `launchSettings` field at all.
            dataStore.edit {
                it[DataStoreNewSessionPrefs.PREFS_KEY] =
                    """{"lastMachineId":"m1","recentPaths":{"m1":["/data/github/hapi"]}}"""
            }
            val prefs = DataStoreNewSessionPrefs(dataStore)
            assertEquals("m1", prefs.readPrefs().lastMachineId)
            assertEquals(mapOf("m1" to listOf("/data/github/hapi")), prefs.readPrefs().recentPaths)
            assertEquals(emptyMap(), prefs.readPrefs().launchSettings)
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `corrupt prefs blob falls back to empty defaults`() = runTest {
        val scope = newScope()
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = scope) { storeFile("junk") }
            // Garbage JSON, and a launchSettings shape that is not a map of
            // maps — both must degrade to the empty defaults, never crash.
            dataStore.edit {
                it[DataStoreNewSessionPrefs.PREFS_KEY] = """{"lastMachineId":"m1","launchSettings":"nope"}"""
            }
            assertEquals(NewSessionPrefsData(), DataStoreNewSessionPrefs(dataStore).readPrefs())

            dataStore.edit {
                it[DataStoreNewSessionPrefs.PREFS_KEY] = "not json {{{"
            }
            assertEquals(NewSessionPrefsData(), DataStoreNewSessionPrefs(dataStore).readPrefs())
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `corrupt launch entry inside the map falls back to empty defaults`() = runTest {
        val scope = newScope()
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = scope) { storeFile("entry") }
            // A single malformed entry (model is a number) breaks the whole
            // blob decode → full defaults, matching the DirectoryExpandPrefs
            // degrade contract.
            dataStore.edit {
                it[DataStoreNewSessionPrefs.PREFS_KEY] =
                    """{"lastMachineId":"m1","launchSettings":{"m1":{"claude":{"model":42}}}}"""
            }
            assertEquals(NewSessionPrefsData(), DataStoreNewSessionPrefs(dataStore).readPrefs())
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `round-tripped launch entries decode with all four fields intact`() = runTest {
        val scope = newScope()
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = scope) { storeFile("fields") }
            val prefs = DataStoreNewSessionPrefs(dataStore)
            prefs.writePrefs(NewSessionPrefsData(launchSettings = sampleLaunchSettings()))
            val claude = prefs.readPrefs().launchSettings.getValue("m1").getValue("claude")
            assertEquals("opus", claude.model)
            assertEquals("high", claude.effort)
            assertEquals("default", claude.modelReasoningEffort)
            assertEquals("plan", claude.permissionMode)

            // The serialized shape keeps permissionMode absent (not
            // "default") for flavors that do not remember it — null
            // round-trips as null, and sentinel-only entries stay compact
            // (HapiJson encodes no defaults).
            val json = HapiJson.encodeToString(
                PreferredLaunchSettings.serializer(),
                PreferredLaunchSettings(model = "sonnet"),
            )
            assertEquals("""{"model":"sonnet"}""", json)
            assertEquals(
                PreferredLaunchSettings(model = "sonnet"),
                HapiJson.decodeFromString(PreferredLaunchSettings.serializer(), json),
            )
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }
}
