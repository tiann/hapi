package app.hapi.companion.feature.settings

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.hapi.companion.R
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Daily token bars on a plain [Canvas] (no chart library by design — plan
 * track B). Single series, one hue; rounded data-ends anchored to a hairline
 * baseline; recessive max/mid gridlines; first/mid/last day labels. Tapping a
 * bar selects it and floats a tooltip with the day's numbers; tapping it
 * again (or the chart padding) clears the selection.
 */
@Composable
fun DailyBarChart(
    bars: List<UsageMath.DailyBar>,
    modifier: Modifier = Modifier,
    chartHeight: Dp = 168.dp,
) {
    var selectedIndex by remember(bars) { mutableStateOf<Int?>(null) }
    var plotSize by remember { mutableStateOf(IntSize.Zero) }
    var tooltipSize by remember { mutableStateOf(IntSize.Zero) }

    val barColor = MaterialTheme.colorScheme.primary
    val gridColor = MaterialTheme.colorScheme.outlineVariant
    val labelColor = MaterialTheme.colorScheme.onSurfaceVariant
    val labelStyle = TextStyle(color = labelColor, fontSize = 10.sp)
    val textMeasurer = rememberTextMeasurer()

    val maxTokens = max(bars.maxOfOrNull { it.totalTokens } ?: 0L, 1L)
    val density = LocalDensity.current
    val labelRowPx = with(density) { LABEL_ROW_HEIGHT.toPx() }

    Box(modifier = modifier.fillMaxWidth()) {
        Canvas(
            modifier = Modifier
                .fillMaxWidth()
                .height(chartHeight)
                .onSizeChanged { plotSize = it }
                .pointerInput(bars) {
                    detectTapGestures { offset ->
                        val index = UsageMath.barIndexAt(offset.x, size.width.toFloat(), bars.size)
                        selectedIndex = if (index == selectedIndex) null else index
                    }
                },
        ) {
            drawDailyBars(
                bars = bars,
                maxTokens = maxTokens,
                selectedIndex = selectedIndex,
                plotBottomInset = labelRowPx,
                barColor = barColor,
                gridColor = gridColor,
                labelStyle = labelStyle,
                textMeasurer = textMeasurer,
            )
        }

        val index = selectedIndex
        if (index != null && index < bars.size && plotSize.width > 0) {
            val slot = plotSize.width.toFloat() / bars.size
            val centerX = slot * (index + 0.5f)
            val offsetX = (centerX - tooltipSize.width / 2f)
                .coerceIn(0f, max(0f, (plotSize.width - tooltipSize.width).toFloat()))
            DayTooltip(
                bar = bars[index],
                modifier = Modifier
                    .onSizeChanged { tooltipSize = it }
                    .offset { IntOffset(offsetX.roundToInt(), 0) },
            )
        }
    }
}

@Composable
private fun DayTooltip(bar: UsageMath.DailyBar, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier,
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        tonalElevation = 2.dp,
        shadowElevation = 2.dp,
    ) {
        Column(modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
            Text(
                text = bar.key,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            val bucket = bar.bucket
            Text(
                text = if (bucket == null) {
                    stringResource(R.string.settings_usage_tooltip_empty)
                } else {
                    stringResource(
                        R.string.settings_usage_tooltip,
                        UsageMath.formatTokens(bucket.totalTokens),
                        bucket.requests,
                        UsageMath.formatTokens(bucket.inputTokens),
                        UsageMath.formatTokens(bucket.outputTokens),
                    )
                },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

private fun DrawScope.drawDailyBars(
    bars: List<UsageMath.DailyBar>,
    maxTokens: Long,
    selectedIndex: Int?,
    plotBottomInset: Float,
    barColor: Color,
    gridColor: Color,
    labelStyle: TextStyle,
    textMeasurer: TextMeasurer,
) {
    if (bars.isEmpty()) return
    val plotHeight = size.height - plotBottomInset
    if (plotHeight <= 0f) return
    val baselineY = plotHeight

    // Recessive scale: hairline baseline + max/mid gridlines with value labels.
    drawLine(gridColor, Offset(0f, baselineY), Offset(size.width, baselineY), strokeWidth = 1.dp.toPx())
    val topPad = 14.dp.toPx() // room for the max label above its gridline
    for ((fraction, value) in listOf(1f to maxTokens, 0.5f to maxTokens / 2)) {
        val y = baselineY - (plotHeight - topPad) * fraction
        drawLine(gridColor.copy(alpha = 0.5f), Offset(0f, y), Offset(size.width, y), strokeWidth = 1f)
        drawText(
            textMeasurer = textMeasurer,
            text = UsageMath.formatTokens(value),
            topLeft = Offset(0f, (y - 12.sp.toPx()).coerceAtLeast(0f)),
            style = labelStyle,
        )
    }

    val slot = size.width / bars.size
    val gap = max(2.dp.toPx(), slot * 0.15f).coerceAtMost(slot / 2)
    val barWidth = max(slot - gap, 1f)
    val corner = CornerRadius(min(4.dp.toPx(), barWidth / 2f), min(4.dp.toPx(), barWidth / 2f))

    bars.forEachIndexed { index, bar ->
        if (bar.totalTokens <= 0) return@forEachIndexed
        val barHeight = max(
            (plotHeight - topPad) * (bar.totalTokens.toFloat() / maxTokens),
            2.dp.toPx(),
        )
        val left = slot * index + (slot - barWidth) / 2f
        val dimmed = selectedIndex != null && selectedIndex != index
        // Rounded data-end at the top, flat edge on the baseline.
        val path = Path().apply {
            addRoundRect(
                RoundRect(
                    rect = Rect(
                        offset = Offset(left, baselineY - barHeight),
                        size = Size(barWidth, barHeight),
                    ),
                    topLeft = corner,
                    topRight = corner,
                    bottomLeft = CornerRadius.Zero,
                    bottomRight = CornerRadius.Zero,
                ),
            )
        }
        drawPath(path, color = if (dimmed) barColor.copy(alpha = 0.45f) else barColor)
    }

    // First / middle / last day labels, clamped into the canvas.
    val labelIndexes = buildSet {
        add(0)
        add(bars.lastIndex)
        if (bars.size >= 5) add(bars.size / 2)
    }
    for (index in labelIndexes) {
        val text = UsageMath.shortDayLabel(bars[index].key)
        val measured = textMeasurer.measure(text, labelStyle)
        val centerX = slot * (index + 0.5f)
        val x = (centerX - measured.size.width / 2f)
            .coerceIn(0f, max(0f, size.width - measured.size.width))
        drawText(
            textMeasurer = textMeasurer,
            text = text,
            topLeft = Offset(x, baselineY + 4.dp.toPx()),
            style = labelStyle,
        )
    }
}

private val LABEL_ROW_HEIGHT: Dp = 20.dp
