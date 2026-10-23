package app.hapi.companion.ui.components

import app.hapi.protocol.git.DiffFile
import app.hapi.protocol.git.DiffLineKind

/**
 * Pure text splitting of one parsed [DiffFile] into per-line gutter/body
 * pairs — the twin of the web DiffView row grid (`DiffView.tsx`:
 * `${lineNumberWidth}ch ${lineNumberWidth}ch track` columns). Every gutter
 * pads to shared widths so the line-number columns stay aligned across rows.
 *
 * Two consumers, one source of truth:
 *  - scroll mode concatenates `gutter + body` into the single-`Text` rows the
 *    viewer has always rendered (byte-identical output);
 *  - wrap mode renders the two pieces as separate cells so the code cell can
 *    soft-wrap while the gutters keep their width (web switches the code
 *    column track from `max-content` to `minmax(0, 1fr)` for the same
 *    reason — a `max-content` track would claim full width before wrapping).
 */
data class DiffRowText(
    /** Line-number gutter (`old new`, both padded to shared widths); blank for hunk headers. */
    val gutter: String,
    /** Code segment: `"  " marker ' ' text` for lines, the raw `@@` header for hunks. */
    val body: String,
    /** True for hunk headers (full-width hint row, no gutter columns). */
    val isHunkHeader: Boolean,
    /** Change kind of the line; null for hunk headers. */
    val kind: DiffLineKind?,
)

object DiffRowSplitter {

    fun rows(file: DiffFile): List<DiffRowText> {
        if (file.hunks.isEmpty()) return emptyList()
        val maxOld = file.hunks.maxOf { hunk -> hunk.oldStart + hunk.oldCount }
        val maxNew = file.hunks.maxOf { hunk -> hunk.newStart + hunk.newCount }
        val oldWidth = maxOf(maxOld.toString().length, 2)
        val newWidth = maxOf(maxNew.toString().length, 2)

        val rows = mutableListOf<DiffRowText>()
        for (hunk in file.hunks) {
            rows += DiffRowText(gutter = "", body = hunk.header, isHunkHeader = true, kind = null)
            for (line in hunk.lines) {
                val marker = when (line.kind) {
                    DiffLineKind.ADD -> "+"
                    DiffLineKind.REMOVE -> "-"
                    DiffLineKind.CONTEXT -> " "
                }
                rows += DiffRowText(
                    gutter = (line.oldLineNumber?.toString() ?: "").padStart(oldWidth) + ' ' +
                        (line.newLineNumber?.toString() ?: "").padStart(newWidth),
                    body = "  $marker ${line.text}",
                    isHunkHeader = false,
                    kind = line.kind,
                )
            }
        }
        return rows
    }
}
