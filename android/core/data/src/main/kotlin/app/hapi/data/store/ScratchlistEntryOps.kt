package app.hapi.data.store

import app.hapi.protocol.wire.ScratchlistEntry

/**
 * Direction for a local scratchlist reorder ([SessionScratchlist.moveEntry]);
 * `UP` moves an entry toward index 0 — the newest slot in hub order.
 */
enum class ScratchlistMoveDirection { UP, DOWN }

/**
 * Pure scratchlist entry policies shared by the store and the UI — the
 * native twin of `web/src/lib/scratchlist.ts`:
 *
 * - [moveEntry] is the adjacent-swap reorder behind the per-row ↑/↓ buttons.
 * - [shouldConfirmDelete] gates entry deletion on a text-length threshold so
 *   a stray tap only kills a trivial note without a confirmation prompt.
 */
object ScratchlistEntryOps {
    /**
     * Web `SCRATCHLIST_CONFIRM_DELETE_THRESHOLD`: texts **strictly longer**
     * than this many characters confirm before delete. Measured with the
     * untrimmed `.length` (UTF-16 code units), exactly like the web client —
     * exactly-at-threshold deletes directly.
     */
    const val CONFIRM_DELETE_THRESHOLD: Int = 100

    /** Web `shouldConfirmDelete`: a null text (or entry) never confirms. */
    fun shouldConfirmDelete(text: String?): Boolean =
        (text?.length ?: 0) > CONFIRM_DELETE_THRESHOLD

    /**
     * Web `moveScratchlistEntry`: swap the entry with its neighbor in
     * [direction]. Unknown ids and edge moves (first `UP`, last `DOWN`)
     * return the list unchanged, so callers can invoke unconditionally.
     */
    fun moveEntry(
        entries: List<ScratchlistEntry>,
        entryId: String,
        direction: ScratchlistMoveDirection,
    ): List<ScratchlistEntry> {
        val index = entries.indexOfFirst { it.entryId == entryId }
        if (index < 0) return entries
        val swapWith = if (direction == ScratchlistMoveDirection.UP) index - 1 else index + 1
        if (swapWith < 0 || swapWith >= entries.size) return entries
        return entries.toMutableList().apply {
            add(swapWith, removeAt(index))
        }
    }
}
