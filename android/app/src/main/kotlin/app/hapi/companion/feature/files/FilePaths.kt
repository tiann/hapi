package app.hapi.companion.feature.files

/**
 * Workspace path math — the Android twin of web `lib/file-path.ts`
 * (`resolveAbsoluteFilePath`) and `lib/file-composer.ts`
 * (`formatFileReference`), driven by the file-action menu ("Copy absolute
 * path", "Add to composer").
 */
object FilePaths {

    private val windowsAbsolutePath = Regex("^[A-Za-z]:[\\\\/]|^\\\\\\\\")
    private val posixAbsolutePath = Regex("^/")

    /**
     * Resolve a workspace-relative path against a session's working directory
     * (web `resolveAbsoluteFilePath`).
     *
     * The platform is decided by the workspace root, not by the shape of the
     * relative path: on a POSIX workspace a relative entry like `C:\notes.txt`
     * is a legal filename and must still be joined. Relative paths from git
     * status / ripgrep always use forward slashes; on Windows roots they are
     * re-joined with backslashes.
     */
    fun resolveAbsoluteFilePath(workspacePath: String?, relativePath: String): String {
        if (relativePath.isEmpty()) return workspacePath ?: ""

        val root = workspacePath ?: ""
        if (root.isEmpty()) return relativePath

        return if (root.startsWith("/")) joinPosix(root, relativePath) else joinWindows(root, relativePath)
    }

    /**
     * Wrap a workspace-relative path in backticks so the agent can spot it in
     * the prompt (web `formatFileReference`).
     */
    fun formatFileReference(relativePath: String): String = "`$relativePath`"

    private fun joinPosix(root: String, relativePath: String): String {
        if (posixAbsolutePath.containsMatchIn(relativePath)) return relativePath
        // Keep every relative-path character: POSIX filenames may contain
        // backslashes, so only '/' is a separator here.
        return root.trimEnd('/') + "/" + relativePath
    }

    private fun joinWindows(root: String, relativePath: String): String {
        if (windowsAbsolutePath.containsMatchIn(relativePath)) return relativePath
        val trimmedRoot = root.trimEnd('\\', '/')
        val base = if (trimmedRoot.isEmpty()) "\\" else "$trimmedRoot\\"
        return base + relativePath.replace('/', '\\')
    }
}
