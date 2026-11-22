package app.hapi.companion.feature.sessions

import app.hapi.protocol.wire.SessionSummaryMetadata

/** Git uses forward slashes for Windows worktrees; keep POSIX filenames literal. */
internal fun projectFolderPath(meta: SessionSummaryMetadata?): String? {
    val path = meta?.worktree?.basePath?.takeIf { it.isNotBlank() }
        ?: meta?.path?.takeIf { it.isNotBlank() } ?: return null
    val windows = (path.length >= 3 && path[0].isLetter() && path[1] == ':' && path[2] in "/\\") || path.startsWith("\\\\")
    return if (windows) path.replace('\\', '/') else path
}

/** Compact labels until more path context is needed on the same machine. */
internal fun projectFolderLabels(paths: Set<String>): Map<String, String> {
    val parts = paths.associateWith { it.split('/', '\\').filter(String::isNotEmpty) }
    val labels = parts.mapValues { (path, segments) -> segments.takeLast(2).joinToString("/").ifEmpty { path } }.toMutableMap()
    for (collisions in paths.groupBy(labels::get).values.filter { it.size > 1 }) {
        for (path in collisions) {
            val segments = parts.getValue(path)
            labels[path] = (3..segments.size).firstNotNullOfOrNull { n ->
                val suffix = segments.takeLast(n)
                if (collisions.none { it != path && parts.getValue(it).takeLast(n) == suffix }) suffix.joinToString("/") else null
            } ?: path
        }
    }
    return labels
}
