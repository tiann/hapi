const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]|^\\\\/
const POSIX_ABSOLUTE_PATH = /^\//

function joinPosix(root: string, relativePath: string): string {
    if (POSIX_ABSOLUTE_PATH.test(relativePath)) return relativePath
    // Keep every relative-path character: POSIX filenames may contain
    // backslashes, so only `/` is a separator here.
    return `${root.replace(/\/+$/, '')}/${relativePath}`
}

function joinWindows(root: string, relativePath: string): string {
    if (WINDOWS_ABSOLUTE_PATH.test(relativePath)) return relativePath
    const trimmedRoot = root.replace(/[\\/]+$/, '')
    const base = trimmedRoot === '' ? '\\' : `${trimmedRoot}\\`
    return `${base}${relativePath.replace(/\//g, '\\')}`
}

/**
 * Resolve a workspace-relative path against a session's working directory.
 *
 * The platform is decided by the workspace root, not by the shape of the
 * relative path: on a POSIX workspace a relative entry like `C:\notes.txt` is a
 * legal filename and must still be joined. Relative paths from git status /
 * ripgrep always use forward slashes; on Windows we re-join with backslashes.
 */
export function resolveAbsoluteFilePath(
    workspacePath: string | null | undefined,
    relativePath: string
): string {
    if (!relativePath) return workspacePath ?? ''

    const root = workspacePath ?? ''
    if (!root) return relativePath

    return root.startsWith('/')
        ? joinPosix(root, relativePath)
        : joinWindows(root, relativePath)
}
