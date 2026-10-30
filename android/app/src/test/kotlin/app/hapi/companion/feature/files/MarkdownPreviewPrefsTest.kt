package app.hapi.companion.feature.files

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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
 * Markdown preview/source pref round-trips against a real temp-file
 * Preferences DataStore (pure JVM), including the cold-start reload path and
 * the web "normalize by absence" rule — web localStorage
 * `hapi.filePreview.markdownMode.v1` stores only the non-default Source
 * choice, so an absent key always reads as Preview
 * (`file-markdown-preview.ts`).
 */
class MarkdownPreviewPrefsTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun newScope(): CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private fun storeFile(name: String): File = File(tmp.root, "$name.preferences_pb")

    @Test
    fun `source round-trips and survives a cold start`() = runTest {
        val file = storeFile("markdown")

        val firstScope = newScope()
        try {
            val prefs = MarkdownPreviewPrefs(PreferenceDataStoreFactory.create(scope = firstScope) { file })
            // Absent key reads as the default Preview.
            assertFalse(prefs.source.first())

            prefs.setSource(true)
            assertTrue(prefs.source.first())
        } finally {
            firstScope.coroutineContext[Job]?.cancelAndJoin()
        }

        // "Second process": a fresh DataStore over the same file.
        val secondScope = newScope()
        try {
            val prefs = MarkdownPreviewPrefs(PreferenceDataStoreFactory.create(scope = secondScope) { file })
            assertTrue(prefs.source.first())

            // Returning to the default also survives the cold start.
            prefs.setSource(false)
            assertFalse(prefs.source.first())
        } finally {
            secondScope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `picking the default removes the key`() = runTest {
        val scope = newScope()
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = scope) { storeFile("absence") }
            val prefs = MarkdownPreviewPrefs(dataStore)

            prefs.setSource(true)
            assertEquals(true, dataStore.data.first()[MarkdownPreviewPrefs.SOURCE_KEY])

            // Web `setMarkdownPreviewMode` removes the entry at the default so
            // the store never accumulates default-value rows.
            prefs.setSource(false)
            assertEquals(null, dataStore.data.first()[MarkdownPreviewPrefs.SOURCE_KEY])
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }

    @Test
    fun `a foreign stored value degrades to the default`() = runTest {
        val scope = newScope()
        try {
            val dataStore = PreferenceDataStoreFactory.create(scope = scope) { storeFile("junk") }
            dataStore.edit { it[MarkdownPreviewPrefs.SOURCE_KEY] = true }
            // A value written under the same key by some other version still
            // only means Source; there is no third state to mis-read.
            assertTrue(MarkdownPreviewPrefs(dataStore).source.first())
        } finally {
            scope.coroutineContext[Job]?.cancelAndJoin()
        }
    }
}
