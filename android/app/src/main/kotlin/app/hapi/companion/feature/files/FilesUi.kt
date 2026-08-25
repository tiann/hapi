package app.hapi.companion.feature.files

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp
import app.hapi.protocol.git.GitFileChange
import java.text.DateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToLong

// Shared bits of the files feature UI: metadata formatting (web
// `file-metadata.ts`), status-badge palette, and the folder glyph the chat
// top bar and Browse tab share (the material core icon set has no folder).

/** `1.2 KB` / `640 B`; null when size is unknown (web `formatFileSize`). */
internal fun formatFileSize(bytes: Long?): String? {
    if (bytes == null || bytes < 0) return null
    if (bytes < 1024) return "$bytes B"
    val units = arrayOf("KB", "MB", "GB", "TB")
    var value = bytes.toDouble()
    var unit = -1
    while (value >= 1024 && unit < units.size - 1) {
        value /= 1024
        unit += 1
    }
    val formatted = if (value >= 10) {
        value.roundToLong().toString()
    } else {
        String.format(Locale.US, "%.1f", value).removeSuffix(".0")
    }
    return "$formatted ${units[unit]}"
}

/** `12/31/2026, 10:03 · 1.2 KB`-style joined metadata line (web `formatFileMetadata`). */
internal fun formatFileMetadata(size: Long?, modified: Long?): String? {
    val time = modified?.let {
        DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(it))
    }
    val parts = listOfNotNull(time, formatFileSize(size))
    return parts.joinToString(" · ").ifEmpty { null }
}

/** Single status letter of the Changes list (web `StatusBadge`). */
internal fun statusLetter(status: GitFileChange): String = when (status) {
    GitFileChange.ADDED -> "A"
    GitFileChange.DELETED -> "D"
    GitFileChange.RENAMED -> "R"
    GitFileChange.UNTRACKED -> "?"
    GitFileChange.CONFLICTED -> "U"
    GitFileChange.MODIFIED -> "M"
}

/** Badge tint per status, tuned per theme (web `--app-git-*-color` vars). */
internal fun statusColor(status: GitFileChange, dark: Boolean): Color = when (status) {
    GitFileChange.ADDED -> if (dark) Color(0xFF4CC38A) else Color(0xFF1A7F37)
    GitFileChange.DELETED, GitFileChange.CONFLICTED -> if (dark) Color(0xFFF47067) else Color(0xFFCF222E)
    GitFileChange.RENAMED -> if (dark) Color(0xFFDBAB0A) else Color(0xFF9A6700)
    GitFileChange.UNTRACKED -> if (dark) Color(0xFF8E8E93) else Color(0xFF6B7280)
    GitFileChange.MODIFIED -> if (dark) Color(0xFF539BF5) else Color(0xFF0969DA)
}

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

/** Folder outline (the web `FolderIcon` path). */
internal val FolderGlyph: ImageVector by lazy {
    strokeIcon("HapiFolder", "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", 1.6f)
}

/** Git branch glyph for the Changes header (the web `GitBranchIcon` paths). */
internal val GitBranchGlyph: ImageVector by lazy {
    strokeIcon(
        "HapiGitBranch",
        "M6 3 L6 15 M6 15 a3 3 0 1 0 0.0001 0 M18 3 a3 3 0 1 0 0.0001 0 M18 9 a9 9 0 0 1 -9 9",
        2f,
    )
}
