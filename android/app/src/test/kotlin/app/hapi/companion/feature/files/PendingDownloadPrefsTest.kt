package app.hapi.companion.feature.files

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
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
 * Pending-download persistence round-trips against a real temp-file
 * Preferences DataStore (pure JVM), plus the pure encode/decode degradation
 * rules — the save/restore seam behind the files feature's process-recreation
 * recovery (review: a download interrupted by process death must resume/report
 * on recreation instead of vanishing).
 */
class PendingDownloadPrefsTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun newScope(): CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private fun storeFile(name: String): File = File(tmp.root, "$name.preferences_pb")

    @Test
    fun `encode emits a json object and decode restores it`() {
        val request = PendingDownloadRequest("src/main.kt", "main.kt")
        assertEquals("""{"path":"src/main.kt","fileName":"main.kt"}""", PendingDownloadPrefs.encode(request))
        assertEquals(request, PendingDownloadPrefs.decode(PendingDownloadPrefs.encode(request)))
    }

    @Test
    fun `decode degrades corrupt payloads to no pending download`() {
        assertNull(PendingDownloadPrefs.decode(null))
        assertNull(PendingDownloadPrefs.decode("not json at all"))
        assertNull(PendingDownloadPrefs.decode("""["src/main.kt","main.kt"]"""))
        assertNull(PendingDownloadPrefs.decode("""{"path":"src/main.kt"}"""))
        assertNull(PendingDownloadPrefs.decode("""{"fileName":"main.kt"}"""))
        assertNull(PendingDownloadPrefs.decode("""{"path":"","fileName":"main.kt"}"""))
        assertNull(PendingDownloadPrefs.decode("""{"path":7,"fileName":"main.kt"}"""))
        assertNull(PendingDownloadPrefs.decode("42"))
    }

    @Test
    fun `request round-trips per owner, clears, and survives a cold start`() = runTest {
        val file = storeFile("pending_download")

        val firstScope = newScope()
        try {
            val prefs = PendingDownloadPrefs(PreferenceDataStoreFactory.create(scope = firstScope) { file })
            val filesOwner = "files:https://a.example:s1"
            val viewerOwner = "viewer:https://a.example:s1:src/app.ts"

            assertNull(prefs.pendingDownload(filesOwner).first())
            prefs.setPendingDownload(filesOwner, PendingDownloadRequest("notes.md", "notes.md"))
            prefs.setPendingDownload(viewerOwner, PendingDownloadRequest("src/app.ts", "app.ts"))
            // The two surfaces never collide.
            assertEquals(PendingDownloadRequest("notes.md", "notes.md"), prefs.pendingDownload(filesOwner).first())
            assertEquals(PendingDownloadRequest("src/app.ts", "app.ts"), prefs.pendingDownload(viewerOwner).first())

            // Clearing one owner leaves the other intact.
            prefs.setPendingDownload(filesOwner, null)
            assertNull(prefs.pendingDownload(filesOwner).first())
            assertEquals(PendingDownloadRequest("src/app.ts", "app.ts"), prefs.pendingDownload(viewerOwner).first())
        } finally {
            firstScope.coroutineContext[Job]?.cancelAndJoin()
        }

        // Cold start (process recreation): the same DataStore file hands the
        // surviving request to the recreated ViewModel.
        val secondScope = newScope()
        try {
            val prefs = PendingDownloadPrefs(PreferenceDataStoreFactory.create(scope = secondScope) { file })
            assertEquals(PendingDownloadRequest("src/app.ts", "app.ts"), prefs.pendingDownload("viewer:https://a.example:s1:src/app.ts").first())
        } finally {
            secondScope.coroutineContext[Job]?.cancelAndJoin()
        }
    }
}
