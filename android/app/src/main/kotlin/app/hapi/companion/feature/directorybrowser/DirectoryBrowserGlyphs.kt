package app.hapi.companion.feature.directorybrowser

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

// Hand-drawn 24 dp stroke glyph — the `ComposerGlyphs`/`FilesUi` precedent
// (no material-icons-extended dependency, no emoji-as-icon).

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

/**
 * Git-repo glyph for directory rows — the web `WorkspaceBrowser` `GitIcon`
 * (lucide git-fork: three commit circles + merge connectors, strokeWidth 2),
 * swapped in for the folder icon when `isGitRepo` is set.
 */
internal val GitRepoGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiGitRepo",
        "M6 3 a3 3 0 1 0 0.0001 0 " +
            "M18 3 a3 3 0 1 0 0.0001 0 " +
            "M12 15 a3 3 0 1 0 0.0001 0 " +
            "M18 9 v2 c0 .6 -.4 1 -1 1 H7 c-.6 0 -1 -.4 -1 -1 V9 " +
            "M12 12 v3",
        2f,
    )
}

/** Tailwind `orange-500` — the web git icon/badge tint (same in both themes). */
internal val GitBadgeColor: Color = Color(0xFFF97316)
