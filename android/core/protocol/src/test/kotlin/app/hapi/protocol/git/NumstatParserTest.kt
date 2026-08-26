package app.hapi.protocol.git

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Inline numstat samples with expectations produced by running the exact
 * inputs through `parseNumStat`/`createDiffStatsMap` in
 * `web/src/lib/gitParsers.ts`.
 */
class NumstatParserTest {

    @Test
    fun `parses counts, totals and binary markers`() {
        val summary = NumstatParser.parse("3\t1\tsrc/app.ts\n5\t2\tboth.txt\n-\t-\timage.png")

        assertEquals(
            listOf(
                DiffFileStat("src/app.ts", changes = 4, insertions = 3, deletions = 1, binary = false),
                DiffFileStat("both.txt", changes = 7, insertions = 5, deletions = 2, binary = false),
                DiffFileStat("image.png", changes = 0, insertions = 0, deletions = 0, binary = true),
            ),
            summary.files,
        )
        assertEquals(8, summary.insertions)
        assertEquals(3, summary.deletions)
        assertEquals(11, summary.changes)
        assertEquals(3, summary.changed)
    }

    @Test
    fun `blank and malformed lines are ignored`() {
        val summary = NumstatParser.parse("\n\nnot numstat\n1\t2\tok.txt\n")

        assertEquals(1, summary.changed)
        assertEquals("ok.txt", summary.files.single().file)
        assertTrue(NumstatParser.parse("").files.isEmpty())
    }

    @Test
    fun `stats map indexes raw path plus normalized brace-rename paths`() {
        val map = NumstatParser.statsMap(NumstatParser.parse("0\t0\t{old => new}/name.ts"))

        val stat = DiffLineStats(added = 0, removed = 0, binary = false)
        assertEquals(stat, map["{old => new}/name.ts"])
        assertEquals(stat, map["new/name.ts"])
        assertEquals(stat, map["old/name.ts"])
        assertEquals(3, map.size)
    }

    @Test
    fun `stats map indexes plain arrow renames`() {
        val map = NumstatParser.statsMap(NumstatParser.parse("2\t3\told.txt => new.txt"))

        val stat = DiffLineStats(added = 2, removed = 3, binary = false)
        assertEquals(stat, map["old.txt => new.txt"])
        assertEquals(stat, map["new.txt"])
        assertEquals(stat, map["old.txt"])
    }

    @Test
    fun `stats map keeps binary flag and plain paths`() {
        val map = NumstatParser.statsMap(NumstatParser.parse("-\t-\tassets/logo.png\n7\t0\tREADME.md"))

        assertEquals(DiffLineStats(0, 0, binary = true), map["assets/logo.png"])
        assertEquals(DiffLineStats(7, 0, binary = false), map["README.md"])
        assertNull(map["missing.txt"])
        assertEquals(2, map.size)
    }

    @Test
    fun `mid-path brace rename normalizes both sides`() {
        val paths = NumstatParser.normalizePath("src/{components => ui}/Button.tsx")

        assertEquals("src/ui/Button.tsx", paths.newPath)
        assertEquals("src/components/Button.tsx", paths.oldPath)
    }

    @Test
    fun `path without rename markers passes through trimmed`() {
        val paths = NumstatParser.normalizePath("  plain/path.txt  ")

        assertEquals("plain/path.txt", paths.newPath)
        assertNull(paths.oldPath)
    }
}
