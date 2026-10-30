package app.hapi.companion.feature.directorybrowser

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
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
import kotlinx.coroutines.test.runTest
import org.junit.Rule
import org.junit.rules.TemporaryFolder

/**
 * Show-hidden persistence round-trips against a real temp-file Preferences
 * DataStore (pure JVM), defaulting to false and surviving a cold start —
 * the web `hapi:workspaceBrowserShowHidden` localStorage contract.
 */
class DirectoryBrowserPrefsTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun newScope(): CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private fun storeFile(name: String): File = File(tmp.root, "$name.preferences_pb")

    @Test
    fun `show hidden defaults to false round-trips and survives a cold start`() = runTest {
        val file = storeFile("showhidden")

        val firstScope = newScope()
        try {
            val prefs = DataStoreDirectoryBrowserPrefs(PreferenceDataStoreFactory.create(scope = firstScope) { file })
            // Fresh store: hidden entries excluded by default (web default false).
            assertFalse(prefs.readShowHidden())

            prefs.writeShowHidden(true)
            assertTrue(prefs.readShowHidden())

            prefs.writeShowHidden(false)
            assertFalse(prefs.readShowHidden())
        } finally {
            firstScope.coroutineContext[Job]?.cancelAndJoin()
        }

        // "Second process": a fresh DataStore over the same file keeps the
        // last written value.
        val secondScope = newScope()
        try {
            val prefs = DataStoreDirectoryBrowserPrefs(PreferenceDataStoreFactory.create(scope = secondScope) { file })
            prefs.writeShowHidden(true)
            assertEquals(true, prefs.readShowHidden())
        } finally {
            secondScope.coroutineContext[Job]?.cancelAndJoin()
        }

        val thirdScope = newScope()
        try {
            assertEquals(
                true,
                DataStoreDirectoryBrowserPrefs(PreferenceDataStoreFactory.create(scope = thirdScope) { file })
                    .readShowHidden(),
            )
        } finally {
            thirdScope.coroutineContext[Job]?.cancelAndJoin()
        }
    }
}
