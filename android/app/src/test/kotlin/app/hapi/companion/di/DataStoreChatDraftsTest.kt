package app.hapi.companion.di

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
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
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Rule
import org.junit.rules.TemporaryFolder

class DataStoreChatDraftsTest {
    @get:Rule val tmp = TemporaryFolder()

    private val hub = "hub.test"

    private fun storeFile(name: String): File =
        File(tmp.root, "$name.preferences_pb")

    private fun newScope(): CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @Test fun `share append and receipt persist together across holder recreation and later edits`() = runTest {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        try {
            val store = PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "drafts.preferences_pb") }
            val first = DataStoreChatDrafts(store, "https://a.example")
            assertEquals("original\nshared", first.appendSharedText("session", "request", "original", "shared"))
            val restored = DataStoreChatDrafts(store, "https://a.example")
            assertEquals("original\nshared", restored.load("session"))
            restored.save("session", "edited")
            assertEquals("edited", restored.appendSharedText("session", "request", "edited", "shared"))
            assertEquals("edited", restored.load("session"))
            val anotherHub = DataStoreChatDrafts(store, "https://b.example")
            assertEquals("shared", anotherHub.appendSharedText("session", "request", "", "shared"))
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test fun `superseding session migration carries receipts with its draft without replacing a target draft`() = runTest {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        try {
            val store = PreferenceDataStoreFactory.create(scope = scope) { File(tmp.root, "drafts.preferences_pb") }
            val drafts = DataStoreChatDrafts(store, "https://a.example")
            drafts.appendSharedText("old", "request", "draft", "shared")
            drafts.move("old", "new")
            assertEquals("draft\nshared", drafts.load("new"))
            assertEquals("draft\nshared", drafts.appendSharedText("new", "request", "draft\nshared", "shared"))
            drafts.save("existing", "keep me")
            drafts.move("new", "existing")
            assertEquals("keep me", drafts.load("existing"))
            assertEquals("keep me\nshared", drafts.appendSharedText("existing", "request", "keep me", "shared"))
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `the ring caps at fifty and evicts the least-recently-saved draft`() = runTest {
        val scope = newScope()
        try {
            var tick = 0L
            val drafts = DataStoreChatDrafts(
                PreferenceDataStoreFactory.create(scope = scope) { storeFile("ring") }, hub,
                now = { tick++ },
            )

            repeat(50) { drafts.save("s$it", "draft $it") }
            drafts.save("s0", "refreshed") // protect the eldest

            drafts.save("s50", "newest")

            assertEquals("refreshed", drafts.load("s0"))
            assertNull(drafts.load("s1"), "next-oldest must be evicted")
            assertEquals("newest", drafts.load("s50"))
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `same-session saves never evict at the cap`() = runTest {
        val scope = newScope()
        try {
            var tick = 0L
            val drafts = DataStoreChatDrafts(
                PreferenceDataStoreFactory.create(scope = scope) { storeFile("same") }, hub,
                now = { tick++ },
            )

            repeat(50) { drafts.save("s$it", "draft $it") }
            repeat(3) { drafts.save("s10", "again") }

            assertTrue((0 until 50).all { drafts.load("s$it") != null })
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `a lost index re-adopts orphan rows so the cap still bounds the store`() = runTest {
        val scope = newScope()
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = scope) { storeFile("orphan") }
            var tick = 0L
            val drafts = DataStoreChatDrafts(dataStore, hub, now = { tick++ })

            // Value rows the index never saw (index lost/corrupt).
            repeat(10) { orphan ->
                dataStore.edit {
                    it[stringPreferencesKey("draft:$hub:orphan$orphan")] = "stale $orphan"
                }
            }

            repeat(60) { drafts.save("s$it", "draft $it") }

            val valueRows = dataStore.data.first().asMap().keys
                .count { it.name.startsWith("draft:$hub:") }
            assertTrue(valueRows <= 50, "cap must bound the store after index loss (was $valueRows)")
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `a corrupt index decodes to empty without breaking saves`() = runTest {
        val scope = newScope()
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = scope) { storeFile("corrupt-index") }
            val drafts = DataStoreChatDrafts(dataStore, hub)

            dataStore.edit { it[stringPreferencesKey("draft-index:$hub")] = "][not json" }
            drafts.save("s1", "still works")

            assertEquals("still works", drafts.load("s1"))
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `move keeps never-clobber semantics and drops the source row`() = runTest {
        val scope = newScope()
        try {
            val drafts = DataStoreChatDrafts(
                PreferenceDataStoreFactory.create(scope = scope) { storeFile("move") }, hub,
            )

            drafts.save("s1", "carry me")
            drafts.move("s1", "s2")
            assertEquals("carry me", drafts.load("s2"))
            assertNull(drafts.load("s1"))

            drafts.save("s3", "mine")
            drafts.save("s4", "target keeps its own")
            drafts.move("s3", "s4")
            assertEquals("target keeps its own", drafts.load("s4"))
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }
}
