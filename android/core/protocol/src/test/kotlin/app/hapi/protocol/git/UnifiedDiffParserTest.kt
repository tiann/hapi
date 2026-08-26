package app.hapi.protocol.git

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class UnifiedDiffParserTest {

    @Test
    fun `parses a modification with two hunks and a section heading`() {
        val diff = """
            diff --git a/src/app.ts b/src/app.ts
            index 83db48f..bf269f4 100644
            --- a/src/app.ts
            +++ b/src/app.ts
            @@ -1,4 +1,5 @@ function main()
             import fs from 'fs'
            -const a = 1
            +const a = 2
            +const b = 3
             console.log(a)
             export {}
            @@ -10,2 +11,2 @@
             tail1
            -tail2
            +tail2!
        """.trimIndent()

        val file = UnifiedDiffParser.parse(diff).single()

        assertEquals("src/app.ts", file.oldPath)
        assertEquals("src/app.ts", file.newPath)
        assertEquals(DiffChangeKind.MODIFY, file.changeKind)
        assertEquals(false, file.isBinary)
        assertEquals(2, file.hunks.size)
        assertEquals(3, file.additions)
        assertEquals(2, file.deletions)

        val hunk = file.hunks[0]
        assertEquals("function main()", hunk.sectionHeading)
        assertEquals(1, hunk.oldStart)
        assertEquals(4, hunk.oldCount)
        assertEquals(1, hunk.newStart)
        assertEquals(5, hunk.newCount)
        assertEquals(
            listOf(
                DiffLine(DiffLineKind.CONTEXT, 1, 1, "import fs from 'fs'"),
                DiffLine(DiffLineKind.REMOVE, 2, null, "const a = 1"),
                DiffLine(DiffLineKind.ADD, null, 2, "const a = 2"),
                DiffLine(DiffLineKind.ADD, null, 3, "const b = 3"),
                DiffLine(DiffLineKind.CONTEXT, 3, 4, "console.log(a)"),
                DiffLine(DiffLineKind.CONTEXT, 4, 5, "export {}"),
            ),
            hunk.lines,
        )

        val second = file.hunks[1]
        assertNull(second.sectionHeading)
        assertEquals(
            listOf(
                DiffLine(DiffLineKind.CONTEXT, 10, 11, "tail1"),
                DiffLine(DiffLineKind.REMOVE, 11, null, "tail2"),
                DiffLine(DiffLineKind.ADD, null, 12, "tail2!"),
            ),
            second.lines,
        )
    }

    @Test
    fun `parses a new file with a missing trailing newline`() {
        val diff = """
            diff --git a/notes.md b/notes.md
            new file mode 100644
            index 0000000..e69de29
            --- /dev/null
            +++ b/notes.md
            @@ -0,0 +1,2 @@
            +hello
            +world
            \ No newline at end of file
        """.trimIndent()

        val file = UnifiedDiffParser.parse(diff).single()

        assertNull(file.oldPath)
        assertEquals("notes.md", file.newPath)
        assertEquals(DiffChangeKind.ADD, file.changeKind)
        assertEquals("100644", file.newMode)
        assertEquals("notes.md", file.displayPath)

        val lines = file.hunks.single().lines
        assertEquals(
            listOf(
                DiffLine(DiffLineKind.ADD, null, 1, "hello"),
                DiffLine(DiffLineKind.ADD, null, 2, "world", noNewlineAtEnd = true),
            ),
            lines,
        )
    }

    @Test
    fun `parses a deleted file`() {
        val diff = """
            diff --git a/old.txt b/old.txt
            deleted file mode 100644
            index 4b5fa63..0000000
            --- a/old.txt
            +++ /dev/null
            @@ -1,2 +0,0 @@
            -line one
            -line two
        """.trimIndent()

        val file = UnifiedDiffParser.parse(diff).single()

        assertEquals("old.txt", file.oldPath)
        assertNull(file.newPath)
        assertEquals(DiffChangeKind.DELETE, file.changeKind)
        assertEquals("100644", file.oldMode)
        assertEquals("old.txt", file.displayPath)
        assertEquals(
            listOf(
                DiffLine(DiffLineKind.REMOVE, 1, null, "line one"),
                DiffLine(DiffLineKind.REMOVE, 2, null, "line two"),
            ),
            file.hunks.single().lines,
        )
    }

    @Test
    fun `parses a rename with an edit`() {
        val diff = """
            diff --git a/src/a.ts b/src/b.ts
            similarity index 87%
            rename from src/a.ts
            rename to src/b.ts
            index 1111111..2222222 100644
            --- a/src/a.ts
            +++ b/src/b.ts
            @@ -3,3 +3,3 @@
             keep
            -old line
            +new line
             keep2
        """.trimIndent()

        val file = UnifiedDiffParser.parse(diff).single()

        assertEquals(DiffChangeKind.RENAME, file.changeKind)
        assertEquals("src/a.ts", file.oldPath)
        assertEquals("src/b.ts", file.newPath)
        assertEquals(87, file.similarity)
        val lines = file.hunks.single().lines
        assertEquals(DiffLine(DiffLineKind.CONTEXT, 3, 3, "keep"), lines[0])
        assertEquals(DiffLine(DiffLineKind.REMOVE, 4, null, "old line"), lines[1])
        assertEquals(DiffLine(DiffLineKind.ADD, null, 4, "new line"), lines[2])
        assertEquals(DiffLine(DiffLineKind.CONTEXT, 5, 5, "keep2"), lines[3])
    }

    @Test
    fun `parses a pure rename without hunks`() {
        val diff = """
            diff --git a/docs/x.md b/docs/y.md
            similarity index 100%
            rename from docs/x.md
            rename to docs/y.md
        """.trimIndent()

        val file = UnifiedDiffParser.parse(diff).single()

        assertEquals(DiffChangeKind.RENAME, file.changeKind)
        assertEquals("docs/x.md", file.oldPath)
        assertEquals("docs/y.md", file.newPath)
        assertEquals(100, file.similarity)
        assertTrue(file.hunks.isEmpty())
    }

    @Test
    fun `parses a binary file marker`() {
        val diff = """
            diff --git a/img/logo.png b/img/logo.png
            index 1234567..89abcde 100644
            Binary files a/img/logo.png and b/img/logo.png differ
        """.trimIndent()

        val file = UnifiedDiffParser.parse(diff).single()

        assertTrue(file.isBinary)
        assertEquals(DiffChangeKind.MODIFY, file.changeKind)
        assertEquals("img/logo.png", file.displayPath)
        assertTrue(file.hunks.isEmpty())
    }

    @Test
    fun `parses a bare unified diff without a git header`() {
        // Codex `unified_diff` tool input shape. Line semantics cross-checked
        // against the web's CodexDiffView parseUnifiedDiff: context lines land
        // on both sides, the no-newline marker is not content.
        val diff = """
            --- a/lib/util.py
            +++ b/lib/util.py
            @@ -1,3 +1,3 @@
             import os
            -x = 1
            +x = 2
        """.trimIndent()

        val file = UnifiedDiffParser.parse(diff).single()

        assertEquals("lib/util.py", file.oldPath)
        assertEquals("lib/util.py", file.newPath)
        assertEquals(DiffChangeKind.MODIFY, file.changeKind)

        // Reconstruct both sides the way the web viewer feeds DiffView.
        val lines = file.hunks.single().lines
        val oldText = lines.filter { it.kind != DiffLineKind.ADD }.joinToString("\n") { it.text }
        val newText = lines.filter { it.kind != DiffLineKind.REMOVE }.joinToString("\n") { it.text }
        assertEquals("import os\nx = 1", oldText)
        assertEquals("import os\nx = 2", newText)
    }

    @Test
    fun `parses multiple files in one diff`() {
        val diff = """
            diff --git a/one.txt b/one.txt
            --- a/one.txt
            +++ b/one.txt
            @@ -1 +1 @@
            -a
            +b
            diff --git a/two.txt b/two.txt
            new file mode 100644
            --- /dev/null
            +++ b/two.txt
            @@ -0,0 +1 @@
            +hi
        """.trimIndent()

        val files = UnifiedDiffParser.parse(diff)

        assertEquals(2, files.size)
        assertEquals("one.txt", files[0].displayPath)
        assertEquals(DiffChangeKind.MODIFY, files[0].changeKind)
        assertEquals("two.txt", files[1].displayPath)
        assertEquals(DiffChangeKind.ADD, files[1].changeKind)
    }

    @Test
    fun `unquotes paths with spaces`() {
        val diff = """
            diff --git "a/sp ace.txt" "b/sp ace.txt"
            --- "a/sp ace.txt"
            +++ "b/sp ace.txt"
            @@ -1 +1 @@
            -x
            +y
        """.trimIndent()

        val file = UnifiedDiffParser.parse(diff).single()

        assertEquals("sp ace.txt", file.oldPath)
        assertEquals("sp ace.txt", file.newPath)
    }

    @Test
    fun `empty input yields no files`() {
        assertTrue(UnifiedDiffParser.parse("").isEmpty())
        assertTrue(UnifiedDiffParser.parse("warning: nothing to see\n").isEmpty())
    }

    @Test
    fun `tolerates a truncated final hunk`() {
        // Streaming cutoffs must keep every line seen so far.
        val diff = """
            diff --git a/x.txt b/x.txt
            --- a/x.txt
            +++ b/x.txt
            @@ -1,5 +1,5 @@
             ctx
            -gone
        """.trimIndent()

        val file = UnifiedDiffParser.parse(diff).single()

        assertEquals(
            listOf(
                DiffLine(DiffLineKind.CONTEXT, 1, 1, "ctx"),
                DiffLine(DiffLineKind.REMOVE, 2, null, "gone"),
            ),
            file.hunks.single().lines,
        )
    }
}
