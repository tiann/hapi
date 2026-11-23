package app.hapi.companion.ui.markdown

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * JVM tests for the mounted-view height state across render-spec changes.
 *
 * Regression shape of the pre-fix bug: `AndroidView.factory` runs only when
 * the Android view is created, so the height callback it installed captured
 * the state object minted by `remember(spec)` for the FIRST spec. Every later
 * LaTeX/color/font-size change minted a fresh state object while the retained
 * view kept writing the orphaned one, so the current block never grew past
 * its 22dp minimum. The holder keeps one stable state and resets it on spec
 * change, so the creation-time callback always feeds live state.
 */
class MathViewHeightStateTest {

    private fun spec(latex: String) =
        MathRenderSpec(latex, displayMode = true, textColorArgb = 0xFF000000.toInt(), fontSizePx = 16)

    @Test
    fun heightCallbackFeedsLiveStateAcrossSpecChangesOnTheSameView() {
        val state = MathViewHeightState()
        // One mounted view: its factory wires the JS bridge callback once and
        // the callback outlives every recomposition (mirrors AndroidView
        // retaining the view while update() swaps the spec).
        val mountedViewCallback: (Int) -> Unit = { px -> state.onHeightReported(px) }

        state.onRender(spec("E = mc^2"))
        mountedViewCallback(90)
        assertEquals(90, state.heightCssPx)

        // Same mounted view, new LaTeX: the creation-time callback must still
        // write the live state, not the orphaned first-spec state.
        state.onRender(spec("\\frac{1}{2}"))
        mountedViewCallback(140)
        assertEquals(140, state.heightCssPx)

        // And a third spec (theme color change) keeps the chain alive.
        state.onRender(spec("\\sqrt{2}"))
        mountedViewCallback(70)
        assertEquals(70, state.heightCssPx)
    }

    @Test
    fun specChangeResetsStaleHeightUntilTheNewDocumentMeasures() {
        val state = MathViewHeightState()
        state.onRender(spec("a"))
        state.onHeightReported(90)
        assertEquals(90, state.heightCssPx)

        state.onRender(spec("b"))
        assertEquals(0, state.heightCssPx, "a new spec must drop the stale height (min size applies while re-measuring)")

        // Re-renders of an identical spec (plain recomposition) keep the height.
        state.onHeightReported(120)
        state.onRender(spec("b"))
        assertEquals(120, state.heightCssPx)
    }

    @Test
    fun nonPositiveReportsAreIgnored() {
        val state = MathViewHeightState()
        state.onRender(spec("a"))
        state.onHeightReported(0)
        state.onHeightReported(-5)
        assertEquals(0, state.heightCssPx)
        state.onHeightReported(42)
        assertEquals(42, state.heightCssPx)
    }
}
