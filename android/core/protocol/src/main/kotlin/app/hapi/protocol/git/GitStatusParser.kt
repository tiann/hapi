package app.hapi.protocol.git

/**
 * Parser for the raw `git status --porcelain=v2 --branch` stdout the hub
 * relays verbatim in `GET /api/sessions/:id/git-status`
 * (`GitCommandResponse.stdout`). Behavioral twin of
 * `parseStatusSummaryV2`/`buildGitStatusFiles` in `web/src/lib/gitParsers.ts`
 * — including its quirks, which the Kotlin port reproduces on purpose so both
 * clients render identical lists:
 *
 * - Rename/copy (`2`) records assign the first tab-separated path to [GitFileEntryV2.from]
 *   and the second to [GitFileEntryV2.path] (the web parser's reading of the
 *   `<path><sep><origPath>` payload).
 * - Unmerged (`u`) records surface in both staged and unstaged lists when both
 *   XY letters are set (e.g. `UU`).
 * - Untracked entries ending in `/` are kept in [GitStatusSummary.notAdded] but
 *   dropped from the merged [GitStatusFiles].
 */

/** One `1 ` / `2 ` / `u ` record: XY letters + path(s). */
data class GitFileEntryV2(
    val path: String,
    /** Index (staged) status letter; `.` = unmodified. */
    val index: String,
    /** Working-tree status letter; `.` = unmodified. */
    val workingDir: String,
    /** Pre-image path of a rename/copy record. */
    val from: String? = null,
)

/** `# branch.*` header lines. */
data class GitBranchInfo(
    val oid: String? = null,
    /** Branch name, or `(detached)` / `(initial)`. */
    val head: String? = null,
    val upstream: String? = null,
    val ahead: Int? = null,
    val behind: Int? = null,
)

data class GitStatusSummary(
    val files: List<GitFileEntryV2>,
    /** `? ` untracked paths (directories keep their trailing `/`). */
    val notAdded: List<String>,
    /** `! ` ignored paths (only present with `--ignored`). */
    val ignored: List<String>,
    val branch: GitBranchInfo,
)

/** Display status derived from one XY letter (`getFileStatus` in the web parser). */
enum class GitFileChange { MODIFIED, ADDED, DELETED, RENAMED, UNTRACKED, CONFLICTED }

/** One row of the Changes list (web `GitFileStatus`, `web/src/types/api.ts`). */
data class GitFileStatus(
    /** Last path segment (`app.ts`). */
    val fileName: String,
    /** Directory part without trailing slash; empty at the repo root. */
    val filePath: String,
    val fullPath: String,
    val status: GitFileChange,
    val isStaged: Boolean,
    val linesAdded: Int,
    val linesRemoved: Int,
    val oldPath: String? = null,
)

/** Merged status + numstat model the Changes tab renders (web `GitStatusFiles`). */
data class GitStatusFiles(
    val stagedFiles: List<GitFileStatus>,
    val unstagedFiles: List<GitFileStatus>,
    /** Branch name; null for detached HEAD / unborn branch. */
    val branch: String?,
    val totalStaged: Int,
    val totalUnstaged: Int,
)

object GitStatusParser {

    private val BRANCH_OID = Regex("""^# branch\.oid (.+)$""")
    private val BRANCH_HEAD = Regex("""^# branch\.head (.+)$""")
    private val BRANCH_UPSTREAM = Regex("""^# branch\.upstream (.+)$""")
    private val BRANCH_AB = Regex("""^# branch\.ab \+(\d+) -(\d+)$""")

    private val ORDINARY_CHANGE =
        Regex("""^1 (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) (.+)$""")
    private val RENAME_COPY =
        Regex("""^2 (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([RC])(\d{1,3}) (.+)\t(.+)$""")
    private val UNMERGED =
        Regex("""^u (.)(.) (.{4}) (\d{6}) (\d{6}) (\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+) (.+)$""")
    private val UNTRACKED = Regex("""^\? (.+)$""")
    private val IGNORED = Regex("""^! (.+)$""")

    /** Porcelain-v2 stdout → structured summary (`parseStatusSummaryV2`). */
    fun parse(statusOutput: String): GitStatusSummary {
        val files = mutableListOf<GitFileEntryV2>()
        val notAdded = mutableListOf<String>()
        val ignored = mutableListOf<String>()
        var branch = GitBranchInfo()

        for (line in statusOutput.trim().split("\n").filter { it.isNotEmpty() }) {
            when {
                line.startsWith("# branch.oid ") ->
                    BRANCH_OID.find(line)?.let { branch = branch.copy(oid = it.groupValues[1]) }
                line.startsWith("# branch.head ") ->
                    BRANCH_HEAD.find(line)?.let { branch = branch.copy(head = it.groupValues[1]) }
                line.startsWith("# branch.upstream ") ->
                    BRANCH_UPSTREAM.find(line)?.let { branch = branch.copy(upstream = it.groupValues[1]) }
                line.startsWith("# branch.ab ") ->
                    BRANCH_AB.find(line)?.let {
                        branch = branch.copy(
                            ahead = it.groupValues[1].toInt(),
                            behind = it.groupValues[2].toInt(),
                        )
                    }
                line.startsWith("1 ") ->
                    ORDINARY_CHANGE.find(line)?.let { match ->
                        files += GitFileEntryV2(
                            index = match.groupValues[1],
                            workingDir = match.groupValues[2],
                            path = match.groupValues[9],
                        )
                    }
                line.startsWith("2 ") ->
                    RENAME_COPY.find(line)?.let { match ->
                        files += GitFileEntryV2(
                            index = match.groupValues[1],
                            workingDir = match.groupValues[2],
                            from = match.groupValues[11],
                            path = match.groupValues[12],
                        )
                    }
                line.startsWith("u ") ->
                    UNMERGED.find(line)?.let { match ->
                        files += GitFileEntryV2(
                            index = match.groupValues[1],
                            workingDir = match.groupValues[2],
                            path = match.groupValues[11],
                        )
                    }
                line.startsWith("? ") -> UNTRACKED.find(line)?.let { notAdded += it.groupValues[1] }
                line.startsWith("! ") -> IGNORED.find(line)?.let { ignored += it.groupValues[1] }
            }
        }

        return GitStatusSummary(files, notAdded, ignored, branch)
    }

    /** Branch name to display; null for `(detached)` / `(initial)` (`getCurrentBranchV2`). */
    fun currentBranch(summary: GitStatusSummary): String? {
        val head = summary.branch.head
        if (head == null || head == "(detached)" || head == "(initial)") return null
        return head
    }

    /**
     * Status stdout + the two `git diff --numstat` stdouts → the Changes-tab
     * model (`buildGitStatusFiles`): staged/unstaged split by XY letter, line
     * counts merged from the matching numstat side, untracked files appended
     * to the unstaged list (directories skipped).
     */
    fun buildGitStatusFiles(
        statusOutput: String,
        unstagedDiffOutput: String,
        stagedDiffOutput: String,
    ): GitStatusFiles {
        val summary = parse(statusOutput)
        val branchName = currentBranch(summary)

        val unstagedStats = NumstatParser.statsMap(NumstatParser.parse(unstagedDiffOutput))
        val stagedStats = NumstatParser.statsMap(NumstatParser.parse(stagedDiffOutput))
        val noStats = DiffLineStats(added = 0, removed = 0, binary = false)

        val stagedFiles = mutableListOf<GitFileStatus>()
        val unstagedFiles = mutableListOf<GitFileStatus>()

        for (file in summary.files) {
            val parts = file.path.split("/")
            val fileName = parts.last().ifEmpty { file.path }
            val filePath = parts.dropLast(1).joinToString("/")

            if (file.index != " " && file.index != "." && file.index != "?") {
                val stats = stagedStats[file.path] ?: noStats
                stagedFiles += GitFileStatus(
                    fileName = fileName,
                    filePath = filePath,
                    fullPath = file.path,
                    status = fileStatus(file.index),
                    isStaged = true,
                    linesAdded = stats.added,
                    linesRemoved = stats.removed,
                    oldPath = file.from,
                )
            }

            if (file.workingDir != " " && file.workingDir != ".") {
                val stats = unstagedStats[file.path] ?: noStats
                unstagedFiles += GitFileStatus(
                    fileName = fileName,
                    filePath = filePath,
                    fullPath = file.path,
                    status = fileStatus(file.workingDir),
                    isStaged = false,
                    linesAdded = stats.added,
                    linesRemoved = stats.removed,
                    oldPath = file.from,
                )
            }
        }

        for (untrackedPath in summary.notAdded) {
            if (untrackedPath.endsWith("/")) continue // untracked directories are not rows
            val parts = untrackedPath.split("/")
            unstagedFiles += GitFileStatus(
                fileName = parts.last().ifEmpty { untrackedPath },
                filePath = parts.dropLast(1).joinToString("/"),
                fullPath = untrackedPath,
                status = GitFileChange.UNTRACKED,
                isStaged = false,
                linesAdded = 0,
                linesRemoved = 0,
            )
        }

        return GitStatusFiles(
            stagedFiles = stagedFiles,
            unstagedFiles = unstagedFiles,
            branch = branchName,
            totalStaged = stagedFiles.size,
            totalUnstaged = unstagedFiles.size,
        )
    }

    private fun fileStatus(statusChar: String): GitFileChange = when (statusChar) {
        "M" -> GitFileChange.MODIFIED
        "A" -> GitFileChange.ADDED
        "D" -> GitFileChange.DELETED
        "R", "C" -> GitFileChange.RENAMED
        "?" -> GitFileChange.UNTRACKED
        "U" -> GitFileChange.CONFLICTED
        else -> GitFileChange.MODIFIED
    }
}
