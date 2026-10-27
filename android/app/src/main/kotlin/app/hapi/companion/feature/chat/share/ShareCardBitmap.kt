package app.hapi.companion.feature.chat.share

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.text.TextPaint
import java.io.File
import kotlin.math.ceil

/**
 * Renders a positioned card onto a bitmap and writes it out as a PNG.
 *
 * All placement decisions happen in the pure layout engine; this layer only
 * owns paint metrics, drawing and file output, keeping the android surface
 * as thin as possible.
 */
object ShareCardBitmap {

    /** Fixed raster width; tall enough for crisp full-width previews. */
    const val CARD_WIDTH_PX = 1080

    private const val TITLE_SIZE = 46f
    private const val META_SIZE = 27f
    private const val BODY_SIZE = 31f
    private const val FOOTER_SIZE = 24f
    private const val LINE_HEIGHT_FACTOR = 1.24f

    private const val BACKGROUND = Color.WHITE
    private const val TITLE_INK = 0xFF111827.toInt()
    private const val META_INK = 0xFF6B7280.toInt()
    private const val USER_INK = 0xFF111827.toInt()
    private const val AGENT_INK = 0xFF1F2937.toInt()
    private const val FOOTER_INK = 0xFF9CA3AF.toInt()
    private const val BUBBLE_FILL = 0xFFEFF2F5.toInt()
    private const val RULE_INK = 0xFFE5E7EB.toInt()

    /** Cache folder for shared card images, cleaned of day-old leftovers. */
    private const val CACHE_DIR_NAME = "share-images"
    private const val CACHE_LIFETIME_MS = 86_400_000L

    /** Paint-backed metrics for the layout engine. */
    fun createMeasurer(): ShareTextMeasurer {
        val paints = ShareCardTextStyle.entries.associateWith { style ->
            TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
                textSize = when (style) {
                    ShareCardTextStyle.TITLE -> TITLE_SIZE
                    ShareCardTextStyle.META -> META_SIZE
                    ShareCardTextStyle.USER, ShareCardTextStyle.AGENT -> BODY_SIZE
                    ShareCardTextStyle.FOOTER -> FOOTER_SIZE
                }
                isFakeBoldText = style == ShareCardTextStyle.TITLE
                color = inkFor(style)
            }
        }
        return object : ShareTextMeasurer {
            override fun measureText(text: String, style: ShareCardTextStyle): Float =
                paints.getValue(style).measureText(text)

            override fun lineHeight(style: ShareCardTextStyle): Float =
                paints.getValue(style).textSize * LINE_HEIGHT_FACTOR
        }
    }

    /** Draw [layout] into a new bitmap. */
    fun renderBitmap(layout: ShareCard): Bitmap {
        val bitmap = Bitmap.createBitmap(
            layout.width.toInt(),
            ceil(layout.height).toInt().coerceAtLeast(1),
            Bitmap.Config.ARGB_8888,
        )
        val canvas = Canvas(bitmap)
        canvas.drawColor(BACKGROUND)
        val bubblePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = BUBBLE_FILL }
        layout.bubbles.forEach { bubble ->
            canvas.drawRoundRect(
                RectF(bubble.left, bubble.top, bubble.right, bubble.bottom),
                bubble.radius, bubble.radius, bubblePaint,
            )
        }
        val textPaints = ShareCardTextStyle.entries.associateWith { style ->
            Paint(Paint.ANTI_ALIAS_FLAG).apply {
                textSize = when (style) {
                    ShareCardTextStyle.TITLE -> TITLE_SIZE
                    ShareCardTextStyle.META -> META_SIZE
                    ShareCardTextStyle.USER, ShareCardTextStyle.AGENT -> BODY_SIZE
                    ShareCardTextStyle.FOOTER -> FOOTER_SIZE
                }
                isFakeBoldText = style == ShareCardTextStyle.TITLE
                color = inkFor(style)
            }
        }
        layout.lines.forEach { line ->
            val paint = textPaints.getValue(line.style)
            val metrics = paint.fontMetrics
            val baseline = line.top +
                (measurerLineHeight(line.style) - metrics.descent - metrics.ascent) / 2f
            canvas.drawText(line.text, line.left, baseline, paint)
        }
        val rule = Paint().apply { color = RULE_INK; strokeWidth = 2f }
        val inset = layout.width * 0.044f
        canvas.drawLine(inset, layout.dividerTop, layout.width - inset, layout.dividerTop, rule)
        return bitmap
    }

    /**
     * Write [bitmap] as a PNG under the share-image cache directory and
     * return it. Stale leftovers from previous shares are removed first.
     */
    fun writePng(context: Context, bitmap: Bitmap, fileName: String): File {
        val directory = File(context.cacheDir, CACHE_DIR_NAME).apply { mkdirs() }
        val cutoff = System.currentTimeMillis() - CACHE_LIFETIME_MS
        directory.listFiles()?.forEach { file ->
            if (file.isFile && file.lastModified() < cutoff) file.delete()
        }
        val target = File(directory, fileName)
        target.outputStream().use { output ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
        }
        return target
    }

    private fun measurerLineHeight(style: ShareCardTextStyle): Float = when (style) {
        ShareCardTextStyle.TITLE -> TITLE_SIZE * LINE_HEIGHT_FACTOR
        ShareCardTextStyle.META -> META_SIZE * LINE_HEIGHT_FACTOR
        ShareCardTextStyle.USER, ShareCardTextStyle.AGENT -> BODY_SIZE * LINE_HEIGHT_FACTOR
        ShareCardTextStyle.FOOTER -> FOOTER_SIZE * LINE_HEIGHT_FACTOR
    }

    private fun inkFor(style: ShareCardTextStyle): Int = when (style) {
        ShareCardTextStyle.TITLE -> TITLE_INK
        ShareCardTextStyle.META -> META_INK
        ShareCardTextStyle.USER -> USER_INK
        ShareCardTextStyle.AGENT -> AGENT_INK
        ShareCardTextStyle.FOOTER -> FOOTER_INK
    }
}
