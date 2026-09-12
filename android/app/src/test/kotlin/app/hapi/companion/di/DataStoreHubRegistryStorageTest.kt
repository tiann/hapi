package app.hapi.companion.di

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import app.hapi.data.auth.HubRegistry
import app.hapi.data.auth.HubRegistryState
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runTest
import org.junit.Rule
import org.junit.rules.TemporaryFolder

/**
 * JVM tests against a real temp-file Preferences DataStore
 * (datastore-preferences-core is pure JVM — no Android runtime needed).
 */
class DataStoreHubRegistryStorageTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun newDataStoreScope(): CoroutineScope =
        CoroutineScope(Dispatchers.IO + SupervisorJob())

    private fun storeFile(name: String): File =
        // DataStore requires the .preferences_pb extension.
        File(tmp.root, "$name.preferences_pb")

    @Test
    fun `raw blob round-trips and lands on disk`() = runTest {
        val scope = newDataStoreScope()
        try {
            val file = storeFile("raw")
            val storage = DataStoreHubRegistryStorage(
                PreferenceDataStoreFactory.create(scope = scope) { file }
            )

            assertNull(storage.read())

            storage.write("""{"hubs":["https://a.example"],"activeHubUrl":"https://a.example"}""")
            assertEquals(
                """{"hubs":["https://a.example"],"activeHubUrl":"https://a.example"}""",
                storage.read(),
            )
            assertTrue(file.exists(), "datastore.edit must have flushed to disk")

            storage.write("""{"hubs":[],"activeHubUrl":null}""")
            assertEquals("""{"hubs":[],"activeHubUrl":null}""", storage.read())
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `a HubRegistry snapshot survives reload through the same store`() = runTest {
        val scope = newDataStoreScope()
        try {
            val storage = DataStoreHubRegistryStorage(
                PreferenceDataStoreFactory.create(scope = scope) { storeFile("registry") }
            )

            val first = HubRegistry(storage)
            first.load()
            first.addHub("https://a.example")
            first.addHub("https://b.example:8443", makeActive = false)

            val second = HubRegistry(storage)
            second.load()
            assertEquals(
                HubRegistryState(
                    hubs = listOf("https://a.example", "https://b.example:8443"),
                    activeHubUrl = "https://a.example",
                ),
                second.state.value,
            )
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `the snapshot survives a cold start - a fresh datastore on the same file`() = runTest {
        val file = storeFile("coldstart")

        val firstScope = newDataStoreScope()
        try {
            val storage = DataStoreHubRegistryStorage(
                PreferenceDataStoreFactory.create(scope = firstScope) { file }
            )
            val registry = HubRegistry(storage)
            registry.load()
            registry.addHub("https://hub.example")
        } finally {
            // Fully release the file so the "second process" may open it.
            firstScope.coroutineContext[Job]?.cancelAndJoin()
        }

        val secondScope = newDataStoreScope()
        try {
            val storage = DataStoreHubRegistryStorage(
                PreferenceDataStoreFactory.create(scope = secondScope) { file }
            )
            val registry = HubRegistry(storage)
            registry.load()
            assertEquals(
                HubRegistryState(hubs = listOf("https://hub.example"), activeHubUrl = "https://hub.example"),
                registry.state.value,
            )
        } finally {
            secondScope.coroutineContext[Job]?.cancelAndJoin()
        }
    }
}
