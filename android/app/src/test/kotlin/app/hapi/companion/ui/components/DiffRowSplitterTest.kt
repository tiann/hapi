package app.hapi.companion.ui.components

import app.hapi.protocol.git.DiffChangeKind
import app.hapi.protocol.git.DiffFile
import app.hapi.protocol.git.DiffHunk
import app.hapi.protocol.git.DiffLine
import app.hapi.protocol.git.DiffLineKind
import app.hapi.protocol.git.UnifiedDiffParser
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * [DiffRowSplitter] purity tests — the web `DiffView.tsx` row-grid twin.
 * Gutters pad to shared widths (aligned columns), hunks carry no gutter, and
 * `gutter + body` must reproduce the pre-wrap single-`Text` rows byte for
 * byte (the scroll-mode rendering relies on it).
 */
class DiffRowSplitterTest {

    private val sampleDiff = """
        diff --git a/src/app.ts b/src/app.ts
        --- a/src/app.ts
        +++ b/src/app.ts
        @@ -1,2 +1,2 @@
         keep
        -old
        +new
    """.trimIndent()

    private fun parse(diff: String): DiffFile = UnifiedDiffParser.parse(diff).single()

    @Test
    fun `splits rows into gutter and body with shared gutter width`() {
        val file = parse(sampleDiff)
        val rows = DiffRowSplitter.rows(file)

        assertEquals(4, rows.size)
        val hunk = rows[0]
        assertTrue(hunk.isHunkHeader)
        assertEquals("", hunk.gutter)
        assertEquals("@@ -1,2 +1,2 @@", hunk.body)
        assertEquals(null, hunk.kind)

        // Hunks end at old line 2 and new line 2 -> both gutters 1 digit,
        // forced to the minimum width of 2 (web `Math.max(..., 2)` twin).
        val context = rows[1]
        assertEquals(DiffLineKind.CONTEXT, context.kind)
        assertEquals(" 1  1", context.gutter)
        assertEquals("    keep", context.body)

        val removed = rows[2]
        assertEquals(DiffLineKind.REMOVE, removed.kind)
        assertEquals(" 2   ", removed.gutter)
        assertEquals("  - old", removed.body)

        val added = rows[3]
        assertEquals(DiffLineKind.ADD, added.kind)
        assertEquals("    2", added.gutter)
        assertEquals("  + new", added.body)

        // Every line gutter is exactly oldWidth + 1 + newWidth chars so the
        // columns align (wrap mode relies on equal intrinsic gutter widths).
        for (row in rows.drop(1)) {
            assertEquals(row.gutter.length, 2 + 1 + 2)
        }
    }

    @Test
    fun `gutter plus body reproduces the legacy single-text row`() {
        val file = parse(sampleDiff)
        val rows = DiffRowSplitter.rows(file)

        // The scroll-mode rendering concatenates gutter + body into one Text;
        // this is the exact string the viewer rendered before the wrap split.
        val expected = listOf(
            "@@ -1,2 +1,2 @@",
            " 1  1    keep",
            " 2     - old",
            "    2  + new",
        )
        assertEquals(expected, rows.map { it.gutter + it.body })
    }

    @Test
    fun `double digit line numbers widen every gutter`() {
        val file = DiffFile(
            oldPath = "a.txt",
            newPath = "a.txt",
            changeKind = DiffChangeKind.MODIFY,
            isBinary = false,
            oldMode = null,
            newMode = null,
            similarity = null,
            hunks = listOf(
                DiffHunk(
                    header = "@@ -9,3 +9,3 @@ fn",
                    oldStart = 9,
                    oldCount = 3,
                    newStart = 9,
                    newCount = 3,
                    sectionHeading = "fn",
                    lines = listOf(
                        DiffLine(DiffLineKind.CONTEXT, 9, 9, "c1"),
                        DiffLine(DiffLineKind.REMOVE, 10, null, "r10"),
                        DiffLine(DiffLineKind.ADD, null, 10, "a10"),
                        DiffLine(DiffLineKind.ADD, null, 11, "a11"),
                    ),
                ),
            ),
        )
        val rows = DiffRowSplitter.rows(file)

        // old side reaches 10 (2 digits), new side reaches 11 (2 digits).
        assertEquals(" 9  9", rows[1].gutter)
        assertEquals("10   ", rows[2].gutter)
        assertEquals("   10", rows[3].gutter)
        assertEquals("   11", rows[4].gutter)
        for (row in rows.drop(1)) {
            assertEquals(2 + 1 + 2, row.gutter.length)
        }
    }

    @Test
    fun `empty hunks produce no rows`() {
        val file = DiffFile(
            oldPath = "a.txt",
            newPath = "a.txt",
            changeKind = DiffChangeKind.MODIFY,
            isBinary = false,
            oldMode = null,
            newMode = null,
            similarity = null,
            hunks = emptyList(),
        )
        assertEquals(emptyList(), DiffRowSplitter.rows(file))
    }
}
