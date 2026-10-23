@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.files

import app.hapi.protocol.git.GitFileChange
import app.hapi.protocol.wire.DirectoryEntry
import app.hapi.protocol.wire.FileReadResponse
import app.hapi.protocol.wire.FileSearchItem
import app.hapi.protocol.wire.FileSearchResponse
import app.hapi.protocol.wire.GitCommandResponse
import app.hapi.protocol.wire.ListDirectoryResponse
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionSummaryMetadata
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest

// ------------------------------------------------------------------ fakes --

internal class FakeFilesGateway : FilesGateway {
    var statusResult = GitCommandResponse(success = true, stdout = "")
    var unstagedNumstat = GitCommandResponse(success = true, stdout = "")
    var stagedNumstat = GitCommandResponse(success = true, stdout = "")
    var diffFileResult = GitCommandResponse(success = true, stdout = "")
    var readFileResult = FileReadResponse(success = true, content = "")
    var searchResult = FileSearchResponse(success = true, files = emptyList())
    var directories: MutableMap<String?, ListDirectoryResponse> = mutableMapOf()
    /** Per-path readFile overrides; [readFileResult] serves unmatched paths. */
    var readFiles: MutableMap<String, FileReadResponse> = mutableMapOf()
    var throwOnStatus: Exception? = null

    val diffFileCalls = mutableListOf<Pair<String, Boolean?>>()
    val searchCalls = mutableListOf<Pair<String, Int>>()
    val listDirectoryCalls = mutableListOf<String?>()
    val numstatCalls = mutableListOf<Boolean>()
    val readFileCalls = mutableListOf<String>()

    override suspend fun gitStatus(sessionId: String): GitCommandResponse {
        throwOnStatus?.let { throw it }
        return statusResult
    }

    override suspend fun gitDiffNumstat(sessionId: String, staged: Boolean): GitCommandResponse {
        numstatCalls += staged
        return if (staged) stagedNumstat else unstagedNumstat
    }

    override suspend fun gitDiffFile(sessionId: String, path: String, staged: Boolean?): GitCommandResponse {
        diffFileCalls += path to staged
        return diffFileResult
    }

    override suspend fun readFile(sessionId: String, path: String): FileReadResponse {
        readFileCalls += path
        return readFiles[path] ?: readFileResult
    }

    override suspend fun searchFiles(sessionId: String, query: String, limit: Int): FileSearchResponse {
        searchCalls += query to limit
        return searchResult
    }

    override suspend fun listDirectory(sessionId: String, path: String?): ListDirectoryResponse {
        listDirectoryCalls += path
        return directories[path] ?: ListDirectoryResponse(success = true, entries = emptyList())
    }
}

class FilesViewModelTest {

    private fun TestScope.buildViewModel(
        gateway: FakeFilesGateway,
        initialSort: DirectorySort = DirectorySort.DEFAULT,
        sortSource: Flow<DirectorySort> = MutableStateFlow(initialSort),
        onSortChanged: suspend (DirectorySort) -> Unit = {},
        expandedSource: Flow<Set<String>> = MutableStateFlow(emptySet()),
        onExpandedChanged: suspend (Set<String>) -> Unit = {},
        sessions: Flow<List<SessionSummary>> = MutableStateFlow(emptyList()),
    ): FilesViewModel =
        FilesViewModel(
            sessionId = "s1",
            gateway = gateway,
            scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler)),
            initialSort = initialSort,
            sortSource = sortSource,
            onSortChanged = onSortChanged,
            expandedSource = expandedSource,
            onExpandedChanged = onExpandedChanged,
            sessions = sessions,
        )

    // ------------------------------------------------------------- changes --

    private val porcelain = listOf(
        "# branch.head main",
        "1 M. N... 100644 100644 100644 aaaaaaaa bbbbbbbb staged.txt",
        "1 .M N... 100644 100644 100644 cccccccc dddddddd unstaged.txt",
        "1 MM N... 100644 100644 100644 eeeeeeee ffffffff both.txt",
        "? fresh.txt",
    ).joinToString("\n")

    @Test
    fun `changes tab merges status with both numstat sides`() = runTest {
        val gateway = FakeFilesGateway().apply {
            statusResult = GitCommandResponse(success = true, stdout = porcelain)
            unstagedNumstat = GitCommandResponse(success = true, stdout = "3\t1\tunstaged.txt\n2\t2\tboth.txt")
            stagedNumstat = GitCommandResponse(success = true, stdout = "5\t0\tstaged.txt\n1\t0\tboth.txt")
        }
        val viewModel = buildViewModel(gateway)
        viewModel.start()
        advanceUntilIdle()

        val state = viewModel.changes.value
        assertEquals(false, state.loading)
        assertNull(state.error)
        val status = assertNotNull(state.status)
        assertEquals("main", status.branch)
        assertEquals(listOf(true, false).sorted(), gateway.numstatCalls.sorted())

        // Staged side takes counts from the staged numstat.
        assertEquals(listOf("staged.txt", "both.txt"), status.stagedFiles.map { it.fullPath })
        assertEquals(5, status.stagedFiles[0].linesAdded)
        assertEquals(1, status.stagedFiles[1].linesAdded)

        // Unstaged side: modified + both + untracked appended last.
        assertEquals(listOf("unstaged.txt", "both.txt", "fresh.txt"), status.unstagedFiles.map { it.fullPath })
        assertEquals(3, status.unstagedFiles[0].linesAdded)
        assertEquals(2, status.unstagedFiles[1].linesRemoved)
        assertEquals(GitFileChange.UNTRACKED, status.unstagedFiles[2].status)
    }

    @Test
    fun `status failure surfaces error with no status`() = runTest {
        val gateway = FakeFilesGateway().apply {
            statusResult = GitCommandResponse(success = false, error = "Session path not available")
        }
        val viewModel = buildViewModel(gateway)
        viewModel.start()
        advanceUntilIdle()

        val state = viewModel.changes.value
        assertNull(state.status)
        assertEquals("Session path not available", state.error)
        assertTrue(gateway.numstatCalls.isEmpty())
    }

    @Test
    fun `numstat failure degrades to zero counts plus banner`() = runTest {
        val gateway = FakeFilesGateway().apply {
            statusResult = GitCommandResponse(success = true, stdout = porcelain)
            unstagedNumstat = GitCommandResponse(success = false, stderr = "boom")
            stagedNumstat = GitCommandResponse(success = true, stdout = "5\t0\tstaged.txt")
        }
        val viewModel = buildViewModel(gateway)
        viewModel.start()
        advanceUntilIdle()

        val state = viewModel.changes.value
        val status = assertNotNull(state.status)
        assertEquals(0, status.unstagedFiles[0].linesAdded)
        assertEquals(5, status.stagedFiles[0].linesAdded)
        assertEquals("Unstaged diff unavailable: boom", state.error)
    }

    @Test
    fun `transport failure on status maps to error state`() = runTest {
        val gateway = FakeFilesGateway().apply { throwOnStatus = IllegalStateException("offline") }
        val viewModel = buildViewModel(gateway)
        viewModel.start()
        advanceUntilIdle()

        assertNull(viewModel.changes.value.status)
        assertEquals("offline", viewModel.changes.value.error)
    }

    // -------------------------------------------------------------- browse --

    private fun dir(name: String) = DirectoryEntry(name = name, type = "directory")
    private fun file(name: String, size: Long? = null) = DirectoryEntry(name = name, type = "file", size = size)

    @Test
    fun `root listing sorts dirs first and hides dot entries by default`() = runTest {
        val gateway = FakeFilesGateway().apply {
            directories[null] = ListDirectoryResponse(
                success = true,
                entries = listOf(
                    file("zeta.txt"),
                    dir("src"),
                    file(".env"),
                    dir(".git"),
                    file("Alpha.md"),
                    DirectoryEntry(name = "weird-socket", type = "other"),
                ),
            )
        }
        val viewModel = buildViewModel(gateway)
        viewModel.start()
        advanceUntilIdle()

        val rows = viewModel.browse.value.rows
        assertEquals(listOf("src", "Alpha.md", "zeta.txt"), rows.map { rowName(it) })
        assertTrue(rows[0] is BrowseRow.Dir)

        viewModel.setShowHidden(true)
        assertEquals(
            listOf(".git", "src", ".env", "Alpha.md", "zeta.txt"),
            viewModel.browse.value.rows.map { rowName(it) },
        )
    }

    @Test
    fun `expanding a directory lazily loads it exactly once`() = runTest {
        val gateway = FakeFilesGateway().apply {
            directories[null] = ListDirectoryResponse(success = true, entries = listOf(dir("src")))
            directories["src"] = ListDirectoryResponse(success = true, entries = listOf(file("app.ts", size = 10)))
        }
        val viewModel = buildViewModel(gateway)
        viewModel.start()
        advanceUntilIdle()

        viewModel.toggleDirectory("src")
        advanceUntilIdle()

        var rows = viewModel.browse.value.rows
        assertEquals(listOf("src", "app.ts"), rows.map { rowName(it) })
        assertEquals(1, (rows[1] as BrowseRow.File).depth)
        assertEquals("src/app.ts", (rows[1] as BrowseRow.File).path)

        // Collapse and re-expand: entries come from the cache, no second call.
        viewModel.toggleDirectory("src")
        viewModel.toggleDirectory("src")
        advanceUntilIdle()
        rows = viewModel.browse.value.rows
        assertEquals(listOf("src", "app.ts"), rows.map { rowName(it) })
        assertEquals(listOf(null, "src"), gateway.listDirectoryCalls)
    }

    @Test
    fun `directory failure renders an inline error row`() = runTest {
        val gateway = FakeFilesGateway().apply {
            directories[null] = ListDirectoryResponse(success = false, error = "denied")
        }
        val viewModel = buildViewModel(gateway)
        viewModel.start()
        advanceUntilIdle()

        val row = viewModel.browse.value.rows.single() as BrowseRow.Error
        assertEquals("denied", row.message)
    }

    private fun rowName(row: BrowseRow): String = when (row) {
        is BrowseRow.Dir -> row.name
        is BrowseRow.File -> row.name
        is BrowseRow.Loading -> "<loading>"
        is BrowseRow.Error -> "<error>"
    }

    // -------------------------------------------------------------- search --

    @Test
    fun `search debounces rapid typing into a single request`() = runTest {
        val gateway = FakeFilesGateway().apply {
            searchResult = FileSearchResponse(
                success = true,
                files = listOf(
                    FileSearchItem(fileName = "app.ts", filePath = "src", fullPath = "src/app.ts", fileType = "file"),
                ),
            )
        }
        val viewModel = buildViewModel(gateway)
        viewModel.start()
        advanceUntilIdle()

        viewModel.setSearchQuery("a")
        advanceTimeBy(100)
        viewModel.setSearchQuery("ap")
        advanceTimeBy(100)
        viewModel.setSearchQuery("app")
        advanceUntilIdle()

        assertEquals(listOf("app" to 200), gateway.searchCalls)
        val state = viewModel.search.value
        assertEquals("app", state.query)
        assertTrue(state.searched)
        assertEquals(listOf("src/app.ts"), state.results.map { it.fullPath })
    }

    @Test
    fun `clearing the query resets results without a request`() = runTest {
        val gateway = FakeFilesGateway()
        val viewModel = buildViewModel(gateway)
        viewModel.start()
        advanceUntilIdle()

        viewModel.setSearchQuery("app")
        advanceUntilIdle()
        assertEquals(1, gateway.searchCalls.size)

        viewModel.setSearchQuery("")
        advanceUntilIdle()
        assertEquals(1, gateway.searchCalls.size)
        assertTrue(viewModel.search.value.results.isEmpty())
        assertEquals(false, viewModel.search.value.searched)
    }

    @Test
    fun `search failure surfaces the error`() = runTest {
        val gateway = FakeFilesGateway().apply {
            searchResult = FileSearchResponse(success = false, error = "ripgrep missing")
        }
        val viewModel = buildViewModel(gateway)
        viewModel.start()
        advanceUntilIdle()

        viewModel.setSearchQuery("x")
        advanceUntilIdle()

        assertEquals("ripgrep missing", viewModel.search.value.error)
        assertTrue(viewModel.search.value.results.isEmpty())
    }

    // ---------------------------------------------------------------- sort --

    @Test
    fun `setSort re-sorts cached browse rows and persists via the hook`() = runTest {
        val persisted = mutableListOf<DirectorySort>()
        val gateway = FakeFilesGateway().apply {
            directories[null] = ListDirectoryResponse(
                success = true,
                entries = listOf(
                    dir("src"),
                    file("big.bin", size = 10),
                    file("small.txt", size = 900),
                    file("mid.md", size = 100),
                ),
            )
        }
        val viewModel = buildViewModel(gateway, onSortChanged = { persisted += it })
        viewModel.start()
        advanceUntilIdle()
        assertEquals(listOf("src", "big.bin", "mid.md", "small.txt"), viewModel.browse.value.rows.map { rowName(it) })

        viewModel.setSort(DirectorySort(DirectorySortField.SIZE, DirectorySortDirection.DESC))
        advanceUntilIdle()

        // Dirs stay first regardless of field; files follow the size sort.
        assertEquals(
            listOf("src", "small.txt", "mid.md", "big.bin"),
            viewModel.browse.value.rows.map { rowName(it) },
        )
        assertEquals(
            DirectorySort(DirectorySortField.SIZE, DirectorySortDirection.DESC),
            viewModel.sort.value,
        )
        assertEquals(listOf(DirectorySort(DirectorySortField.SIZE, DirectorySortDirection.DESC)), persisted)
    }

    @Test
    fun `setSort re-orders already-loaded search results`() = runTest {
        val gateway = FakeFilesGateway().apply {
            searchResult = FileSearchResponse(
                success = true,
                files = listOf(
                    FileSearchItem(fileName = "b.txt", filePath = "", fullPath = "b.txt", fileType = "file"),
                    FileSearchItem(fileName = "a.txt", filePath = "", fullPath = "a.txt", fileType = "file"),
                ),
            )
        }
        val viewModel = buildViewModel(gateway)
        viewModel.start()
        advanceUntilIdle()

        viewModel.setSearchQuery("txt")
        advanceUntilIdle()
        assertEquals(listOf("a.txt", "b.txt"), viewModel.search.value.results.map { it.fullPath })

        viewModel.setSort(DirectorySort(DirectorySortField.NAME, DirectorySortDirection.DESC))
        advanceUntilIdle()
        assertEquals(listOf("b.txt", "a.txt"), viewModel.search.value.results.map { it.fullPath })
    }

    @Test
    fun `sort source applies until the user overrides it`() = runTest {
        val source = MutableStateFlow(DirectorySort.DEFAULT)
        val gateway = FakeFilesGateway()
        val viewModel = buildViewModel(gateway, sortSource = source)
        viewModel.start()
        advanceUntilIdle()

        source.value = DirectorySort(DirectorySortField.MODIFIED, DirectorySortDirection.DESC)
        advanceUntilIdle()
        assertEquals(DirectorySort(DirectorySortField.MODIFIED, DirectorySortDirection.DESC), viewModel.sort.value)

        viewModel.setSort(DirectorySort(DirectorySortField.NAME, DirectorySortDirection.DESC))
        advanceUntilIdle()
        source.value = DirectorySort(DirectorySortField.SIZE, DirectorySortDirection.ASC)
        advanceUntilIdle()
        // First user choice wins; later source emissions are ignored.
        assertEquals(DirectorySort(DirectorySortField.NAME, DirectorySortDirection.DESC), viewModel.sort.value)
    }

    // -------------------------------------------------- expand persistence --

    @Test
    fun `toggleDirectory persists the expand set on every change`() = runTest {
        val persisted = mutableListOf<Set<String>>()
        val gateway = FakeFilesGateway().apply {
            directories[null] = ListDirectoryResponse(
                success = true,
                entries = listOf(dir("src"), file("a.txt")),
            )
            directories["src"] = ListDirectoryResponse(
                success = true,
                entries = listOf(file("nested.txt")),
            )
        }
        val viewModel = buildViewModel(gateway, onExpandedChanged = { persisted += it })
        viewModel.start()
        advanceUntilIdle()
        assertTrue(persisted.isEmpty())

        viewModel.toggleDirectory("src")
        advanceUntilIdle()
        assertTrue(viewModel.browse.value.rows.map { rowName(it) }.contains("nested.txt"))
        assertEquals(listOf<Set<String>>(setOf("src")), persisted)

        viewModel.toggleDirectory("src")
        advanceUntilIdle()
        assertFalse(viewModel.browse.value.rows.map { rowName(it) }.contains("nested.txt"))
        // Web writes on every expand AND collapse (`writeExpanded` both branches).
        assertEquals(listOf<Set<String>>(setOf("src"), emptySet()), persisted)
    }

    @Test
    fun `expanded source restores the tree until the user toggles`() = runTest {
        val source = MutableStateFlow<Set<String>>(emptySet())
        val gateway = FakeFilesGateway().apply {
            directories[null] = ListDirectoryResponse(
                success = true,
                entries = listOf(dir("src"), dir("docs")),
            )
            directories["src"] = ListDirectoryResponse(
                success = true,
                entries = listOf(file("nested.txt")),
            )
            directories["docs"] = ListDirectoryResponse(
                success = true,
                entries = listOf(file("guide.md")),
            )
        }
        val viewModel = buildViewModel(gateway, expandedSource = source)
        viewModel.start()
        advanceUntilIdle()
        assertEquals(listOf("docs", "src"), viewModel.browse.value.rows.map { rowName(it) })

        // A persisted set applies on arrival and loads the restored directory.
        source.value = setOf("src")
        advanceUntilIdle()
        assertTrue(viewModel.browse.value.rows.map { rowName(it) }.contains("nested.txt"))
        assertTrue(gateway.listDirectoryCalls.contains("src"))

        // First user toggle stops the persisted set from re-applying.
        viewModel.toggleDirectory("src")
        advanceUntilIdle()
        assertFalse(viewModel.browse.value.rows.map { rowName(it) }.contains("nested.txt"))
        source.value = setOf("src", "docs")
        advanceUntilIdle()
        assertFalse(viewModel.browse.value.rows.map { rowName(it) }.contains("guide.md"))
    }

    @Test
    fun `initial sort orders the first browse rendering`() = runTest {
        val gateway = FakeFilesGateway().apply {
            directories[null] = ListDirectoryResponse(
                success = true,
                entries = listOf(dir("src"), file("a.txt"), file("b.txt")),
            )
        }
        val viewModel = buildViewModel(
            gateway,
            initialSort = DirectorySort(DirectorySortField.NAME, DirectorySortDirection.DESC),
        )
        viewModel.start()
        advanceUntilIdle()

        assertEquals(listOf("src", "b.txt", "a.txt"), viewModel.browse.value.rows.map { rowName(it) })
    }

    // ------------------------------------------------------------ download --

    @Test
    fun `downloadFile fetches bytes and exposes a ready payload`() = runTest {
        val bytes = byteArrayOf(1, 2, 3, 4)
        val gateway = FakeFilesGateway().apply {
            readFiles["src/app.ts"] = FileReadResponse(
                success = true,
                content = Base64.getEncoder().encodeToString(bytes),
            )
        }
        val viewModel = buildViewModel(gateway)
        viewModel.start()
        advanceUntilIdle()

        viewModel.downloadFile("src/app.ts", "app.ts")
        advanceUntilIdle()

        assertEquals(listOf("src/app.ts"), gateway.readFileCalls)
        val ready = assertNotNull(viewModel.downloads.value.ready)
        assertEquals("app.ts", ready.fileName)
        assertEquals(FileDownloads.FALLBACK_MIME, ready.mimeType)
        assertTrue(ready.bytes.contentEquals(bytes))
        assertNull(viewModel.downloads.value.error)
    }

    @Test
    fun `download is single-flight while one payload is pending`() = runTest {
        val gateway = FakeFilesGateway().apply {
            readFiles["a.txt"] = FileReadResponse(success = true, content = Base64.getEncoder().encodeToString(byteArrayOf(1)))
        }
        val viewModel = buildViewModel(gateway)
        viewModel.start()
        advanceUntilIdle()

        viewModel.downloadFile("a.txt", "a.txt")
        advanceUntilIdle()
        // ready payload still unconsumed: a second request must not start.
        viewModel.downloadFile("b.txt", "b.txt")
        advanceUntilIdle()

        assertEquals(listOf("a.txt"), gateway.readFileCalls)
        assertNotNull(viewModel.downloads.value.ready)

        viewModel.consumeReadyDownload()
        assertEquals(null, viewModel.downloads.value.ready)
        viewModel.downloadFile("b.txt", "b.txt")
        advanceUntilIdle()
        assertEquals(listOf("a.txt", "b.txt"), gateway.readFileCalls)
    }

    @Test
    fun `download failure surfaces the error detail or the default`() = runTest {
        val gateway = FakeFilesGateway().apply {
            readFiles["boom.txt"] = FileReadResponse(success = false, error = "too large")
            readFiles["mum.txt"] = FileReadResponse(success = false)
        }
        val viewModel = buildViewModel(gateway)
        viewModel.start()
        advanceUntilIdle()

        viewModel.downloadFile("boom.txt", "boom.txt")
        advanceUntilIdle()
        assertEquals("too large", viewModel.downloads.value.error)

        viewModel.clearDownloadError()
        assertNull(viewModel.downloads.value.error)

        viewModel.downloadFile("mum.txt", "mum.txt")
        advanceUntilIdle()
        assertEquals("Failed to download file.", viewModel.downloads.value.error)
    }

    // --------------------------------------------------------- workspace path --

    @Test
    fun `workspace path follows the session summary metadata`() = runTest {
        val sessions = MutableStateFlow(
            listOf(
                SessionSummary(id = "other", active = false, metadata = SessionSummaryMetadata(path = "/elsewhere")),
                SessionSummary(id = "s1", active = true, metadata = SessionSummaryMetadata(path = "/work/repo")),
            ),
        )
        val viewModel = buildViewModel(FakeFilesGateway(), sessions = sessions)
        viewModel.start()
        advanceUntilIdle()
        assertEquals("/work/repo", viewModel.workspacePath.value)

        sessions.value = listOf(
            SessionSummary(id = "s1", active = true, metadata = SessionSummaryMetadata(path = "/moved")),
        )
        advanceUntilIdle()
        assertEquals("/moved", viewModel.workspacePath.value)
    }

    @Test
    fun `missing session summary leaves the workspace path null`() = runTest {
        val viewModel = buildViewModel(
            FakeFilesGateway(),
            sessions = MutableStateFlow(listOf(SessionSummary(id = "other", active = false))),
        )
        viewModel.start()
        advanceUntilIdle()
        assertNull(viewModel.workspacePath.value)
    }
}
