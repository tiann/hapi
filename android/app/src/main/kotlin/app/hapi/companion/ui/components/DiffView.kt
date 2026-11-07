package app.hapi.companion.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.hapi.companion.R
import app.hapi.companion.ui.markdown.CodeWrapState
import app.hapi.companion.ui.markdown.LocalCodeWrap
import app.hapi.companion.ui.theme.HapiExtendedColors
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.git.DiffChangeKind
import app.hapi.protocol.git.DiffFile
import app.hapi.protocol.git.DiffLineKind

/**
 * Renders one parsed [DiffFile] (`app.hapi.protocol.git.UnifiedDiffParser`):
 * header with path + add/remove badges + the global wrap toggle, hunk
 * headers, +/- tinted rows with dual line-number gutters. Starts compact
 * ([compact]) and expands in place beyond [compactLineLimit] rows.
 *
 * Like web `DiffView.tsx`, the body follows the global code-wrap switch
 * ([LocalCodeWrap]): off — horizontal scroll with one `Text` per row (gutters
 * and code concatenated, aligned by [androidx.compose.foundation.layout.IntrinsicSize]);
 * on — each row splits into a fixed gutter cell plus a soft-wrapping code
 * cell (web's `minmax(0, 1fr)` code track + `whitespace-pre-wrap`), so long
 * lines wrap instead of scrolling. Chat tool cards reuse this view, so the
 * one switch covers every diff surface, matching the web.
 */
@Composable
fun DiffView(
    file: DiffFile,
    modifier: Modifier = Modifier,
    compact: Boolean = true,
    compactLineLimit: Int = 12,
) {
    val colors = MaterialTheme.hapi
    val codeWrap = LocalCodeWrap.current
    var expanded by rememberSaveable(file.displayPath, file.hunks.size) { mutableStateOf(!compact) }

    Column(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(colors.codeBackground),
    ) {
        DiffHeader(file, colors, codeWrap)

        if (file.isBinary) {
            Text(
                text = stringResource(R.string.diff_binary_file),
                fontSize = 14.sp,
                color = colors.hint,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            )
            return@Column
        }
        if (file.hunks.isEmpty()) return@Column

        val rows = remember(file, colors) { buildDiffRows(file, colors) }
        val visible = if (expanded) rows else rows.take(compactLineLimit)
        val hidden = rows.size - visible.size

        if (codeWrap.wrap) {
            // Web wrap branch: gutters keep their width, the code cell takes
            // the remaining width and soft-wraps (no horizontal scroll).
            Column(modifier = Modifier.padding(vertical = 4.dp)) {
                for (row in visible) {
                    if (row.isHunkHeader) {
                        Text(
                            text = row.body,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 14.sp,
                            lineHeight = 20.sp,
                            softWrap = true,
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(row.background)
                                .padding(horizontal = 10.dp),
                        )
                    } else {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(row.background)
                                .padding(horizontal = 10.dp),
                        ) {
                            Text(
                                text = row.gutter,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 14.sp,
                                lineHeight = 20.sp,
                                softWrap = false,
                                maxLines = 1,
                            )
                            Text(
                                text = row.body,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 14.sp,
                                lineHeight = 20.sp,
                                softWrap = true,
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                }
            }
        } else {
            Column(
                modifier = Modifier
                    .horizontalScroll(rememberScrollState())
                    .width(IntrinsicSize.Max)
                    .padding(vertical = 4.dp),
            ) {
                for (row in visible) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(row.background),
                    ) {
                        Text(
                            text = row.gutter + row.body,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 14.sp,
                            lineHeight = 20.sp,
                            softWrap = false,
                            maxLines = 1,
                            modifier = Modifier.padding(horizontal = 10.dp),
                        )
                    }
                }
            }
        }

        if (hidden > 0 || (expanded && rows.size > compactLineLimit)) {
            Text(
                text = if (hidden > 0) {
                    stringResource(R.string.diff_show_more, hidden)
                } else {
                    stringResource(R.string.diff_collapse)
                },
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { expanded = !expanded }
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
    }
}

@Composable
private fun DiffHeader(file: DiffFile, colors: HapiExtendedColors, codeWrap: CodeWrapState) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.codeHeaderBackground)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        val title = when {
            file.changeKind == DiffChangeKind.RENAME || file.changeKind == DiffChangeKind.COPY ->
                "${file.oldPath ?: "?"} → ${file.newPath ?: "?"}"
            else -> file.displayPath
        }
        Text(
            text = title,
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            letterSpacing = 0.5.sp,
            color = colors.codeHeaderForeground,
            maxLines = 1,
            overflow = TextOverflow.MiddleEllipsis,
            modifier = Modifier.weight(1f),
        )
        val kindLabel = when (file.changeKind) {
            DiffChangeKind.ADD -> "new"
            DiffChangeKind.DELETE -> "deleted"
            DiffChangeKind.RENAME -> "renamed"
            DiffChangeKind.COPY -> "copied"
            DiffChangeKind.MODIFY -> null
        }
        if (kindLabel != null) {
            Text(
                text = kindLabel,
                fontSize = 10.sp,
                color = colors.hint,
            )
        }
        DiffStatBadge(added = true, value = file.additions, colors = colors)
        DiffStatBadge(added = false, value = file.deletions, colors = colors)
        // Web `DiffWrapToggle` twin: same global switch as the CodeBlock
        // header, offered wherever a diff renders.
        IconButton(
            onClick = { codeWrap.onToggle(!codeWrap.wrap) },
            modifier = Modifier.size(48.dp),
        ) {
            Icon(
                painterResource(R.drawable.ic_wrap_text),
                stringResource(if (codeWrap.wrap) R.string.code_wrap_disable else R.string.code_wrap_enable),
                Modifier.size(18.dp),
                // Active state reads as on-surface; idle matches the label.
                tint = if (codeWrap.wrap) MaterialTheme.colorScheme.onSurface else colors.codeHeaderForeground,
            )
        }
    }
}

@Composable
private fun DiffStatBadge(added: Boolean, value: Int, colors: HapiExtendedColors) {
    Text(
        text = (if (added) "+" else "-") + value,
        fontSize = 10.sp,
        fontWeight = FontWeight.Medium,
        color = if (added) colors.diffAddText else colors.diffRemoveText,
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(if (added) colors.diffAddBackground else colors.diffRemoveBackground)
            .padding(horizontal = 7.dp, vertical = 1.dp),
    )
}

private class DiffRow(
    val gutter: AnnotatedString,
    val body: AnnotatedString,
    val isHunkHeader: Boolean,
    val background: Color,
)

private fun buildDiffRows(file: DiffFile, colors: HapiExtendedColors): List<DiffRow> {
    val gutterStyle = SpanStyle(color = colors.hint.copy(alpha = 0.8f))

    val rows = mutableListOf<DiffRow>()
    for (text in DiffRowSplitter.rows(file)) {
        if (text.isHunkHeader) {
            rows += DiffRow(
                gutter = AnnotatedString(""),
                body = buildAnnotatedString {
                    withStyle(SpanStyle(color = colors.hint)) { append(text.body) }
                },
                isHunkHeader = true,
                background = colors.diffHunkBackground,
            )
        } else {
            val (background, textColor) = when (text.kind) {
                DiffLineKind.ADD -> colors.diffAddBackground to colors.diffAddText
                DiffLineKind.REMOVE -> colors.diffRemoveBackground to colors.diffRemoveText
                DiffLineKind.CONTEXT, null -> Color.Transparent to colors.inlineCodeForeground
            }
            rows += DiffRow(
                gutter = buildAnnotatedString { withStyle(gutterStyle) { append(text.gutter) } },
                body = buildAnnotatedString {
                    withStyle(SpanStyle(color = textColor)) { append(text.body) }
                },
                isHunkHeader = false,
                background = background,
            )
        }
    }
    return rows
}
