import Foundation
import HapiUI
import Testing

/// Unified-diff parser fixtures: modify / add / delete / rename / binary /
/// bare hunks. Line semantics follow the web's `CodexDiffView.parseUnifiedDiff`
/// (empty in-hunk line = context, `\` marker is not content); rename/binary
/// semantics follow `gitParsers.ts` (R/C → renamed, binary → 0/0 counts).
@Suite("UnifiedDiffParser")
struct DiffModelTests {
    // MARK: - Modify

    private let modifyDiff = """
    diff --git a/src/app.ts b/src/app.ts
    index 1234567..89abcde 100644
    --- a/src/app.ts
    +++ b/src/app.ts
    @@ -1,3 +1,4 @@ import section
     import a
    -import b
    +import b2
    +import c
     import d
    @@ -10,2 +11,2 @@
     x
     y
    """

    @Test func parsesModifiedFile() throws {
        let files = UnifiedDiffParser.parse(modifyDiff)
        #expect(files.count == 1)
        let file = try #require(files.first)
        #expect(file.kind == .modified)
        #expect(file.oldPath == "src/app.ts")
        #expect(file.newPath == "src/app.ts")
        #expect(file.isBinary == false)
        #expect(file.hunks.count == 2)
        #expect(file.additions == 2)
        #expect(file.deletions == 1)
        #expect(file.displayPath == "src/app.ts")
    }

    @Test func parsesHunkHeaderNumbersAndHeading() throws {
        let file = try #require(UnifiedDiffParser.parse(modifyDiff).first)
        let first = try #require(file.hunks.first)
        #expect(first.oldStart == 1)
        #expect(first.oldCount == 3)
        #expect(first.newStart == 1)
        #expect(first.newCount == 4)
        #expect(first.sectionHeading == "import section")
        #expect(first.header == "@@ -1,3 +1,4 @@ import section")
        let second = try #require(file.hunks.last)
        #expect(second.sectionHeading == nil)
    }

    @Test func computesLineNumbers() throws {
        let file = try #require(UnifiedDiffParser.parse(modifyDiff).first)
        let lines = try #require(file.hunks.first).lines
        #expect(lines.count == 5)
        #expect(lines[0] == DiffLine(kind: .context, text: "import a", oldNumber: 1, newNumber: 1))
        #expect(lines[1] == DiffLine(kind: .deletion, text: "import b", oldNumber: 2))
        #expect(lines[2] == DiffLine(kind: .addition, text: "import b2", newNumber: 2))
        #expect(lines[3] == DiffLine(kind: .addition, text: "import c", newNumber: 3))
        #expect(lines[4] == DiffLine(kind: .context, text: "import d", oldNumber: 3, newNumber: 4))

        let secondHunk = try #require(file.hunks.last).lines
        #expect(secondHunk[0].oldNumber == 10)
        #expect(secondHunk[0].newNumber == 11)
        #expect(secondHunk[1].oldNumber == 11)
        #expect(secondHunk[1].newNumber == 12)
    }

    // MARK: - Add / delete

    @Test func parsesAddedFile() throws {
        let diff = """
        diff --git a/new.txt b/new.txt
        new file mode 100644
        index 0000000..e69de29
        --- /dev/null
        +++ b/new.txt
        @@ -0,0 +1,2 @@
        +hello
        +world
        """
        let file = try #require(UnifiedDiffParser.parse(diff).first)
        #expect(file.kind == .added)
        #expect(file.oldPath == nil)
        #expect(file.newPath == "new.txt")
        #expect(file.additions == 2)
        #expect(file.deletions == 0)
        #expect(file.hunks.first?.lines.map(\.newNumber) == [1, 2])
        #expect(file.displayPath == "new.txt")
    }

    @Test func parsesDeletedFile() throws {
        let diff = """
        diff --git a/old.txt b/old.txt
        deleted file mode 100644
        index e69de29..0000000
        --- a/old.txt
        +++ /dev/null
        @@ -1,2 +0,0 @@
        -hello
        -world
        """
        let file = try #require(UnifiedDiffParser.parse(diff).first)
        #expect(file.kind == .deleted)
        #expect(file.oldPath == "old.txt")
        #expect(file.newPath == nil)
        #expect(file.additions == 0)
        #expect(file.deletions == 2)
        #expect(file.hunks.first?.lines.map(\.oldNumber) == [1, 2])
        #expect(file.displayPath == "old.txt")
    }

    // MARK: - Rename

    @Test func parsesPureRename() throws {
        let diff = """
        diff --git a/lib/a.ts b/lib/b.ts
        similarity index 100%
        rename from lib/a.ts
        rename to lib/b.ts
        """
        let file = try #require(UnifiedDiffParser.parse(diff).first)
        #expect(file.kind == .renamed)
        #expect(file.oldPath == "lib/a.ts")
        #expect(file.newPath == "lib/b.ts")
        #expect(file.hunks.isEmpty)
        #expect(file.additions == 0)
        #expect(file.displayPath == "lib/a.ts → lib/b.ts")
    }

    @Test func parsesRenameWithEdits() throws {
        let diff = """
        diff --git a/lib/a.ts b/lib/b.ts
        similarity index 90%
        rename from lib/a.ts
        rename to lib/b.ts
        index 111..222 100644
        --- a/lib/a.ts
        +++ b/lib/b.ts
        @@ -1,2 +1,2 @@
         keep
        -old
        +new
        """
        let file = try #require(UnifiedDiffParser.parse(diff).first)
        #expect(file.kind == .renamed)
        #expect(file.hunks.count == 1)
        #expect(file.additions == 1)
        #expect(file.deletions == 1)
    }

    @Test func copyCountsAsRenamed() throws {
        let diff = """
        diff --git a/x.ts b/y.ts
        copy from x.ts
        copy to y.ts
        """
        let file = try #require(UnifiedDiffParser.parse(diff).first)
        #expect(file.kind == .renamed)
        #expect(file.oldPath == "x.ts")
        #expect(file.newPath == "y.ts")
    }

    // MARK: - Binary

    @Test func parsesBinaryFile() throws {
        let diff = """
        diff --git a/img.png b/img.png
        index 1234567..89abcde 100644
        Binary files a/img.png and b/img.png differ
        """
        let file = try #require(UnifiedDiffParser.parse(diff).first)
        #expect(file.isBinary)
        #expect(file.hunks.isEmpty)
        // gitParsers numstat parity: binary reports 0/0.
        #expect(file.additions == 0)
        #expect(file.deletions == 0)
    }

    // MARK: - Bare hunks (agent unified_diff inputs)

    @Test func parsesHeaderlessHunk() throws {
        let diff = """
        @@ -1,2 +1,2 @@
         a
        -b
        +c
        """
        let files = UnifiedDiffParser.parse(diff)
        #expect(files.count == 1)
        let file = try #require(files.first)
        #expect(file.oldPath == nil)
        #expect(file.newPath == nil)
        #expect(file.kind == .modified)
        #expect(file.hunks.count == 1)
        #expect(file.hunks.first?.lines.count == 3)
        #expect(file.additions == 1)
        #expect(file.deletions == 1)
        #expect(file.displayPath == "diff")
    }

    @Test func parsesOmittedCountsAsOne() throws {
        let diff = """
        @@ -3 +7 @@
        -x
        +y
        """
        let hunk = try #require(UnifiedDiffParser.parse(diff).first?.hunks.first)
        #expect(hunk.oldStart == 3)
        #expect(hunk.oldCount == 1)
        #expect(hunk.newStart == 7)
        #expect(hunk.newCount == 1)
        #expect(hunk.lines[0].oldNumber == 3)
        #expect(hunk.lines[1].newNumber == 7)
    }

    @Test func emptyInHunkLineIsContext() throws {
        let diff = """
        --- a/f.txt
        +++ b/f.txt
        @@ -1,3 +1,3 @@
         a

         b
        """
        let lines = try #require(UnifiedDiffParser.parse(diff).first?.hunks.first).lines
        #expect(lines.count == 3)
        #expect(lines[1] == DiffLine(kind: .context, text: "", oldNumber: 2, newNumber: 2))
    }

    @Test func noNewlineMarkerIsNotContent() throws {
        let diff = """
        --- a/f.txt
        +++ b/f.txt
        @@ -1 +1 @@
        -old
        \\ No newline at end of file
        +new
        \\ No newline at end of file
        """
        let file = try #require(UnifiedDiffParser.parse(diff).first)
        let lines = try #require(file.hunks.first).lines
        #expect(lines.count == 4)
        #expect(lines[1].kind == .noNewlineMarker)
        #expect(lines[3].kind == .noNewlineMarker)
        #expect(lines[1].oldNumber == nil)
        #expect(lines[1].newNumber == nil)
        #expect(file.additions == 1)
        #expect(file.deletions == 1)
    }

    // MARK: - Multi-file and junk

    @Test func parsesMultiFileDiff() {
        let diff = """
        diff --git a/a.txt b/a.txt
        --- a/a.txt
        +++ b/a.txt
        @@ -1 +1 @@
        -x
        +y
        diff --git a/b.txt b/b.txt
        --- a/b.txt
        +++ b/b.txt
        @@ -1 +1 @@
        -p
        +q
        """
        let files = UnifiedDiffParser.parse(diff)
        #expect(files.count == 2)
        #expect(files.map(\.displayPath) == ["a.txt", "b.txt"])
        #expect(files.allSatisfy { $0.hunks.count == 1 })
    }

    @Test func ignoresProseAndStrayMarkers() {
        let text = """
        Here is a summary of changes.
        --- notes below
        nothing else
        """
        #expect(UnifiedDiffParser.parse(text).isEmpty)
        #expect(UnifiedDiffParser.parse("").isEmpty)
    }

    @Test func closesHunkWhenCountsLie() throws {
        // Declared counts promise more lines than delivered; the next file
        // header must still start a fresh file.
        let diff = """
        diff --git a/a.txt b/a.txt
        --- a/a.txt
        +++ b/a.txt
        @@ -1,5 +1,5 @@
        -x
        +y
        diff --git a/b.txt b/b.txt
        --- a/b.txt
        +++ b/b.txt
        @@ -1 +1 @@
        -p
        +q
        """
        let files = UnifiedDiffParser.parse(diff)
        #expect(files.count == 2)
        #expect(files.last?.newPath == "b.txt")
        #expect(files.first?.hunks.count == 1)
    }
}
