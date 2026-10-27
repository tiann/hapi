package app.hapi.companion.feature.chat.share

/**
 * Text roles on a shared card. User and assistant body text share metrics
 * but carry different ink; the split keeps color decisions out of the
 * layout math.
 */
enum class ShareCardTextStyle { TITLE, META, USER, AGENT, FOOTER }

/**
 * Text metrics source for layout. The card layout runs against this
 * interface, so pure tests feed it a fake and the renderer feeds it real
 * paint measurements.
 */
interface ShareTextMeasurer {
    /** Rendered width of [text] under [style]. */
    fun measureText(text: String, style: ShareCardTextStyle): Float

    /** Vertical advance of one line under [style]. */
    fun lineHeight(style: ShareCardTextStyle): Float
}

/** Card geometry in pixels. */
data class ShareCardMetrics(
    val width: Float,
    val padding: Float = 48f,
    val titleCaptionGap: Float = 12f,
    val captionBodyGap: Float = 40f,
    val segmentGap: Float = 28f,
    val bubblePaddingX: Float = 28f,
    val bubblePaddingY: Float = 22f,
    val bubbleRadius: Float = 22f,
    val bubbleMaxWidthFraction: Float = 0.85f,
    val footerGap: Float = 44f,
    val footerTextGap: Float = 22f,
)

/** One placed text run: box top-left corner plus its role. */
data class ShareCardLine(
    val text: String,
    val style: ShareCardTextStyle,
    val left: Float,
    val top: Float,
)

/** Rounded rectangle behind a user message. */
data class ShareCardBubble(
    val left: Float,
    val top: Float,
    val right: Float,
    val bottom: Float,
    val radius: Float,
)

/** Fully positioned card: draw bubbles' rounded rects, then text lines, then the footer rule. */
data class ShareCard(
    val width: Float,
    val height: Float,
    val lines: List<ShareCardLine>,
    val bubbles: List<ShareCardBubble>,
    /** Y of the footer divider rule. */
    val dividerTop: Float,
    val truncated: Boolean,
)

/**
 * Layout engine for the shared card: wraps and positions every text run.
 * Greedy word wrap with character fallback keeps unspaced scripts and long
 * tokens inside the card; body segments are placed whole while the height
 * budget allows, an oversize leading segment is clipped to the lines that
 * fit, and the card stops early (marking itself truncated) once the budget
 * runs out, so huge turns cannot produce an unbounded bitmap.
 */
object ShareCardLayout {

    /** Sanity ceiling for very long turns; body content beyond it is cut. */
    const val DEFAULT_MAX_HEIGHT_PX = 9_000f

    /** Ellipsis run appended when body content was cut off. */
    private const val ELLIPSIS = "…"

    /**
     * Wrap [text] to [maxWidth] under [style]: paragraphs split on
     * newlines, lines fill greedily by words, and tokens wider than the
     * line break by character.
     */
    fun wrapText(
        text: String,
        maxWidth: Float,
        style: ShareCardTextStyle,
        measurer: ShareTextMeasurer,
    ): List<String> {
        if (maxWidth <= 0f) return listOf(text)
        val out = mutableListOf<String>()
        for (paragraph in text.split('\n')) {
            if (paragraph.isBlank()) {
                out.add("")
                continue
            }
            var line = ""
            for (word in paragraph.split(' ').filter { it.isNotEmpty() }) {
                val candidate = if (line.isEmpty()) word else "$line $word"
                if (measurer.measureText(candidate, style) <= maxWidth) {
                    line = candidate
                    continue
                }
                if (line.isNotEmpty()) {
                    out.add(line)
                    line = ""
                }
                var remainder = word
                while (remainder.length > 1 && measurer.measureText(remainder, style) > maxWidth) {
                    var cut = remainder.length - 1
                    while (cut > 1 && measurer.measureText(remainder.substring(0, cut), style) > maxWidth) {
                        cut--
                    }
                    out.add(remainder.substring(0, cut))
                    remainder = remainder.substring(cut)
                }
                line = remainder
            }
            out.add(line)
        }
        return out
    }

    /**
     * Position the whole card. The header (title + caption line) always
     * renders; body segments are added while they fit whole under
     * [maxHeightPx] (footer space reserved), a lone segment too tall for
     * the whole budget is clipped to the lines that fit, and an ellipsis
     * run closes a cut card. [footerText] renders right-aligned under the
     * closing rule.
     */
    fun layoutShareCard(
        title: String,
        metadataLabels: List<String>,
        segments: List<ShareTurnSegment>,
        measurer: ShareTextMeasurer,
        metrics: ShareCardMetrics = ShareCardMetrics(width = 1080f),
        maxHeightPx: Float = DEFAULT_MAX_HEIGHT_PX,
        footerText: String = FOOTER_TEXT,
    ): ShareCard {
        val lines = mutableListOf<ShareCardLine>()
        val bubbles = mutableListOf<ShareCardBubble>()
        val contentWidth = metrics.width - 2 * metrics.padding
        val bubbleMaxWidth = contentWidth * metrics.bubbleMaxWidthFraction

        var y = metrics.padding
        for (piece in wrapText(title.trim().ifEmpty { ELLIPSIS }, contentWidth, ShareCardTextStyle.TITLE, measurer)) {
            lines += ShareCardLine(piece, ShareCardTextStyle.TITLE, metrics.padding, y)
            y += measurer.lineHeight(ShareCardTextStyle.TITLE)
        }
        if (metadataLabels.isNotEmpty()) {
            y += metrics.titleCaptionGap
            val caption = metadataLabels.joinToString(" · ")
            for (piece in wrapText(caption, contentWidth, ShareCardTextStyle.META, measurer)) {
                lines += ShareCardLine(piece, ShareCardTextStyle.META, metrics.padding, y)
                y += measurer.lineHeight(ShareCardTextStyle.META)
            }
        }

        var truncated = false
        var placedAnyBody = false
        if (segments.isNotEmpty()) {
            y += metrics.captionBodyGap
            val bodyLineHeight = measurer.lineHeight(ShareCardTextStyle.USER)
            val bodyBudget = maxHeightPx - footerReserve(metrics, measurer)
            for (segment in segments) {
                val isUser = segment.role == "user"
                val style = if (isUser) ShareCardTextStyle.USER else ShareCardTextStyle.AGENT
                val maxWidth = if (isUser) bubbleMaxWidth else contentWidth
                val wrapped = wrapText(segment.text, maxWidth, style, measurer)
                    .filterNot { it.isEmpty() }
                if (wrapped.isEmpty()) continue
                val gap = if (placedAnyBody) metrics.segmentGap else 0f
                val segmentHeight = wrapped.size * bodyLineHeight +
                    if (isUser) 2 * metrics.bubblePaddingY else 0f
                if (placedAnyBody && y + gap + segmentHeight > bodyBudget) {
                    truncated = true
                    break
                }
                var placedLines = wrapped
                if (!placedAnyBody && y + gap + segmentHeight > bodyBudget) {
                    // A single oversize leading segment is clipped to the
                    // lines that fit (reserving space for the ellipsis run)
                    // instead of overflowing the cap, so the closing rule
                    // and footer survive inside [maxHeightPx].
                    val paddingY = if (isUser) 2 * metrics.bubblePaddingY else 0f
                    val clipBudget = bodyBudget - (y + gap) -
                        (metrics.segmentGap + bodyLineHeight) - paddingY
                    val fitCount = (clipBudget / bodyLineHeight).toInt().coerceAtLeast(1)
                    placedLines = wrapped.take(fitCount)
                    truncated = true
                }
                val placedHeight = placedLines.size * bodyLineHeight +
                    if (isUser) 2 * metrics.bubblePaddingY else 0f
                y += gap
                if (isUser) {
                    val widest = placedLines.maxOf { measurer.measureText(it, style) }
                    val bubbleWidth = (widest + 2 * metrics.bubblePaddingX)
                        .coerceAtMost(contentWidth)
                    val bubbleLeft = metrics.width - metrics.padding - bubbleWidth
                    bubbles += ShareCardBubble(
                        left = bubbleLeft,
                        top = y,
                        right = bubbleLeft + bubbleWidth,
                        bottom = y + placedHeight,
                        radius = metrics.bubbleRadius,
                    )
                    placedLines.forEachIndexed { index, piece ->
                        lines += ShareCardLine(
                            piece, style,
                            bubbleLeft + metrics.bubblePaddingX,
                            y + metrics.bubblePaddingY + index * bodyLineHeight,
                        )
                    }
                } else {
                    placedLines.forEachIndexed { index, piece ->
                        lines += ShareCardLine(piece, style, metrics.padding, y + index * bodyLineHeight)
                    }
                }
                y += placedHeight
                placedAnyBody = true
                if (truncated) break
            }
            if (truncated) {
                y += metrics.segmentGap
                lines += ShareCardLine(ELLIPSIS, ShareCardTextStyle.AGENT, metrics.padding, y)
                y += bodyLineHeight
            }
        }

        y += metrics.footerGap
        val dividerTop = y
        y += metrics.footerTextGap
        lines += ShareCardLine(
            footerText, ShareCardTextStyle.FOOTER,
            metrics.width - metrics.padding - measurer.measureText(footerText, ShareCardTextStyle.FOOTER),
            y,
        )
        y += measurer.lineHeight(ShareCardTextStyle.FOOTER) + metrics.padding
        return ShareCard(
            width = metrics.width,
            height = y.coerceAtMost(maxHeightPx),
            lines = lines,
            bubbles = bubbles,
            dividerTop = dividerTop,
            truncated = truncated,
        )
    }

    /** Space the footer (rule + run + closing padding) needs at the bottom. */
    private fun footerReserve(metrics: ShareCardMetrics, measurer: ShareTextMeasurer): Float =
        metrics.footerGap + metrics.footerTextGap +
            measurer.lineHeight(ShareCardTextStyle.FOOTER) + metrics.padding

    private const val FOOTER_TEXT = "Generated by HAPI"
}
