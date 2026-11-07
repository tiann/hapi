package app.hapi.companion.feature.files

import androidx.compose.ui.graphics.Color
import app.hapi.protocol.git.GitFileChange
import java.text.DateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToLong

// Shared bits of the files feature UI: metadata formatting (web
// `file-metadata.ts`) and the status-badge palette. The folder/git-branch
// glyphs moved to ui/components/HapiGlyphs.kt (single strokeIcon home).

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
