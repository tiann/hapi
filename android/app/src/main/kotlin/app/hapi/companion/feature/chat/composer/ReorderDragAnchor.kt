package app.hapi.companion.feature.chat.composer

/**
 * Drag-to-reorder anchor for the attachment tray ([ChatComposer]): the slot
 * the dragged chip currently occupies, tracked at issue time.
 *
 * The dragged chip's index must NOT be re-read from the LazyRow layout on
 * every drag event: the layout lags a just-issued
 * [app.hapi.companion.feature.chat.attachments.ComposerAttachments.move] by
 * a frame (StateFlow pipeline + recomposition), so back-to-back events over
 * the same slot would both see the stale pre-move order and fire the same
 * move twice — the second firing lands on the already-moved list and moves
 * the displaced neighbor instead, i.e. the dragged chip immediately swaps
 * back. Tracking the anchor here makes consecutive same-slot events a no-op;
 * once the layout settles it agrees with the anchor.
 */
internal class ReorderDragAnchor {
    /** Current slot of the dragged chip; negative ⇒ no drag active. */
    var index: Int = -1
        private set

    val active: Boolean get() = index >= 0

    /** Long-press picked the chip at [startIndex]. */
    fun start(startIndex: Int) {
        index = startIndex
    }

    /** Drag ended or was cancelled. */
    fun reset() {
        index = -1
    }

    /**
     * The pointer entered the slot at [targetIndex]: the move to issue
     * (`from` to `to`), or null when no drag is active or the dragged chip
     * already occupies that slot (no-op — also the swap-back guard for a
     * stale layout). The anchor advances to the new slot only when a move
     * is issued, so it always tracks where the tray now holds the chip.
     */
    fun enterSlot(targetIndex: Int): Pair<Int, Int>? =
        if (!active || targetIndex == index) null
        else (index to targetIndex).also { index = targetIndex }
}
