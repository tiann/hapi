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

// ── Transcript glyphs (lucide 24 dp paths, ISC license, verbatim) ────────────

/** Terminal prompt — shell tool cards (lucide `terminal`). */
internal val HapiTerminalGlyph: ImageVector by lazy {
    strokeIcon("HapiTerminal", "m4 17 6-6-6-6 M12 19h8")
}

/** Open book — read tool cards (lucide `book-open`). */
internal val HapiBookGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiBook",
        "M12 5v16 M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4" +
            "a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z",
    )
}

/** Pencil — edit/write tool cards (lucide `pencil`). */
internal val HapiPencilGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiPencil",
        "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622" +
            "l4.353-1.32a2 2 0 0 0 .83-.497z M15 5 l4 4",
    )
}

/** Globe — web tool cards (lucide `globe`). */
internal val HapiGlobeGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiGlobe",
        "M12 2 a10 10 0 1 0 0.001 0 z M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20 M2 12h20",
    )
}

/** Rocket — subagent tool cards (lucide `rocket`). */
internal val HapiRocketGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiRocket",
        "M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5 " +
            "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09 " +
            "M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z " +
            "M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05",
    )
}

/** Circled question mark — permission/question tool cards (lucide `circle-help`). */
internal val HapiHelpGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiHelp",
        "M12 2 a10 10 0 1 0 0.001 0 z M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3 M12 17h.01",
    )
}

/** Lightbulb — todo/reasoning tool cards (lucide `lightbulb`). */
internal val HapiBulbGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiBulb",
        "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5 " +
            "M9 18h6 M10 22h4",
    )
}

/** Puzzle piece — MCP/skill tool cards (lucide `puzzle`). */
internal val HapiPuzzleGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiPuzzle",
        "M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682" +
            "a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015" +
            "1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474" +
            "2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61" +
            "a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z",
    )
}

/** Speech bubble — message tool cards (lucide `message-circle`). */
internal val HapiMsgGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiMsg",
        "M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998" +
            "a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719",
    )
}

/** Two-person silhouette — team tool cards (lucide `users`). */
internal val HapiUsersGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiUsers",
        "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3.128a4 4 0 0 1 0 7.744 " +
            "M22 21v-2a4 4 0 0 0-3-3.87 M9 3 a4 4 0 1 0 0.001 0 z",
    )
}

/** Wrench — generic tool fallback (lucide `wrench`). */
internal val HapiWrenchGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiWrench",
        "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218" +
            "a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259" +
            "c.438.12.54.662.219.984z",
    )
}

/** Hourglass — retry/limit-wait event rows (lucide `hourglass`). */
internal val HapiHourglassGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiHourglass",
        "M5 22h14 M5 2h14 M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22 " +
            "M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2",
    )
}

/** Boxed item — compaction event rows (lucide `box`). */
internal val HapiBoxGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiBox",
        "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4" +
            "a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z M3.3 7 l8.7 5 8.7-5 M12 22V12",
    )
}

/** Cloud — recap event rows (lucide `cloud`). */
internal val HapiCloudGlyph: ImageVector by lazy {
    strokeIcon("HapiCloud", "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z")
}

/** Clock face — context/turn-duration event rows (lucide `clock`). */
internal val HapiClockGlyph: ImageVector by lazy {
    strokeIcon("HapiClock", "M12 2 a10 10 0 1 0 0.001 0 z M12 6v6l4 2")
}

/** Checked box — task-list markers, done state (lucide `square-check`). */
internal val HapiSquareCheckGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiSquareCheck",
        "M5 3 h14 a2 2 0 0 1 2 2 v14 a2 2 0 0 1 -2 2 H5 a2 2 0 0 1 -2 -2 V5 a2 2 0 0 1 2 -2 z M9 12 l2 2 4-4",
    )
}

/** Dotted circle — task-list markers, in-progress state (lucide `circle-dot`). */
internal val HapiCircleDotGlyph: ImageVector by lazy {
    strokeIcon("HapiCircleDot", "M12 2 a10 10 0 1 0 0.001 0 z M12 12h.01")
}

/** Empty box — task-list markers, pending state (lucide `square`). */
internal val HapiSquareGlyph: ImageVector by lazy {
    strokeIcon("HapiSquare", "M5 3 h14 a2 2 0 0 1 2 2 v14 a2 2 0 0 1 -2 2 H5 a2 2 0 0 1 -2 -2 V5 a2 2 0 0 1 2 -2 z")
}
