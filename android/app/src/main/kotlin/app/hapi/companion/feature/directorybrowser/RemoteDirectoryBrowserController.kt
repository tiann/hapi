package app.hapi.companion.feature.directorybrowser

import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.MachineDirectoryEntry
import app.hapi.protocol.wire.MachineListDirectoryResponse
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class RemoteDirectoryBreadcrumb(
    val label: String,
    val path: String,
)

data class RemoteDirectoryBrowserState(
    val open: Boolean = false,
    val path: String = "",
    val roots: List<String> = emptyList(),
    val breadcrumbs: List<RemoteDirectoryBreadcrumb> = emptyList(),
    val entries: List<MachineDirectoryEntry> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    val includeHidden: Boolean = false,
    val canGoUp: Boolean = false,
)

/** Pure remote-path operations shared by directory-browser consumers. */
object RemoteDirectoryPath {
    fun browseRoots(machine: Machine): List<String> {
        val workspaceRoots = machine.metadata?.workspaceRoots
            ?.filter { it.isNotBlank() }
            ?.distinct()
            .orEmpty()
        if (workspaceRoots.isNotEmpty()) return workspaceRoots
        return listOfNotNull(machine.metadata?.homeDir?.takeIf { it.isNotBlank() })
    }

    fun join(parent: String, child: String): String {
        val separator = if (parent.contains('\\') && !parent.contains('/')) "\\" else "/"
        return if (parent.endsWith('/') || parent.endsWith('\\')) parent + child else parent + separator + child
    }

    fun parent(path: String): String? {
        val trimmed = path.trim()
        if (trimmed.isEmpty() || trimmed == "/" || Regex("^[A-Za-z]:[\\\\/]$").matches(trimmed)) return null
        val unc = trimmed.startsWith("\\\\") || trimmed.startsWith("//")
        val withoutTrailing = trimmed.trimEnd('/', '\\')
        if (unc) {
            val components = withoutTrailing.drop(2).split('/', '\\').filter { it.isNotEmpty() }
            if (components.size <= 2) return null
        }
        val index = maxOf(withoutTrailing.lastIndexOf('/'), withoutTrailing.lastIndexOf('\\'))
        if (index < 0) return null
        if (index == 0) return withoutTrailing.substring(0, 1)
        if (index == 2 && Regex("^[A-Za-z]:").containsMatchIn(withoutTrailing)) {
            return withoutTrailing.substring(0, 3)
        }
        return withoutTrailing.substring(0, index)
    }

    /** Lexical UI boundary; the runner remains authoritative and resolves symlinks. */
    fun isWithinRoot(path: String, root: String): Boolean {
        fun normalize(value: String): String {
            val slashed = value.trim().replace('\\', '/')
            val rootLength = if (Regex("^[A-Za-z]:/$").matches(slashed)) 3 else 1
            return if (slashed.length > rootLength) slashed.trimEnd('/') else slashed
        }

        val normalizedPath = normalize(path)
        val normalizedRoot = normalize(root)
        if (normalizedPath.isEmpty() || normalizedRoot.isEmpty()) return false
        val ignoreCase = Regex("^[A-Za-z]:").containsMatchIn(normalizedRoot) || normalizedRoot.startsWith("//")
        val rootPrefix = if (normalizedRoot.endsWith('/')) normalizedRoot else "$normalizedRoot/"
        return normalizedPath.equals(normalizedRoot, ignoreCase) ||
            normalizedPath.startsWith(rootPrefix, ignoreCase)
    }
}

/**
 * Reusable runner-backed directory navigation state machine.
 *
 * Consumers provide the machine list-directory request and decide what to do
 * with the selected path. Navigation is lexically confined to [roots]; the
 * runner performs the canonical symlink-aware boundary check.
 */
class RemoteDirectoryBrowserController(
    private val scope: CoroutineScope,
    private val listDirectory: suspend (
        machineId: String,
        path: String,
        includeHidden: Boolean,
    ) -> MachineListDirectoryResponse,
    private val fallbackError: String,
) {
    private val mutableState = MutableStateFlow(RemoteDirectoryBrowserState())
    val state: StateFlow<RemoteDirectoryBrowserState> = mutableState.asStateFlow()

    private var machineId: String? = null
    private var loadJob: Job? = null
    private var requestVersion = 0L

    fun open(machineId: String, roots: List<String>, initialPath: String? = null) {
        close()
        val usableRoots = roots.filter { it.isNotBlank() }.distinct()
        val path = initialPath
            ?.takeIf { candidate -> usableRoots.any { RemoteDirectoryPath.isWithinRoot(candidate, it) } }
            ?: usableRoots.firstOrNull()
            ?: return
        this.machineId = machineId
        mutableState.value = RemoteDirectoryBrowserState(
            open = true,
            path = path,
            roots = usableRoots,
        )
        load(path)
    }

    fun close() {
        loadJob?.cancel()
        requestVersion += 1
        machineId = null
        mutableState.value = RemoteDirectoryBrowserState()
    }

    fun navigate(path: String) {
        val current = mutableState.value
        if (!current.open || current.roots.none { RemoteDirectoryPath.isWithinRoot(path, it) }) return
        load(path)
    }

    fun navigateEntry(name: String) {
        navigate(RemoteDirectoryPath.join(mutableState.value.path, name))
    }

    fun navigateUp() {
        val current = mutableState.value
        val parent = RemoteDirectoryPath.parent(current.path) ?: return
        if (current.roots.any { RemoteDirectoryPath.isWithinRoot(parent, it) }) navigate(parent)
    }

    fun refresh() = load(mutableState.value.path)

    fun setIncludeHidden(includeHidden: Boolean) {
        if (!mutableState.value.open) return
        mutableState.update { it.copy(includeHidden = includeHidden) }
        load(mutableState.value.path)
    }

    private fun load(path: String) {
        val targetMachineId = machineId ?: return
        val current = mutableState.value
        if (!current.open || current.roots.none { RemoteDirectoryPath.isWithinRoot(path, it) }) return
        loadJob?.cancel()
        val currentRequest = ++requestVersion
        val includeHidden = current.includeHidden
        mutableState.update {
            it.copy(
                path = path,
                entries = emptyList(),
                loading = true,
                error = null,
                breadcrumbs = breadcrumbs(path, it.roots),
                canGoUp = RemoteDirectoryPath.parent(path)
                    ?.let { parent -> it.roots.any { root -> RemoteDirectoryPath.isWithinRoot(parent, root) } }
                    == true,
            )
        }
        loadJob = scope.launch {
            val response = try {
                listDirectory(targetMachineId, path, includeHidden)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                if (isCurrent(currentRequest, targetMachineId, path, includeHidden)) {
                    mutableState.update {
                        it.copy(loading = false, error = error.message ?: fallbackError)
                    }
                }
                return@launch
            }
            if (!isCurrent(currentRequest, targetMachineId, path, includeHidden)) return@launch
            if (!response.success) {
                mutableState.update {
                    it.copy(loading = false, error = response.error ?: fallbackError)
                }
                return@launch
            }
            mutableState.update {
                it.copy(
                    loading = false,
                    error = null,
                    entries = response.entries.orEmpty()
                        .filter { entry -> entry.type == "directory" }
                        .sortedBy { entry -> entry.name.lowercase() },
                )
            }
        }
    }

    private fun isCurrent(
        version: Long,
        targetMachineId: String,
        path: String,
        includeHidden: Boolean,
    ): Boolean =
        requestVersion == version &&
            machineId == targetMachineId &&
            mutableState.value.open &&
            mutableState.value.path == path &&
            mutableState.value.includeHidden == includeHidden

    private fun breadcrumbs(path: String, roots: List<String>): List<RemoteDirectoryBreadcrumb> {
        val root = roots.filter { RemoteDirectoryPath.isWithinRoot(path, it) }.maxByOrNull { it.length }
            ?: return listOf(RemoteDirectoryBreadcrumb(path, path))
        val result = mutableListOf(RemoteDirectoryBreadcrumb(root, root))
        val relative = path.drop(root.length).trim('/', '\\')
        var cursor = root
        for (segment in relative.split('/', '\\').filter { it.isNotEmpty() }) {
            cursor = RemoteDirectoryPath.join(cursor, segment)
            result += RemoteDirectoryBreadcrumb(segment, cursor)
        }
        return result
    }
}
