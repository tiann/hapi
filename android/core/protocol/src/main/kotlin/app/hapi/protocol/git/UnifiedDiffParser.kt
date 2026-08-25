package app.hapi.protocol.git

/**
 * Unified diff parser for the raw `git diff` stdout the hub relays verbatim
 * (`{success, stdout, stderr}` -- clients parse themselves, like
 * `web/src/lib/gitParsers.ts` does for status/numstat) and for agent-supplied
 * `unified_diff` tool inputs (the web reference for line semantics is
 * `parseUnifiedDiff` in `web/src/components/ToolCard/views/CodexDiffView.tsx`:
 * context lines belong to both sides, `\ No newline at end of file` markers are
 * not content, blank lines inside a hunk are empty context lines).
 *
 * Handles `diff --git` headers (new/deleted/rename/copy/mode/similarity/index/
 * binary markers) as well as bare `--- / +++ / @@` diffs without a git header.
 * Tolerant of streaming-truncated hunks and of the wrong `@@` counts LLMs emit:
 * counts steer disambiguation but never discard lines.
 */

enum class DiffLineKind { CONTEXT, ADD, REMOVE }

data class DiffLine(
    val kind: DiffLineKind,
    /** 1-based line number in the old file; null for ADD lines. */
    val oldLineNumber: Int?,
    /** 1-based line number in the new file; null for REMOVE lines. */
    val newLineNumber: Int?,
    /** Line content without the +/-/space marker. */
    val text: String,
    /** True when a `\ No newline at end of file` marker followed this line. */
    val noNewlineAtEnd: Boolean = false,
)

data class DiffHunk(
    /** The raw `@@ -a,b +c,d @@` header line (heading included). */
    val header: String,
    val oldStart: Int,
    val oldCount: Int,
    val newStart: Int,
    val newCount: Int,
    /** Text after the closing `@@` (enclosing function/section), if any. */
    val sectionHeading: String?,
    val lines: List<DiffLine>,
) {
    val additions: Int get() = lines.count { it.kind == DiffLineKind.ADD }
    val deletions: Int get() = lines.count { it.kind == DiffLineKind.REMOVE }
}

enum class DiffChangeKind { MODIFY, ADD, DELETE, RENAME, COPY }

data class DiffFile(
    /** Old path (`a/` prefix stripped); null for created files (`/dev/null`). */
    val oldPath: String?,
    /** New path (`b/` prefix stripped); null for deleted files (`/dev/null`). */
    val newPath: String?,
    val changeKind: DiffChangeKind,
    val isBinary: Boolean,
    val oldMode: String?,
    val newMode: String?,
    /** `similarity index N%` for renames/copies. */
    val similarity: Int?,
    val hunks: List<DiffHunk>,
) {
    /** Path to show: the post-image, falling back to the pre-image. */
    val displayPath: String get() = newPath ?: oldPath ?: ""
    val additions: Int get() = hunks.sumOf { it.additions }
    val deletions: Int get() = hunks.sumOf { it.deletions }
}

object UnifiedDiffParser {

    private val HUNK_HEADER = Regex("""^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$""")
    private val DIFF_GIT = Regex("""^diff --git (.+)$""")
    private val SIMILARITY = Regex("""^similarity index (\d{1,3})%$""")
    private val DISSIMILARITY = Regex("""^dissimilarity index (\d{1,3})%$""")
    private val OLD_MODE = Regex("""^old mode (\d{6})$""")
    private val NEW_MODE = Regex("""^new mode (\d{6})$""")
    private val NEW_FILE_MODE = Regex("""^new file mode (\d{6})$""")
    private val DELETED_FILE_MODE = Regex("""^deleted file mode (\d{6})$""")
    private val INDEX_LINE = Regex("""^index [0-9a-f]+\.\.[0-9a-f]+( \d{6})?$""")
    private val BINARY_FILES = Regex("""^Binary files (.+) and (.+) differ$""")

    fun parse(diffOutput: String): List<DiffFile> {
        val lines = diffOutput.split("\n")
        val files = mutableListOf<DiffFile>()
        var file: FileBuilder? = null
        var hunk: HunkBuilder? = null

        fun closeHunk() {
            val h = hunk ?: return
            file?.hunks?.add(h.build())
            hunk = null
        }

        fun closeFile() {
            closeHunk()
            val f = file ?: return
            files.add(f.build())
            file = null
        }

        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            val inHunk = hunk != null

            // ── Hunk content (checked first: `--- x` inside a hunk is a REMOVE) ──
            if (inHunk) {
                val h = hunk!!
                val consumed = when {
                    line.startsWith("\\") -> {
                        // `\ No newline at end of file` annotates the previous line.
                        h.markNoNewline()
                        true
                    }
                    h.wantsMore() -> h.consume(line)
                    // Counts are exhausted: only clearly-content lines continue the
                    // hunk (tolerates wrong LLM counts); structure lines close it.
                    line.startsWith("@@") || isFileBoundary(lines, i) -> false
                    line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") ->
                        h.consume(line)
                    else -> false
                }
                if (consumed) {
                    i += 1
                    continue
                }
                closeHunk()
                // fall through: re-process this line as structure
            }

            val hunkMatch = HUNK_HEADER.find(line)
            when {
                hunkMatch != null -> {
                    if (file == null) file = FileBuilder() // hunk with no header at all
                    val oldStart = hunkMatch.groupValues[1].toIntOrNull() ?: 0
                    val oldCount = hunkMatch.groupValues[2].ifEmpty { "1" }.toIntOrNull() ?: 1
                    val newStart = hunkMatch.groupValues[3].toIntOrNull() ?: 0
                    val newCount = hunkMatch.groupValues[4].ifEmpty { "1" }.toIntOrNull() ?: 1
                    val heading = hunkMatch.groupValues[5].removePrefix(" ").ifEmpty { null }
                    hunk = HunkBuilder(line, oldStart, oldCount, newStart, newCount, heading)
                }
                DIFF_GIT.matches(line) -> {
                    closeFile()
                    file = FileBuilder()
                    val paths = parseDiffGitPaths(DIFF_GIT.find(line)!!.groupValues[1])
                    if (paths != null) {
                        file!!.headerOldPath = paths.first
                        file!!.headerNewPath = paths.second
                    }
                }
                line.startsWith("--- ") -> {
                    // A bare `---`/`+++` pair (no `diff --git`) starts a new file.
                    if (file != null && file!!.sawMinusPath) closeFile()
                    if (file == null) file = FileBuilder()
                    file!!.oldPath = parseFileHeaderPath(line.removePrefix("--- "), "a/")
                    file!!.sawMinusPath = true
                }
                line.startsWith("+++ ") -> {
                    if (file == null) file = FileBuilder()
                    file!!.newPath = parseFileHeaderPath(line.removePrefix("+++ "), "b/")
                    file!!.sawPlusPath = true
                }
                file != null && SIMILARITY.matches(line) ->
                    file!!.similarity = SIMILARITY.find(line)!!.groupValues[1].toIntOrNull()
                file != null && DISSIMILARITY.matches(line) -> Unit
                file != null && OLD_MODE.matches(line) ->
                    file!!.oldMode = OLD_MODE.find(line)!!.groupValues[1]
                file != null && NEW_MODE.matches(line) ->
                    file!!.newMode = NEW_MODE.find(line)!!.groupValues[1]
                file != null && NEW_FILE_MODE.matches(line) -> {
                    file!!.isNewFile = true
                    file!!.newMode = NEW_FILE_MODE.find(line)!!.groupValues[1]
                }
                file != null && DELETED_FILE_MODE.matches(line) -> {
                    file!!.isDeletedFile = true
                    file!!.oldMode = DELETED_FILE_MODE.find(line)!!.groupValues[1]
                }
                file != null && line.startsWith("rename from ") -> {
                    file!!.isRename = true
                    file!!.renameFrom = line.removePrefix("rename from ")
                }
                file != null && line.startsWith("rename to ") -> {
                    file!!.isRename = true
                    file!!.renameTo = line.removePrefix("rename to ")
                }
                file != null && line.startsWith("copy from ") -> {
                    file!!.isCopy = true
                    file!!.renameFrom = line.removePrefix("copy from ")
                }
                file != null && line.startsWith("copy to ") -> {
                    file!!.isCopy = true
                    file!!.renameTo = line.removePrefix("copy to ")
                }
                file != null && INDEX_LINE.matches(line) -> Unit
                BINARY_FILES.matches(line) -> {
                    if (file == null) file = FileBuilder()
                    file!!.isBinary = true
                }
                line == "GIT binary patch" -> {
                    if (file == null) file = FileBuilder()
                    file!!.isBinary = true
                }
                else -> Unit // prologue/epilogue noise (e.g. `warning:` lines)
            }
            i += 1
        }

        closeFile()
        return files
    }

    /** True when line i starts a new file section (`diff --git`, `Binary files`, or a `---`/`+++` pair). */
    private fun isFileBoundary(lines: List<String>, i: Int): Boolean {
        val line = lines[i]
        if (DIFF_GIT.matches(line)) return true
        if (BINARY_FILES.matches(line)) return true
        return line.startsWith("--- ") && i + 1 < lines.size && lines[i + 1].startsWith("+++ ")
    }

    /**
     * `--- a/path`-style header payload -> path. Strips the customary prefix,
     * a trailing `\t`-separated timestamp, and quoting; `/dev/null` -> null.
     */
    private fun parseFileHeaderPath(rawValue: String, prefix: String): String? {
        var value = rawValue
        val tab = value.indexOf('\t')
        if (tab >= 0) value = value.substring(0, tab)
        value = unquote(value)
        if (value == "/dev/null") return null
        if (value.startsWith(prefix)) value = value.removePrefix(prefix)
        return value
    }

    /**
     * `diff --git a/<old> b/<new>` payload -> (old, new). Handles quoted paths;
     * for unquoted paths with spaces uses the last ` b/` separator heuristic.
     * Returns null when the payload cannot be split confidently.
     */
    private fun parseDiffGitPaths(payload: String): Pair<String, String>? {
        if (payload.startsWith("\"")) {
            val closing = findClosingQuote(payload) ?: return null
            val old = unquote(payload.substring(0, closing + 1))
            val rest = payload.substring(closing + 1).trimStart()
            val new = unquote(rest)
            return stripPrefix(old, "a/") to stripPrefix(new, "b/")
        }
        val sep = payload.lastIndexOf(" b/")
        if (sep < 0) {
            // `--no-prefix` form: single space split, best effort.
            val space = payload.indexOf(' ')
            if (space < 0) return null
            return payload.substring(0, space) to payload.substring(space + 1)
        }
        val old = stripPrefix(payload.substring(0, sep), "a/")
        val new = payload.substring(sep + 3)
        return old to new
    }

    private fun stripPrefix(value: String, prefix: String): String =
        if (value.startsWith(prefix)) value.removePrefix(prefix) else value

    private fun findClosingQuote(quoted: String): Int? {
        var i = 1
        while (i < quoted.length) {
            when (quoted[i]) {
                '\\' -> i += 2
                '"' -> return i
                else -> i += 1
            }
        }
        return null
    }

    /** Undo git's C-style path quoting (`"a/sp ace.txt"`, `\t`, `\\`, `\"`). */
    private fun unquote(value: String): String {
        if (!value.startsWith("\"") || !value.endsWith("\"") || value.length < 2) return value
        val inner = value.substring(1, value.length - 1)
        val sb = StringBuilder(inner.length)
        var i = 0
        while (i < inner.length) {
            val c = inner[i]
            if (c == '\\' && i + 1 < inner.length) {
                when (val next = inner[i + 1]) {
                    'n' -> sb.append('\n')
                    't' -> sb.append('\t')
                    'r' -> sb.append('\r')
                    '\\', '"' -> sb.append(next)
                    else -> {
                        sb.append(c)
                        sb.append(next)
                    }
                }
                i += 2
            } else {
                sb.append(c)
                i += 1
            }
        }
        return sb.toString()
    }

    private class FileBuilder {
        var headerOldPath: String? = null
        var headerNewPath: String? = null
        var oldPath: String? = null
        var newPath: String? = null
        var sawMinusPath = false
        var sawPlusPath = false
        var isNewFile = false
        var isDeletedFile = false
        var isRename = false
        var isCopy = false
        var isBinary = false
        var renameFrom: String? = null
        var renameTo: String? = null
        var oldMode: String? = null
        var newMode: String? = null
        var similarity: Int? = null
        val hunks = mutableListOf<DiffHunk>()

        fun build(): DiffFile {
            val resolvedOld = when {
                isNewFile -> null
                sawMinusPath -> oldPath
                else -> renameFrom ?: headerOldPath
            }
            val resolvedNew = when {
                isDeletedFile -> null
                sawPlusPath -> newPath
                else -> renameTo ?: headerNewPath
            }
            val kind = when {
                isRename -> DiffChangeKind.RENAME
                isCopy -> DiffChangeKind.COPY
                isNewFile || (sawMinusPath && oldPath == null) -> DiffChangeKind.ADD
                isDeletedFile || (sawPlusPath && newPath == null) -> DiffChangeKind.DELETE
                else -> DiffChangeKind.MODIFY
            }
            return DiffFile(
                oldPath = if (kind == DiffChangeKind.ADD) null else resolvedOld,
                newPath = if (kind == DiffChangeKind.DELETE) null else resolvedNew,
                changeKind = kind,
                isBinary = isBinary,
                oldMode = oldMode,
                newMode = newMode,
                similarity = similarity,
                hunks = hunks.toList(),
            )
        }
    }

    private class HunkBuilder(
        val header: String,
        val oldStart: Int,
        val oldCount: Int,
        val newStart: Int,
        val newCount: Int,
        val sectionHeading: String?,
    ) {
        private val lines = mutableListOf<DiffLine>()
        private var oldNo = oldStart
        private var newNo = newStart
        private var remainingOld = oldCount
        private var remainingNew = newCount

        fun wantsMore(): Boolean = remainingOld > 0 || remainingNew > 0

        /** Returns true when the line was hunk content. */
        fun consume(line: String): Boolean {
            when {
                line.startsWith("+") -> {
                    lines += DiffLine(DiffLineKind.ADD, null, newNo, line.substring(1))
                    newNo += 1
                    remainingNew -= 1
                }
                line.startsWith("-") -> {
                    lines += DiffLine(DiffLineKind.REMOVE, oldNo, null, line.substring(1))
                    oldNo += 1
                    remainingOld -= 1
                }
                line.startsWith(" ") -> {
                    lines += DiffLine(DiffLineKind.CONTEXT, oldNo, newNo, line.substring(1))
                    oldNo += 1
                    newNo += 1
                    remainingOld -= 1
                    remainingNew -= 1
                }
                line.isEmpty() && wantsMore() -> {
                    // Some generators emit truly empty context lines (web parser
                    // treats them as empty context on both sides).
                    lines += DiffLine(DiffLineKind.CONTEXT, oldNo, newNo, "")
                    oldNo += 1
                    newNo += 1
                    remainingOld -= 1
                    remainingNew -= 1
                }
                else -> return false
            }
            return true
        }

        fun markNoNewline() {
            val last = lines.lastOrNull() ?: return
            lines[lines.size - 1] = last.copy(noNewlineAtEnd = true)
        }

        fun build(): DiffHunk = DiffHunk(
            header = header,
            oldStart = oldStart,
            oldCount = oldCount,
            newStart = newStart,
            newCount = newCount,
            sectionHeading = sectionHeading,
            lines = lines.toList(),
        )
    }
}
