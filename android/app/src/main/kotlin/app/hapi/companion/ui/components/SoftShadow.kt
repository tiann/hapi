package app.hapi.companion.ui.components

import android.graphics.Paint
import androidx.compose.ui.draw.CacheDrawScope
import androidx.compose.ui.draw.DrawResult
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Even, diffuse drop shadow for a rounded card (iOS `.shadow(color:radius:y:)`).
 *
 * Material elevation shadows are lit from above the screen, so near the
 * bottom edge they fall heavily below the card and read as a smudge under a
 * hairline-bordered surface; this draws one blurred copy of the card shape
 * instead. [fill] must be the card's own opaque color (it is painted under
 * the card). Hardware-accelerated shape shadow layers need API 28; older
 * devices simply draw no shadow and keep the hairline border.
 *
 * Draws outside the node's bounds: ancestors must not clip (a material3
 * `Surface` clips its content), or the blur is cut into a hard edge.
 *
 * Use as `Modifier.drawWithCache { softShadow(...) }` (the paint is rebuilt
 * only on size changes). Deliberately not a `Modifier` factory: this AGP's
 * Compose lint `ModifierDeclarationDetector` crashes on app-module factories.
 */
fun CacheDrawScope.softShadow(
    fill: Color,
    cornerRadius: Dp,
    shadowColor: Color = Color.Black.copy(alpha = 0.08f),
    blur: Dp = 8.dp,
    offsetY: Dp = 2.dp,
): DrawResult {
    val radius = cornerRadius.toPx()
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = fill.toArgb()
        setShadowLayer(blur.toPx(), 0f, offsetY.toPx(), shadowColor.toArgb())
    }
    return onDrawBehind {
        drawIntoCanvas { canvas ->
            canvas.nativeCanvas.drawRoundRect(0f, 0f, size.width, size.height, radius, radius, paint)
        }
    }
}
