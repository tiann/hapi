package app.hapi.companion.ui.components

import android.graphics.Bitmap
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * Device checks for the zoomable image viewer (review r4361795961/r4361795975):
 * a zoomed/panned portrait image stays inside the canvas below the toolbar, a
 * pinch that follows a tap no longer reads as the double tap (a genuine double
 * tap still resets), and every toolbar control is reachable through its
 * content description.
 *
 * Gestures are injected in one event stream per phase with explicit
 * `advanceEventTime` steps, so the tap→pinch and tap→tap pairs stay inside the
 * platform double-tap window on any shard speed — real user gesture order,
 * not synthetic state flips (batch-34 v4 lesson).
 */
@OptIn(ExperimentalTestApi::class)
class ZoomableImageViewerTest {

    @get:Rule
    val compose = createComposeRule()

    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    /** Saturated green that exists nowhere in the chrome — image pixels only. */
    private val imageGreen = 0xFF00E000.toInt()

    private fun solidBitmap(width: Int, height: Int): ImageBitmap {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(imageGreen)
        return bitmap.asImageBitmap()
    }

    private class Harness(val images: List<ZoomableImage>) {
        @Volatile var open = true
        @Volatile var dismissed = false
    }

    private fun mount(harness: Harness) {
        compose.setContent {
            HapiTheme {
                if (harness.open) {
                    ZoomableImageViewerDialog(
                        images = harness.images,
                        onDismiss = {
                            harness.open = false
                            harness.dismissed = true
                        },
                    )
                }
            }
        }
        compose.waitForIdle()
    }

    /** Sampled fraction of [node]'s pixels that are the image green. */
    private fun greenPixelRatio(node: SemanticsNodeInteraction): Float {
        val bitmap = node.captureToImage().asAndroidBitmap()
        var green = 0
        var sampled = 0
        var y = 0
        while (y < bitmap.height) {
            var x = 0
            while (x < bitmap.width) {
                val pixel = bitmap.getPixel(x, y)
                sampled++
                if (android.graphics.Color.green(pixel) > 140 &&
                    android.graphics.Color.red(pixel) < 90 &&
                    android.graphics.Color.blue(pixel) < 90
                ) {
                    green++
                }
                x += 4
            }
            y += 4
        }
        return if (sampled == 0) 1f else green.toFloat() / sampled
    }

    @Test
    fun zoomedPortraitImageStaysInsideTheCanvasWithTheToolbarUsable() {
        val harness = Harness(
            listOf(ZoomableImage(ZoomableImageContent.Decoded(solidBitmap(540, 1620)), "tall.png")),
        )
        mount(harness)
        val zoomIn = context.getString(R.string.files_image_viewer_zoom_in)

        // Real user order: zoom to 4x with the + control, then pan upward
        // hard — the review's zooming/panning portrait sequence.
        repeat(12) { compose.onNodeWithContentDescription(zoomIn).performClick() }
        compose.onNodeWithText("400%").assertIsDisplayed()
        repeat(3) {
            compose.onNodeWithTag("zoomable-canvas").performTouchInput {
                swipe(Offset(center.x, center.y), Offset(center.x, top + 40f), durationMillis = 400)
            }
        }
        compose.waitForIdle()

        // Pre-fix (no canvas clip) the transformed image painted over the
        // toolbar: the title-bar region sampled image green and Close was
        // buried. Post-fix the toolbar stays chrome-only and functional.
        val toolbarGreen = greenPixelRatio(compose.onNodeWithTag("zoomable-title-bar"))
        assertEquals("zoomed portrait must not paint over the toolbar", 0f, toolbarGreen, 0f)
        val close = context.getString(R.string.files_image_viewer_close)
        compose.onNodeWithContentDescription(close).assertIsDisplayed().assertHasClickAction().performClick()
        compose.waitUntil(5_000) { harness.dismissed }
    }

    @Test
    fun pinchAfterTapKeepsTheZoomWhileADoubleTapResets() {
        val harness = Harness(
            listOf(ZoomableImage(ZoomableImageContent.Decoded(solidBitmap(1080, 1080)), "square.png")),
        )
        mount(harness)
        compose.onNodeWithText("100%").assertIsDisplayed()

        // One event stream, explicit event times — the pair stays inside the
        // double-tap window on any shard. First an ordinary tap on the image
        // (the tap the bug remembered), then the review's quick pinch: the
        // stationary first finger is released LAST. Pre-fix, that final
        // release read as the double tap and reset the pinch to 100%.
        compose.onNodeWithTag("zoomable-canvas").performTouchInput {
            down(center)
            advanceEventTime(40)
            up()
            advanceEventTime(60)
            down(0, center)
            advanceEventTime(40)
            down(1, center - Offset(80f, 0f))
            advanceEventTime(40)
            moveTo(1, center - Offset(160f, 0f))
            advanceEventTime(40)
            up(1)
            advanceEventTime(40)
            up(0)
        }
        compose.waitForIdle()
        compose.onNodeWithText("200%").assertIsDisplayed()

        // A genuine double tap still resets the view.
        compose.onNodeWithTag("zoomable-canvas").performTouchInput {
            down(center)
            advanceEventTime(40)
            up()
            advanceEventTime(80)
            down(center)
            advanceEventTime(40)
            up()
        }
        compose.waitForIdle()
        compose.onNodeWithText("100%").assertIsDisplayed()
    }

    @Test
    fun toolbarControlsAreLabeledReachableAndPageTheGallery() {
        val harness = Harness(
            listOf(
                ZoomableImage(ZoomableImageContent.Decoded(solidBitmap(200, 200)), "alpha.png"),
                ZoomableImage(ZoomableImageContent.Decoded(solidBitmap(200, 200)), "beta.png"),
            ),
        )
        mount(harness)
        val previous = context.getString(R.string.files_image_viewer_previous)
        val next = context.getString(R.string.files_image_viewer_next)
        val zoomOut = context.getString(R.string.files_image_viewer_zoom_out)
        val reset = context.getString(R.string.files_image_viewer_reset)
        val zoomIn = context.getString(R.string.files_image_viewer_zoom_in)
        val close = context.getString(R.string.files_image_viewer_close)

        // Every control is reachable through a content description (screen
        // readers and the device tests share this surface).
        compose.onNodeWithContentDescription(close).assertIsDisplayed().assertHasClickAction()
        compose.onNodeWithContentDescription(zoomOut).assertIsDisplayed().assertHasClickAction()
        compose.onNodeWithContentDescription(reset).assertIsDisplayed().assertHasClickAction()
        compose.onNodeWithContentDescription(zoomIn).assertIsDisplayed().assertHasClickAction()
        compose.onNodeWithContentDescription(next).assertIsDisplayed().assertHasClickAction()

        // Paging: back is disabled on the first page, next advances and
        // resets, back returns.
        compose.onNodeWithContentDescription(previous).assertIsDisplayed().assertIsNotEnabled()
        compose.onNodeWithText("1 / 2").assertIsDisplayed()
        compose.onNodeWithContentDescription(next).performClick()
        compose.onNodeWithText("2 / 2").assertIsDisplayed()
        compose.onNodeWithText("beta.png").assertIsDisplayed()
        compose.onNodeWithContentDescription(previous).assertIsEnabled().performClick()
        compose.onNodeWithText("1 / 2").assertIsDisplayed()
        compose.onNodeWithText("alpha.png").assertIsDisplayed()

        // The zoom controls act: + raises the percent, the percent resets.
        compose.onNodeWithContentDescription(zoomIn).performClick()
        compose.onNodeWithText("125%").assertIsDisplayed()
        compose.onNodeWithContentDescription(reset).performClick()
        compose.onNodeWithText("100%").assertIsDisplayed()
        assertTrue("test stays on the first page after zooming", harness.open)
    }
}
