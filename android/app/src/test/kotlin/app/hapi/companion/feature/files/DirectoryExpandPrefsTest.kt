package app.hapi.companion.feature.files

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
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
 * Expanded-directory set round-trips against a real temp-file Preferences
 * DataStore (pure JVM), plus the pure encode/decode degradation rules — the
 * web sessionStorage `hapi-dir-expanded-{sessionId}` JSON-array twin
 * (`DirectoryTree.tsx` `readExpanded`: non-array payloads fall back to the
 * root-only default).
 */
class DirectoryExpandPrefsTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun newScope(): CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private fun storeFile(name: String): File = File(tmp.root, "$name.preferences_pb")

    @Test
    fun `encode emits a json string array and decode restores it`() {
        val paths = setOf("", "src", "src/main")
        // setOf is insertion-ordered, so the wire form is deterministic.
        assertEquals("""["","src","src/main"]""", DirectoryExpandPrefs.encode(paths))
        assertEquals(paths, DirectoryExpandPrefs.decode(DirectoryExpandPrefs.encode(paths)))
    }

    @Test
    fun `decode degrades non-array payloads to the default`() {
        assertEquals(emptySet(), DirectoryExpandPrefs.decode(null))
        assertEquals(emptySet(), DirectoryExpandPrefs.decode("not json at all"))
        assertEquals(emptySet(), DirectoryExpandPrefs.decode("""{"paths":["src"]}"""))
        assertEquals(emptySet(), DirectoryExpandPrefs.decode("42"))
        // Non-string array elements drop out; string ones survive.
        assertEquals(setOf("src"), DirectoryExpandPrefs.decode("""["src",7,null,true]"""))
        // Duplicates collapse (a set never re-expands them).
        assertEquals(setOf("a"), DirectoryExpandPrefs.decode("""["a","a"]"""))
    }

    @Test
    fun `expanded set round-trips per hub and session and survives a cold start`() = runTest {
        val file = storeFile("expand")

        val firstScope = newScope()
        try {
            val prefs = DirectoryExpandPrefs(PreferenceDataStoreFactory.create(scope = firstScope) { file })
            assertEquals(emptySet(), prefs.expandedPaths("https://a.example", "s1").first())

            prefs.setExpandedPaths("https://a.example", "s1", setOf("", "src"))
            assertEquals(setOf("", "src"), prefs.expandedPaths("https://a.example", "s1").first())

            // Another hub or session on the same store stays untouched
            // (Android pairs several hubs; web keys by session only).
            assertEquals(emptySet(), prefs.expandedPaths("https://b.example", "s1").first())
            assertEquals(emptySet(), prefs.expandedPaths("https://a.example", "s2").first())
            prefs.setExpandedPaths("https://b.example", "s2", setOf("docs"))
        } finally {
            firstScope.coroutineContext[Job]?.cancelAndJoin()
        }

        // "Second process": a fresh DataStore over the same file.
        val secondScope = newScope()
        try {
            val prefs = DirectoryExpandPrefs(PreferenceDataStoreFactory.create(scope = secondScope) { file })
            assertEquals(setOf("", "src"), prefs.expandedPaths("https://a.example", "s1").first())
            assertEquals(setOf("docs"), prefs.expandedPaths("https://b.example", "s2").first())
        } finally {
            secondScope.coroutineContext[Job]?.cancelAndJoin()
        }
    }
}
