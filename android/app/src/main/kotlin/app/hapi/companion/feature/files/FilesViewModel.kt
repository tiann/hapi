package app.hapi.companion.feature.files

import app.hapi.protocol.git.GitStatusFiles
import app.hapi.protocol.git.GitStatusParser
import app.hapi.protocol.wire.DirectoryEntry
import app.hapi.protocol.wire.FileSearchItem
import app.hapi.protocol.wire.GitCommandResponse
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

// ------------------------------------------------------------- UI models --

/** Changes tab (web `useGitStatusFiles` + `files.tsx` Changes list). */
data class ChangesUiState(
    val loading: Boolean = true,
    /** null after load ⇒ git unavailable for this session (not a repo / no path). */
    val status: GitStatusFiles? = null,
    /** Banner text: status failure, or partial numstat failures. */
    val error: String? = null,
)

/** One row of the flattened Browse tree ([FilesViewModel.browse]). */
sealed interface BrowseRow {
    val depth: Int

    data class Dir(
        /** Session-root-relative path (`src/app`). */
        val path: String,
        val name: String,
        override val depth: Int,
        val expanded: Boolean,
    ) : BrowseRow

    data class File(
        val path: String,
        val name: String,
        override val depth: Int,
        val size: Long?,
        val modified: Long?,
    ) : BrowseRow

    /** Placeholder while a directory listing is in flight. */
    data class Loading(val parentPath: String, override val depth: Int) : BrowseRow

    /** Inline listing failure for one directory (web `DirectoryErrorRow`). */
    data class Error(val parentPath: String, override val depth: Int, val message: String) : BrowseRow
}

data class BrowseUiState(
    val rows: List<BrowseRow> = emptyList(),
    val showHidden: Boolean = false,
)

/** Search tab (debounced `GET /files?query=`). */
data class SearchUiState(
    val query: String = "",
    val loading: Boolean = false,
    val results: List<FileSearchItem> = emptyList(),
    val error: String? = null,
    /** True once a search for the current query completed (drives the empty state). */
    val searched: Boolean = false,
)

/**
 * Fallback strings the files ViewModel needs (B-M5a Strings seam): defaults
 * are the pre-i18n English (JVM tests construct without arguments); production
 * passes resource-resolved values from the Navigation holder. The two diff
 * banners are `%1$s`-formatted with the failure detail.
 */
class FilesStrings(
    val gitStatusUnavailable: String = "Git status unavailable",
    val unstagedDiffUnavailable: String = "Unstaged diff unavailable: %1\$s",
    val stagedDiffUnavailable: String = "Staged diff unavailable: %1\$s",
    val unknownError: String = "unknown error",
    val listDirectoryFailed: String = "Failed to list directory",
    val searchFailed: String = "Failed to search files",
)

/**
 * Files screen state: three independent tabs over the session's git/files
 * endpoints. Changes ports `useGitStatusFiles` (status + both numstat sides
 * merged in `:core:protocol`'s `GitStatusParser.buildGitStatusFiles`); Browse
 * is a lazily-expanded directory tree flattened to rows (dirs-first name sort
 * like web `directory-sort.ts`, plus an Android-only hidden-file toggle);
 * Search debounces the ripgrep-backed `/files` query.
 */
class FilesViewModel(
    private val sessionId: String,
    private val gateway: FilesGateway,
    private val scope: CoroutineScope,
    private val strings: FilesStrings = FilesStrings(),
    private val searchDebounceMs: Long = SEARCH_DEBOUNCE_MS,
) {
    private val changesState = MutableStateFlow(ChangesUiState())
    val changes: StateFlow<ChangesUiState> = changesState.asStateFlow()

    private val browseState = MutableStateFlow(BrowseUiState())
    val browse: StateFlow<BrowseUiState> = browseState.asStateFlow()

    private val searchState = MutableStateFlow(SearchUiState())
    val search: StateFlow<SearchUiState> = searchState.asStateFlow()

    /** null = never requested; entries null while loading. */
    private data class DirNode(val entries: List<DirectoryEntry>? = null, val error: String? = null) {
        val loading: Boolean get() = entries == null && error == null
    }

    private val nodes = MutableStateFlow<Map<String, DirNode>>(emptyMap())
    private val expanded = MutableStateFlow<Set<String>>(emptySet())
    private val queryInput = MutableStateFlow("")
    private var started = false

    fun start() {
        if (started) return
        started = true
        refreshChanges()
        loadDirectory(ROOT)
        scope.launch {
            queryInput.collectLatest { query ->
                if (query.isBlank()) {
                    searchState.value = SearchUiState(query = query)
                    return@collectLatest
                }
                delay(searchDebounceMs)
                runSearch(query)
            }
        }
    }

    // ------------------------------------------------------------- changes --

    fun refreshChanges() {
        scope.launch { loadChanges() }
    }

    private suspend fun loadChanges() {
        changesState.update { it.copy(loading = true, error = null) }

        val statusResult = try {
            gateway.gitStatus(sessionId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            changesState.value = ChangesUiState(
                loading = false,
                status = null,
                error = e.message ?: strings.gitStatusUnavailable,
            )
            return
        }
        if (!statusResult.success) {
            changesState.value = ChangesUiState(
                loading = false,
                status = null,
                error = statusResult.error ?: statusResult.stderr ?: strings.gitStatusUnavailable,
            )
            return
        }

        // Both numstat sides in parallel; a failed side degrades to zero
        // counts plus a banner note, never a failed tab (web parity).
        val (unstagedResult, stagedResult) = coroutineScope {
            val unstaged = async { runCatching { gateway.gitDiffNumstat(sessionId, staged = false) } }
            val staged = async { runCatching { gateway.gitDiffNumstat(sessionId, staged = true) } }
            unstaged.await() to staged.await()
        }

        val unstaged = unstagedResult.getOrNull()
        val staged = stagedResult.getOrNull()
        val status = GitStatusParser.buildGitStatusFiles(
            statusOutput = statusResult.stdout.orEmpty(),
            unstagedDiffOutput = if (unstaged?.success == true) unstaged.stdout.orEmpty() else "",
            stagedDiffOutput = if (staged?.success == true) staged.stdout.orEmpty() else "",
        )

        val errors = buildList {
            if (unstaged?.success != true) {
                add(strings.unstagedDiffUnavailable.format(describeNumstatFailure(unstaged, unstagedResult.exceptionOrNull())))
            }
            if (staged?.success != true) {
                add(strings.stagedDiffUnavailable.format(describeNumstatFailure(staged, stagedResult.exceptionOrNull())))
            }
        }

        changesState.value = ChangesUiState(
            loading = false,
            status = status,
            error = errors.joinToString(" ").ifEmpty { null },
        )
    }

    private fun describeNumstatFailure(
        result: GitCommandResponse?,
        exception: Throwable?,
    ): String = result?.error ?: result?.stderr ?: exception?.message ?: strings.unknownError

    // -------------------------------------------------------------- browse --

    fun toggleDirectory(path: String) {
        val wasExpanded = path in expanded.value
        expanded.update { if (wasExpanded) it - path else it + path }
        if (!wasExpanded && nodes.value[path] == null) {
            loadDirectory(path)
        } else {
            rebuildBrowse()
        }
    }

    fun setShowHidden(showHidden: Boolean) {
        browseState.update { it.copy(showHidden = showHidden) }
        rebuildBrowse()
    }

    /** Re-lists the root and every expanded directory. */
    fun refreshBrowse() {
        loadDirectory(ROOT)
        for (path in expanded.value) loadDirectory(path)
    }

    private fun loadDirectory(path: String) {
        nodes.update { it + (path to DirNode()) }
        rebuildBrowse()
        scope.launch {
            val node = try {
                val response = gateway.listDirectory(sessionId, path.ifEmpty { null })
                if (response.success) {
                    DirNode(entries = response.entries.orEmpty())
                } else {
                    DirNode(error = response.error ?: strings.listDirectoryFailed)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                DirNode(error = e.message ?: strings.listDirectoryFailed)
            }
            nodes.update { it + (path to node) }
            rebuildBrowse()
        }
    }

    private fun rebuildBrowse() {
        val rows = mutableListOf<BrowseRow>()
        appendChildren(ROOT, 0, rows)
        browseState.update { it.copy(rows = rows) }
    }

    private fun appendChildren(path: String, depth: Int, out: MutableList<BrowseRow>) {
        val node = nodes.value[path]
        when {
            node == null || node.loading -> out += BrowseRow.Loading(path, depth)
            node.error != null -> out += BrowseRow.Error(path, depth, node.error)
            else -> {
                val showHidden = browseState.value.showHidden
                val visible = node.entries.orEmpty()
                    .filter { showHidden || !it.name.startsWith(".") }
                    .sortedWith(DIRS_FIRST_BY_NAME)
                for (entry in visible) {
                    val childPath = if (path.isEmpty()) entry.name else "$path/${entry.name}"
                    when (entry.type) {
                        "directory" -> {
                            val isExpanded = childPath in expanded.value
                            out += BrowseRow.Dir(childPath, entry.name, depth, isExpanded)
                            if (isExpanded) appendChildren(childPath, depth + 1, out)
                        }
                        "file" -> out += BrowseRow.File(childPath, entry.name, depth, entry.size, entry.modified)
                        // 'other' entries (sockets, links, …) are dropped, like the web tree.
                    }
                }
            }
        }
    }

    // -------------------------------------------------------------- search --

    fun setSearchQuery(query: String) {
        searchState.update { it.copy(query = query) }
        queryInput.value = query
    }

    fun refreshSearch() {
        val query = queryInput.value
        if (query.isBlank()) return
        scope.launch { runSearch(query) }
    }

    private suspend fun runSearch(query: String) {
        searchState.update { it.copy(loading = true, error = null) }
        try {
            val response = gateway.searchFiles(sessionId, query, SEARCH_LIMIT)
            searchState.update {
                if (response.success) {
                    it.copy(loading = false, results = response.files.orEmpty(), error = null, searched = true)
                } else {
                    it.copy(
                        loading = false,
                        results = emptyList(),
                        error = response.error ?: strings.searchFailed,
                        searched = true,
                    )
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            searchState.update {
                it.copy(
                    loading = false,
                    results = emptyList(),
                    error = e.message ?: strings.searchFailed,
                    searched = true,
                )
            }
        }
    }

    private companion object {
        const val ROOT = ""
        const val SEARCH_DEBOUNCE_MS = 300L

        /** Web default limit (`useSessionFileSearch`). */
        const val SEARCH_LIMIT = 200

        /** Dirs first, then case-insensitive name — web `sortDirectoryEntries` default. */
        val DIRS_FIRST_BY_NAME: Comparator<DirectoryEntry> =
            compareBy<DirectoryEntry> { it.type != "directory" }
                .thenBy(String.CASE_INSENSITIVE_ORDER) { it.name }
    }
}
