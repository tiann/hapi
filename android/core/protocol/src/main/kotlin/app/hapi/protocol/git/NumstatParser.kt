package app.hapi.protocol.git

/**
 * Parser for raw `git diff --numstat` stdout
 * (`GET /api/sessions/:id/git-diff-numstat?staged=`), the behavioral twin of
 * `parseNumStat`/`createDiffStatsMap` in `web/src/lib/gitParsers.ts`: binary
 * files report `-\t-` and count as 0/0, rename paths come in either the brace
 * form (`src/{old => new}/x.ts`) or the plain form (`old.txt => new.txt`) and
 * the stats map indexes the raw spelling plus both normalized paths so the
 * status-list merge finds them under the post-image path.
 */

/** One numstat row. */
data class DiffFileStat(
    /** Raw path column, rename arrows included. */
    val file: String,
    val changes: Int,
    val insertions: Int,
    val deletions: Int,
    val binary: Boolean,
)

data class DiffSummary(
    val files: List<DiffFileStat>,
    val insertions: Int,
    val deletions: Int,
    val changes: Int,
    /** Number of files listed. */
    val changed: Int,
)

/** Per-path counts for the Changes-list merge (web `createDiffStatsMap` values). */
data class DiffLineStats(val added: Int, val removed: Int, val binary: Boolean)

object NumstatParser {

    private val NUMSTAT_LINE = Regex("""^(\d+|-)\t(\d+|-)\t(.*)$""")
    private val BRACE_RENAME = Regex("""\{([^{}]+?)\s*=>\s*([^{}]+?)\}""")
    private val PLAIN_ARROW = Regex("""\s*=>\s*""")

    /** Numstat stdout → per-file counts + totals (`parseNumStat`). */
    fun parse(numStatOutput: String): DiffSummary {
        val files = mutableListOf<DiffFileStat>()
        var insertionsTotal = 0
        var deletionsTotal = 0
        var changesTotal = 0

        for (line in numStatOutput.trim().split("\n").filter { it.isNotEmpty() }) {
            val match = NUMSTAT_LINE.find(line) ?: continue
            val insertionsStr = match.groupValues[1]
            val deletionsStr = match.groupValues[2]
            val file = match.groupValues[3]

            val isBinary = insertionsStr == "-" || deletionsStr == "-"
            val insertions = if (isBinary) 0 else insertionsStr.toInt()
            val deletions = if (isBinary) 0 else deletionsStr.toInt()
            val changes = insertions + deletions

            files += DiffFileStat(
                file = file,
                changes = changes,
                insertions = insertions,
                deletions = deletions,
                binary = isBinary,
            )
            insertionsTotal += insertions
            deletionsTotal += deletions
            changesTotal += changes
        }

        return DiffSummary(
            files = files,
            insertions = insertionsTotal,
            deletions = deletionsTotal,
            changes = changesTotal,
            changed = files.size,
        )
    }

    /**
     * Counts keyed by every spelling of each path — the raw column plus the
     * normalized new/old paths of a rename (`createDiffStatsMap`), so lookups
     * by porcelain-status path always hit.
     */
    fun statsMap(summary: DiffSummary): Map<String, DiffLineStats> {
        val stats = mutableMapOf<String, DiffLineStats>()

        for (file in summary.files) {
            val stat = DiffLineStats(added = file.insertions, removed = file.deletions, binary = file.binary)
            val paths = normalizePath(file.file)
            stats[file.file] = stat
            if (paths.newPath.isNotEmpty() && paths.newPath != file.file) {
                stats[paths.newPath] = stat
            }
            val oldPath = paths.oldPath
            if (!oldPath.isNullOrEmpty() && oldPath != file.file && oldPath != paths.newPath) {
                stats[oldPath] = stat
            }
        }

        return stats
    }

    internal data class NormalizedPaths(val newPath: String, val oldPath: String? = null)

    /** `src/{old => new}/x.ts` / `old.txt => new.txt` → post/pre-image paths. */
    internal fun normalizePath(rawPath: String): NormalizedPaths {
        val trimmed = rawPath.trim()

        if (trimmed.contains("{") && trimmed.contains("=>") && trimmed.contains("}")) {
            val newPath = BRACE_RENAME.replace(trimmed) { it.groupValues[2].trim() }
            val oldPath = BRACE_RENAME.replace(trimmed) { it.groupValues[1].trim() }
            return NormalizedPaths(newPath = newPath, oldPath = oldPath)
        }

        if (trimmed.contains("=>")) {
            val parts = trimmed.split(PLAIN_ARROW)
            val oldPath = parts.firstOrNull()?.trim()
            val newPath = parts.lastOrNull()?.trim()
            if (!newPath.isNullOrEmpty()) {
                return NormalizedPaths(newPath = newPath, oldPath = oldPath)
            }
        }

        return NormalizedPaths(newPath = trimmed)
    }
}
