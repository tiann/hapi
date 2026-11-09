package app.hapi.companion.ui.components

import androidx.compose.ui.geometry.Offset

/** How a finished gesture's final pointer release classifies. */
enum class TapOutcome {
    /** Second tap of a double tap — the caller resets the view (web `onDoubleClick`). */
    DOUBLE_TAP,

    /** Eligible single tap — remembered for a possible double tap. */
    SINGLE_TAP,

    /**
     * Not a tap: the gesture had multiple pointers, dragged/pressed beyond
     * the tap limits, the release was a cancelled stream, or it landed off
     * the image.
     */
    NOT_A_TAP,
}

/**
 * Tap/double-tap classification for [ZoomableImageViewerDialog] — the Android
 * twin of the web viewer's `lastTapRef` bookkeeping, hardened per review
 * r4361795975: the final pointer release alone must not decide. A gesture
 * that became a pinch (a second pointer pressed) can never be a tap even when
 * its last-released finger never moved — a tap followed by a quick pinch with
 * the first finger held stationary must not reset the scale — so the tracker
 * keeps per-gesture eligibility (multi-pointer, travel high-water mark,
 * duration) and a pinch also invalidates the remembered tap. Pure state over
 * Compose geometry so the classification is JVM-testable; the composable
 * feeds it pointer events.
 */
class ImageViewerTapTracker(
    /** Both the inter-tap window and the per-gesture duration cap (Compose uses the view configuration's doubleTapTimeoutMillis). */
    private val doubleTapTimeoutMillis: Long,
    /** Travel high-water mark a tap may not exceed (view configuration touch slop). */
    private val maxMovement: Float,
) {
    private var lastTapAt = -1L
    private var gestureStart = Offset.Zero
    private var gestureStartUptime = 0L
    private var gestureHadMultiplePointers = false
    private var gestureMaxTravel = 0f

    /** A new gesture begins with its first pointer down. */
    fun beginGesture(start: Offset, uptimeMillis: Long) {
        gestureStart = start
        gestureStartUptime = uptimeMillis
        gestureHadMultiplePointers = false
        gestureMaxTravel = 0f
    }

    /**
     * Every tracked pointer position raises the gesture's travel high-water
     * mark — a finger that wanders past [maxMovement] and returns before the
     * release is still not a tap.
     */
    fun onPointerPosition(position: Offset) {
        gestureMaxTravel = maxOf(gestureMaxTravel, ImageViewerMath.distance(position, gestureStart))
    }

    /**
     * A second pressed pointer turned the gesture into a pinch: it can no
     * longer be a tap, and the remembered tap is invalidated too —
     * `beginPinch` cleared the backdrop tracking but not the tap tracking,
     * which is what let a tap–pinch–release sequence reset the zoom.
     */
    fun onMultiPointer() {
        gestureHadMultiplePointers = true
        lastTapAt = -1L
    }

    /**
     * The last pointer of the gesture lifted. Only an eligible release of an
     * all-single-pointer, within-limits gesture counts as a tap; anything
     * else breaks a pending double-tap sequence (like the web, where a drag
     * between the two presses suppresses `dblclick`).
     */
    fun classifyRelease(
        releasePosition: Offset,
        releaseUptime: Long,
        /** Compose has no cancel event type — cancelled streams arrive as all-up changes and must not count. */
        isRelease: Boolean,
        /** Over the transformed image (the caller owns the hit test). */
        isOverImage: Boolean,
    ): TapOutcome {
        if (!isRelease || !isOverImage) {
            lastTapAt = -1L
            return TapOutcome.NOT_A_TAP
        }
        val eligibleTap = !gestureHadMultiplePointers &&
            gestureMaxTravel <= maxMovement &&
            releasePosition.isCloseTo(gestureStart) &&
            releaseUptime - gestureStartUptime <= doubleTapTimeoutMillis
        if (!eligibleTap) {
            lastTapAt = -1L
            return TapOutcome.NOT_A_TAP
        }
        return if (lastTapAt >= 0 && releaseUptime - lastTapAt <= doubleTapTimeoutMillis) {
            lastTapAt = -1L
            TapOutcome.DOUBLE_TAP
        } else {
            lastTapAt = releaseUptime
            TapOutcome.SINGLE_TAP
        }
    }

    /** Distance from [gestureStart] within [maxMovement] — mirrors the old release check. */
    private fun Offset.isCloseTo(other: Offset): Boolean =
        ImageViewerMath.distance(this, other) <= maxMovement
}
