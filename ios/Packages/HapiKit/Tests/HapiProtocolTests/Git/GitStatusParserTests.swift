import Foundation
import HapiProtocol
import Testing

/// Inline porcelain-v2 samples with expectations produced by running the
/// exact inputs through `web/src/lib/gitParsers.ts` (`parseStatusSummaryV2`,
/// `getCurrentBranchV2`, `buildGitStatusFiles`) — transcribed from the
/// Android reference suite (`GitStatusParserTest.kt`). The Swift parser must
/// match the web behavior byte for byte, quirks included.
@Suite("GitStatusParser")
struct GitStatusParserTests {

    private let fullStatus = [
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
    ].joined(separator: "\n")

    @Test func parsesBranchHeaders() {
        let branch = GitStatusParser.parse(fullStatus).branch

        #expect(branch.oid == "3b18e512dba79e4c8300dd08aeb37f8e728b8dad")
        #expect(branch.head == "main")
        #expect(branch.upstream == "origin/main")
        #expect(branch.ahead == 2)
        #expect(branch.behind == 1)
    }

    @Test func parsesOrdinaryRenameUnmergedUntrackedAndIgnoredRecords() {
        let summary = GitStatusParser.parse(fullStatus)

        #expect(summary.files.count == 7)
        #expect(summary.files[0] == GitFileEntryV2(path: "src/app.ts", index: ".", workingDir: "M"))
        #expect(summary.files[1] == GitFileEntryV2(path: "docs/readme.md", index: "M", workingDir: "."))
        #expect(summary.files[2] == GitFileEntryV2(path: "both.txt", index: "M", workingDir: "M"))
        // Paths with spaces survive (the path group is greedy).
        #expect(summary.files[3] == GitFileEntryV2(path: "new file.txt", index: "A", workingDir: "."))
        #expect(summary.files[4] == GitFileEntryV2(path: "gone.txt", index: ".", workingDir: "D"))
        // Rename record: first tab-separated path -> from, second -> path
        // (exactly how the web parser reads the payload).
        #expect(
            summary.files[5]
                == GitFileEntryV2(path: "new/name.ts", index: "R", workingDir: ".", from: "old/name.ts")
        )
        #expect(summary.files[6] == GitFileEntryV2(path: "conflict.txt", index: "U", workingDir: "U"))

        #expect(summary.notAdded == ["untracked.txt", "build/"])
        #expect(summary.ignored == ["ignored.txt"])
        #expect(GitStatusParser.currentBranch(summary) == "main")
    }

    @Test func detachedAndInitialHeadsHaveNoCurrentBranch() {
        let detached = GitStatusParser.parse(
            "# branch.oid deadbeef\n# branch.head (detached)\n1 .M N... 100644 100644 100644 aa bb x.txt"
        )
        #expect(detached.branch.head == "(detached)")
        #expect(GitStatusParser.currentBranch(detached) == nil)
        #expect(detached.files.count == 1)

        let initial = GitStatusParser.parse("# branch.head (initial)")
        #expect(GitStatusParser.currentBranch(initial) == nil)

        #expect(GitStatusParser.currentBranch(GitStatusParser.parse("")) == nil)
    }

    @Test func malformedRecordsAreSkipped() {
        let summary = GitStatusParser.parse(
            [
                "1 not-a-valid-record",
                "2 R. missing-everything",
                "# branch.ab +x -y",
                "1 MM N... 100644 100644 100644 eeeeeeee ffffffff ok.txt",
            ].joined(separator: "\n")
        )

        #expect(summary.files == [GitFileEntryV2(path: "ok.txt", index: "M", workingDir: "M")])
        #expect(summary.branch.ahead == nil)
    }

    // MARK: - buildGitStatusFiles

    private let unstagedNumstat = "3\t1\tsrc/app.ts\n5\t2\tboth.txt\n-\t-\timage.png"
    private let stagedNumstat =
        "4\t0\tdocs/readme.md\n1\t1\tboth.txt\n10\t0\tnew file.txt\n0\t0\t{old => new}/name.ts"

    @Test func mergesStatusWithNumstatIntoStagedAndUnstagedSections() {
        let built = GitStatusParser.buildGitStatusFiles(
            statusOutput: fullStatus,
            unstagedDiffOutput: unstagedNumstat,
            stagedDiffOutput: stagedNumstat
        )

        #expect(built.branch == "main")
        #expect(built.totalStaged == 5)
        #expect(built.totalUnstaged == 5)

        #expect(built.stagedFiles == [
            GitFileStatus(
                fileName: "readme.md", filePath: "docs", fullPath: "docs/readme.md",
                status: .modified, isStaged: true, linesAdded: 4, linesRemoved: 0
            ),
            GitFileStatus(
                fileName: "both.txt", filePath: "", fullPath: "both.txt",
                status: .modified, isStaged: true, linesAdded: 1, linesRemoved: 1
            ),
            GitFileStatus(
                fileName: "new file.txt", filePath: "", fullPath: "new file.txt",
                status: .added, isStaged: true, linesAdded: 10, linesRemoved: 0
            ),
            // Rename counts resolve through the normalized brace path.
            GitFileStatus(
                fileName: "name.ts", filePath: "new", fullPath: "new/name.ts",
                status: .renamed, isStaged: true, linesAdded: 0, linesRemoved: 0,
                oldPath: "old/name.ts"
            ),
            GitFileStatus(
                fileName: "conflict.txt", filePath: "", fullPath: "conflict.txt",
                status: .conflicted, isStaged: true, linesAdded: 0, linesRemoved: 0
            ),
        ])

        #expect(built.unstagedFiles == [
            GitFileStatus(
                fileName: "app.ts", filePath: "src", fullPath: "src/app.ts",
                status: .modified, isStaged: false, linesAdded: 3, linesRemoved: 1
            ),
            GitFileStatus(
                fileName: "both.txt", filePath: "", fullPath: "both.txt",
                status: .modified, isStaged: false, linesAdded: 5, linesRemoved: 2
            ),
            GitFileStatus(
                fileName: "gone.txt", filePath: "", fullPath: "gone.txt",
                status: .deleted, isStaged: false, linesAdded: 0, linesRemoved: 0
            ),
            // UU conflicts appear on both sides, like the web list.
            GitFileStatus(
                fileName: "conflict.txt", filePath: "", fullPath: "conflict.txt",
                status: .conflicted, isStaged: false, linesAdded: 0, linesRemoved: 0
            ),
            // Untracked files land unstaged; the untracked build/ dir is dropped.
            GitFileStatus(
                fileName: "untracked.txt", filePath: "", fullPath: "untracked.txt",
                status: .untracked, isStaged: false, linesAdded: 0, linesRemoved: 0
            ),
        ])
    }

    @Test func emptyOutputsBuildAnEmptyModel() {
        let built = GitStatusParser.buildGitStatusFiles(
            statusOutput: "",
            unstagedDiffOutput: "",
            stagedDiffOutput: ""
        )

        #expect(built.branch == nil)
        #expect(built.stagedFiles.isEmpty)
        #expect(built.unstagedFiles.isEmpty)
        #expect(built.totalStaged == 0)
        #expect(built.totalUnstaged == 0)
    }

    @Test func filesMissingFromNumstatKeepZeroCounts() {
        let built = GitStatusParser.buildGitStatusFiles(
            statusOutput: "# branch.head work\n1 .M N... 100644 100644 100644 aa bb solo.txt",
            unstagedDiffOutput: "",
            stagedDiffOutput: ""
        )

        #expect(built.unstagedFiles.count == 1)
        #expect(built.unstagedFiles.first?.linesAdded == 0)
        #expect(built.unstagedFiles.first?.linesRemoved == 0)
    }
}
