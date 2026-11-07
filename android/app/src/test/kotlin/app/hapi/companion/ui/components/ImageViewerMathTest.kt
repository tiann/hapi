package app.hapi.companion.ui.components

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Zoom/pan arithmetic against web `ImagePreview.tsx`'s constants and math —
 * the numbers below mirror the web component's own behavior (0.25–8× in 0.25
 * steps, midpoint-following pinch, ≤4 px backdrop tap, `Math.round` percent).
 */
class ImageViewerMathTest {

    @Test
    fun clampsScaleIntoTheWebViewerRange() {
        assertEquals(0.25f, ImageViewerMath.clampScale(0.1f))
        assertEquals(8f, ImageViewerMath.clampScale(12f))
        assertEquals(1.75f, ImageViewerMath.clampScale(1.75f))
    }

    @Test
    fun zoomByStepsAndStopsAtTheBounds() {
        assertEquals(1.25f, ImageViewerMath.zoomBy(1f, 0.25f))
        assertEquals(0.75f, ImageViewerMath.zoomBy(1f, -0.25f))
        // Web zoomBy clamps past either end rather than skipping past it.
        assertEquals(0.25f, ImageViewerMath.zoomBy(0.25f, -0.25f))
        assertEquals(8f, ImageViewerMath.zoomBy(7.9f, 0.25f))
        assertEquals(8f, ImageViewerMath.zoomBy(8f, 0.25f))
        assertEquals(0.25f, ImageViewerMath.zoomBy(1f, -1.25f))
    }

    @Test
    fun pinchScaleFollowsTheStartDistanceRatio() {
        assertEquals(2f, ImageViewerMath.pinchScale(startScale = 1f, startDistance = 100f, distance = 200f))
        assertEquals(0.5f, ImageViewerMath.pinchScale(startScale = 1f, startDistance = 200f, distance = 100f))
        assertEquals(3f, ImageViewerMath.pinchScale(startScale = 2f, startDistance = 50f, distance = 75f))
        // Clamped like the web viewer's clampImageScale.
        assertEquals(8f, ImageViewerMath.pinchScale(startScale = 4f, startDistance = 10f, distance = 100f))
        assertEquals(0.25f, ImageViewerMath.pinchScale(startScale = 1f, startDistance = 100f, distance = 10f))
        // Degenerate pinch (fingers on top of each other) keeps the scale.
        assertEquals(1.5f, ImageViewerMath.pinchScale(startScale = 1.5f, startDistance = 0f, distance = 30f))
    }

    @Test
    fun dragOffsetTracksTravelFromTheStartPoint() {
        assertEquals(
            Offset(12f, -6f),
            ImageViewerMath.dragOffset(origin = Offset(10f, 4f), start = Offset(0f, 5f), position = Offset(2f, -5f)),
        )
        assertEquals(
            Offset(10f, 4f),
            ImageViewerMath.dragOffset(origin = Offset(10f, 4f), start = Offset(7f, 9f), position = Offset(7f, 9f)),
        )
    }

    @Test
    fun pinchOffsetTracksMidpointTravel() {
        assertEquals(
            Offset(15f, 10f),
            ImageViewerMath.pinchOffset(
                origin = Offset(20f, 20f),
                startCenter = Offset(40f, 30f),
                center = Offset(35f, 20f),
            ),
        )
    }

    @Test
    fun distanceAndMidpointMatchEuclideanMath() {
        assertEquals(5f, ImageViewerMath.distance(Offset(0f, 0f), Offset(3f, 4f)))
        assertEquals(0f, ImageViewerMath.distance(Offset(1f, 1f), Offset(1f, 1f)))
        assertEquals(Offset(5f, 5f), ImageViewerMath.midpoint(Offset(0f, 0f), Offset(10f, 10f)))
        assertEquals(Offset(5.5f, -1f), ImageViewerMath.midpoint(Offset(1f, 2f), Offset(10f, -4f)))
    }

    @Test
    fun backdropClickAllowsUpToTheMaxMovement() {
        assertTrue(ImageViewerMath.isBackdropClick(movement = 0f, maxMovement = 4f))
        assertTrue(ImageViewerMath.isBackdropClick(movement = 4f, maxMovement = 4f))
        assertFalse(ImageViewerMath.isBackdropClick(movement = 4.1f, maxMovement = 4f))
    }

    @Test
    fun zoomPercentRoundsHalfUpLikeJavaScriptMathRound() {
        assertEquals(100, ImageViewerMath.zoomPercent(1f))
        assertEquals(25, ImageViewerMath.zoomPercent(0.25f))
        assertEquals(225, ImageViewerMath.zoomPercent(2.25f))
        assertEquals(800, ImageViewerMath.zoomPercent(8f))
        assertEquals(13, ImageViewerMath.zoomPercent(0.125f))
    }

    @Test
    fun fittedSizeLetterboxesLikeContentScaleFit() {
        assertEquals(Size(100f, 50f), ImageViewerMath.fittedSize(Size(200f, 100f), Size(100f, 100f)))
        assertEquals(Size(50f, 100f), ImageViewerMath.fittedSize(Size(100f, 200f), Size(100f, 100f)))
        // Fit also upscales small images to fill the box.
        assertEquals(Size(100f, 100f), ImageViewerMath.fittedSize(Size(10f, 10f), Size(100f, 100f)))
        assertNull(ImageViewerMath.fittedSize(Size(0f, 100f), Size(100f, 100f)))
        assertNull(ImageViewerMath.fittedSize(Size(100f, 100f), Size(0f, 0f)))
    }

    @Test
    fun visualRectScalesAroundTheImageCenterAndShiftsByOffset() {
        // 100x100 canvas, image fitted to 100x50 (centered): rect (0,25)-(100,75).
        val rect = ImageViewerMath.visualRect(
            box = Size(100f, 100f),
            fitted = Size(100f, 50f),
            scale = 1f,
            offset = Offset.Zero,
        )
        assertEquals(0f, rect.left)
        assertEquals(25f, rect.top)
        assertEquals(100f, rect.right)
        assertEquals(75f, rect.bottom)

        // 2x zoom doubles around the center; the offset then translates it.
        val zoomed = ImageViewerMath.visualRect(
            box = Size(100f, 100f),
            fitted = Size(100f, 50f),
            scale = 2f,
            offset = Offset(10f, -20f),
        )
        assertEquals(-40f, zoomed.left)
        assertEquals(-20f, zoomed.top)
        assertEquals(160f, zoomed.right)
        assertEquals(80f, zoomed.bottom)

        assertTrue(rect.contains(Offset(50f, 50f)))
        assertFalse(rect.contains(Offset(50f, 10f)))
        assertTrue(zoomed.contains(Offset(50f, 10f)))
    }
}
