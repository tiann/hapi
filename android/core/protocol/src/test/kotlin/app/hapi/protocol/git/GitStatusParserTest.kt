package app.hapi.protocol.git

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Inline porcelain-v2 samples with expectations produced by running the exact
 * inputs through `web/src/lib/gitParsers.ts` (`parseStatusSummaryV2`,
 * `getCurrentBranchV2`, `buildGitStatusFiles`) — the Kotlin parser must match
 * the web behavior byte for byte, quirks included.
 */
class GitStatusParserTest {

    private val fullStatus = listOf(
        "# branch.oid 3b18e512dba79e4c8300dd08aeb37f8e728b8dad",
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +2 -1",
        "1 .M N... 100644 100644 100644 aaaaaaaa bbbbbbbb src/app.ts",
        "1 M. N... 100644 100644 100644 cccccccc dddddddd docs/readme.md",
        "1 MM N... 100644 100644 100644 eeeeeeee ffffffff both.txt",
        "1 A. N... 000000 100644 100644 00000000 11111111 new file.txt",
        "1 .D N... 100644 100644 000000 22222222 33333333 gone.txt",
        "2 R. N... 100644 100644 100644 44444444 55555555 R100 old/name.ts\tnew/name.ts",
        "u UU N... 100644 100644 100644 100644 66666666 77777777 88888888 conflict.txt",
        "? untracked.txt",
        "? build/",
        "! ignored.txt",
    ).joinToString("\n")

    @Test
    fun `parses branch headers`() {
        val branch = GitStatusParser.parse(fullStatus).branch

        assertEquals("3b18e512dba79e4c8300dd08aeb37f8e728b8dad", branch.oid)
        assertEquals("main", branch.head)
        assertEquals("origin/main", branch.upstream)
        assertEquals(2, branch.ahead)
        assertEquals(1, branch.behind)
    }

    @Test
    fun `parses ordinary, rename, unmerged, untracked and ignored records`() {
        val summary = GitStatusParser.parse(fullStatus)

        assertEquals(7, summary.files.size)
        assertEquals(GitFileEntryV2(path = "src/app.ts", index = ".", workingDir = "M"), summary.files[0])
        assertEquals(GitFileEntryV2(path = "docs/readme.md", index = "M", workingDir = "."), summary.files[1])
        assertEquals(GitFileEntryV2(path = "both.txt", index = "M", workingDir = "M"), summary.files[2])
        // Paths with spaces survive (the path group is greedy).
        assertEquals(GitFileEntryV2(path = "new file.txt", index = "A", workingDir = "."), summary.files[3])
        assertEquals(GitFileEntryV2(path = "gone.txt", index = ".", workingDir = "D"), summary.files[4])
        // Rename record: first tab-separated path -> from, second -> path
        // (exactly how the web parser reads the payload).
        assertEquals(
            GitFileEntryV2(path = "new/name.ts", index = "R", workingDir = ".", from = "old/name.ts"),
            summary.files[5],
        )
        assertEquals(GitFileEntryV2(path = "conflict.txt", index = "U", workingDir = "U"), summary.files[6])

        assertEquals(listOf("untracked.txt", "build/"), summary.notAdded)
        assertEquals(listOf("ignored.txt"), summary.ignored)
        assertEquals("main", GitStatusParser.currentBranch(summary))
    }

    @Test
    fun `detached and initial heads have no current branch`() {
        val detached = GitStatusParser.parse(
            "# branch.oid deadbeef\n# branch.head (detached)\n1 .M N... 100644 100644 100644 aa bb x.txt",
        )
        assertEquals("(detached)", detached.branch.head)
        assertNull(GitStatusParser.currentBranch(detached))
        assertEquals(1, detached.files.size)

        val initial = GitStatusParser.parse("# branch.head (initial)")
        assertNull(GitStatusParser.currentBranch(initial))

        assertNull(GitStatusParser.currentBranch(GitStatusParser.parse("")))
    }

    @Test
    fun `malformed records are skipped`() {
        val summary = GitStatusParser.parse(
            listOf(
                "1 not-a-valid-record",
                "2 R. missing-everything",
                "# branch.ab +x -y",
                "1 MM N... 100644 100644 100644 eeeeeeee ffffffff ok.txt",
            ).joinToString("\n"),
        )

        assertEquals(listOf(GitFileEntryV2(path = "ok.txt", index = "M", workingDir = "M")), summary.files)
        assertNull(summary.branch.ahead)
    }

    // ------------------------------------------------- buildGitStatusFiles --

    private val unstagedNumstat = "3\t1\tsrc/app.ts\n5\t2\tboth.txt\n-\t-\timage.png"
    private val stagedNumstat =
        "4\t0\tdocs/readme.md\n1\t1\tboth.txt\n10\t0\tnew file.txt\n0\t0\t{old => new}/name.ts"

    @Test
    fun `merges status with numstat into staged and unstaged sections`() {
        val built = GitStatusParser.buildGitStatusFiles(fullStatus, unstagedNumstat, stagedNumstat)

        assertEquals("main", built.branch)
        assertEquals(5, built.totalStaged)
        assertEquals(5, built.totalUnstaged)

        assertEquals(
            listOf(
                GitFileStatus("readme.md", "docs", "docs/readme.md", GitFileChange.MODIFIED, true, 4, 0),
                GitFileStatus("both.txt", "", "both.txt", GitFileChange.MODIFIED, true, 1, 1),
                GitFileStatus("new file.txt", "", "new file.txt", GitFileChange.ADDED, true, 10, 0),
                // Rename counts resolve through the normalized brace path.
                GitFileStatus("name.ts", "new", "new/name.ts", GitFileChange.RENAMED, true, 0, 0, "old/name.ts"),
                GitFileStatus("conflict.txt", "", "conflict.txt", GitFileChange.CONFLICTED, true, 0, 0),
            ),
            built.stagedFiles,
        )

        assertEquals(
            listOf(
                GitFileStatus("app.ts", "src", "src/app.ts", GitFileChange.MODIFIED, false, 3, 1),
                GitFileStatus("both.txt", "", "both.txt", GitFileChange.MODIFIED, false, 5, 2),
                GitFileStatus("gone.txt", "", "gone.txt", GitFileChange.DELETED, false, 0, 0),
                // UU conflicts appear on both sides, like the web list.
                GitFileStatus("conflict.txt", "", "conflict.txt", GitFileChange.CONFLICTED, false, 0, 0),
                // Untracked files land unstaged; the untracked build/ dir is dropped.
                GitFileStatus("untracked.txt", "", "untracked.txt", GitFileChange.UNTRACKED, false, 0, 0),
            ),
            built.unstagedFiles,
        )
    }

    @Test
    fun `empty outputs build an empty model`() {
        val built = GitStatusParser.buildGitStatusFiles("", "", "")

        assertNull(built.branch)
        assertTrue(built.stagedFiles.isEmpty())
        assertTrue(built.unstagedFiles.isEmpty())
        assertEquals(0, built.totalStaged)
        assertEquals(0, built.totalUnstaged)
    }

    @Test
    fun `files missing from numstat keep zero counts`() {
        val built = GitStatusFilesFixture.singleModified()

        assertEquals(0, built.unstagedFiles.single().linesAdded)
        assertEquals(0, built.unstagedFiles.single().linesRemoved)
    }

    private object GitStatusFilesFixture {
        fun singleModified(): GitStatusFiles = GitStatusParser.buildGitStatusFiles(
            "# branch.head work\n1 .M N... 100644 100644 100644 aa bb solo.txt",
            "",
            "",
        )
    }
}
