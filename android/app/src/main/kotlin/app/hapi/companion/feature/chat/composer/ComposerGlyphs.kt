package app.hapi.companion.feature.chat.composer

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

// Hand-drawn 24 dp stroke glyphs (the FolderGlyph precedent) — no
// material-icons-extended dependency, and no emoji-as-icon (device fonts
// render those inconsistently, which is exactly what made the first composer
// build look broken).

private fun strokeIcon(name: String, pathData: String, strokeWidth: Float = 1.8f): ImageVector =
    ImageVector.Builder(
        name = name,
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply {
        addPath(
            pathData = addPathNodes(pathData),
            fill = null,
            // Any opaque stroke works: Icon() recolors via ColorFilter tint.
            stroke = SolidColor(Color.Black),
            strokeLineWidth = strokeWidth,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
        )
    }.build()

/** "+" — opens the attachment picker sheet. */
internal val PlusGlyph: ImageVector by lazy {
    strokeIcon("HapiPlus", "M12 5 L12 19 M5 12 L19 12", 2f)
}

/** Microphone — dictation toggle. */
internal val MicGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiMic",
        "M12 3 a3 3 0 0 1 3 3 v5 a3 3 0 0 1 -6 0 v-5 a3 3 0 0 1 3 -3 " +
            "M6.5 11 a5.5 5.5 0 0 0 11 0 M12 16.5 L12 20.5 M9 20.5 L15 20.5",
    )
}

/** Stop square — abort while a turn runs, and the recording-stop state. */
internal val StopGlyph: ImageVector by lazy {
    strokeIcon("HapiStop", "M8 8 h8 v8 h-8 z", 2f)
}

/** Upward arrow — send. */
internal val ArrowUpGlyph: ImageVector by lazy {
    strokeIcon("HapiArrowUp", "M12 19 L12 5.5 M6.5 11 L12 5.5 L17.5 11", 2.2f)
}
