package app.hapi.companion.ui.components

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size

/**
 * Pure zoom/pan arithmetic for the shared zoomable image viewer — the Android
 * twin of web `ImagePreview.tsx`'s constants and gesture math: scale range
 * 0.25–8 in 0.25 steps, free (unclamped) pan, pinch = scale relative to the
 * gesture's start distance with the finger midpoint following, and a backdrop
 * tap that closes only when the pointer barely moved (≤ 4 px of travel).
 *
 * Kept free of anything but Compose geometry types so it stays JVM-testable;
 * [ZoomableImageViewerDialog] is the (thin) UI shell over it.
 */
object ImageViewerMath {
    const val MIN_SCALE = 0.25f
    const val MAX_SCALE = 8f
    const val SCALE_STEP = 0.25f

    fun clampScale(scale: Float): Float = scale.coerceIn(MIN_SCALE, MAX_SCALE)

    /** Title-bar −/+ (web `zoomBy`): step, then clamp into the range. */
    fun zoomBy(scale: Float, delta: Float): Float = clampScale(scale + delta)

    /**
     * Pinch scale: relative to the gesture's start distance (web
     * `pinch.startScale * (distance / pinch.startDistance)`); a degenerate
     * start distance keeps the current scale.
     */
    fun pinchScale(startScale: Float, startDistance: Float, distance: Float): Float =
        if (startDistance > 0f) clampScale(startScale * (distance / startDistance)) else startScale

    /** Single-pointer drag: offset = origin + travel (web `dragRef`). */
    fun dragOffset(origin: Offset, start: Offset, position: Offset): Offset =
        Offset(origin.x + position.x - start.x, origin.y + position.y - start.y)

    /** Pinch: the offset tracks the finger midpoint's travel (web `pinchRef`). */
    fun pinchOffset(origin: Offset, startCenter: Offset, center: Offset): Offset =
        Offset(origin.x + center.x - startCenter.x, origin.y + center.y - startCenter.y)

    fun distance(a: Offset, b: Offset): Float = (a - b).getDistance()

    fun midpoint(a: Offset, b: Offset): Offset = Offset((a.x + b.x) / 2f, (a.y + b.y) / 2f)

    /** Backdrop tap closes only within [maxMovement] of travel (≤, like the web check). */
    fun isBackdropClick(movement: Float, maxMovement: Float): Boolean = movement <= maxMovement

    /** Reset-button label: `Math.round(scale * 100)` (web title bar percent). */
    fun zoomPercent(scale: Float): Int = Math.round(scale * 100f)

    /**
     * Size the image occupies inside [box] under `ContentScale.Fit` (centered
     * letterbox). Null when either size isn't usable yet — the image is still
     * loading, so hit-testing treats everything as backdrop (like the web's
     * collapsed `<img>` while `src` hasn't decoded).
     */
    fun fittedSize(intrinsic: Size, box: Size): Size? {
        if (intrinsic.width <= 0f || intrinsic.height <= 0f || box.width <= 0f || box.height <= 0f) return null
        val scale = minOf(box.width / intrinsic.width, box.height / intrinsic.height)
        return Size(intrinsic.width * scale, intrinsic.height * scale)
    }

    /**
     * On-screen rect of the fitted image after the viewer transform —
     * `translate(offset) scale(scale)` around the image center (CSS
     * `transform-origin: center center` in the web viewer). Pointer positions
     * inside this rect are "on the image" and never count as backdrop taps.
     */
    fun visualRect(box: Size, fitted: Size, scale: Float, offset: Offset): Rect {
        val centerX = box.width / 2f
        val centerY = box.height / 2f
        val halfWidth = fitted.width * scale / 2f
        val halfHeight = fitted.height * scale / 2f
        return Rect(
            left = centerX + offset.x - halfWidth,
            top = centerY + offset.y - halfHeight,
            right = centerX + offset.x + halfWidth,
            bottom = centerY + offset.y + halfHeight,
        )
    }
}
