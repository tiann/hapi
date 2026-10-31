package app.hapi.companion.feature.terminal

/**
 * Pure-Kotlin VT/ANSI terminal emulator: a cell-grid state machine that
 * consumes the PTY byte stream (as decoded UTF-8 text) and exposes a render
 * snapshot. This is the Android stand-in for xterm.js on the web terminal
 * route (`web/src/routes/sessions/terminal.tsx` + `TerminalView`).
 *
 * Supported surface (cut to what this link actually carries — the runner sets
 * `TERM=xterm-256color`, `COLORTERM=truecolor`, and real shells/TUIs run
 * behind it; see the slice's `xtermSurface` survey):
 * - UTF-8 printables (already decoded by the transport), BS/HT/CR/LF/VT/FF, BEL;
 * - CSI: CUU/CUD/CUF/CUB/CHA/CUP/VPA/HPA, ED/EL/ECH, ICH/DCH, IL/DL, SU/SD,
 *   SGR (bold/faint/italic/underline/strike/blink/inverse/invisible,
 *   8/16/256/truecolor fg+bg, defaults), DECSTBM scroll regions, DECOM,
 *   DECSC/DECRC (+ CSI s/u aliases);
 * - ESC: 7/8 save/restore, c full reset (RIS), #8 DECALN, charset/k keypad
 *   designations safely consumed;
 * - DEC private modes: 1049/47/1047 alt screen, 25 cursor visibility,
 *   7 autowrap, 6 origin mode; mouse-reporting and bracketed-paste modes are
 *   consumed (counted) but not acted on;
 * - OSC (title/hyperlink) and DCS/SOS/PM/APC strings consumed to their terminators.
 *
 * Known non-goals vs xterm.js (declared slice deviations): no character-set
 * translation (all text passes through as-is), every code point occupies one
 * cell (no double-width CJK grid accounting), no sixel, no mouse reporting.
 *
 * Differences from the web client's xterm options, both deliberate:
 * - `convertEol: true` is baked in: bare LF also returns the cursor to column 0
 *   (the PTY stream under a shell mixes bare LFs; xterm+convertEol treats them
 *   as CRLF, so parity requires the same here).
 * - The parser state machine persists across [write] calls, so a sequence
 *   split at an arbitrary chunk boundary (hub buffer replay!) reassembles
 *   correctly; a replay may even start mid-sequence, which lands in
 * [unknownSequenceCount] instead of corrupting the grid.
 *
 * Thread model: mutation happens on the owning ViewModel's scope; [snapshot]
 * is synchronized on the same lock so the UI thread reads a consistent grid.
 */
class TerminalEmulator(
    initialCols: Int = DEFAULT_COLS,
    initialRows: Int = DEFAULT_ROWS,
) {
    private val lock = Any()

    var cols: Int = initialCols.coerceAtLeast(MIN_COLS)
        private set
    var rows: Int = initialRows.coerceAtLeast(MIN_ROWS)
        private set

    /** Monotonic counter the render layer observes to rebuild snapshots. */
    val revision: Long get() = synchronized(lock) { revisionField }
    private var revisionField: Long = 0

    /** Escape sequences consumed but not implemented (diagnostics only, never fatal). */
    val unknownSequenceCount: Int get() = synchronized(lock) { unknownSequenceCountField }
    private var unknownSequenceCountField: Int = 0

    // ------------------------------------------------------------- state --
    private var cursorX = 0
    private var cursorY = 0
    private var currentStyle = TerminalStyle()

    /** Deferred autowrap: printed at the last column, the wrap happens on the NEXT printable. */
    private var wrapPending = false

    private var topMargin = 0
    private var bottomMargin = this.rows - 1 // inclusive, screen row index

    private var originMode = false
    private var autowrap = true
    private var cursorVisible = true

    private val mainBuffer = TerminalBuffer(isAlternate = false, rows = this.rows)
    private val altBuffer = TerminalBuffer(isAlternate = true, rows = this.rows)
    private var activeBuffer: TerminalBuffer = mainBuffer
    private var altScreenActive = false

    /** DECSC/DECRC slots, one per screen (xterm saves per buffer). */
    private var savedMain = SavedState()
    private var savedAlt = SavedState()

    // Tab stops: uniform every 8 columns is the xterm default; per-column
    // TBC/HTS sets are rare behind shells — counted as unknown if requested.
    private val tabStop = 8

    private var parserState = ParserState.GROUND
    private val csiParams = ArrayList<Int>(8)
    private var csiPrivate = false
    private var csiIntermediate = ' '
    private val oscBuffer = StringBuilder()

    // --------------------------------------------------------------- API --

    /** Feed one chunk of PTY output (UTF-8 text, possibly mid-sequence). */
    fun write(data: String) {
        if (data.isEmpty()) return
        synchronized(lock) {
            var index = 0
            while (index < data.length) {
                val codePoint = data.codePointAt(index)
                index += Character.charCount(codePoint)
                feed(codePoint)
            }
            revisionField++
        }
    }

    /**
     * Full local reset for reconnect replay: clears screen, scrollback, styles
     * and margins (the hub replays its whole ≤256 KB buffer after a socket
     * reconnect; appending to live content would double the scrollback, which
     * is a known web quirk we deliberately do not replicate — clear-then-replay).
     */
    fun reset() {
        synchronized(lock) {
            hardResetLocked()
            revisionField++
        }
    }

    /**
     * Resize with line-preserving reflow of the main buffer: wrapped lines are
     * un-joined (via their [TerminalLine.isWrapped] flags) and re-wrapped at
     * the new width, exactly like xterm.js's reflow. Both buffers always end
     * up at the new geometry — whichever screen is active — because entering
     * the alt screen later iterates `0 until rows` over it. On the alternate
     * screen there is no scrollback and no rewrap (xterm semantics): content
     * is kept, clamped to the new width. The cursor stays on its row, clamped
     * to the (re-clamped) margins (xterm additionally preserves the column
     * offset; that nuance is skipped — a resize is rare and the next output
     * repaints interactive TUIs anyway).
     */
    fun resize(newCols: Int, newRows: Int) {
        val safeCols = newCols.coerceIn(MIN_COLS, MAX_COLS)
        val safeRows = newRows.coerceIn(MIN_ROWS, MAX_ROWS)
        synchronized(lock) {
            if (safeCols == cols && safeRows == rows) return
            if (altScreenActive) {
                resizeAltLocked(safeCols, safeRows)
            } else {
                reflowMainLocked(safeCols, safeRows)
                // No reflow of main content the user cannot see, but the alt
                // buffer's row count must follow: a later 1049 enters it with
                // `0 until rows` and would run past a stale deque.
                altBuffer.setRows(safeRows)
            }
            clampMarginsLocked()
            cursorX = cursorX.coerceIn(0, cols - 1)
            cursorY = cursorY.coerceIn(topMargin, bottomMargin)
            wrapPending = false
            revisionField++
        }
    }

    /**
     * Alt-screen resize: keep the painted content (a TUI repaints after
     * SIGWINCH, but blanking first loses less-frequent full redraws), clamp
     * every line to the new width, drop continuation flags, pad/trim rows at
     * the bottom. The main buffer follows without reflow.
     */
    private fun resizeAltLocked(newCols: Int, newRows: Int) {
        cols = newCols
        rows = newRows
        altBuffer.screen.forEach { line ->
            if (line.cellCount > newCols) line.truncateFrom(newCols)
            line.isWrapped = false
        }
        altBuffer.setRows(newRows)
        mainBuffer.setRows(newRows)
    }

    /**
     * Immutable render snapshot: scrollback + screen lines as style runs, with
     * the cursor run flagged. Line `i` is scrollback for
     * `i < scrollbackCount`, otherwise screen row `i - scrollbackCount`.
     */
    fun snapshot(): TerminalSnapshot = synchronized(lock) { buildSnapshotLocked() }

    // ----------------------------------------------------------- parsing --

    private enum class ParserState {
        GROUND,
        ESCAPE,
        ESCAPE_INTERMEDIATE,
        CSI_ENTRY,
        CSI_PARAM,
        CSI_INTERMEDIATE,
        CSI_IGNORE,
        OSC_STRING,
        OSC_ESCAPE,
        STRING_IGNORE,
        STRING_IGNORE_ESCAPE,
    }

    private fun feed(codePoint: Int) {
        when (parserState) {
            ParserState.GROUND -> feedGround(codePoint)
            ParserState.ESCAPE -> feedEscape(codePoint)
            ParserState.ESCAPE_INTERMEDIATE -> feedEscapeIntermediate(codePoint)
            ParserState.CSI_ENTRY, ParserState.CSI_PARAM, ParserState.CSI_INTERMEDIATE ->
                feedCsi(codePoint)
            ParserState.CSI_IGNORE -> if (isCsiTerminator(codePoint)) parserState = ParserState.GROUND
            ParserState.OSC_STRING -> feedOsc(codePoint)
            ParserState.OSC_ESCAPE -> {
                // ESC after OSC: only ESC \ (ST) terminates; anything else is
                // malformed — treat as new escape (defensive).
                parserState = ParserState.GROUND
                if (codePoint != '\\'.code) unknownSequenceCountField++
                if (codePoint == ESC) parserState = ParserState.ESCAPE
            }
            ParserState.STRING_IGNORE -> if (codePoint == ESC) parserState = ParserState.STRING_IGNORE_ESCAPE
            ParserState.STRING_IGNORE_ESCAPE -> {
                parserState = ParserState.GROUND
                if (codePoint == '\\'.code) return
                if (codePoint == ESC) parserState = ParserState.STRING_IGNORE_ESCAPE else unknownSequenceCountField++
            }
        }
    }

    private fun feedGround(codePoint: Int) {
        when {
            codePoint == ESC -> parserState = ParserState.ESCAPE
            codePoint < 32 || codePoint == 127 -> executeControl(codePoint)
            else -> printCodePoint(codePoint)
        }
    }

    private fun executeControl(codePoint: Int) {
        when (codePoint) {
            7 -> Unit // BEL: no audio hook here; the screen layer may add one.
            8 -> { // BS
                if (cursorX > 0) cursorX--
                wrapPending = false
            }
            9 -> { // HT to next tab stop
                val next = ((cursorX / tabStop) + 1) * tabStop
                cursorX = if (next >= cols) cols - 1 else next
                wrapPending = false
            }
            10, 11, 12 -> lineFeedLocked() // LF/VT/FF — see convertEol note above
            13 -> { // CR
                cursorX = 0
                wrapPending = false
            }
            24, 26 -> parserState = ParserState.GROUND // CAN/SUB abort
            else -> Unit // NUL etc.: ignored
        }
    }

    private fun printCodePoint(codePoint: Int) {
        if (wrapPending) {
            wrapPending = false
            cursorX = 0
            advanceLineLocked(wrap = true)
        }
        if (cursorX >= cols) {
            if (autowrap) {
                cursorX = 0
                advanceLineLocked(wrap = true)
            } else {
                cursorX = cols - 1
            }
        }
        activeBuffer.lineAt(cursorY).setCell(cursorX, TerminalCell(codePoint, currentStyle))
        cursorX++
        if (cursorX >= cols && autowrap) {
            wrapPending = true
            cursorX = cols - 1 // xterm leaves the cursor visually at the last column until the wrap fires
        }
    }

    /** Line feed with scroll-region handling (LF also homes the column — convertEol). */
    private fun lineFeedLocked() {
        cursorX = 0
        advanceLineLocked(wrap = false)
    }

    private fun advanceLineLocked(wrap: Boolean) {
        if (cursorY == bottomMargin) {
            scrollRegionUpLocked(1)
        } else if (cursorY >= rows - 1) {
            cursorY = rows - 1
        } else {
            cursorY++
        }
        if (wrap) activeBuffer.lineAt(cursorY).isWrapped = true
        wrapPending = false
    }

    /**
     * Scroll the margin region up by [count], leaving lines above topMargin and
     * below bottomMargin untouched. Only lines pushed off the top of the SCREEN
     * (topMargin == 0) enter scrollback — xterm.js keeps partial-region scrolls
     * inside the screen — and never on the alternate screen.
     */
    private fun scrollRegionUpLocked(count: Int) {
        val n = count.coerceIn(0, bottomMargin - topMargin + 1)
        repeat(n) {
            val pushedOff = activeBuffer.screen.removeAt(topMargin)
            if (!activeBuffer.isAlternate && topMargin == 0) {
                if (activeBuffer.scrollback.size >= activeBuffer.scrollbackLimit) {
                    activeBuffer.scrollback.removeFirst()
                }
                activeBuffer.scrollback.addLast(pushedOff)
            }
            activeBuffer.screen.add(bottomMargin, TerminalLine())
        }
    }

    private fun scrollRegionDownLocked(count: Int) {
        val n = count.coerceIn(0, bottomMargin - topMargin + 1)
        repeat(n) {
            activeBuffer.screen.removeAt(bottomMargin)
            activeBuffer.screen.add(topMargin, TerminalLine())
        }
    }

    // ------------------------------------------------------------ escape --

    private fun feedEscape(codePoint: Int) {
        parserState = ParserState.GROUND
        when {
            codePoint == '['.code -> {
                parserState = ParserState.CSI_ENTRY
                csiParams.clear()
                csiPrivate = false
                csiIntermediate = ' '
            }
            codePoint == ']'.code -> {
                parserState = ParserState.OSC_STRING
                oscBuffer.setLength(0)
            }
            codePoint == 'P'.code || codePoint == 'X'.code || codePoint == '^'.code || codePoint == '_'.code ->
                parserState = ParserState.STRING_IGNORE // DCS/SOS/PM/APC: consume to ST
            codePoint == '7'.code -> saveCursorLocked()
            codePoint == '8'.code -> restoreCursorLocked()
            codePoint == 'c'.code -> hardResetLocked()
            codePoint == '='.code || codePoint == '>'.code -> Unit // keypad modes: ignored
            codePoint == 'M'.code -> reverseLineFeedLocked() // RI
            codePoint == 'E'.code -> lineFeedLocked() // NEL
            codePoint in 0x20..0x2F -> { // intermediate (charset selection "#(", "(", "+" …)
                parserState = ParserState.ESCAPE_INTERMEDIATE
                csiIntermediate = codePoint.toChar()
            }
            codePoint == ESC -> parserState = ParserState.ESCAPE
            else -> unknownSequenceCountField++
        }
    }

    private fun feedEscapeIntermediate(codePoint: Int) {
        parserState = ParserState.GROUND
        when {
            codePoint == '8'.code && csiIntermediate == '#' -> decalnLocked()
            codePoint == ESC -> parserState = ParserState.ESCAPE
            else -> Unit // charset designations etc.: safely consumed
        }
    }

    private fun reverseLineFeedLocked() {
        if (cursorY == topMargin) {
            scrollRegionDownLocked(1)
        } else if (cursorY > 0) {
            cursorY--
        }
    }

    private fun decalnLocked() {
        val cell = TerminalCell('E'.code, TerminalStyle())
        for (row in 0 until rows) {
            val line = activeBuffer.lineAt(row)
            line.isWrapped = false
            for (col in 0 until cols) line.setCell(col, cell)
        }
    }

    // ---------------------------------------------------------------- CSI --

    private fun feedCsi(codePoint: Int) {
        when {
            parserState == ParserState.CSI_ENTRY && codePoint == '?'.code -> {
                csiPrivate = true
                parserState = ParserState.CSI_PARAM
            }
            parserState == ParserState.CSI_ENTRY && codePoint == '>'.code -> {
                csiPrivate = false // CSI > … secondary: parsed then ignored per-command
                parserState = ParserState.CSI_PARAM
            }
            parserState == ParserState.CSI_ENTRY && codePoint in 0x30..0x39 -> {
                csiParams.clear()
                csiParams.add(codePoint - '0'.code)
                parserState = ParserState.CSI_PARAM
            }
            parserState == ParserState.CSI_ENTRY && codePoint == ';'.code -> {
                csiParams.clear()
                csiParams.add(0)
                csiParams.add(0)
                parserState = ParserState.CSI_PARAM
            }
            parserState == ParserState.CSI_PARAM && codePoint in 0x30..0x39 -> {
                if (csiParams.isEmpty()) csiParams.add(0)
                val last = csiParams.size - 1
                // Cap guards against hostile streams: 20+ digit params would
                // overflow Int; nothing real emits params > 65535.
                csiParams[last] = (csiParams[last] * 10 + (codePoint - '0'.code)).coerceAtMost(MAX_PARAM_VALUE)
            }
            parserState == ParserState.CSI_PARAM && (codePoint == ';'.code || codePoint == ':'.code) -> {
                // ':' sub-params flattened to ';' (SGR 38:2:… form); count cap
                // bounds memory on junk streams.
                if (csiParams.size < MAX_CSI_PARAMS) csiParams.add(0)
            }
            codePoint in 0x20..0x2F && parserState != ParserState.CSI_IGNORE -> {
                csiIntermediate = codePoint.toChar()
                parserState = ParserState.CSI_INTERMEDIATE
            }
            codePoint in 0x40..0x7E -> {
                if (parserState == ParserState.CSI_IGNORE) {
                    parserState = ParserState.GROUND
                    return
                }
                parserState = ParserState.GROUND
                dispatchCsi(codePoint.toChar())
            }
            codePoint == ESC -> parserState = ParserState.ESCAPE // malformed; try to resync
            else -> parserState = ParserState.CSI_IGNORE
        }
    }

    private fun isCsiTerminator(codePoint: Int): Boolean = codePoint in 0x40..0x7E

    private fun param(index: Int, default: Int): Int = csiParams.getOrNull(index)?.takeIf { it != 0 } ?: default

    private fun rawParam(index: Int): Int = csiParams.getOrNull(index) ?: 0

    private fun dispatchCsi(final: Char) {
        when (final) {
            'A' -> moveCursor(vertical = -param(0, 1))
            'B' -> moveCursor(vertical = param(0, 1))
            'C' -> moveCursor(horizontal = param(0, 1))
            'D' -> moveCursor(horizontal = -param(0, 1))
            'E' -> { moveCursor(vertical = param(0, 1)); cursorX = 0 } // CNL
            'F' -> { moveCursor(vertical = -param(0, 1)); cursorX = 0 } // CPL
            'G', '`' -> cursorX = (param(0, 1) - 1).coerceIn(0, cols - 1) // CHA/HPA
            'd' -> { // VPA
                val row = param(0, 1) - 1
                cursorY = rowOriginToScreen(row)
            }
            'H', 'f' -> { // CUP
                val row = param(0, 1) - 1
                val col = param(1, 1) - 1
                cursorY = rowOriginToScreen(row)
                cursorX = col.coerceIn(0, cols - 1)
            }
            'J' -> eraseDisplay(rawParam(0))
            'K' -> eraseLine(rawParam(0))
            'X' -> { // ECH
                val count = param(0, 1)
                activeBuffer.lineAt(cursorY).clearRange(cursorX, cursorX + count)
            }
            'P' -> { // DCH: delete cells, shifting the tail left
                val line = activeBuffer.lineAt(cursorY)
                val count = param(0, 1)
                val from = cursorX.coerceAtMost(line.cellCount)
                val cells = line.cells
                val end = (from + count).coerceAtMost(cells.size)
                repeat(end - from) { cells.removeAt(from) }
            }
            '@' -> { // ICH: insert blanks at cursor
                val line = activeBuffer.lineAt(cursorY)
                val count = param(0, 1)
                val from = cursorX.coerceAtMost(line.cellCount)
                // Clamp to the remaining width: an unclamped 16-bit param on
                // a narrow line would materialise ~65k blank cells.
                val blanks = count.coerceAtMost(cols - from).coerceAtLeast(0)
                repeat(blanks) { line.cells.add(from, TerminalCell.BLANK) }
            }
            'L' -> insertLines(param(0, 1))
            'M' -> deleteLines(param(0, 1))
            'S' -> scrollRegionUpLocked(param(0, 1))
            'T' -> scrollRegionDownLocked(param(0, 1))
            'm' -> applySgr()
            'r' -> { // DECSTBM
                val top = param(0, 1) - 1
                val bottom = param(1, rows) - 1
                setScrollRegionLocked(top, bottom)
            }
            's' -> saveCursorLocked()
            'u' -> restoreCursorLocked()
            'h' -> if (csiPrivate) applyPrivateModes(set = true) else unknownSequenceCountField++
            'l' -> if (csiPrivate) applyPrivateModes(set = false) else unknownSequenceCountField++
            else -> unknownSequenceCountField++ // DA/DSR/SCUSR/DECSTR etc.: ignored
        }
        wrapPending = false
    }

    private fun moveCursor(vertical: Int = 0, horizontal: Int = 0) {
        if (vertical != 0) {
            val target = cursorY + vertical
            cursorY = target.coerceIn(topMargin, bottomMargin)
        }
        if (horizontal != 0) {
            val target = cursorX + horizontal
            cursorX = target.coerceIn(0, cols - 1)
        }
    }

    /** Origin-mode-aware row mapping (DECOM: CUP rows count from the top margin). */
    private fun rowOriginToScreen(row: Int): Int {
        val rowInRegion = if (originMode) row.coerceIn(0, bottomMargin - topMargin) else row.coerceIn(0, rows - 1)
        return if (originMode) topMargin + rowInRegion else rowInRegion
    }

    private fun eraseDisplay(mode: Int) {
        when (mode) {
            0 -> {
                activeBuffer.lineAt(cursorY).truncateFrom(cursorX)
                for (row in cursorY + 1 until rows) activeBuffer.lineAt(row).clear()
            }
            1 -> {
                for (row in 0 until cursorY) activeBuffer.lineAt(row).clear()
                activeBuffer.lineAt(cursorY).clearRange(0, cursorX + 1)
            }
            2 -> for (row in 0 until rows) activeBuffer.lineAt(row).clear()
            3 -> activeBuffer.scrollback.clear() // xterm SCROLLBACK erase
            else -> unknownSequenceCountField++
        }
    }

    private fun eraseLine(mode: Int) {
        val line = activeBuffer.lineAt(cursorY)
        when (mode) {
            0 -> line.truncateFrom(cursorX)
            1 -> line.clearRange(0, cursorX + 1)
            2 -> line.clear()
            else -> unknownSequenceCountField++
        }
    }

    /** IL: blank lines inserted at the cursor, region tail dropped. No scrollback growth. */
    private fun insertLines(count: Int) {
        if (cursorY < topMargin || cursorY > bottomMargin) return
        val n = count.coerceIn(0, bottomMargin - cursorY + 1)
        repeat(n) {
            activeBuffer.screen.removeAt(bottomMargin)
            activeBuffer.screen.add(cursorY, TerminalLine())
        }
    }

    /** DL: lines at the cursor removed, blanks appended at the region bottom. */
    private fun deleteLines(count: Int) {
        if (cursorY < topMargin || cursorY > bottomMargin) return
        val n = count.coerceIn(0, bottomMargin - cursorY + 1)
        repeat(n) {
            activeBuffer.screen.removeAt(cursorY)
            activeBuffer.screen.add(bottomMargin, TerminalLine())
        }
    }

    private fun setScrollRegionLocked(top: Int, bottom: Int) {
        if (top < 0 || bottom >= rows || top >= bottom) {
            topMargin = 0
            bottomMargin = rows - 1
        } else {
            topMargin = top
            bottomMargin = bottom
        }
        cursorY = if (originMode) topMargin else 0
        cursorX = 0
    }

    private fun clampMarginsLocked() {
        topMargin = topMargin.coerceIn(0, rows - 2)
        bottomMargin = bottomMargin.coerceIn(topMargin + 1, rows - 1)
    }

    private fun applyPrivateModes(set: Boolean) {
        var index = 0
        while (index < csiParams.size) {
            when (val mode = rawParam(index)) {
                1049 -> if (set) enterAltScreenLocked(saveCursor = true) else exitAltScreenLocked(restoreCursor = true)
                47, 1047 -> if (set) enterAltScreenLocked(saveCursor = false) else exitAltScreenLocked(restoreCursor = false)
                25 -> cursorVisible = set
                7 -> autowrap = set
                6 -> {
                    originMode = set
                    cursorY = if (originMode) topMargin else 0
                    cursorX = 0
                }
                1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 9 -> Unit // mouse modes: ignored
                2004 -> Unit // bracketed paste tracked nowhere: pastes stay raw (web parity)
                else -> unknownSequenceCountField++
            }
            index++
        }
    }

    private fun enterAltScreenLocked(saveCursor: Boolean) {
        if (altScreenActive) return
        if (saveCursor) savedMain = captureStateLocked()
        altScreenActive = true
        activeBuffer = altBuffer
        for (row in 0 until rows) altBuffer.lineAt(row).clear()
        cursorX = 0
        cursorY = 0
        topMargin = 0
        bottomMargin = rows - 1
        originMode = false
    }

    private fun exitAltScreenLocked(restoreCursor: Boolean) {
        if (!altScreenActive) return
        altScreenActive = false
        activeBuffer = mainBuffer
        topMargin = 0
        bottomMargin = rows - 1
        originMode = false
        if (restoreCursor) restoreStateLocked(savedMain)
        else {
            cursorX = 0
            cursorY = 0
        }
    }

    // --------------------------------------------------------------- SGR --

    private fun applySgr() {
        if (csiParams.isEmpty()) {
            currentStyle = TerminalStyle()
            return
        }
        var index = 0
        while (index < csiParams.size) {
            when (val code = csiParams[index]) {
                0 -> currentStyle = TerminalStyle()
                1 -> currentStyle = currentStyle.copy(bold = true)
                2 -> currentStyle = currentStyle.copy(faint = true)
                3 -> currentStyle = currentStyle.copy(italic = true)
                4 -> currentStyle = currentStyle.copy(underline = true)
                5 -> currentStyle = currentStyle.copy(blink = true)
                7 -> currentStyle = currentStyle.copy(inverse = true)
                8 -> currentStyle = currentStyle.copy(invisible = true)
                9 -> currentStyle = currentStyle.copy(strikethrough = true)
                21 -> currentStyle = currentStyle.copy(bold = false) // xterm: "double underline" ≈ bold off is the common read; harmless either way
                22 -> currentStyle = currentStyle.copy(bold = false, faint = false)
                23 -> currentStyle = currentStyle.copy(italic = false)
                24 -> currentStyle = currentStyle.copy(underline = false)
                25 -> currentStyle = currentStyle.copy(blink = false)
                27 -> currentStyle = currentStyle.copy(inverse = false)
                28 -> currentStyle = currentStyle.copy(invisible = false)
                29 -> currentStyle = currentStyle.copy(strikethrough = false)
                in 30..37 -> currentStyle = currentStyle.copy(foreground = TerminalColor.Indexed(code - 30))
                38 -> index += applyExtendedColor(index, isForeground = true)
                39 -> currentStyle = currentStyle.copy(foreground = TerminalColor.Default)
                in 40..47 -> currentStyle = currentStyle.copy(background = TerminalColor.Indexed(code - 40))
                48 -> index += applyExtendedColor(index, isForeground = false)
                49 -> currentStyle = currentStyle.copy(background = TerminalColor.Default)
                in 90..97 -> currentStyle = currentStyle.copy(foreground = TerminalColor.Indexed(code - 90 + 8))
                in 100..107 -> currentStyle = currentStyle.copy(background = TerminalColor.Indexed(code - 100 + 8))
                else -> unknownSequenceCountField++
            }
            index++
        }
    }

    /**
     * SGR 38/48 extended color: `38;5;n`, `38;2;r;g;b` (and the ':' forms the
     * CSI layer already flattened). Returns how many extra params were consumed.
     */
    private fun applyExtendedColor(index: Int, isForeground: Boolean): Int {
        val kind = rawParam(index + 1)
        return when (kind) {
            5 -> {
                val colorIndex = rawParam(index + 2).coerceIn(0, 255)
                currentStyle = if (isForeground) {
                    currentStyle.copy(foreground = TerminalColor.Indexed(colorIndex))
                } else {
                    currentStyle.copy(background = TerminalColor.Indexed(colorIndex))
                }
                2
            }
            2 -> {
                val r = rawParam(index + 2).coerceIn(0, 255)
                val g = rawParam(index + 3).coerceIn(0, 255)
                val b = rawParam(index + 4).coerceIn(0, 255)
                val rgb = (r shl 16) or (g shl 8) or b
                currentStyle = if (isForeground) {
                    currentStyle.copy(foreground = TerminalColor.Rgb(rgb))
                } else {
                    currentStyle.copy(background = TerminalColor.Rgb(rgb))
                }
                4
            }
            else -> {
                unknownSequenceCountField++
                0
            }
        }
    }

    // ----------------------------------------------------- save / restore --

    private class SavedState(
        val cursorX: Int = 0,
        val cursorY: Int = 0,
        val style: TerminalStyle = TerminalStyle(),
        val originMode: Boolean = false,
    )

    private fun captureStateLocked() = SavedState(cursorX, cursorY, currentStyle, originMode)

    private fun saveCursorLocked() {
        if (altScreenActive) savedAlt = captureStateLocked() else savedMain = captureStateLocked()
    }

    private fun restoreCursorLocked() = restoreStateLocked(
        if (altScreenActive) savedAlt else savedMain,
    )

    private fun restoreStateLocked(state: SavedState) {
        cursorX = state.cursorX.coerceIn(0, cols - 1)
        cursorY = state.cursorY.coerceIn(topMargin, bottomMargin)
        currentStyle = state.style
        originMode = state.originMode
        wrapPending = false
    }

    private fun hardResetLocked() {
        mainBuffer.screen.clear()
        repeat(rows) { mainBuffer.screen.addLast(TerminalLine()) }
        mainBuffer.scrollback.clear()
        altBuffer.screen.clear()
        repeat(rows) { altBuffer.screen.addLast(TerminalLine()) }
        altBuffer.scrollback.clear()
        altScreenActive = false
        activeBuffer = mainBuffer
        cursorX = 0
        cursorY = 0
        currentStyle = TerminalStyle()
        wrapPending = false
        topMargin = 0
        bottomMargin = rows - 1
        originMode = false
        autowrap = true
        cursorVisible = true
        parserState = ParserState.GROUND
    }

    // -------------------------------------------------------------- OSC --

    private fun feedOsc(codePoint: Int) {
        when {
            codePoint == 7 -> parserState = ParserState.GROUND // BEL terminator
            codePoint == ESC -> parserState = ParserState.OSC_ESCAPE
            codePoint == 127 -> Unit
            else -> if (oscBuffer.length < MAX_OSC_LENGTH) oscBuffer.appendCodePoint(codePoint)
        }
    }

    // ------------------------------------------------------------- reflow --

    private fun reflowMainLocked(newCols: Int, newRows: Int) {
        val oldLines = mainBuffer.allLines()
        val oldScrollbackCount = mainBuffer.scrollbackCount

        // 1. Un-join wrapped lines into logical lines (cells + wrap flag).
        data class Logical(var cells: ArrayList<TerminalCell>, var startIndex: Int)

        val logicalLines = ArrayList<Logical>(oldLines.size)
        var current: Logical? = null
        oldLines.forEachIndexed { index, line ->
            if (current == null || !line.isWrapped) {
                current = Logical(ArrayList(line.cells), index)
                logicalLines.add(current!!)
            } else {
                current!!.cells.addAll(line.cells)
            }
        }

        // 2. Which logical line holds the cursor?
        val cursorAbsolute = oldScrollbackCount + cursorY
        var cursorLogicalIndex = 0
        logicalLines.forEachIndexed { index, logical ->
            if (cursorAbsolute >= logical.startIndex && cursorAbsolute < logical.startIndex +
                visualSpan(logical.cells, cols)
            ) {
                cursorLogicalIndex = index
            }
        }
        // Fallback: cursor sits past the last line's start — keep it on the last logical line.
        // (visualSpan below counts this logical line's rows at the OLD width.)

        // 3. Re-wrap every logical line at the new width.
        val rebuilt = ArrayList<TerminalLine>(oldLines.size)
        val logicalRowOffsets = IntArray(logicalLines.size)
        logicalLines.forEachIndexed { index, logical ->
            logicalRowOffsets[index] = rebuilt.size
            if (logical.cells.isEmpty()) {
                rebuilt.add(TerminalLine())
                return@forEachIndexed
            }
            var offset = 0
            while (offset < logical.cells.size) {
                val end = (offset + newCols).coerceAtMost(logical.cells.size)
                val line = TerminalLine(ArrayList(logical.cells.subList(offset, end)))
                // Continuation chunks keep the wrap flag so a later resize can
                // un-join them again; the first chunk is a line start.
                line.isWrapped = offset > 0
                rebuilt.add(line)
                offset = end
            }
        }

        // 4. Redistribute: scrollback (capped) + screen (last newRows).
        cols = newCols
        rows = newRows
        mainBuffer.screen.clear()
        mainBuffer.scrollback.clear()
        val keepFrom = rebuilt.size.coerceAtLeast(newRows) - newRows
        for (index in 0 until keepFrom) {
            if (mainBuffer.scrollback.size >= mainBuffer.scrollbackLimit) {
                mainBuffer.scrollback.removeFirst()
            }
            mainBuffer.scrollback.addLast(rebuilt[index])
        }
        for (index in keepFrom until rebuilt.size) {
            mainBuffer.screen.addLast(rebuilt[index])
        }
        while (mainBuffer.screen.size < newRows) mainBuffer.screen.addLast(TerminalLine())
        mainBuffer.setRows(newRows)

        // 5. Cursor: same logical line, its LAST visual row, column clamped.
        if (logicalLines.isEmpty()) {
            cursorY = 0
        } else {
            val clampedLogical = cursorLogicalIndex.coerceIn(0, logicalLines.size - 1)
            val rowStart = logicalRowOffsets[clampedLogical]
            val rowEnd = if (clampedLogical + 1 < logicalLines.size) logicalRowOffsets[clampedLogical + 1] else rebuilt.size
            val lastRow = (rowEnd - 1).coerceAtLeast(rowStart)
            cursorY = (lastRow - mainBuffer.scrollback.size).coerceIn(0, newRows - 1)
        }
        cursorX = cursorX.coerceIn(0, newCols - 1)
    }

    /** How many visual rows a logical line occupies at [width] (>= 1). */
    private fun visualSpan(logical: ArrayList<TerminalCell>, width: Int): Int =
        (logical.size + width - 1).coerceAtLeast(1) / width

    // ----------------------------------------------------------- snapshot --

    private fun buildSnapshotLocked(): TerminalSnapshot {
        val lines = ArrayList<TerminalSnapshotLine>(mainBuffer.scrollbackCount + rows)
        if (altScreenActive) {
            for (row in 0 until rows) lines.add(buildLineRuns(altBuffer.lineAt(row)))
            return TerminalSnapshot(
                cols = cols,
                rows = rows,
                scrollbackCount = 0,
                cursorLine = cursorY,
                cursorCol = cursorX,
                cursorVisible = cursorVisible,
                lines = lines,
            )
        }
        mainBuffer.scrollback.forEach { lines.add(buildLineRuns(it)) }
        val cursorAbsolute = mainBuffer.scrollbackCount + cursorY
        for (row in 0 until rows) {
            val line = mainBuffer.lineAt(row)
            val absolute = mainBuffer.scrollbackCount + row
            lines.add(buildLineRuns(line, markCursor = absolute == cursorAbsolute))
        }
        return TerminalSnapshot(
            cols = cols,
            rows = rows,
            scrollbackCount = mainBuffer.scrollbackCount,
            cursorLine = cursorAbsolute,
            cursorCol = cursorX,
            cursorVisible = cursorVisible,
            lines = lines,
        )
    }

    private fun buildLineRuns(line: TerminalLine, markCursor: Boolean = false): TerminalSnapshotLine {
        val runs = ArrayList<TerminalRun>(8)
        val text = StringBuilder()
        var style: TerminalStyle? = null

        fun flush() {
            val current = style
            if (text.isNotEmpty() && current != null) {
                runs.add(TerminalRun(text.toString(), current))
            }
            text.setLength(0)
        }

        line.cells.forEachIndexed { index, cell ->
            if (markCursor && index == cursorX) {
                flush()
                // Character.toChars handles supplementary code points (surrogate pair).
                runs.add(TerminalRun(String(Character.toChars(cell.codePoint)), cell.style, isCursor = true))
                // Continue the run after the cursor with the cursor cell's style
                // so same-styled neighbors merge without an extra flush.
                style = cell.style
                return@forEachIndexed
            }
            if (style == null) {
                style = cell.style
            } else if (cell.style != style) {
                flush()
                style = cell.style
            }
            text.appendCodePoint(cell.codePoint)
        }
        flush()
        if (markCursor && cursorX >= line.cellCount) {
            // Cursor sits on an unwritten (ragged-right) cell: emit a blank
            // flagged run so the block cursor still renders.
            runs.add(TerminalRun(" ", TerminalStyle(), isCursor = true))
        }
        return TerminalSnapshotLine(runs, line.isWrapped)
    }

    companion object {
        const val DEFAULT_COLS = 80
        const val DEFAULT_ROWS = 24
        const val MIN_COLS = 2
        const val MAX_COLS = 500
        const val MIN_ROWS = 2
        const val MAX_ROWS = 200
        private const val ESC = 27
        private const val MAX_OSC_LENGTH = 8192
        private const val MAX_CSI_PARAMS = 32
        private const val MAX_PARAM_VALUE = 65535
    }
}

/** One styled text run in a render snapshot. */
data class TerminalRun(
    val text: String,
    val style: TerminalStyle,
    /** True when this single-cell run sits under the cursor (block cursor rendering). */
    val isCursor: Boolean = false,
)

/** A line of a render snapshot, as merged style runs. */
data class TerminalSnapshotLine(
    val runs: List<TerminalRun>,
    val isWrapped: Boolean,
)

/**
 * Immutable full-buffer snapshot for one frame: scrollback + screen lines in
 * order. `lines[i]` is scrollback while `i < scrollbackCount`, else screen row
 * `i - scrollbackCount`. The cursor cell is flagged inside
 * [TerminalSnapshotLine.runs] (`isCursor`) instead of being a separate
 * coordinate overlay, so LazyColumn item layout stays trivial.
 */
data class TerminalSnapshot(
    val cols: Int,
    val rows: Int,
    val scrollbackCount: Int,
    /** Absolute line index (into [lines]) of the cursor row. */
    val cursorLine: Int,
    val cursorCol: Int,
    val cursorVisible: Boolean,
    val lines: List<TerminalSnapshotLine>,
)
