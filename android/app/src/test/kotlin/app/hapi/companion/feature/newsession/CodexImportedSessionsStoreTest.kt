@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.newsession

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

/**
 * Memory-store semantics for the imported-markers map (web
 * `web/src/lib/codexImportedSessions.ts`): blank ids skipped, ids trimmed,
 * clear is a no-op for absent ids.
 */
class CodexImportedSessionsStoreTest {

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
}
