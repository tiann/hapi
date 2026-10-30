package app.hapi.companion.di

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import app.hapi.companion.feature.chat.attachments.ComposerDraftAttachment
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
 * JVM tests against a real temp-file Preferences DataStore (pure-JVM core,
 * the `DataStoreHubRegistryStorageTest` precedent): persistence round-trip,
 * ring eviction, corruption fallback, orphan adoption, supersession move.
 */
class DataStoreAttachmentDraftsTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private val hub = "hub.test"

    private fun refs(id: String, path: String = "/u/$id") = listOf(
        ComposerDraftAttachment(
            id = id, filename = "$id.jpg", mimeType = "image/jpeg", sizeBytes = 3, path = path,
        )
    )

    private fun storeFile(name: String): File =
        File(tmp.root, "$name.preferences_pb")

    private fun newScope(): CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @Test
    fun `save and load round-trip and an empty save clears`() = runTest {
        val scope = newScope()
        try {
            val drafts = DataStoreAttachmentDrafts(
                PreferenceDataStoreFactory.create(scope = scope) { storeFile("rt") }, hub,
            )

            assertTrue(drafts.load("s1").isEmpty())
            drafts.save("s1", refs("a") + refs("b"))
            assertEquals(listOf("a", "b"), drafts.load("s1").map { it.id })
            assertEquals("/u/a", drafts.load("s1").first().path)

            drafts.save("s1", emptyList())
            assertTrue(drafts.load("s1").isEmpty())
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `the ring caps at fifty and evicts the least-recently-saved session`() = runTest {
        val scope = newScope()
        try {
            var tick = 0L
            val drafts = DataStoreAttachmentDrafts(
                PreferenceDataStoreFactory.create(scope = scope) { storeFile("ring") }, hub,
                now = { tick++ },
            )

            repeat(50) { drafts.save("s$it", refs("a$it")) }
            // Refresh the eldest: it must survive the next insert.
            drafts.save("s0", refs("a0"))

            drafts.save("s50", refs("a50"))

            assertTrue(drafts.load("s0").isNotEmpty(), "refreshed eldest must survive")
            assertTrue(drafts.load("s1").isEmpty(), "next-oldest must be evicted")
            assertTrue(drafts.load("s50").isNotEmpty(), "newest must survive")
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `same-session re-saves never evict at the cap`() = runTest {
        val scope = newScope()
        try {
            var tick = 0L
            val drafts = DataStoreAttachmentDrafts(
                PreferenceDataStoreFactory.create(scope = scope) { storeFile("same") }, hub,
                now = { tick++ },
            )

            repeat(50) { drafts.save("s$it", refs("a$it")) }
            repeat(3) { drafts.save("s49", refs("fresh$it")) }

            assertTrue((0 until 50).all { drafts.load("s$it").isNotEmpty() })
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `a corrupt value row degrades to empty (silent fallback)`() = runTest {
        val scope = newScope()
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = scope) { storeFile("corrupt") }
            val drafts = DataStoreAttachmentDrafts(dataStore, hub)

            dataStore.edit { it[stringPreferencesKey("adraft:$hub:s1")] = "{\"not\":\"json" }

            assertTrue(drafts.load("s1").isEmpty())
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `a corrupt index is dropped and orphans are re-adopted so the cap still bounds the store`() = runTest {
        val scope = newScope()
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = scope) { storeFile("orphan") }
            var tick = 0L
            val drafts = DataStoreAttachmentDrafts(dataStore, hub, now = { tick++ })

            // Rows written under a lost/corrupt index: value keys the index
            // does not know about.
            repeat(10) { orphan ->
                dataStore.edit {
                    it[stringPreferencesKey("adraft:$hub:orphan$orphan")] =
                        DataStoreAttachmentDrafts.encodeAttachments(refs("x"))
                }
            }
            dataStore.edit { it[stringPreferencesKey("adraft-index:$hub")] = "][not json" }

            // The first write re-adopts the orphans, then ring pressure must
            // bring the total row count back within the cap.
            repeat(60) { drafts.save("s$it", refs("a$it")) }

            val valueRows = dataStore.data.first().asMap().keys
                .count { it.name.startsWith("adraft:$hub:") }
            assertTrue(valueRows <= 50, "cap must bound the store after index loss (was $valueRows)")
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `move carries references without clobbering a target draft`() = runTest {
        val scope = newScope()
        try {
            val drafts = DataStoreAttachmentDrafts(
                PreferenceDataStoreFactory.create(scope = scope) { storeFile("move") }, hub,
            )

            drafts.save("s1", refs("a"))
            drafts.move("s1", "s2")

            assertEquals(listOf("a"), drafts.load("s2").map { it.id })
            assertTrue(drafts.load("s1").isEmpty())

            // Target with its own draft wins (the text-draft `move` contract):
            // a carry never clobbers words already typed in the target.
            drafts.save("s3", refs("mine"))
            drafts.save("s4", refs("other"))
            drafts.move("s3", "s4")
            assertEquals(listOf("other"), drafts.load("s4").map { it.id })
            assertTrue(drafts.load("s3").isEmpty(), "source row is consumed by the move")
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    // -------------------------------------------------------------- codecs --

    @Test
    fun `decoding drops path-less and empty-id entries instead of failing`() {
        val raw = """
            [{"id":"ok","filename":"a.jpg","mimeType":"image/jpeg","sizeBytes":1,"path":"/u/ok"},
             {"id":"nopath","filename":"b.jpg","mimeType":"image/jpeg","sizeBytes":1},
             {"id":"","filename":"c.jpg","mimeType":"image/jpeg","sizeBytes":1,"path":"/u/c"}]
        """.trimIndent()

        val decoded = DataStoreAttachmentDrafts.decodeAttachments(raw)

        assertEquals(listOf("ok"), decoded.map { it.id })
    }

    @Test
    fun `index codec round-trips and corrupt input yields an empty index`() {
        val index = linkedMapOf("s1" to 1L, "s2" to 2L)

        val decoded = DataStoreAttachmentDrafts.decodeIndex(
            DataStoreAttachmentDrafts.encodeIndex(index),
        )

        assertEquals(index, decoded)
        assertTrue(DataStoreAttachmentDrafts.decodeIndex("][bad").isEmpty())
        assertTrue(DataStoreAttachmentDrafts.decodeIndex(null).isEmpty())
    }

    @Test
    fun `preview data URLs round-trip through the codec`() {
        val entry = ComposerDraftAttachment(
            id = "shot", filename = "shot.jpg", mimeType = "image/jpeg", sizeBytes = 3,
            path = "/u/shot", previewUrl = "data:image/jpeg;base64,QUJD",
        )

        val decoded = DataStoreAttachmentDrafts.decodeAttachments(
            DataStoreAttachmentDrafts.encodeAttachments(listOf(entry)),
        )

        assertEquals(entry, decoded.single())
        assertEquals("data:image/jpeg;base64,QUJD", decoded.single().previewUrl)
    }
}
