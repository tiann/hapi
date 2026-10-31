package app.hapi.companion.feature.terminal

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * Golden tests for the pure-JVM terminal core (slice: interactive remote
 * terminal). Every case asserts on the public snapshot surface the UI renders
 * from — no internals — so the tests double as documentation of the supported
 * ANSI subset.
 */
class TerminalEmulatorTest {

    private fun emulator(cols: Int = 80, rows: Int = 24) = TerminalEmulator(cols, rows)

    private fun TerminalSnapshot.screenRow(row: Int): String =
        lines[scrollbackCount + row].runs.joinToString("") { it.text }

    private fun TerminalSnapshot.scrollbackRow(row: Int): String =
        lines[row].runs.joinToString("") { it.text }

    private fun TerminalSnapshot.cursorRuns(): List<TerminalRun> =
        lines.flatMap { it.runs }.filter { it.isCursor }

    // ---------------------------------------------------------- printing --

    @Test
    fun `plain text lands on row zero and advances the cursor`() {
        val term = emulator()
        term.write("hi")
        val snapshot = term.snapshot()
        assertEquals("hi", snapshot.screenRow(0).trimEnd())
        assertEquals(0, snapshot.cursorLine)
        assertEquals(2, snapshot.cursorCol)
        assertEquals(0, snapshot.scrollbackCount)
    }

    @Test
    fun `bare LF homes the column like convertEol`() {
        val term = emulator()
        term.write("abc\ndef")
        val snapshot = term.snapshot()
        assertEquals("abc", snapshot.screenRow(0).trimEnd())
        assertEquals("def", snapshot.screenRow(1).trimEnd())
        assertEquals(1, snapshot.cursorLine)
        assertEquals(3, snapshot.cursorCol)
    }

    @Test
    fun `CRLF advances exactly one line`() {
        val term = emulator()
        term.write("abc\r\ndef")
        val snapshot = term.snapshot()
        assertEquals("abc", snapshot.screenRow(0).trimEnd())
        assertEquals("def", snapshot.screenRow(1).trimEnd())
        assertEquals(1, snapshot.cursorLine)
    }

    @Test
    fun `VT and FF behave like LF`() {
        val term = emulator()
        term.write("a\u000Bb\u000Cc")
        val snapshot = term.snapshot()
        assertEquals("a", snapshot.screenRow(0).trimEnd())
        assertEquals("b", snapshot.screenRow(1).trimEnd())
        assertEquals("c", snapshot.screenRow(2).trimEnd())
    }

    @Test
    fun `backspace moves left without erasing`() {
        val term = emulator()
        term.write("abc\u0008")
        val snapshot = term.snapshot()
        assertEquals("abc", snapshot.screenRow(0).trimEnd())
        assertEquals(2, snapshot.cursorCol)
    }

    @Test
    fun `tab advances to the next multiple of eight and stops at the edge`() {
        val term = emulator()
        term.write("x\t")
        assertEquals(8, term.snapshot().cursorCol)
        term.write("\t\t\t\t\t\t\t\t\t\t\t")
        val snapshot = term.snapshot()
        assertEquals(79, snapshot.cursorCol)
        assertEquals("x", snapshot.screenRow(0).trimEnd())
    }

    @Test
    fun `UTF-8 supplementary characters occupy one cell and survive the snapshot`() {
        val term = emulator()
        term.write("a𝕏b")
        val snapshot = term.snapshot()
        assertEquals("a𝕏b", snapshot.screenRow(0).trimEnd())
        assertEquals(3, snapshot.cursorCol)
    }

    // ---------------------------------------------------------- movement --

    @Test
    fun `CUP positions absolutely and clamps to the grid`() {
        val term = emulator()
        term.write("\u001B[5;10H")
        assertEquals(4, term.snapshot().cursorLine)
        assertEquals(9, term.snapshot().cursorCol)
        term.write("\u001B[999;999H")
        val clamped = term.snapshot()
        assertEquals(23, clamped.cursorLine)
        assertEquals(79, clamped.cursorCol)
    }

    @Test
    fun `relative cursor movement clamps at the edges`() {
        val term = emulator()
        term.write("\u001B[10A\u001B[10D")
        val snapshot = term.snapshot()
        assertEquals(0, snapshot.cursorLine)
        assertEquals(0, snapshot.cursorCol)
        term.write("\u001B[10B\u001B[10C")
        val moved = term.snapshot()
        assertEquals(10, moved.cursorLine)
        assertEquals(10, moved.cursorCol)
    }

    @Test
    fun `CHA sets the column and VPA sets the row`() {
        val term = emulator()
        term.write("\u001B[30G")
        assertEquals(29, term.snapshot().cursorCol)
        term.write("\u001B[12d")
        assertEquals(11, term.snapshot().cursorLine)
    }

    @Test
    fun `CNL and CPL move a line and home the column`() {
        val term = emulator()
        term.write("\u001B[5;20H\u001B[2E")
        assertEquals(6, term.snapshot().cursorLine)
        assertEquals(0, term.snapshot().cursorCol)
        term.write("\u001B[3F")
        assertEquals(3, term.snapshot().cursorLine)
        assertEquals(0, term.snapshot().cursorCol)
    }

    // ----------------------------------------------------------- erasing --

    @Test
    fun `EL modes erase to end, to start, and whole line`() {
        val toEnd = emulator()
        toEnd.write("0123456789\u001B[5G\u001B[K")
        assertEquals("0123", toEnd.snapshot().screenRow(0).trimEnd())

        val toStart = emulator()
        toStart.write("0123456789\u001B[5G\u001B[1K")
        // Blanks stay in the grid (leading spaces are real cells); only
        // trailing-blank trimming is applied.
        assertEquals("     56789", toStart.snapshot().screenRow(0))

        val whole = emulator()
        whole.write("0123456789\u001B[2K")
        assertEquals("", whole.snapshot().screenRow(0).trimEnd())
    }

    @Test
    fun `ED 0 clears from cursor to end of screen`() {
        val term = emulator(cols = 10, rows = 4)
        term.write("aa\nbb\ncc\ndd\u001B[2;2H\u001B[J")
        val snapshot = term.snapshot()
        assertEquals("aa", snapshot.screenRow(0).trimEnd())
        assertEquals("b", snapshot.screenRow(1).trimEnd())
        assertEquals("", snapshot.screenRow(2).trimEnd())
        assertEquals("", snapshot.screenRow(3).trimEnd())
    }

    @Test
    fun `ED 1 clears from start to cursor inclusive`() {
        val term = emulator(cols = 10, rows = 3)
        term.write("aa\nbb\ncc\u001B[2;2H\u001B[1J")
        val snapshot = term.snapshot()
        assertEquals("", snapshot.screenRow(0).trimEnd())
        assertEquals("", snapshot.screenRow(1).trimEnd())
        assertEquals("cc", snapshot.screenRow(2).trimEnd())
    }

    @Test
    fun `ED 2 clears the screen but keeps scrollback`() {
        val term = emulator(cols = 10, rows = 2)
        term.write("one\ntwo\nthree") // "one" pushed to scrollback
        assertEquals(1, term.snapshot().scrollbackCount)
        term.write("\u001B[2J")
        val snapshot = term.snapshot()
        assertEquals(1, snapshot.scrollbackCount)
        assertEquals("one", snapshot.scrollbackRow(0).trimEnd())
        assertEquals("", snapshot.screenRow(0).trimEnd())
        assertEquals("", snapshot.screenRow(1).trimEnd())
    }

    @Test
    fun `ED 3 clears scrollback only`() {
        val term = emulator(cols = 10, rows = 2)
        term.write("one\ntwo\nthree")
        assertEquals(1, term.snapshot().scrollbackCount)
        term.write("\u001B[3J")
        val snapshot = term.snapshot()
        assertEquals(0, snapshot.scrollbackCount)
        assertEquals("two", snapshot.screenRow(0).trimEnd())
        assertEquals("three", snapshot.screenRow(1).trimEnd())
    }

    @Test
    fun `ECH blanks cells without shifting`() {
        val term = emulator()
        term.write("abcdef\u001B[1;2H\u001B[3X")
        assertEquals("a   ef", term.snapshot().screenRow(0).trimEnd())
    }

    @Test
    fun `DCH deletes cells shifting the tail left`() {
        val term = emulator()
        term.write("abcdef\u001B[1;2H\u001B[2P")
        assertEquals("adef", term.snapshot().screenRow(0).trimEnd())
    }

    @Test
    fun `ICH inserts blanks shifting the tail right`() {
        val term = emulator()
        term.write("abcdef\u001B[1;2H\u001B[2@")
        assertEquals("a  bcdef", term.snapshot().screenRow(0).trimEnd())
    }

    // --------------------------------------------------------- scrolling --

    @Test
    fun `scrolling a full screen pushes the top line into scrollback`() {
        val term = emulator(cols = 10, rows = 3)
        term.write("A\nB\nC\nD")
        val snapshot = term.snapshot()
        assertEquals(1, snapshot.scrollbackCount)
        assertEquals("A", snapshot.scrollbackRow(0).trimEnd())
        assertEquals("B", snapshot.screenRow(0).trimEnd())
        assertEquals("C", snapshot.screenRow(1).trimEnd())
        assertEquals("D", snapshot.screenRow(2).trimEnd())
    }

    @Test
    fun `scroll region scrolling leaves lines outside the region untouched`() {
        val term = emulator(cols = 10, rows = 6)
        term.write("L0\nL1\nL2\nL3\nL4\nL5")
        term.write("\u001B[2;5r") // region rows 1..4 (1-based)
        term.write("\u001B[5;1H") // park on the bottom margin row
        term.write("\n") // scroll region up by one
        val snapshot = term.snapshot()
        assertEquals("L0", snapshot.screenRow(0).trimEnd())
        assertEquals("L2", snapshot.screenRow(1).trimEnd())
        assertEquals("L3", snapshot.screenRow(2).trimEnd())
        assertEquals("L4", snapshot.screenRow(3).trimEnd())
        assertEquals("", snapshot.screenRow(4).trimEnd())
        assertEquals("L5", snapshot.screenRow(5).trimEnd())
        // Partial-region scrolls stay inside the screen: no scrollback growth.
        assertEquals(0, snapshot.scrollbackCount)
    }

    @Test
    fun `DECOM makes CUP relative to the top margin`() {
        val term = emulator(cols = 10, rows = 6)
        term.write("\u001B[3;5r")
        term.write("\u001B[?6h")
        term.write("\u001B[1;1HX")
        val snapshot = term.snapshot()
        assertEquals("X", snapshot.screenRow(2).trimEnd()) // row 3 1-based
        // Row 1 (outside the region, above the top margin) untouched.
        assertEquals("", snapshot.screenRow(0).trimEnd())
    }

    @Test
    fun `IL and DL shift lines inside the region only`() {
        val term = emulator(cols = 10, rows = 5)
        term.write("A\nB\nC\nD\nE")
        term.write("\u001B[1;3r") // region rows 0..2
        term.write("\u001B[2;1H") // row 1, inside region
        term.write("\u001B[1L") // insert blank at row 1, C/D shift down, old row2 gone
        val snapshot = term.snapshot()
        assertEquals("A", snapshot.screenRow(0).trimEnd())
        assertEquals("", snapshot.screenRow(1).trimEnd())
        assertEquals("B", snapshot.screenRow(2).trimEnd())
        assertEquals("D", snapshot.screenRow(3).trimEnd())
        assertEquals("E", snapshot.screenRow(4).trimEnd())
        term.write("\u001B[1M") // delete the blank at row 1: B moves back up
        val afterDelete = term.snapshot()
        assertEquals("B", afterDelete.screenRow(1).trimEnd())
        assertEquals("", afterDelete.screenRow(2).trimEnd())
    }

    @Test
    fun `reverse index at the top margin scrolls the region down`() {
        val term = emulator(cols = 10, rows = 4)
        term.write("A\nB\nC\nD")
        term.write("\u001B[1;1H\u001BM")
        val snapshot = term.snapshot()
        assertEquals("", snapshot.screenRow(0).trimEnd())
        assertEquals("A", snapshot.screenRow(1).trimEnd())
        assertEquals("B", snapshot.screenRow(2).trimEnd())
        assertEquals("C", snapshot.screenRow(3).trimEnd())
    }

    @Test
    fun `scrollback is capped and evicts oldest first`() {
        val term = emulator(cols = 10, rows = 2)
        repeat(1002) { index -> term.write("L$index\n") }
        // 1001 scroll events push L0..L1000; the cap keeps the newest 1000.
        val snapshot = term.snapshot()
        assertEquals(1000, snapshot.scrollbackCount)
        assertEquals("L1", snapshot.scrollbackRow(0).trimEnd())
        assertEquals("L1000", snapshot.scrollbackRow(999).trimEnd())
    }

    // -------------------------------------------------------------- wrap --

    @Test
    fun `autowrap is deferred until the next printable`() {
        val term = emulator(cols = 10, rows = 4)
        term.write("0123456789")
        var snapshot = term.snapshot()
        assertEquals("0123456789", snapshot.screenRow(0).trimEnd())
        assertEquals(9, snapshot.cursorCol) // visually parked on the last column
        assertEquals(0, snapshot.cursorLine)
        term.write("A")
        snapshot = term.snapshot()
        assertEquals("A", snapshot.screenRow(1).trimEnd())
        assertEquals(1, snapshot.cursorCol)
        assertEquals(1, snapshot.cursorLine)
    }

    @Test
    fun `wrapped lines are flagged for reflow`() {
        val term = emulator(cols = 10, rows = 4)
        term.write("0123456789ABC")
        val snapshot = term.snapshot()
        assertFalse(snapshot.lines[snapshot.scrollbackCount].isWrapped)
        assertTrue(snapshot.lines[snapshot.scrollbackCount + 1].isWrapped)
    }

    @Test
    fun `disabling autowrap overwrites the last column`() {
        val term = emulator(cols = 10, rows = 4)
        term.write("\u001B[?7l")
        term.write("0123456789XYZ")
        val snapshot = term.snapshot()
        // No wrap ever fires; every char past the edge overwrites column 9.
        assertEquals("012345678Z", snapshot.screenRow(0).trimEnd())
        assertEquals("", snapshot.screenRow(1).trimEnd())
    }

    // -------------------------------------------------------------- SGR --

    @Test
    fun `SGR basic attributes and colors apply to subsequent cells`() {
        val term = emulator()
        term.write("plain\u001B[1;31mboldred\u001B[0mplain")
        val runs = term.snapshot().lines[0].runs
        assertEquals("plain", runs[0].text)
        assertFalse(runs[0].style.bold)
        assertEquals("boldred", runs[1].text)
        assertTrue(runs[1].style.bold)
        assertEquals(TerminalColor.Indexed(1), runs[1].style.foreground)
        assertEquals("plain", runs[2].text)
        assertFalse(runs[2].style.bold)
        assertEquals(TerminalColor.Default, runs[2].style.foreground)
    }

    @Test
    fun `SGR 256-color indexes parse for foreground and background`() {
        val term = emulator()
        term.write("\u001B[38;5;208;48;5;17mX")
        // runs[0] is the text run; a blank cursor run trails on the cursor line.
        val run = term.snapshot().lines[0].runs.first()
        assertEquals("X", run.text)
        assertEquals(TerminalColor.Indexed(208), run.style.foreground)
        assertEquals(TerminalColor.Indexed(17), run.style.background)
    }

    @Test
    fun `SGR truecolor parses with semicolons and colons`() {
        val term = emulator()
        term.write("\u001B[38;2;10;20;30mA\u001B[38:2:1:2:3mB")
        val runs = term.snapshot().lines[0].runs
        assertEquals(TerminalColor.Rgb(0x0A141E), runs[0].style.foreground)
        assertEquals(TerminalColor.Rgb(0x010203), runs[1].style.foreground)
    }

    @Test
    fun `SGR bright aliases and single resets work`() {
        val term = emulator()
        term.write("\u001B[1;91;4;9mX\u001B[22;24;29mY")
        val runs = term.snapshot().lines[0].runs
        assertTrue(runs[0].style.bold)
        assertEquals(TerminalColor.Indexed(9), runs[0].style.foreground)
        assertTrue(runs[0].style.underline)
        assertTrue(runs[0].style.strikethrough)
        assertFalse(runs[1].style.bold)
        assertFalse(runs[1].style.underline)
        assertFalse(runs[1].style.strikethrough)
    }

    @Test
    fun `SGR inverse is a flag not a color swap`() {
        val term = emulator()
        term.write("\u001B[7;31;44mX")
        val run = term.snapshot().lines[0].runs.first()
        assertEquals("X", run.text)
        assertTrue(run.style.inverse)
        assertEquals(TerminalColor.Indexed(1), run.style.foreground)
        assertEquals(TerminalColor.Indexed(4), run.style.background)
    }

    // ---------------------------------------------------------- alt screen --

    @Test
    fun `alt screen 1049 saves and restores the main screen`() {
        val term = emulator(cols = 20, rows = 4)
        term.write("main-content")
        term.write("\u001B[?1049h")
        term.write("ALT SCREEN")
        val altSnapshot = term.snapshot()
        assertEquals("ALT SCREEN", altSnapshot.screenRow(0).trimEnd())
        term.write("\u001B[?1049l")
        val restored = term.snapshot()
        assertEquals("main-content", restored.screenRow(0).trimEnd())
        assertEquals("main-content".length, restored.cursorCol)
        assertEquals(0, restored.cursorLine)
    }

    @Test
    fun `alt screen scrolling never grows scrollback`() {
        val term = emulator(cols = 10, rows = 3)
        term.write("\u001B[?1049h")
        term.write("a\nb\nc\nd\ne\nf\ng")
        assertEquals(0, term.snapshot().scrollbackCount)
    }

    // ------------------------------------------------------------ resize --

    @Test
    fun `resize rewraps continuation lines into one logical line`() {
        val term = emulator(cols = 10, rows = 5)
        term.write("0123456789ABC") // wraps: 10 + 3
        term.resize(20, 5)
        val snapshot = term.snapshot()
        assertEquals("0123456789ABC", snapshot.screenRow(0).trimEnd())
        assertEquals("", snapshot.screenRow(1).trimEnd())
        assertFalse(snapshot.lines[snapshot.scrollbackCount].isWrapped)
    }

    @Test
    fun `resize narrower splits lines and flags continuation`() {
        val term = emulator(cols = 10, rows = 5)
        term.write("0123456789ABC")
        term.resize(4, 5)
        // Rewrap gives 4 text lines + the 3 blank screen rows = 7 total; the
        // screen keeps the last 5, overflow lands in scrollback.
        val snapshot = term.snapshot()
        assertEquals(2, snapshot.scrollbackCount)
        assertEquals("0123", snapshot.scrollbackRow(0).trimEnd())
        assertEquals("4567", snapshot.scrollbackRow(1).trimEnd())
        assertEquals("89AB", snapshot.screenRow(0).trimEnd())
        assertEquals("C", snapshot.screenRow(1).trimEnd())
        assertTrue(snapshot.lines[snapshot.scrollbackCount + 1].isWrapped)
    }

    @Test
    fun `resize shorter pushes whole lines into scrollback`() {
        val term = emulator(cols = 10, rows = 5)
        term.write("1\n2\n3\n4\n5")
        term.resize(10, 3)
        val snapshot = term.snapshot()
        assertEquals(2, snapshot.scrollbackCount)
        assertEquals("1", snapshot.scrollbackRow(0).trimEnd())
        assertEquals("2", snapshot.scrollbackRow(1).trimEnd())
        assertEquals("3", snapshot.screenRow(0).trimEnd())
        assertEquals("5", snapshot.screenRow(2).trimEnd())
        assertEquals(3, snapshot.rows)
    }

    @Test
    fun `resize keeps the cursor on the same logical line`() {
        val term = emulator(cols = 10, rows = 5)
        term.write("0123456789ABCDEF") // cursor on wrapped row 1, col 6
        assertEquals(1, term.snapshot().cursorLine)
        term.resize(20, 5)
        val snapshot = term.snapshot()
        assertEquals("0123456789ABCDEF", snapshot.screenRow(0).trimEnd())
        assertEquals(0, snapshot.cursorLine)
        assertEquals(6, snapshot.cursorCol)
    }

    @Test
    fun `resize while on the alt screen keeps geometry consistent after exit`() {
        val term = emulator(cols = 10, rows = 5)
        term.write("hello")
        term.write("\u001B[?1049h")
        term.write("alt")
        term.resize(12, 3)
        term.write("\u001B[?1049l")
        val snapshot = term.snapshot()
        assertEquals(3, snapshot.rows)
        assertEquals(12, snapshot.cols)
        assertEquals("hello", snapshot.screenRow(0).trimEnd())
    }

    @Test
    fun `resize on the main screen keeps the alt buffer in sync for a later alt entry`() {
        // Regression: reflowMainLocked resized only the main buffer, so
        // growing rows on the main screen left the alt deque at the old count
        // — entering the alt screen then indexed past it.
        val term = emulator(cols = 10, rows = 5)
        term.resize(10, 8)
        term.write("\u001B[?1049h")
        term.write("alt-line")
        val snapshot = term.snapshot()
        assertEquals(8, snapshot.rows)
        assertEquals(0, snapshot.scrollbackCount)
        assertEquals("alt-line", snapshot.screenRow(0).trimEnd())
    }

    @Test
    fun `alt screen resize keeps content clamped to the new width`() {
        val term = emulator(cols = 10, rows = 5)
        term.write("\u001B[?1049h")
        term.write("0123456789")
        term.resize(4, 5)
        val snapshot = term.snapshot()
        assertEquals("0123", snapshot.screenRow(0).trimEnd())
        // Cursor column clamped into the narrower grid; the next write lands
        // inside it (wrapPending was reset by the resize).
        term.write("X")
        assertEquals("012X", term.snapshot().screenRow(0).trimEnd())
    }

    @Test
    fun `alt screen resize taller pads rows and keeps the cursor on its row`() {
        val term = emulator(cols = 10, rows = 5)
        term.write("\u001B[?1049h")
        term.write("a\nb\nc\nd\ne") // cursor lands on row 4
        assertEquals(4, term.snapshot().cursorLine)
        term.resize(10, 8)
        val snapshot = term.snapshot()
        assertEquals(8, snapshot.rows)
        assertEquals("a", snapshot.screenRow(0).trimEnd())
        assertEquals("e", snapshot.screenRow(4).trimEnd())
        assertEquals("", snapshot.screenRow(7).trimEnd())
        assertEquals(4, snapshot.cursorLine)
    }

    @Test
    fun `alt screen resize with margins keeps them inside the new geometry`() {
        val term = emulator(cols = 10, rows = 8)
        term.write("\u001B[?1049h")
        // DECSTBM 2..6 while 8 rows tall, then shrink to 4: margins must
        // re-clamp instead of pointing past the screen.
        term.write("\u001B[2;6r")
        term.write("\u001B[2;3H") // cursor to row 2 col 3 (1-based), inside the region
        term.resize(10, 4)
        term.write("z")
        val snapshot = term.snapshot()
        assertEquals(4, snapshot.rows)
        // Row 2 (1-based) is still writable after the shrink: no crash, and
        // the cursor was not pushed outside the re-clamped margins ("z" at
        // col 3, after the two blanks CUP skipped over).
        assertEquals("z", snapshot.screenRow(1).trim())
    }

    // ------------------------------------------------- parsing robustness --

    @Test
    fun `sequences split across write chunks reassemble`() {
        val term = emulator()
        term.write("text\u001B[3")
        // The parameter list itself is split across the chunk boundary.
        term.write(";31mred")
        val runs = term.snapshot().lines[0].runs
        assertEquals("text", runs[0].text)
        assertEquals("red", runs[1].text)
        assertTrue(runs[1].style.italic)
        assertEquals(TerminalColor.Indexed(1), runs[1].style.foreground)
    }

    @Test
    fun `OSC titles and DCS strings never reach the grid`() {
        val term = emulator()
        term.write("\u001B]0;window title\u0007")
        term.write("\u001B]2;other title\u001B\\")
        term.write("\u001BP1;2;qignored-payload\u001B\\")
        term.write("end")
        val snapshot = term.snapshot()
        assertEquals("end", snapshot.screenRow(0).trimEnd())
        assertEquals(3, snapshot.cursorCol)
    }

    @Test
    fun `unknown sequences are counted and ignored`() {
        val term = emulator()
        val before = term.unknownSequenceCount
        term.write("\u001B[6n") // DSR: report cursor — unsupported, no reply channel
        term.write("\u001B[?9001h") // unrecognized private mode
        term.write("\u001B[0c") // DA
        term.write("ok")
        assertEquals(before + 3, term.unknownSequenceCount)
        assertEquals("ok", term.snapshot().screenRow(0).trimEnd())
    }

    @Test
    fun `huge and malformed parameter streams stay bounded`() {
        val term = emulator()
        term.write("\u001B[" + "9".repeat(40) + "A")
        term.write("\u001B[" + ";".repeat(500) + "m")
        term.write("still alive")
        assertEquals("still alive", term.snapshot().screenRow(0).trimEnd())
    }

    @Test
    fun `mouse and bracketed paste modes are consumed silently`() {
        val term = emulator()
        val before = term.unknownSequenceCount
        term.write("\u001B[?1000h\u001B[?1002h\u001B[?1006h\u001B[?2004h")
        term.write("\u001B[?2004l\u001B[?1000l")
        assertEquals(before, term.unknownSequenceCount)
    }

    // ------------------------------------------------------ misc controls --

    @Test
    fun `DECSC and DECRC restore position and style per screen`() {
        val term = emulator()
        term.write("abc\u001B7")
        term.write("XXXX\u001B[2;1H")
        term.write("\u001B8")
        val snapshot = term.snapshot()
        assertEquals("abcXXXX", snapshot.screenRow(0).trimEnd())
        assertEquals(3, snapshot.cursorCol)
    }

    @Test
    fun `DECALN fills the screen with E`() {
        val term = emulator(cols = 5, rows = 3)
        term.write("\u001B#8")
        val snapshot = term.snapshot()
        for (row in 0 until 3) {
            assertEquals("EEEEE", snapshot.screenRow(row).trimEnd())
        }
    }

    @Test
    fun `RIS clears everything`() {
        val term = emulator(cols = 10, rows = 3)
        term.write("one\ntwo\nthree\u001B[31m")
        term.write("\u001Bc")
        val snapshot = term.snapshot()
        assertEquals(0, snapshot.scrollbackCount)
        assertEquals("", snapshot.screenRow(0).trimEnd())
        term.write("x")
        val run = term.snapshot().lines[0].runs.first()
        assertEquals("x", run.text)
        assertEquals(TerminalColor.Default, run.style.foreground)
    }

    @Test
    fun `reset clears content for reconnect replay`() {
        val term = emulator(cols = 10, rows = 3)
        term.write("old\ndata\u001B[31m")
        term.reset()
        val snapshot = term.snapshot()
        assertEquals(0, snapshot.scrollbackCount)
        assertEquals("", snapshot.screenRow(0).trimEnd())
        assertEquals(0, snapshot.cursorLine)
        assertEquals(0, snapshot.cursorCol)
    }

    // ---------------------------------------------------------- snapshot --

    @Test
    fun `snapshot flags exactly one cursor run on the cursor cell`() {
        val term = emulator()
        term.write("hello")
        var snapshot = term.snapshot()
        // Cursor past the last written cell: blank flagged run appended.
        assertEquals(1, snapshot.cursorRuns().size)
        assertEquals(" ", snapshot.cursorRuns().single().text)

        term.write("\u001B[4G") // park on the second "l"
        snapshot = term.snapshot()
        val cursorRun = snapshot.cursorRuns().single()
        assertEquals("l", cursorRun.text)
        assertEquals("hel", snapshot.lines[0].runs[0].text)
        // The cursor cell's char lives in the cursor run; the following run
        // continues from the NEXT cell.
        assertEquals("o", snapshot.lines[0].runs.last().text)
    }

    @Test
    fun `cursor visibility follows DEC private mode 25`() {
        val term = emulator()
        assertTrue(term.snapshot().cursorVisible)
        term.write("\u001B[?25l")
        assertFalse(term.snapshot().cursorVisible)
        term.write("\u001B[?25h")
        assertTrue(term.snapshot().cursorVisible)
    }

    @Test
    fun `revision advances on every mutation`() {
        val term = emulator()
        val first = term.revision
        term.write("a")
        val second = term.revision
        term.resize(100, 30)
        val third = term.revision
        term.reset()
        assertNotEquals(first, second)
        assertNotEquals(second, third)
    }
}

/** Palette golden values (xterm defaults — parity anchors for the renderer). */
class TerminalPaletteTest {

    @Test
    fun `classic sixteen colors match xterm defaults`() {
        assertEquals(0x000000, TerminalPalette.BASIC[0])
        assertEquals(0x800000, TerminalPalette.BASIC[1])
        assertEquals(0xC0C0C0, TerminalPalette.BASIC[7])
        assertEquals(0xFF0000, TerminalPalette.BASIC[9])
        assertEquals(0xFFFFFF, TerminalPalette.BASIC[15])
    }

    @Test
    fun `color cube and grayscale ramp match xterm table`() {
        assertEquals(0x000000, TerminalPalette.COLORS_256[16])
        // Cube: 16 + r*36 + g*6 + b with levels 0/95/135/175/215/255.
        assertEquals(0x0000FF, TerminalPalette.COLORS_256[16 + 5])
        assertEquals(0xFF0000, TerminalPalette.COLORS_256[16 + 5 * 36])
        assertEquals(0xFFFFFF, TerminalPalette.COLORS_256[16 + 5 * 36 + 5 * 6 + 5])
        // Grayscale ramp starts at 8 and steps by 10.
        assertEquals(0x080808, TerminalPalette.COLORS_256[232])
        assertEquals(0xEEEEEE, TerminalPalette.COLORS_256[255])
    }

    @Test
    fun `bold promotes indexed 0-7 to the bright slot`() {
        assertEquals(TerminalPalette.COLORS_256[9], TerminalPalette.resolveIndexed(1, bold = true))
        assertEquals(TerminalPalette.COLORS_256[1], TerminalPalette.resolveIndexed(1, bold = false))
        // Bright colors and out-of-range indexes pass through unchanged/clamped.
        assertEquals(TerminalPalette.COLORS_256[12], TerminalPalette.resolveIndexed(12, bold = true))
        assertEquals(TerminalPalette.COLORS_256[0], TerminalPalette.resolveIndexed(-4, bold = false))
        assertEquals(TerminalPalette.COLORS_256[255], TerminalPalette.resolveIndexed(999, bold = true))
    }
}
