package app.hapi.companion.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

// Shared 24 dp stroke glyphs (the ComposerGlyphs/FilesUi strokeIcon precedent)
// for surfaces core Material does not cover — image/paperclip/camera/doc/
// clipboard/note/inbox shapes follow the lucide 24 dp paths (ISC license).
// Never hand-draw a glyph core Material already ships (Close/Check/Add/
// KeyboardArrow×/Lock/Refresh/Warning/…), and never add the
// material-icons-extended dependency (existing decision).

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

/** Photo/image frame — attachment thumbs for non-previewable image mimes. */
internal val HapiImageGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiImage",
        "M5 3 h14 a2 2 0 0 1 2 2 v14 a2 2 0 0 1 -2 2 H5 a2 2 0 0 1 -2 -2 V5 a2 2 0 0 1 2 -2 z " +
            "M9 9.5 a1.5 1.5 0 1 0 0.001 0 z " +
            "M21 15 l-3.1 -3.1 a2 2 0 0 0 -2.8 0 L6 21",
    )
}

/** Paperclip — generic non-image attachment chip glyph. */
internal val HapiPaperclipGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiPaperclip",
        "m21.44 11.05 -9.19 9.19 a6 6 0 0 1 -8.49 -8.49 l8.57 -8.57 A4 4 0 1 1 18 8.84 " +
            "l-8.59 8.57 a2 2 0 0 1 -2.83 -2.83 l8.49 -8.48",
    )
}

/** Camera — the "take a photo" attachment source. */
internal val HapiCameraGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiCamera",
        "M23 19 a2 2 0 0 1 -2 2 H3 a2 2 0 0 1 -2 -2 V8 a2 2 0 0 1 2 -2 h4 l2 -3 h6 l2 3 h4 " +
            "a2 2 0 0 1 2 2 z M12 9 a4 4 0 1 0 0.001 0 z",
    )
}

/** Document — the "pick a file" attachment source (web FileIcon path). */
internal val HapiDocGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiDoc",
        "M14 2 H6 a2 2 0 0 0 -2 2 v16 a2 2 0 0 0 2 2 h12 a2 2 0 0 0 2 -2 V8 z M14 2 v6 h6",
    )
}

/** Clipboard — the "paste from clipboard" attachment source. */
internal val HapiClipboardGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiClipboard",
        "M9 4 H7 a2 2 0 0 0 -2 2 v14 a2 2 0 0 0 2 2 h10 a2 2 0 0 0 2 -2 V6 a2 2 0 0 0 -2 -2 h-2 " +
            "M9 2 h6 v3 H9 z",
    )
}

/** Sticky note — scratchlist entry points (web ScratchlistToggleIcon ported to 24 dp). */
internal val HapiNoteGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiNote",
        "M6 4 h9 l4 4 v11 a1.5 1.5 0 0 1 -1.5 1.5 h-11.5 a1.5 1.5 0 0 1 -1.5 -1.5 v-13.5 " +
            "a1.5 1.5 0 0 1 1.5 -1.5 z M15 4 v4 h4 M8.5 12 h7 M8.5 16 h5",
    )
}

/** Inbox tray — park the composer draft into the scratchlist. */
internal val HapiInboxGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiInbox",
        "M22 12 h-6 l-2 3 h-4 l-2 -3 H2 M5.45 5.11 2 12 v6 a2 2 0 0 0 2 2 h16 a2 2 0 0 0 2 -2 " +
            "v-6 l-3.45 -6.89 A2 2 0 0 0 16.76 4 H7.24 a2 2 0 0 0 -1.79 1.11 z",
    )
}
