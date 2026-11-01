package app.hapi.companion.feature.files

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.core.app.ActivityOptionsCompat
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.wire.FileReadResponse
import app.hapi.protocol.wire.FileSearchResponse
import app.hapi.protocol.wire.GitCommandResponse
import app.hapi.protocol.wire.ListDirectoryResponse
import java.io.File
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/**
 * Device check for pending-download recovery (files foundation review): a
 * download that reached the SAF CreateDocument picker, followed by process
 * death, relaunches the picker from the recreated ViewModel — and the user's
 * late Save decision lands in the file. The real DataStore-backed
 * [PendingDownloadPrefs] survives both "processes"; a recording
 * [ActivityResultRegistry] stands in for the system picker window (batch-34
 * v4 lesson: real user gesture order — tap download, process death while the
 * picker is up, then return from the picker).
 */
class FileViewerSaveRecreationTest {

    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    /** The files viewer only reads; recorded for read-count assertions. */
    private class DeviceFilesGateway(private val content: String) : FilesGateway {
        val reads = CopyOnWriteArrayList<String>()

        override suspend fun gitStatus(sessionId: String): GitCommandResponse =
            GitCommandResponse(success = true, stdout = "")

        override suspend fun gitDiffNumstat(sessionId: String, staged: Boolean): GitCommandResponse =
            GitCommandResponse(success = true, stdout = "")

        override suspend fun gitDiffFile(sessionId: String, path: String, staged: Boolean?): GitCommandResponse =
            GitCommandResponse(success = true, stdout = "")

        override suspend fun readFile(sessionId: String, path: String): FileReadResponse {
            reads += path
            return FileReadResponse(success = true, content = content)
        }

        override suspend fun searchFiles(sessionId: String, query: String, limit: Int): FileSearchResponse =
            FileSearchResponse(success = true, files = emptyList())

        override suspend fun listDirectory(sessionId: String, path: String?): ListDirectoryResponse =
            ListDirectoryResponse(success = true, entries = emptyList())
    }

    /** Stands in for the SAF picker window: records launches, delivers one Uri. */
    private class RecordingPickerRegistry : ActivityResultRegistry() {
        val launches = CopyOnWriteArrayList<Pair<String, String>>()
        private var lastRequestCode = -1
        private var lastContract: ActivityResultContract<*, *>? = null

        override fun <I, O> onLaunch(
            requestCode: Int,
            contract: ActivityResultContract<I, O>,
            input: I,
            options: ActivityOptionsCompat?,
        ) {
            @Suppress("UNCHECKED_CAST")
            launches += input as Pair<String, String>
            lastRequestCode = requestCode
            lastContract = contract
        }

        /** Delivers a picked target Uri to the most recent launch. */
        fun returnPickedUri(uri: Uri) {
            @Suppress("UNCHECKED_CAST")
            val contract = lastContract as ActivityResultContract<Pair<String, String>, Uri?>
            dispatchResult(lastRequestCode, contract.parseResult(Activity.RESULT_OK, Intent().setData(uri)))
        }
    }

    @Test
    fun returningFromTheSavePickerAfterProcessRecreationCompletesTheSave() {
        val bytes = "saved after process recreation".toByteArray()
        val gateway = DeviceFilesGateway(Base64.getEncoder().encodeToString(bytes))
        val storeFile = File(context.cacheDir, "save-recreation-${System.nanoTime()}.preferences_pb")
        val target = File(context.cacheDir, "save-recreation-${System.nanoTime()}.md")
        val storeScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val observerScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val prefs = PendingDownloadPrefs(PreferenceDataStoreFactory.create(scope = storeScope) { storeFile })
        val owner = "viewer:https://device.example:s1:docs/notes.md"
        val persisted = MutableStateFlow<PendingDownloadRequest?>(null)
        val observer = observerScope.launch { prefs.pendingDownload(owner).collect { persisted.value = it } }

        val registry = RecordingPickerRegistry()
        val registryOwner = object : ActivityResultRegistryOwner {
            override val activityResultRegistry: ActivityResultRegistry = registry
        }

        fun buildViewModel(scope: CoroutineScope) = FileViewerViewModel(
            sessionId = "s1",
            path = "docs/notes.md",
            initialStaged = null,
            initialMode = null,
            focusLine = null,
            gateway = gateway,
            scope = scope,
            markdownPreviewSource = kotlinx.coroutines.flow.emptyFlow(),
            onMarkdownPreviewChanged = {},
            pendingDownloadSource = prefs.pendingDownload(owner),
            onPendingDownloadChanged = { prefs.setPendingDownload(owner, it) },
        )

        // One setContent per test (the Compose test environment forbids a
        // second call), and an activity recreate does NOT remount rule
        // content: setContent binds to the activity instance the rule
        // created, so scenario.recreate() only yields a fresh empty activity
        // (the CI round that tried it never saw the second picker launch).
        // "Process death" is therefore a key(epoch) remount inside the single
        // composition — bumping the epoch disposes the whole subtree and
        // composes a genuinely fresh `remember { buildViewModel(...) }` over
        // the same DataStore-backed prefs, exactly the recovery seam a real
        // relaunch exercises.
        val firstScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val secondScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        var processScope: CoroutineScope? = firstScope
        val processEpoch = mutableIntStateOf(1)
        compose.setContent {
            CompositionLocalProvider(LocalActivityResultRegistryOwner provides registryOwner) {
                HapiTheme {
                    key(processEpoch.intValue) {
                        val viewModel = remember { buildViewModel(requireNotNull(processScope)) }
                        FileViewerScreen(viewModel = viewModel, onBack = {})
                    }
                }
            }
        }

        try {
            // Process #1: content loads, the user taps download, the picker
            // opens — then the process dies with the picker still up.
            compose.waitUntil(10_000) { gateway.reads.isNotEmpty() }
            val download = context.getString(R.string.files_download)
            compose.onNodeWithContentDescription(download).performClick()
            compose.waitUntil(10_000) { registry.launches.size == 1 }
            compose.waitUntil(10_000) { persisted.value != null }
            firstScope.cancel()
            processScope = secondScope
            compose.runOnIdle { processEpoch.intValue = 2 }

            // Process #2: fresh ViewModel, same DataStore file — the recovery
            // seam re-runs the fetch and the picker relaunches on its own.
            compose.waitUntil(10_000) { registry.launches.size == 2 }

            // The user finally returns from the picker with a target: the
            // write goes through the recreated screen, and consuming the
            // payload clears the persisted request.
            registry.returnPickedUri(Uri.fromFile(target))
            compose.waitUntil(10_000) { target.exists() && target.readBytes().contentEquals(bytes) }
            compose.waitUntil(10_000) { persisted.value == null }

            assertEquals(
                "both picker launches carry the same payload",
                List(2) { "application/octet-stream" to "notes.md" },
                registry.launches,
            )
            // Content + download in process #1, then the same pair replayed
            // by the recovery seam in process #2.
            assertEquals(List(4) { "docs/notes.md" }, gateway.reads.toList())
        } finally {
            firstScope.cancel()
            secondScope.cancel()
            observerScope.cancel()
            storeScope.cancel()
            storeFile.delete()
            target.delete()
        }
    }
}
