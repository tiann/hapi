package app.hapi.companion.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.isSpecified
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.hapi.companion.R
import coil.ImageLoader
import coil.compose.AsyncImage
import coil.compose.AsyncImagePainter

/** Web `BACKDROP_CLICK_MAX_MOVEMENT` (4 px ≈ 4 dp) for backdrop tap-to-close. */
private val BackdropClickMaxMovement = 4.dp

/** Transient gesture bookkeeping (the web component's pointer refs). */
private class DragGesture(val pointerId: Long, val start: Offset, val origin: Offset)

private class PinchGesture(
    val startDistance: Float,
    val startScale: Float,
    val startCenter: Offset,
    val origin: Offset,
)

private class BackdropPress(val pointerId: Long, val start: Offset)

/** What the viewer renders for one gallery entry. */
@Immutable
sealed interface ZoomableImageContent {
    /**
     * Anything Coil can load — hub URL strings (generated images, scratchlist
     * attachments) or raw [ByteArray]s (files viewer); `imageLoader` may carry
     * the per-hub authed loader (null falls back to the context loader). SVG
     * documents decode when that loader has `SvgDecoder` registered, matching
     * the web's `<img src>` treatment.
     */
    @Immutable
    data class Loaded(val model: Any, val imageLoader: ImageLoader? = null) : ZoomableImageContent

    /** An already-decoded bitmap (e.g. wire `previewUrl` bubble thumbnails). */
    @Immutable
    data class Decoded(val bitmap: ImageBitmap) : ZoomableImageContent
}

@Immutable
data class ZoomableImage(
    val content: ZoomableImageContent,
    val fileName: String,
)

/**
 * Full-screen zoomable image viewer, the Android take on web
 * `ImagePreview.tsx`: a title bar (truncated file name, optional ←/→ paging
 * with an "n / N" counter, − / percent-reset / + zoom buttons, close) over a
 * canvas that pinches (0.25–8×), pans, double-taps to reset, and closes on a
 * backdrop tap that barely moved. Paging resets the view, like the web.
 *
 * The web assembles galleries by scanning the DOM for triggers sharing a
 * `galleryId`; that registry has no Android equivalent, so callers pass the
 * [images] list and [initialIndex] explicitly (single-image call sites pass
 * one entry and get no paging chrome, matching the 1-image web gallery).
 */
@Composable
fun ZoomableImageViewerDialog(
    images: List<ZoomableImage>,
    onDismiss: () -> Unit,
    initialIndex: Int = 0,
) {
    if (images.isEmpty()) return
    var index by remember { mutableIntStateOf(initialIndex.coerceIn(0, images.lastIndex)) }
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var intrinsic by remember { mutableStateOf<Size?>(null) }

    val current = images[index]
    LaunchedEffect(current) {
        intrinsic = when (val content = current.content) {
            is ZoomableImageContent.Decoded ->
                Size(content.bitmap.width.toFloat(), content.bitmap.height.toFloat())
            is ZoomableImageContent.Loaded -> null
        }
    }

    fun resetView() {
        scale = 1f
        offset = Offset.Zero
    }

    fun showImage(next: Int) {
        index = next.coerceIn(0, images.lastIndex)
        resetView()
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 0.9f)),
        ) {
            ZoomableTitleBar(
                fileName = current.fileName,
                index = index,
                count = images.size,
                scale = scale,
                onPrev = { showImage(index - 1) },
                onNext = { showImage(index + 1) },
                onZoomOut = { scale = ImageViewerMath.zoomBy(scale, -ImageViewerMath.SCALE_STEP) },
                onZoomIn = { scale = ImageViewerMath.zoomBy(scale, ImageViewerMath.SCALE_STEP) },
                onReset = { resetView() },
                onClose = onDismiss,
            )
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    // Unit-keyed on purpose: the gesture state lives in the
                    // composable states (scale/offset/intrinsic), so a parent
                    // recomposition must not cancel an in-flight pinch.
                    .pointerInput(Unit) {
                        val backdropMaxMovement = BackdropClickMaxMovement.toPx()
                        val doubleTapTimeoutMillis = viewConfiguration.doubleTapTimeoutMillis
                        val tapMaxMovement = viewConfiguration.touchSlop
                        var drag: DragGesture? = null
                        var pinch: PinchGesture? = null
                        var backdropPress: BackdropPress? = null
                        var lastTapAt = -1L

                        fun overImage(position: Offset): Boolean {
                            val intrinsicSize = intrinsic ?: return false
                            val box = Size(size.width.toFloat(), size.height.toFloat())
                            val fitted = ImageViewerMath.fittedSize(intrinsicSize, box) ?: return false
                            return ImageViewerMath.visualRect(box, fitted, scale, offset).contains(position)
                        }

                        fun beginPinch(pointers: Map<Long, Offset>) {
                            val iterator = pointers.entries.iterator()
                            val first = iterator.next()
                            val second = iterator.next()
                            pinch = PinchGesture(
                                startDistance = ImageViewerMath.distance(first.value, second.value),
                                startScale = scale,
                                startCenter = ImageViewerMath.midpoint(first.value, second.value),
                                origin = offset,
                            )
                            drag = null
                            backdropPress = null
                        }

                        fun pointerUp(
                            change: PointerInputChange,
                            pointers: LinkedHashMap<Long, Offset>,
                            gestureStart: Offset,
                            isRelease: Boolean,
                        ) {
                            // The web checks the backdrop close BEFORE dropping the
                            // pointer (map size 1 == this was the only finger).
                            val press = backdropPress
                            if (press != null && press.pointerId == change.id.value &&
                                pointers.size == 1 && isRelease &&
                                ImageViewerMath.isBackdropClick(
                                    ImageViewerMath.distance(change.position, press.start),
                                    backdropMaxMovement,
                                )
                            ) {
                                onDismiss()
                                return
                            }
                            pointers.remove(change.id.value)
                            if (backdropPress?.pointerId == change.id.value) backdropPress = null
                            if (drag?.pointerId == change.id.value) drag = null
                            if (pointers.size == 1) {
                                // Remaining finger picks up the pan (web does the same).
                                pinch = null
                                val remaining = pointers.entries.first()
                                drag = DragGesture(remaining.key, remaining.value, offset)
                            } else if (pointers.isEmpty()) {
                                pinch = null
                                // Double-tap on the image resets (web onDoubleClick).
                                if (isRelease &&
                                    ImageViewerMath.isBackdropClick(
                                        ImageViewerMath.distance(change.position, gestureStart),
                                        tapMaxMovement,
                                    ) &&
                                    overImage(change.position)
                                ) {
                                    val now = change.uptimeMillis
                                    if (lastTapAt >= 0 && now - lastTapAt <= doubleTapTimeoutMillis) {
                                        scale = 1f
                                        offset = Offset.Zero
                                        lastTapAt = -1L
                                    } else {
                                        lastTapAt = now
                                    }
                                }
                            }
                        }

                        awaitEachGesture {
                            val firstDown = awaitFirstDown(requireUnconsumed = false)
                            val pointers = LinkedHashMap<Long, Offset>()
                            pointers[firstDown.id.value] = firstDown.position
                            val gestureStart = firstDown.position
                            // Only a press on the exposed backdrop is a close candidate.
                            backdropPress = if (!overImage(firstDown.position)) {
                                BackdropPress(firstDown.id.value, firstDown.position)
                            } else {
                                null
                            }
                            drag = DragGesture(firstDown.id.value, firstDown.position, offset)
                            pinch = null

                            var gestureEnded = false
                            while (!gestureEnded) {
                                val event = awaitPointerEvent()
                                val isRelease = event.type == PointerEventType.Release
                                val lifted = ArrayList<PointerInputChange>()
                                for (change in event.changes) {
                                    if (change.pressed) {
                                        pointers.putIfAbsent(change.id.value, change.position)
                                        if (pointers.size >= 2 && pinch == null) beginPinch(pointers)
                                    } else if (pointers.containsKey(change.id.value)) {
                                        lifted.add(change)
                                    }
                                }
                                if (lifted.isNotEmpty()) {
                                    // Compose has no cancel event type — cancelled streams
                                    // arrive as all-up changes, handled like ups (release-only
                                    // affordances just check [isRelease]).
                                    for (change in lifted) {
                                        pointerUp(change, pointers, gestureStart, isRelease)
                                    }
                                } else {
                                    for (change in event.changes) {
                                        if (change.pressed) pointers[change.id.value] = change.position
                                    }
                                    val activePinch = pinch
                                    if (pointers.size >= 2 && activePinch != null) {
                                        val iterator = pointers.entries.iterator()
                                        val a = iterator.next().value
                                        val b = iterator.next().value
                                        scale = ImageViewerMath.pinchScale(
                                            activePinch.startScale,
                                            activePinch.startDistance,
                                            ImageViewerMath.distance(a, b),
                                        )
                                        offset = ImageViewerMath.pinchOffset(
                                            activePinch.origin,
                                            activePinch.startCenter,
                                            ImageViewerMath.midpoint(a, b),
                                        )
                                    } else if (pointers.size == 1) {
                                        val activeDrag = drag
                                        if (activeDrag != null && activeDrag.pointerId == pointers.keys.first()) {
                                            offset = ImageViewerMath.dragOffset(
                                                activeDrag.origin,
                                                activeDrag.start,
                                                pointers.values.first(),
                                            )
                                        }
                                    }
                                    if ((drag != null || pinch != null) && pointers.isNotEmpty()) {
                                        event.changes.forEach { if (it.positionChanged()) it.consume() }
                                    }
                                }
                                if (pointers.isEmpty()) gestureEnded = true
                            }
                        }
                    },
            ) {
                val transform = Modifier.graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                    translationX = offset.x
                    translationY = offset.y
                }
                when (val content = current.content) {
                    is ZoomableImageContent.Loaded -> LoadedImage(
                        content = content,
                        fileName = current.fileName,
                        onIntrinsic = { intrinsic = it },
                        modifier = Modifier.fillMaxSize().then(transform),
                    )
                    is ZoomableImageContent.Decoded -> Image(
                        bitmap = content.bitmap,
                        contentDescription = current.fileName,
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.fillMaxSize().then(transform),
                    )
                }
            }
        }
    }
}

@Composable
private fun LoadedImage(
    content: ZoomableImageContent.Loaded,
    fileName: String,
    onIntrinsic: (Size?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val onState: (AsyncImagePainter.State) -> Unit = { state ->
        onIntrinsic(
            when (state) {
                is AsyncImagePainter.State.Success -> state.painter.intrinsicSize.takeIf { it.isSpecified }
                else -> null
            },
        )
    }
    val loader = content.imageLoader
    if (loader != null) {
        AsyncImage(
            model = content.model,
            contentDescription = fileName,
            imageLoader = loader,
            onState = onState,
            contentScale = ContentScale.Fit,
            modifier = modifier,
        )
    } else {
        AsyncImage(
            model = content.model,
            contentDescription = fileName,
            onState = onState,
            contentScale = ContentScale.Fit,
            modifier = modifier,
        )
    }
}

@Composable
private fun ZoomableTitleBar(
    fileName: String,
    index: Int,
    count: Int,
    scale: Float,
    onPrev: () -> Unit,
    onNext: () -> Unit,
    onZoomOut: () -> Unit,
    onZoomIn: () -> Unit,
    onReset: () -> Unit,
    onClose: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color.Black.copy(alpha = 0.5f))
            .statusBarsPadding()
            .padding(horizontal = 4.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = fileName,
            color = Color.White,
            fontSize = 14.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = 8.dp),
        )
        if (count > 1) {
            IconButton(onClick = onPrev, enabled = index > 0) {
                Icon(
                    Icons.AutoMirrored.Filled.KeyboardArrowLeft,
                    tint = Color.White,
                    contentDescription = stringResource(R.string.files_image_viewer_previous),
                )
            }
            Text(
                text = stringResource(R.string.files_image_viewer_counter, index + 1, count),
                color = Color.White.copy(alpha = 0.7f),
                fontSize = 12.sp,
                maxLines = 1,
            )
            IconButton(onClick = onNext, enabled = index < count - 1) {
                Icon(
                    Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    tint = Color.White,
                    contentDescription = stringResource(R.string.files_image_viewer_next),
                )
            }
        }
        val buttonColors = ButtonDefaults.textButtonColors(
            contentColor = Color.White,
            disabledContentColor = Color.White.copy(alpha = 0.4f),
        )
        TextButton(
            onClick = onZoomOut,
            enabled = scale > ImageViewerMath.MIN_SCALE,
            colors = buttonColors,
        ) {
            Text(text = "−", fontSize = 18.sp)
        }
        TextButton(onClick = onReset, colors = buttonColors) {
            Text(text = "${ImageViewerMath.zoomPercent(scale)}%", fontSize = 13.sp)
        }
        TextButton(
            onClick = onZoomIn,
            enabled = scale < ImageViewerMath.MAX_SCALE,
            colors = buttonColors,
        ) {
            Text(text = "+", fontSize = 16.sp)
        }
        IconButton(onClick = onClose) {
            Icon(
                Icons.Filled.Close,
                tint = Color.White,
                contentDescription = stringResource(R.string.files_image_viewer_close),
            )
        }
    }
}
