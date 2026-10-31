package app.hapi.companion.feature.terminal

/**
 * One grid line of cells. Ragged-right: only cells the stream actually wrote
 * exist; anything past [cells] is a blank with the line's implicit default
 * style. [isWrapped] marks a continuation line (the previous line overflowed
 * into this one) — the same flag xterm exposes as `buffer.active.getLine(i).isWrapped`.
 */
class TerminalLine(
    cells: MutableList<TerminalCell> = ArrayList(),
    var isWrapped: Boolean = false,
) {
    var cells: MutableList<TerminalCell> = cells
        private set

    val cellCount: Int get() = cells.size

    fun cellAt(index: Int): TerminalCell? = cells.getOrNull(index)

    fun setCell(index: Int, cell: TerminalCell) {
        while (cells.size <= index) cells.add(TerminalCell.BLANK)
        cells[index] = cell
    }

    fun clearRange(fromIndex: Int, toIndexExclusive: Int) {
        if (fromIndex >= cells.size || toIndexExclusive <= 0) return
        val from = fromIndex.coerceAtLeast(0)
        val to = toIndexExclusive.coerceAtMost(cells.size)
        for (i in from until to) cells[i] = TerminalCell.BLANK
    }

    /** Cells from [fromIndex] onward are removed (line gets shorter). */
    fun truncateFrom(fromIndex: Int) {
        if (fromIndex <= 0) {
            cells.clear()
            return
        }
        while (cells.size > fromIndex) cells.removeAt(cells.size - 1)
    }

    /** Blank-run trim: xterm erases leave trailing blanks; we drop them to keep lines compact. */
    fun trimTrailingBlanks() {
        while (cells.isNotEmpty() && cells.last() == TerminalCell.BLANK) cells.removeAt(cells.size - 1)
    }

    fun clear() {
        cells.clear()
        isWrapped = false
    }

    fun copy(): TerminalLine = TerminalLine(ArrayList(cells), isWrapped)
}

/** One styled character cell; [codePoint] is a single Unicode code point. */
data class TerminalCell(
    val codePoint: Int,
    val style: TerminalStyle,
) {
    companion object {
        /** Blank filler (space, default style) — a shared immutable instance. */
        val BLANK = TerminalCell(' '.code, TerminalStyle())
    }
}

/**
 * Fixed-height line store with a scrollback ring, shared by the main and
 * alternate screens. Pure storage: scrolling (and its margin rules) lives in
 * [TerminalEmulator], which inserts/removes rows directly through [screen] —
 * only lines pushed off the top of the full screen belong in [scrollback],
 * and the alternate screen never scrolls back (xterm semantics).
 *
 * Invariants: [screen] always holds exactly [rows] lines (padded with blank
 * lines).
 */
class TerminalBuffer(val isAlternate: Boolean, rows: Int) {
    var rows: Int = rows
        private set
    val screen: ArrayDeque<TerminalLine> = ArrayDeque(rows)
    val scrollback: ArrayDeque<TerminalLine> = ArrayDeque()

    /** Scrollback line cap (xterm default `scrollback: 1000`; the web client leaves it default). */
    var scrollbackLimit: Int = 1000

    init {
        repeat(rows) { screen.addLast(TerminalLine()) }
    }

    /** Number of scrollback lines actually held (<= [scrollbackLimit]). */
    val scrollbackCount: Int get() = scrollback.size

    fun lineAt(screenRow: Int): TerminalLine = screen[screenRow]

    /** Resize without reflow: pad/truncate every line to [cols] is NOT done here — lines are ragged by design. */
    fun setRows(newRows: Int) {
        while (screen.size < newRows) screen.addLast(TerminalLine())
        while (screen.size > newRows) screen.removeLast()
        rows = newRows
    }

    /** All logical content in order (scrollback + screen), for reflow and snapshots. */
    fun allLines(): List<TerminalLine> = ArrayList<TerminalLine>(scrollback.size + screen.size).apply {
        addAll(scrollback)
        addAll(screen)
    }
}
