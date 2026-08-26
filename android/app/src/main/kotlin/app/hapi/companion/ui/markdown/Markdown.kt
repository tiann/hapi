package app.hapi.companion.ui.markdown

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.Measurable
import androidx.compose.ui.layout.Placeable
import androidx.compose.ui.layout.layoutId
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.LinkInteractionListener
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import app.hapi.companion.ui.theme.HapiExtendedColors
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.markdown.HrefDecision
import app.hapi.protocol.markdown.HrefPolicy
import app.hapi.protocol.markdown.MarkdownTransforms
import org.commonmark.ext.gfm.strikethrough.Strikethrough
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.gfm.tables.TableHead
import org.commonmark.ext.gfm.tables.TableRow
import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.Code
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.HtmlBlock
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.ListItem
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text as MdText
import org.commonmark.node.ThematicBreak

// ── Link handling ────────────────────────────────────────────────────────────

/**
 * Receives clicks on markdown links. The chat screen provides a confirm-aware
 * URL opener (`rememberChatLinkHandler`); file taps route to the session file
 * viewer once it exists (M4).
 */
interface MarkdownLinkHandler {
    /** A workspace file citation (`src/a.ts`, `hub/src/x.ts:345`, ...). */
    fun onFilePath(path: String, line: Int?)

    /**
     * A URL whose [HrefPolicy] decision is [HrefDecision.Allowed] or
     * [HrefDecision.ConfirmFirst]; blocked destinations never reach here --
     * they render as inert text.
     */
    fun onUrl(url: String, decision: HrefDecision)
}

private object NoOpMarkdownLinkHandler : MarkdownLinkHandler {
    override fun onFilePath(path: String, line: Int?) = Unit
    override fun onUrl(url: String, decision: HrefDecision) = Unit
}

val LocalMarkdownLinkHandler = staticCompositionLocalOf<MarkdownLinkHandler> { NoOpMarkdownLinkHandler }

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Renders chat markdown with the shared HAPI pipeline: source transforms and
 * parser configuration come from `:core:protocol` ([MarkdownTransforms.parse]:
 * table repair, GFM tables/strikethrough/autolink, indented code disabled),
 * then this walker maps the AST to Compose. Unknown fences (mermaid, math)
 * degrade to plain [CodeBlock]s per the v1 plan; html blocks fall back to
 * monospace text.
 */
@Composable
fun Markdown(text: String, modifier: Modifier = Modifier) {
    val parsed = remember(text) { prepareDocument(text) }
    val baseStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp, lineHeight = 22.sp)
    CompositionLocalProvider(LocalTextStyle provides baseStyle) {
        Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            MarkdownBlockChildren(parsed.document, parsed)
        }
    }
}

/** Parsed AST plus the task-list markers stripped out of it (identity-keyed). */
private class ParsedMarkdown(val document: Node, val taskMarkers: Map<Node, Boolean>)

private val TASK_MARKER = Regex("""^\[([ xX])\]\s+""")

/**
 * Parse + normalize GFM task-list items (`- [x] done`): the textual marker is
 * removed from the first text node and remembered per list item, so the walker
 * can draw a checkbox prefix (the task extension jar is not needed for this).
 */
private fun prepareDocument(text: String): ParsedMarkdown {
    val document = MarkdownTransforms.parse(text)
    val markers = HashMap<Node, Boolean>()
    var node: Node? = document
    val stack = ArrayDeque<Node>()
    while (node != null) {
        if (node is ListItem) {
            val firstText = (node.firstChild as? Paragraph)?.firstChild as? MdText
            val literal = firstText?.literal
            val match = literal?.let { TASK_MARKER.find(it) }
            if (firstText != null && match != null) {
                markers[node] = match.groupValues[1] != " "
                firstText.literal = literal.removeRange(match.range)
            }
        }
        var child = node.firstChild
        while (child != null) {
            stack.addLast(child)
            child = child.next
        }
        node = stack.removeLastOrNull()
    }
    return ParsedMarkdown(document, markers)
}

// ── Block rendering ──────────────────────────────────────────────────────────

@Composable
private fun MarkdownBlockChildren(parent: Node, parsed: ParsedMarkdown) {
    var child = parent.firstChild
    while (child != null) {
        MarkdownBlock(child, parsed)
        child = child.next
    }
}

@Composable
private fun MarkdownBlock(node: Node, parsed: ParsedMarkdown) {
    when (node) {
        is Paragraph -> MarkdownInlineText(node)
        is Heading -> MarkdownInlineText(node, style = headingStyle(node.level))
        is BlockQuote -> MarkdownBlockQuote(node, parsed)
        is BulletList -> MarkdownList(node, ordered = false, parsed = parsed)
        is OrderedList -> MarkdownList(node, ordered = true, parsed = parsed)
        is FencedCodeBlock -> CodeBlock(
            code = node.literal.orEmpty().trimEnd('\n'),
            language = node.info?.trim()?.takeWhile { !it.isWhitespace() }?.ifEmpty { null },
        )
        is IndentedCodeBlock -> CodeBlock(code = node.literal.orEmpty().trimEnd('\n'), language = null)
        is TableBlock -> MarkdownTable(node)
        is ThematicBreak -> HorizontalDivider(color = MaterialTheme.hapi.divider)
        is HtmlBlock -> HtmlBlockFallback(node.literal.orEmpty())
        else -> if (node.firstChild != null) MarkdownBlockChildren(node, parsed)
    }
}

@Composable
private fun headingStyle(level: Int): TextStyle {
    // Chat headings are compact (web: 1.05rem..0.88rem semibold).
    val base = LocalTextStyle.current
    val size = when (level) {
        1 -> 18.sp
        2 -> 17.sp
        3 -> 16.sp
        else -> 15.sp
    }
    return base.copy(fontSize = size, lineHeight = size * 1.4, fontWeight = FontWeight.SemiBold)
}

@Composable
private fun MarkdownBlockQuote(node: BlockQuote, parsed: ParsedMarkdown) {
    val colors = MaterialTheme.hapi
    Row(
        modifier = Modifier
            .height(IntrinsicSize.Min)
            .clip(RoundedCornerShape(topEnd = 12.dp, bottomEnd = 12.dp))
            .background(colors.blockquoteBackground),
    ) {
        Box(
            Modifier
                .width(3.dp)
                .fillMaxHeight()
                .background(colors.blockquoteBar),
        )
        CompositionLocalProvider(LocalContentColor provides colors.blockquoteForeground) {
            Column(
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                MarkdownBlockChildren(node, parsed)
            }
        }
    }
}

@Composable
private fun MarkdownList(list: Node, ordered: Boolean, parsed: ParsedMarkdown) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        var index = (list as? OrderedList)?.markerStartNumber ?: 1
        var item = list.firstChild
        while (item != null) {
            if (item is ListItem) {
                val task = parsed.taskMarkers[item]
                val marker = when {
                    task == true -> "☑" // checked box
                    task == false -> "☐" // empty box
                    ordered -> "$index."
                    else -> "•" // bullet
                }
                MarkdownListItem(item, marker, parsed)
                index += 1
            }
            item = item.next
        }
    }
}

@Composable
private fun MarkdownListItem(item: ListItem, marker: String, parsed: ParsedMarkdown) {
    Row {
        Text(
            text = marker,
            style = LocalTextStyle.current,
            color = MaterialTheme.hapi.hint,
            modifier = Modifier
                .widthIn(min = 22.dp)
                .padding(end = 4.dp),
        )
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            MarkdownBlockChildren(item, parsed)
        }
    }
}

@Composable
private fun HtmlBlockFallback(literal: String) {
    Text(
        text = literal.trimEnd('\n'),
        style = LocalTextStyle.current.copy(
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            lineHeight = 17.sp,
        ),
        color = MaterialTheme.hapi.hint,
    )
}

// ── Table rendering ──────────────────────────────────────────────────────────

private class TableRowModel(val isHeader: Boolean, val cells: List<TableCell>)

@Composable
private fun MarkdownTable(table: TableBlock) {
    val colors = MaterialTheme.hapi
    val rows = remember(table) { collectTableRows(table) }
    if (rows.isEmpty()) return
    val columnCount = rows.maxOf { it.cells.size }

    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(12.dp))
            .background(colors.tableBackground)
            .horizontalScroll(rememberScrollState()),
    ) {
        TableGrid(rows, columnCount, colors)
    }
}

private fun collectTableRows(table: TableBlock): List<TableRowModel> {
    val rows = mutableListOf<TableRowModel>()
    var section = table.firstChild
    while (section != null) {
        val isHeader = section is TableHead
        var row = section.firstChild
        while (row != null) {
            if (row is TableRow) {
                val cells = mutableListOf<TableCell>()
                var cell = row.firstChild
                while (cell != null) {
                    if (cell is TableCell) cells.add(cell)
                    cell = cell.next
                }
                rows.add(TableRowModel(isHeader, cells))
            }
            row = row.next
        }
        section = section.next
    }
    return rows
}

/**
 * Content-sized grid: column widths come from the widest cell (capped so long
 * prose wraps), row backgrounds/dividers are dedicated measurables sized after
 * the cells, placed behind them. The whole grid lives in a horizontal scroller.
 */
@Composable
private fun TableGrid(rows: List<TableRowModel>, columnCount: Int, colors: HapiExtendedColors) {
    val cellStyle = LocalTextStyle.current.copy(fontSize = 13.sp, lineHeight = 19.sp)
    Layout(
        content = {
            rows.forEachIndexed { r, row ->
                Box(
                    Modifier
                        .layoutId("bg:$r")
                        .background(if (row.isHeader) colors.tableHeaderBackground else colors.tableBackground),
                )
                row.cells.forEachIndexed { c, cell ->
                    val alignment = cell.alignment
                    Box(
                        modifier = Modifier
                            .layoutId("cell:$r:$c")
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                        contentAlignment = when (alignment) {
                            TableCell.Alignment.CENTER -> Alignment.TopCenter
                            TableCell.Alignment.RIGHT -> Alignment.TopEnd
                            else -> Alignment.TopStart
                        },
                    ) {
                        MarkdownInlineText(
                            cell,
                            style = if (row.isHeader) cellStyle.copy(fontWeight = FontWeight.SemiBold) else cellStyle,
                            textAlign = when (alignment) {
                                TableCell.Alignment.CENTER -> TextAlign.Center
                                TableCell.Alignment.RIGHT -> TextAlign.End
                                else -> TextAlign.Start
                            },
                        )
                    }
                }
            }
        },
    ) { measurables, _ ->
        val cellCap = 320.dp.roundToPx()
        val cells = Array(rows.size) { arrayOfNulls<Measurable>(columnCount) }
        val backgrounds = arrayOfNulls<Measurable>(rows.size)
        for (measurable in measurables) {
            val id = measurable.layoutId as String
            val parts = id.split(':')
            when (parts[0]) {
                "bg" -> backgrounds[parts[1].toInt()] = measurable
                "cell" -> cells[parts[1].toInt()][parts[2].toInt()] = measurable
            }
        }

        val columnWidths = IntArray(columnCount)
        for (r in rows.indices) {
            for (c in 0 until columnCount) {
                val cell = cells[r][c] ?: continue
                val intrinsic = cell.maxIntrinsicWidth(Constraints.Infinity)
                columnWidths[c] = maxOf(columnWidths[c], minOf(intrinsic, cellCap))
            }
        }
        val tableWidth = columnWidths.sum()

        val placeables = Array(rows.size) { arrayOfNulls<Placeable>(columnCount) }
        val rowHeights = IntArray(rows.size)
        for (r in rows.indices) {
            for (c in 0 until columnCount) {
                val cell = cells[r][c] ?: continue
                val placeable = cell.measure(
                    Constraints(minWidth = columnWidths[c], maxWidth = columnWidths[c]),
                )
                placeables[r][c] = placeable
                rowHeights[r] = maxOf(rowHeights[r], placeable.height)
            }
        }
        val backgroundPlaceables = Array(rows.size) { r ->
            backgrounds[r]?.measure(Constraints.fixed(tableWidth, rowHeights[r]))
        }

        val tableHeight = rowHeights.sum()
        layout(tableWidth, tableHeight) {
            var y = 0
            for (r in rows.indices) {
                backgroundPlaceables[r]?.place(0, y)
                var x = 0
                for (c in 0 until columnCount) {
                    placeables[r][c]?.place(x, y)
                    x += columnWidths[c]
                }
                y += rowHeights[r]
            }
        }
    }
}

// ── Inline rendering ─────────────────────────────────────────────────────────

@Composable
private fun MarkdownInlineText(
    parent: Node,
    style: TextStyle = LocalTextStyle.current,
    textAlign: TextAlign? = null,
) {
    val handler = LocalMarkdownLinkHandler.current
    val colors = MaterialTheme.hapi
    val annotated = remember(parent, colors, handler) {
        buildAnnotatedString {
            appendInlineChildren(parent, InlineContext(colors, handler), insideLink = false)
        }
    }
    Text(
        text = annotated,
        style = if (textAlign != null) style.copy(textAlign = textAlign) else style,
    )
}

private class InlineContext(val colors: HapiExtendedColors, val handler: MarkdownLinkHandler) {
    val linkStyles = TextLinkStyles(
        style = SpanStyle(
            color = colors.link,
            fontWeight = FontWeight.Medium,
            textDecoration = TextDecoration.Underline,
        ),
    )
    val codeSpanStyle = SpanStyle(
        fontFamily = FontFamily.Monospace,
        fontSize = 0.9.em,
        background = colors.inlineCodeBackground,
        color = colors.inlineCodeForeground,
    )
}

private fun AnnotatedString.Builder.appendInlineChildren(
    parent: Node,
    ctx: InlineContext,
    insideLink: Boolean,
) {
    var node = parent.firstChild
    while (node != null) {
        appendInlineNode(node, ctx, insideLink)
        node = node.next
    }
}

private fun AnnotatedString.Builder.appendInlineNode(node: Node, ctx: InlineContext, insideLink: Boolean) {
    when (node) {
        is MdText -> {
            val literal = node.literal.orEmpty()
            if (insideLink) append(literal) else appendTextWithFilePaths(literal, ctx)
        }
        // Soft breaks collapse to spaces on the assistant surface (web parity;
        // user prompts get a breaks-preserving variant later).
        is SoftLineBreak -> append(' ')
        is HardLineBreak -> append('\n')
        is Emphasis -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) {
            appendInlineChildren(node, ctx, insideLink)
        }
        is StrongEmphasis -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) {
            appendInlineChildren(node, ctx, insideLink)
        }
        is Strikethrough -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) {
            appendInlineChildren(node, ctx, insideLink)
        }
        is Code -> appendInlineCode(node.literal.orEmpty(), ctx, insideLink)
        is Link -> if (insideLink) appendInlineChildren(node, ctx, true) else appendLink(node, ctx)
        is Image -> appendImageFallback(node, ctx)
        is HtmlInline -> append(node.literal.orEmpty())
        else -> appendInlineChildren(node, ctx, insideLink)
    }
}

/** Plain prose: autolink workspace file citations found by the shared detector. */
private fun AnnotatedString.Builder.appendTextWithFilePaths(literal: String, ctx: InlineContext) {
    val links = MarkdownTransforms.detectFilePathLinks(literal)
    if (links.isEmpty()) {
        append(literal)
        return
    }
    var cursor = 0
    for (link in links) {
        if (link.range.first > cursor) append(literal.substring(cursor, link.range.first))
        appendFilePathLink(link.display, link.path, link.line, ctx, monospace = false)
        cursor = link.range.last + 1
    }
    if (cursor < literal.length) append(literal.substring(cursor))
}

private fun AnnotatedString.Builder.appendFilePathLink(
    display: String,
    path: String,
    line: Int?,
    ctx: InlineContext,
    monospace: Boolean,
) {
    val listener = LinkInteractionListener { ctx.handler.onFilePath(path, line) }
    withLink(LinkAnnotation.Clickable("hapi-file:$path", ctx.linkStyles, listener)) {
        if (monospace) {
            withStyle(ctx.codeSpanStyle.copy(color = ctx.colors.link)) { append(display) }
        } else {
            append(display)
        }
    }
}

/** Inline code: whole-value file paths become links, everything else is a code span. */
private fun AnnotatedString.Builder.appendInlineCode(literal: String, ctx: InlineContext, insideLink: Boolean) {
    val whole = if (insideLink) null else MarkdownTransforms.matchWholeFilePath(literal)
    if (whole != null) {
        appendFilePathLink(whole.display, whole.path, whole.line, ctx, monospace = true)
    } else {
        withStyle(ctx.codeSpanStyle) { append(literal) }
    }
}

private fun AnnotatedString.Builder.appendLink(node: Link, ctx: InlineContext) {
    val destination = node.destination.orEmpty()

    // Autolinked URLs (text == destination) may have swallowed trailing CJK
    // punctuation; split it back out as plain text (web parity).
    val onlyChild = node.firstChild
    val isAutolink = onlyChild is MdText && onlyChild.next == null && onlyChild.literal == destination
    if (isAutolink) {
        val split = MarkdownTransforms.stripCjkAutolinkArtifacts(destination)
        appendClassifiedLink(split.url, ctx) { append(split.url) }
        if (split.trailing.isNotEmpty()) append(split.trailing)
        return
    }

    // Explicit [label](relative/file.ext) → session file viewer.
    val filePath = MarkdownTransforms.rewriteExplicitLinkTarget(destination)
    if (filePath != null) {
        val listener = LinkInteractionListener { ctx.handler.onFilePath(filePath, null) }
        withLink(LinkAnnotation.Clickable("hapi-file:$filePath", ctx.linkStyles, listener)) {
            appendInlineChildren(node, ctx, insideLink = true)
        }
        return
    }

    appendClassifiedLink(destination, ctx) { appendInlineChildren(node, ctx, insideLink = true) }
}

/** Apply [HrefPolicy]: blocked → inert hint text; otherwise clickable via the handler. */
private fun AnnotatedString.Builder.appendClassifiedLink(
    url: String,
    ctx: InlineContext,
    content: AnnotatedString.Builder.() -> Unit,
) {
    when (val decision = HrefPolicy.classify(url)) {
        is HrefDecision.Blocked -> withStyle(SpanStyle(color = ctx.colors.hint)) { content() }
        else -> {
            val listener = LinkInteractionListener { ctx.handler.onUrl(url, decision) }
            withLink(LinkAnnotation.Clickable("url:$url", ctx.linkStyles, listener)) { content() }
        }
    }
}

/** No inline image loading in the markdown pass (M2 wires Coil): alt text as a link. */
private fun AnnotatedString.Builder.appendImageFallback(node: Image, ctx: InlineContext) {
    val destination = node.destination.orEmpty()
    appendClassifiedLink(destination, ctx) {
        if (node.firstChild != null) appendInlineChildren(node, ctx, insideLink = true) else append(destination)
    }
}
