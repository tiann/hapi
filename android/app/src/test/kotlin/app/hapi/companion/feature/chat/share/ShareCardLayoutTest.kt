package app.hapi.companion.feature.chat.share

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ShareCardLayoutTest {

    /** Deterministic metrics: every character is [charWidth] wide. */
    private class FakeMeasurer(private val charWidth: Float = 10f) : ShareTextMeasurer {
        override fun measureText(text: String, style: ShareCardTextStyle): Float =
            text.length * charWidth

        override fun lineHeight(style: ShareCardTextStyle): Float = when (style) {
            ShareCardTextStyle.TITLE -> 20f
            ShareCardTextStyle.META -> 12f
            ShareCardTextStyle.USER, ShareCardTextStyle.AGENT -> 14f
            ShareCardTextStyle.FOOTER -> 10f
        }
    }

    private fun segment(role: String, text: String) =
        ShareTurnSegment(role, ShareTurnSegmentKind.TEXT, text)

    // -------------------------------------------------------------- wrap --

    @Test fun wordsFillLinesGreedily() {
        val lines = ShareCardLayout.wrapText("aaa bb cc", 50f, ShareCardTextStyle.AGENT, FakeMeasurer())
        assertEquals(listOf("aaa", "bb cc"), lines)
    }

    @Test fun oversizedWordsSplitByCharacter() {
        val lines = ShareCardLayout.wrapText("abcdefghijkl", 50f, ShareCardTextStyle.AGENT, FakeMeasurer())
        assertEquals(listOf("abcde", "fghij", "kl"), lines)
    }

    @Test fun oversizedWordAfterAFittingWordStartsAFreshLine() {
        val lines = ShareCardLayout.wrapText("ab cdefghij", 50f, ShareCardTextStyle.AGENT, FakeMeasurer())
        assertEquals(listOf("ab", "cdefg", "hij"), lines)
    }

    @Test fun paragraphBreaksSurviveWrapping() {
        val lines = ShareCardLayout.wrapText("first\n\nsecond", 500f, ShareCardTextStyle.AGENT, FakeMeasurer())
        assertEquals(listOf("first", "", "second"), lines)
    }

    @Test fun unspacedScriptsWrapByCharacter() {
        val text = "一二三四五"
        val lines = ShareCardLayout.wrapText(text, 20f, ShareCardTextStyle.AGENT, FakeMeasurer())
        assertEquals(listOf("一二", "三四", "五"), lines)
    }

    // ------------------------------------------------------------ layout --

    @Test fun headerBodyAndFooterLandInsideTheCard() {
        val measurer = FakeMeasurer()
        val metrics = ShareCardMetrics(width = 1080f)
        val layout = ShareCardLayout.layoutShareCard(
            title = "Session title",
            metadataLabels = listOf("Codex", "MacBook"),
            segments = listOf(segment("user", "the question"), segment("assistant", "the answer")),
            measurer = measurer,
            metrics = metrics,
        )

        val contentRight = layout.width - metrics.padding
        val titleLines = layout.lines.filter { it.style == ShareCardTextStyle.TITLE }
        val captionLines = layout.lines.filter { it.style == ShareCardTextStyle.META }
        val userLines = layout.lines.filter { it.style == ShareCardTextStyle.USER }
        val agentLines = layout.lines.filter { it.style == ShareCardTextStyle.AGENT }
        val footerLines = layout.lines.filter { it.style == ShareCardTextStyle.FOOTER }

        // Header at the top-left, in order.
        assertTrue(titleLines.first().left == metrics.padding && titleLines.first().top == metrics.padding)
        assertTrue(captionLines.first().top > titleLines.last().top)

        // One bubble per user segment, right-aligned, containing its lines.
        assertEquals(1, layout.bubbles.size)
        val bubble = layout.bubbles.single()
        assertEquals(contentRight, bubble.right)
        assertTrue(userLines.all { it.left >= bubble.left && it.left + measurer.measureText(it.text, it.style) <= bubble.right })
        assertTrue(userLines.all { it.top >= bubble.top && it.top + measurer.lineHeight(it.style) <= bubble.bottom })

        // Assistant text opens at the left margin under the bubble.
        assertTrue(agentLines.all { it.left == metrics.padding })
        assertTrue(agentLines.first().top >= bubble.bottom)

        // Footer right-aligned above the bottom edge, rule above the text.
        val footer = footerLines.single()
        assertEquals(contentRight, footer.left + measurer.measureText(footer.text, ShareCardTextStyle.FOOTER))
        assertTrue(layout.dividerTop < footer.top)
        assertTrue(footer.top + measurer.lineHeight(ShareCardTextStyle.FOOTER) <= layout.height)
        assertEquals(false, layout.truncated)
    }

    @Test fun everyLineStaysWithinTheContentWidth() {
        val measurer = FakeMeasurer()
        val layout = ShareCardLayout.layoutShareCard(
            title = "t",
            metadataLabels = listOf("a"),
            segments = listOf(
                segment("user", "x".repeat(400)),
                segment("assistant", "y".repeat(400)),
            ),
            measurer = measurer,
        )
        val contentRight = layout.width - ShareCardMetrics(width = 1080f).padding
        assertTrue(layout.lines.all { it.left + measurer.measureText(it.text, it.style) <= contentRight + 0.5f })
    }

    @Test fun longTurnsCutOffInsteadOfGrowingUnbounded() {
        val measurer = FakeMeasurer()
        val segments = (0 until 200).map { segment("assistant", "line number $it") }
        val layout = ShareCardLayout.layoutShareCard(
            title = "t",
            metadataLabels = emptyList(),
            segments = segments,
            measurer = measurer,
            maxHeightPx = 600f,
        )
        assertTrue(layout.truncated)
        assertTrue(layout.height <= 600f + 100f)
        assertTrue(layout.lines.any { it.style == ShareCardTextStyle.AGENT && it.text == "…" })
        // Far from all two hundred segments made it onto the card.
        assertTrue(layout.lines.count { it.style == ShareCardTextStyle.AGENT && it.text != "…" } < 200)
    }

    @Test fun emptyTurnsStillProduceAHeaderAndFooter() {
        val layout = ShareCardLayout.layoutShareCard(
            title = "Empty session",
            metadataLabels = emptyList(),
            segments = emptyList(),
            measurer = FakeMeasurer(),
        )
        assertTrue(layout.lines.any { it.style == ShareCardTextStyle.TITLE })
        assertTrue(layout.lines.any { it.style == ShareCardTextStyle.FOOTER })
        assertTrue(layout.bubbles.isEmpty())
        assertEquals(false, layout.truncated)
    }
}
