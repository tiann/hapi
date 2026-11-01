package app.hapi.companion.ui.components

import androidx.compose.ui.geometry.Offset
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * [ImageViewerTapTracker] classification — the extracted gesture-classification
 * seam behind [ZoomableImageViewerDialog]'s double-tap reset. The pre-fix
 * composable decided "tap" from the final release alone: its position vs the
 * gesture's first down plus the previous release time. Review r4361795975's
 * sequence — tap, then a quick pinch whose first finger stays put and lifts
 * last — satisfied that condition (final release stationary, within the
 * double-tap window) and reset the scale right after zooming; these tests
 * encode the classification the fixed tracker must give for that input.
 */
class ImageViewerTapTrackerTest {

    private val timeout = 300L
    private val slop = 8f
    private val center = Offset(500f, 800f)

    private fun tracker() = ImageViewerTapTracker(timeout, slop)

    /** A single-pointer stationary press-release within the limits. */
    private fun tap(t: ImageViewerTapTracker, at: Offset = center, uptime: Long): TapOutcome {
        t.beginGesture(at, uptime)
        t.onPointerPosition(at)
        return t.classifyRelease(at, uptime + 40, isRelease = true, isOverImage = true)
    }

    @Test
    fun `two quick stationary taps classify as a double tap`() {
        val t = tracker()
        assertEquals(TapOutcome.SINGLE_TAP, tap(t, uptime = 1_000))
        assertEquals(TapOutcome.DOUBLE_TAP, tap(t, uptime = 1_200))
    }

    @Test
    fun `a tap followed by a pinch never resets - the review sequence`() {
        val t = tracker()
        // First: an ordinary tap (pre-fix code remembered it as lastTapAt).
        assertEquals(TapOutcome.SINGLE_TAP, tap(t, uptime = 1_000))

        // Then the review's quick pinch: the first finger presses at the tap
        // point and never moves; a second finger presses and spreads; the
        // moving finger lifts first and the stationary finger releases last
        // — within the double-tap window of the remembered tap.
        t.beginGesture(center, uptimeMillis = 1_100)
        t.onPointerPosition(center)
        val secondFinger = center + Offset(120f, 40f)
        t.onPointerPosition(secondFinger)
        t.onMultiPointer()
        t.onPointerPosition(secondFinger + Offset(80f, 20f))
        // Moving finger lifts first (pointers drop to one — no release
        // classification yet), then the stationary finger releases last.
        val outcome = t.classifyRelease(
            releasePosition = center,
            releaseUptime = 1_180,
            isRelease = true,
            isOverImage = true,
        )
        // Pre-fix: this release was treated as the second tap of a double tap
        // and reset the zoom. Fixed: the gesture became a pinch.
        assertEquals(TapOutcome.NOT_A_TAP, outcome)
    }

    @Test
    fun `a pinch invalidates the remembered tap for later genuine taps`() {
        val t = tracker()
        assertEquals(TapOutcome.SINGLE_TAP, tap(t, uptime = 1_000))
        // A pinch begins and both fingers lift (gesture ends ineligible).
        t.beginGesture(center, uptimeMillis = 1_100)
        t.onMultiPointer()
        assertEquals(
            TapOutcome.NOT_A_TAP,
            t.classifyRelease(center, releaseUptime = 1_150, isRelease = true, isOverImage = true),
        )
        // A genuine quick tap afterwards pairs with nothing: it is a fresh
        // first tap, not a double tap (pre-fix would have reset here too).
        assertEquals(TapOutcome.SINGLE_TAP, tap(t, uptime = 1_250))
    }

    @Test
    fun `a drag away and back is not a tap`() {
        val t = tracker()
        assertEquals(TapOutcome.SINGLE_TAP, tap(t, uptime = 1_000))
        // The finger travels far past the slop and returns before releasing —
        // the final release position alone looks stationary (the pre-fix
        // condition), but the travel high-water mark disqualifies it.
        t.beginGesture(center, uptimeMillis = 1_200)
        t.onPointerPosition(center + Offset(200f, 0f))
        val outcome = t.classifyRelease(
            releasePosition = center,
            releaseUptime = 1_260,
            isRelease = true,
            isOverImage = true,
        )
        assertEquals(TapOutcome.NOT_A_TAP, outcome)
        // The intervening drag also broke the double-tap sequence.
        assertEquals(TapOutcome.SINGLE_TAP, tap(t, uptime = 1_320))
    }

    @Test
    fun `a press held past the duration cap is not a tap`() {
        val t = tracker()
        assertEquals(TapOutcome.SINGLE_TAP, tap(t, uptime = 1_000))
        t.beginGesture(center, uptimeMillis = 1_200)
        t.onPointerPosition(center)
        val outcome = t.classifyRelease(
            releasePosition = center,
            releaseUptime = 1_200 + timeout + 10,
            isRelease = true,
            isOverImage = true,
        )
        assertEquals(TapOutcome.NOT_A_TAP, outcome)
    }

    @Test
    fun `a slow second tap is a fresh single tap not a double tap`() {
        val t = tracker()
        assertEquals(TapOutcome.SINGLE_TAP, tap(t, uptime = 1_000))
        assertEquals(TapOutcome.SINGLE_TAP, tap(t, uptime = 1_000 + timeout + 10))
    }

    @Test
    fun `a cancelled stream release is not a tap and clears the remembered tap`() {
        val t = tracker()
        assertEquals(TapOutcome.SINGLE_TAP, tap(t, uptime = 1_000))
        t.beginGesture(center, uptimeMillis = 1_100)
        t.onPointerPosition(center)
        assertEquals(
            TapOutcome.NOT_A_TAP,
            t.classifyRelease(center, releaseUptime = 1_150, isRelease = false, isOverImage = true),
        )
        // The remembered tap was consumed: the next quick tap starts fresh.
        assertEquals(TapOutcome.SINGLE_TAP, tap(t, uptime = 1_220))
    }

    @Test
    fun `a release off the image is not a tap and clears the remembered tap`() {
        val t = tracker()
        assertEquals(TapOutcome.SINGLE_TAP, tap(t, uptime = 1_000))
        t.beginGesture(center, uptimeMillis = 1_100)
        t.onPointerPosition(center)
        assertEquals(
            TapOutcome.NOT_A_TAP,
            t.classifyRelease(center, releaseUptime = 1_150, isRelease = true, isOverImage = false),
        )
        assertEquals(TapOutcome.SINGLE_TAP, tap(t, uptime = 1_220))
    }
}
