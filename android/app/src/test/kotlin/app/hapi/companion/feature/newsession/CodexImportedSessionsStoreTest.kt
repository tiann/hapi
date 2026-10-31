@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.newsession

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Rule
import org.junit.rules.TemporaryFolder

/**
 * Memory-store semantics for the imported-markers map (web
 * `web/src/lib/codexImportedSessions.ts`): blank ids skipped, ids trimmed,
 * clear is a no-op for absent ids. Plus per-hub isolation of the DataStore
 * twin (review: "scope imported markers per hub"): two stores over one
 * temp-file DataStore, differing only in their `hubKey`, must never observe
 * each other's markers — the Android twin of the web's per-origin
 * localStorage — including across a cold restart and under a corrupt blob.
 */
class CodexImportedSessionsStoreTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun newScope(): CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private fun storeFile(name: String): File = File(tmp.root, "$name.preferences_pb")

    @Test
    fun `mark imported skips blanks and stamps every kept id`() = runTest {
        val store = MemoryCodexImportedSessionsStore()
        assertTrue(store.markers.value.isEmpty())

        store.markImported(listOf(" a ", "", "   ", "b"), importedAt = 5L)
        assertEquals(mapOf("a" to 5L, "b" to 5L), store.markers.value)

        // Re-importing refreshes the timestamp.
        store.markImported(listOf("a"), importedAt = 9L)
        assertEquals(mapOf("a" to 9L, "b" to 5L), store.markers.value)
    }

    @Test
    fun `clear marker only removes what is present`() = runTest {
        val store = MemoryCodexImportedSessionsStore()
        store.markImported(listOf("a", "b"), importedAt = 1L)

        store.clearMarker("missing")
        assertEquals(mapOf("a" to 1L, "b" to 1L), store.markers.value)

        store.clearMarker("a")
        assertEquals(mapOf("b" to 1L), store.markers.value)
    }

    @Test
    fun `markers partition per hub and clearing one hub leaves the other intact`() = runTest {
        val scope = newScope()
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = scope) { storeFile("hubs") }
            val hubA = DataStoreCodexImportedSessionsStore(dataStore, scope, hubKey = "https://hub-a.example")
            val hubB = DataStoreCodexImportedSessionsStore(dataStore, scope, hubKey = "https://hub-b.example")

            hubA.markImported(listOf("thread-1", "thread-2"), importedAt = 1_000L)
            // The collector runs on the real IO scope; await its emission.
            assertEquals(
                mapOf("thread-1" to 1_000L, "thread-2" to 1_000L),
                hubA.markers.first { it.isNotEmpty() },
            )

            // hubB never sees hubA's import: the same thread id stays
            // selectable (not badged) there.
            assertEquals(emptyMap(), hubB.markers.value)

            // hubB importing the same thread id stays local to hubB.
            hubB.markImported(listOf("thread-1"), importedAt = 2_000L)
            assertEquals(mapOf("thread-1" to 2_000L), hubB.markers.first { it.isNotEmpty() })
            assertEquals(1_000L, hubA.markers.value["thread-1"])

            // Clearing on one hub must not touch the other hub's markers.
            hubB.clearMarker("thread-1")
            assertEquals(emptyMap(), hubB.markers.first { it.isEmpty() })
            assertEquals(1_000L, hubA.markers.value["thread-1"])
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `markers survive a cold start and stay hub-scoped across restarts`() = runTest {
        val file = storeFile("cold")

        val firstScope = newScope()
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = firstScope) { file }
            val hubA = DataStoreCodexImportedSessionsStore(dataStore, firstScope, hubKey = "https://hub-a.example")
            val hubB = DataStoreCodexImportedSessionsStore(dataStore, firstScope, hubKey = "https://hub-b.example")
            hubA.markImported(listOf("thread-9"), importedAt = 42L)
            hubB.markImported(listOf("thread-9"), importedAt = 43L)
            assertEquals(mapOf("thread-9" to 42L), hubA.markers.first { it.isNotEmpty() })
            assertEquals(mapOf("thread-9" to 43L), hubB.markers.first { it.isNotEmpty() })
        } finally {
            firstScope.coroutineContext[Job]?.cancelAndJoin()
        }

        // "Second process": a fresh DataStore over the same file reloads
        // each hub's own markers — and only those.
        val secondScope = newScope()
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = secondScope) { file }
            val hubA = DataStoreCodexImportedSessionsStore(dataStore, secondScope, hubKey = "https://hub-a.example")
            val hubB = DataStoreCodexImportedSessionsStore(dataStore, secondScope, hubKey = "https://hub-b.example")
            assertEquals(mapOf("thread-9" to 42L), hubA.markers.first { it.isNotEmpty() })
            assertEquals(mapOf("thread-9" to 43L), hubB.markers.first { it.isNotEmpty() })
        } finally {
            secondScope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `corrupt hub blob degrades to empty markers without touching other hubs`() = runTest {
        val scope = newScope()
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = scope) { storeFile("corrupt") }
            // Sabotage exactly hubA's blob; hubB's stays absent.
            dataStore.edit {
                it[stringPreferencesKey("codex_imported_sessions:https://hub-a.example")] = "{not json"
            }
            val hubA = DataStoreCodexImportedSessionsStore(dataStore, scope, hubKey = "https://hub-a.example")
            val hubB = DataStoreCodexImportedSessionsStore(dataStore, scope, hubKey = "https://hub-b.example")

            hubB.markImported(listOf("thread-1"), importedAt = 1L)
            assertEquals(mapOf("thread-1" to 1L), hubB.markers.first { it.isNotEmpty() })
            // hubA degraded to empty (decode failure swallowed) — and its
            // next import rewrites the blob cleanly.
            assertEquals(emptyMap(), hubA.markers.value)
            hubA.markImported(listOf("thread-2"), importedAt = 5L)
            assertEquals(mapOf("thread-2" to 5L), hubA.markers.first { it.isNotEmpty() })
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }
}

