package app.hapi.protocol.markdown

import org.commonmark.node.Code
import org.commonmark.node.Document
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.HtmlBlock
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.LinkReferenceDefinition
import org.commonmark.node.Node
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.Text

/**
 * Math extraction, port of the web pipeline so both renderers agree on chat
 * markdown (`web/src/lib/remark-latex-bracket-math.ts` + `remark-math`
 * `singleDollarTextMath: false` semantics):
 *
 * - `$$...$$` on its own lines -> [MathKind.DISPLAY] (micromark math flow);
 *   mid-paragraph `$$...$$` -> [MathKind.INLINE] (math text), closing run must
 *   be the same size as the opening run.
 * - Single `$...$` NEVER opens math (currency protection, GitHub parity).
 * - `\[...\]` -> [MathKind.DISPLAY], `\( ... \)` -> [MathKind.INLINE]; the
 *   opener `\(`/`\[` may be escaped by an odd run of backslashes.
 * - Code spans, fenced/indented code, html and link/image/definition
 *   destinations never trigger math, and an unclosed opener is left as text.
 *
 * Mechanism (same as the web plugin): parse the repaired source once to learn
 * which source ranges are protected, replace every formula with private-use
 * placeholder tokens that keep the line shape (so the re-parse does not split
 * the paragraph), re-parse the safe source, then restore the tokens as
 * [MathBlockNode]/[MathInlineNode] and hoist display math out of paragraphs.
 *
 * Pure JVM on purpose: unit-tested in `:core:protocol` (MarkdownMathTest
 * mirrors the web remark-latex-bracket-math/markdown-text test names).
 */
internal object MarkdownMath {

    /** Cheap pre-check: sources without any of these substrings skip the whole two-parse dance. */
    val MATH_HINT: Regex = Regex("""\$\$|\\\[|\\\(""")

    private const val PLACEHOLDER_BASE = 0xE000
    private const val PLACEHOLDER_END = 0xF8FF

    private val LIST_MARKER: Regex = Regex("""^(?:[-+*]|\d{1,9}[.)])[ \t]+""")

    // ── Result types ─────────────────────────────────────────────────────────

    /** One extracted formula plus its source span and its container prefix. */
    internal class MathMatch(
        val kind: MathKind,
        val value: String,
        val start: Int,
        val end: Int,
        val prefix: String,
    ) {
        internal var token: Char = ' '
    }

    /** The token-replaced source plus every extracted formula. */
    internal class PreparedMath(val safeSource: String, val matches: List<MathMatch>)

    /**
     * Full pipeline for sources that pass [MATH_HINT]: mask-protected parse,
     * extraction, placeholder re-parse and restore. Returns the final document.
     */
    fun parseWithMath(
        source: String,
        spannedParse: (String) -> Node,
        plainParse: (String) -> Node,
    ): Document {
        val maskTree = spannedParse(source)
        val prepared = extract(source, maskTree as Document) ?: return maskTree as Document
        val document = plainParse(prepared.safeSource) as Document
        restore(document, prepared)
        return document
    }

    // ── Extraction ───────────────────────────────────────────────────────────

    /**
     * Find every formula in [source], using [tree] (parsed with source spans
     * enabled) to learn protected ranges. Returns null when there is no math,
     * in which case the caller keeps the original tree as-is.
     */
    fun extract(source: String, tree: Document): PreparedMath? {
        val mask = BooleanArray(source.length)
        markProtectedRanges(source, tree, mask)

        val matches = mutableListOf<MathMatch>()
        matches += findDollarMath(source, mask)
        // Existing $$ math is opaque to the bracket scan (web SOURCE_OPAQUE
        // contains math/inlineMath: `$$\verb|\(x\)|$$` keeps its inner `\(`).
        for (match in matches) markRange(mask, match.start, match.end)
        matches += findBracketMathMatches(source, mask)
        if (matches.isEmpty()) return null

        matches.sortBy { it.start }
        val out = StringBuilder(source.length)
        var cursor = 0
        var nextToken = PLACEHOLDER_BASE
        for (match in matches) {
            val token = findUnusedPlaceholderToken(source, nextToken)
            nextToken = token.code + 1
            match.token = token
            out.append(source, cursor, match.start)
            out.append(makeSourcePlaceholder(source.substring(match.start, match.end), match.prefix, token))
            cursor = match.end
        }
        out.append(source, cursor, source.length)
        return PreparedMath(out.toString(), matches.toList())
    }

    // ── Dollar math (remark-math `singleDollarTextMath: false` semantics) ────

    /**
     * `$$` runs: flow math when the run opens a line (after a container
     * prefix or <= 3 spaces) with only whitespace after it, closing on a later
     * line that is just a `$$` run of >= the opening size; otherwise text math
     * inside a paragraph, closing on an equal-sized run with no blank line or
     * protected range in between. Single `$` never opens math.
     */
    private fun findDollarMath(source: String, mask: BooleanArray): List<MathMatch> {
        val matches = mutableListOf<MathMatch>()
        var cursor = 0
        while (cursor < source.length) {
            val p = source.indexOf('$', cursor)
            if (p < 0) break
            var size = 0
            while (p + size < source.length && source[p + size] == '$') size++
            if (size < 2 || isProtected(mask, p, size) || !isUnescapedDelimiter(source, p)) {
                cursor = p + 1
                continue
            }

            val lineStart = source.lastIndexOf('\n', p - 1) + 1
            val lineEnd = source.indexOf('\n', p).let { if (it < 0) source.length else it }
            val container = getMarkdownContainerPrefix(source, p)
            val lineIndent = source.substring(lineStart, p).takeWhile { it == ' ' || it == '\t' }.length
            val restOfLineBlank = source.substring(p + size, lineEnd).isBlank()
            val atFlowPosition = p - lineStart == container.prefix.length &&
                (container.recognized || lineIndent <= 3)

            if (atFlowPosition && restOfLineBlank) {
                val close = findFlowClose(source, mask, size, container.prefix, lineEnd)
                if (close != null) {
                    val value = stripLinePrefix(source.substring(lineEnd + 1, close.start), container.prefix).trim()
                    if (value.isNotEmpty()) {
                        matches.add(MathMatch(MathKind.DISPLAY, value, p, close.end, container.prefix))
                        cursor = close.end
                        continue
                    }
                }
                // Unclosed flow math falls through to the paragraph-text rules,
                // matching micromark: the opener line stays a paragraph.
            }

            val textClose = findTextClose(source, mask, p, size)
            if (textClose != null) {
                val raw = source.substring(p + size, textClose)
                val value = trimMirroredWhitespace(raw)
                if (value.isNotEmpty()) {
                    matches.add(MathMatch(MathKind.INLINE, value, p, textClose + size, ""))
                    cursor = textClose + size
                    continue
                }
            }
            cursor = p + size
        }
        return matches
    }

    private class CloseSpan(val start: Int, val end: Int)

    /** Closing `$$` line for flow math: container prefix / <= 3 spaces, then a `$` run >= [size]. */
    private fun findFlowClose(
        source: String,
        mask: BooleanArray,
        size: Int,
        prefix: String,
        openLineEnd: Int,
    ): CloseSpan? {
        var lineStart = openLineEnd + 1
        while (lineStart < source.length) {
            val lineEnd = source.indexOf('\n', lineStart).let { if (it < 0) source.length else it }
            var contentStart = lineStart
            var content = source.substring(lineStart, lineEnd)
            if (prefix.isNotEmpty() && content.startsWith(prefix)) {
                contentStart += prefix.length
                content = content.substring(prefix.length)
            }
            var indent = 0
            while (indent < content.length && indent < 3 && (content[indent] == ' ' || content[indent] == '\t')) indent++
            val rest = content.substring(indent)
            var run = 0
            while (run < rest.length && rest[run] == '$') run++
            if (run >= size && rest.substring(run).isBlank() && !isProtected(mask, contentStart + indent, run)) {
                val runStart = contentStart + indent
                return CloseSpan(runStart, runStart + run)
            }
            lineStart = lineEnd + 1
        }
        return null
    }

    /**
     * Lines that would interrupt the opening paragraph (heading, blockquote,
     * fence, thematic break): micromark math-text cannot cross them, so the
     * search fails there. A blank line is handled inline below.
     */
    private val PARAGRAPH_INTERRUPT: Regex = Regex("""^[ \t]{0,3}(?:#|>|```|~~~|[-*_][ \t]*[-*_][ \t]*[-*_])""")

    /** Closing equal-sized `$$` run for text math: same paragraph, unescaped, nothing protected in between. */
    private fun findTextClose(source: String, mask: BooleanArray, openStart: Int, size: Int): Int? {
        var i = openStart + size
        while (i < source.length) {
            val c = source[i]
            if (c == '\n') {
                // A blank line ends the paragraph; text math cannot cross it.
                var j = i + 1
                while (j < source.length && (source[j] == ' ' || source[j] == '\t')) j++
                if (j >= source.length || source[j] == '\n') return null
                // Nor can another block construct that interrupts paragraphs.
                if (PARAGRAPH_INTERRUPT.containsMatchIn(source.substring(j).lineSequence().first())) return null
                i++
            } else if (c == '$') {
                var run = 0
                while (i + run < source.length && source[i + run] == '$') run++
                if (run == size && !isProtected(mask, i, run) && isUnescapedDelimiter(source, i)) {
                    return if (containsProtectedRange(mask, openStart, i)) null else i
                }
                i += run
            } else {
                i++
            }
        }
        return null
    }

    /** micromark math-text resolve: trimmed only when BOTH edges are whitespace. */
    private fun trimMirroredWhitespace(value: String): String {
        if (value.isEmpty()) return value
        val firstWs = value.first().isWhitespace()
        val lastWs = value.last().isWhitespace()
        return if (firstWs && lastWs) value.trim() else value
    }

    // ── Bracket math (remark-latex-bracket-math port) ────────────────────────

    private fun findBracketMathMatches(source: String, mask: BooleanArray): List<MathMatch> {
        val matches = mutableListOf<MathMatch>()
        var cursor = 0
        while (true) {
            val displayStart = findNextDelimiter(source, "\\[", cursor, mask)
            val inlineStart = findNextDelimiter(source, "\\(", cursor, mask)

            val start: Int
            val kind: MathKind
            if (displayStart >= 0 && (inlineStart < 0 || displayStart < inlineStart)) {
                start = displayStart
                kind = MathKind.DISPLAY
            } else if (inlineStart >= 0) {
                start = inlineStart
                kind = MathKind.INLINE
            } else {
                break
            }

            val closingDelimiter = if (kind == MathKind.DISPLAY) "\\]" else "\\)"
            val closingStart = findClosingDelimiter(source, closingDelimiter, start + 2, mask)
            if (closingStart < 0) {
                cursor = start + 2
                continue
            }

            val prefix = getMarkdownContainerPrefix(source, start).prefix
            val value = stripLinePrefix(source.substring(start + 2, closingStart), prefix).trim()
            val end = closingStart + 2
            if (value.isNotEmpty()) matches.add(MathMatch(kind, value, start, end, prefix))
            cursor = end
        }
        return matches
    }

    /** An odd run of backslashes before the delimiter escapes the final backslash. */
    private fun isUnescapedDelimiter(source: String, offset: Int): Boolean {
        var precedingBackslashes = 0
        var index = offset - 1
        while (index >= 0 && source[index] == '\\') {
            precedingBackslashes++
            index--
        }
        return precedingBackslashes % 2 == 0
    }

    private fun findNextDelimiter(source: String, delimiter: String, from: Int, mask: BooleanArray): Int {
        var offset = source.indexOf(delimiter, from)
        while (offset >= 0 && (isProtected(mask, offset, delimiter.length) || !isUnescapedDelimiter(source, offset))) {
            offset = source.indexOf(delimiter, offset + 1)
        }
        return offset
    }

    private fun findClosingDelimiter(source: String, delimiter: String, from: Int, mask: BooleanArray): Int {
        val offset = findNextDelimiter(source, delimiter, from, mask)
        return if (offset >= 0 && !containsProtectedRange(mask, from, offset)) offset else -1
    }

    // ── Container prefixes ───────────────────────────────────────────────────

    internal class ContainerPrefix(val prefix: String, val recognized: Boolean)

    /**
     * Container prefix (blockquote markers, list markers, <= 3 spaces) that
     * precedes [offset] on its line; list markers normalize to spaces
     * (continuation indent). Returns the raw leading text when no container is
     * recognized and the delimiter is preceded by non-blank prose (web parity).
     */
    private fun getMarkdownContainerPrefix(source: String, offset: Int): ContainerPrefix {
        val lineStart = source.lastIndexOf('\n', offset - 1) + 1
        val beforeDelimiter = source.substring(lineStart, offset)
        var cursor = 0
        val continuation = StringBuilder()
        var recognizedContainer = false

        while (cursor < beforeDelimiter.length) {
            val containerStart = cursor
            while (cursor < beforeDelimiter.length &&
                (beforeDelimiter[cursor] == ' ' || beforeDelimiter[cursor] == '\t')
            ) cursor++
            if (cursor - containerStart > 3) {
                cursor = containerStart
                break
            }

            if (cursor < beforeDelimiter.length && beforeDelimiter[cursor] == '>') {
                cursor++
                if (cursor < beforeDelimiter.length &&
                    (beforeDelimiter[cursor] == ' ' || beforeDelimiter[cursor] == '\t')
                ) cursor++
                continuation.append(beforeDelimiter, containerStart, cursor)
                recognizedContainer = true
                continue
            }

            val listMarker = LIST_MARKER.find(beforeDelimiter.substring(cursor))
            if (listMarker != null) {
                repeat(cursor - containerStart + listMarker.value.length) { continuation.append(' ') }
                cursor += listMarker.value.length
                recognizedContainer = true
                continue
            }

            cursor = containerStart
            break
        }

        if (!recognizedContainer && beforeDelimiter.isNotBlank()) return ContainerPrefix("", false)
        val prefix = continuation.toString().ifEmpty { beforeDelimiter }
        return ContainerPrefix(prefix, recognizedContainer)
    }

    /** Remove [prefix] from the start of every line in [value], including the first. */
    private fun stripLinePrefix(value: String, prefix: String): String {
        if (prefix.isEmpty()) return value
        return value.replace(Regex("(^|\\n)" + Regex.escape(prefix)), "$1")
    }

    // ── Placeholder construction ─────────────────────────────────────────────

    private fun findUnusedPlaceholderToken(source: String, start: Int): Char {
        for (code in start..PLACEHOLDER_END) {
            if (!source.contains(code.toChar())) return code.toChar()
        }
        throw IllegalStateException("Unable to allocate a LaTeX placeholder token")
    }

    /**
     * Replace every line of the raw span with the placeholder token, keeping
     * the line shape (newlines, container prefix) so the re-parse keeps the
     * formula inside its original block; an empty line takes one token so the
     * paragraph is not split (web `makeSourcePlaceholder`).
     */
    private fun makeSourcePlaceholder(raw: String, prefix: String, token: Char): String {
        val out = StringBuilder(raw.length)
        val lines = raw.split('\n')
        for (index in lines.indices) {
            if (index > 0) out.append('\n')
            val line = lines[index]
            if (index == 0) {
                repeat(maxOf(1, line.length)) { out.append(token) }
            } else {
                val kept = if (prefix.isNotEmpty() && line.startsWith(prefix)) prefix else ""
                out.append(kept)
                repeat(maxOf(1, line.length - kept.length)) { out.append(token) }
            }
        }
        return out.toString()
    }

    // ── Protected ranges (mask) ──────────────────────────────────────────────

    /**
     * Ranges the math scan must never touch, learned from a parse with
     * `IncludeSourceSpans.BLOCKS_AND_INLINES`: code blocks/html blocks/
     * definitions consume whole lines; inline code, inline html and links
     * (incl. images and autolinks, which the autolink extension emits as
     * [Link]s) protect their exact span. Web parity note: the web plugin only
     * protects link DESTINATIONS (math inside `[label]` renders); here the
     * whole link is protected, which cannot corrupt anything and at most
     * leaves label math as literal text.
     */
    private fun markProtectedRanges(source: String, tree: Document, mask: BooleanArray) {
        val lineStarts = lineStartOffsets(source)
        val stack = ArrayDeque<Node>()
        stack.addLast(tree)
        while (stack.isNotEmpty()) {
            val node = stack.removeLast()
            when (node) {
                is FencedCodeBlock, is IndentedCodeBlock, is HtmlBlock, is LinkReferenceDefinition -> {
                    for (span in node.sourceSpans) protectFullLine(mask, lineStarts, source.length, span.lineIndex)
                }
                is Code, is HtmlInline, is Link, is Image -> {
                    for (span in node.sourceSpans) {
                        if (span.lineIndex < lineStarts.size) {
                            val start = lineStarts[span.lineIndex] + span.columnIndex
                            markRange(mask, start, start + span.length)
                        }
                    }
                }
            }
            var child = node.firstChild
            while (child != null) {
                stack.addLast(child)
                child = child.next
            }
        }
    }

    private fun lineStartOffsets(source: String): IntArray {
        val starts = ArrayList<Int>()
        starts.add(0)
        for (index in source.indices) {
            if (source[index] == '\n') starts.add(index + 1)
        }
        return starts.toIntArray()
    }

    private fun protectFullLine(mask: BooleanArray, lineStarts: IntArray, sourceLength: Int, lineIndex: Int) {
        if (lineIndex >= lineStarts.size) return
        val start = lineStarts[lineIndex]
        val end = if (lineIndex + 1 < lineStarts.size) lineStarts[lineIndex + 1] - 1 else sourceLength
        markRange(mask, start, end)
    }

    private fun markRange(mask: BooleanArray, start: Int, end: Int) {
        for (index in maxOf(0, start) until minOf(mask.size, end)) mask[index] = true
    }

    private fun isProtected(mask: BooleanArray, start: Int, length: Int): Boolean {
        for (index in start until minOf(mask.size, start + length)) {
            if (mask[index]) return true
        }
        return false
    }

    private fun containsProtectedRange(mask: BooleanArray, start: Int, end: Int): Boolean {
        for (index in maxOf(0, start) until minOf(mask.size, end)) {
            if (mask[index]) return true
        }
        return false
    }

    // ── Restore ──────────────────────────────────────────────────────────────

    /**
     * Turn placeholder tokens in the re-parsed [document] into math nodes:
     * split text node runs into [Text]/[MathInlineNode]/[MathBlockNode]
     * (fragments of one formula across soft line breaks collapse to a single
     * node), then hoist display math out of paragraphs (web
     * `splitParagraphAroundDisplayMath`), dropping whitespace-only leftovers.
     */
    fun restore(document: Document, prepared: PreparedMath) {
        val byToken = HashMap<Char, MathMatch>()
        for (match in prepared.matches) byToken[match.token] = match
        val emitted = HashSet<Char>()

        // Pass 1: split every text node that contains a placeholder run.
        val texts = ArrayList<Text>()
        val stack = ArrayDeque<Node>()
        stack.addLast(document)
        while (stack.isNotEmpty()) {
            val node = stack.removeLast()
            if (node is Text) texts.add(node)
            var child = node.firstChild
            while (child != null) {
                stack.addLast(child)
                child = child.next
            }
        }
        for (text in texts) {
            val literal = text.literal.orEmpty()
            var hasToken = false
            for (c in literal) {
                if (byToken.containsKey(c)) {
                    hasToken = true
                    break
                }
            }
            if (!hasToken) continue

            var cursor = 0
            var index = 0
            while (index < literal.length) {
                val match = byToken[literal[index]]
                if (match == null) {
                    index++
                    continue
                }
                var runEnd = index
                while (runEnd < literal.length && literal[runEnd] == literal[index]) runEnd++
                if (index > cursor) text.insertBefore(Text(literal.substring(cursor, index)))
                if (emitted.add(match.token)) {
                    text.insertBefore(
                        if (match.kind == MathKind.DISPLAY) MathBlockNode(match.value) else MathInlineNode(match.value),
                    )
                }
                cursor = runEnd
                index = runEnd
            }
            if (cursor < literal.length) text.insertBefore(Text(literal.substring(cursor)))
            text.unlink()
        }

        // Pass 2: hoist display math out of paragraphs.
        val paragraphs = ArrayList<Paragraph>()
        stack.addLast(document)
        while (stack.isNotEmpty()) {
            val node = stack.removeLast()
            if (node is Paragraph && node.firstChild?.next == null) {
                // Fast path: single-child paragraphs either hold one math node
                // (hoist) or nothing to do; still collected for uniform handling.
            }
            if (node is Paragraph) paragraphs.add(node)
            var child = node.firstChild
            while (child != null) {
                stack.addLast(child)
                child = child.next
            }
        }
        for (paragraph in paragraphs) {
            var hasDisplay = false
            var child = paragraph.firstChild
            while (child != null) {
                if (child is MathBlockNode) {
                    hasDisplay = true
                    break
                }
                child = child.next
            }
            if (!hasDisplay) continue

            var group = ArrayList<Node>()
            val flush = {
                val hasContent = group.any { !isBlankInline(it) }
                if (hasContent) {
                    val rest = Paragraph()
                    for (inline in group) {
                        inline.unlink()
                        rest.appendChild(inline)
                    }
                    paragraph.insertBefore(rest)
                } else {
                    for (inline in group) inline.unlink()
                }
                group = ArrayList()
            }
            var node = paragraph.firstChild
            while (node != null) {
                val next = node.next
                if (node is MathBlockNode) {
                    flush()
                    node.unlink()
                    paragraph.insertBefore(node)
                } else {
                    group.add(node)
                }
                node = next
            }
            flush()
            paragraph.unlink()
        }
    }

    /** Whitespace-only text, soft and hard line breaks carry no paragraph content. */
    private fun isBlankInline(node: Node): Boolean = when (node) {
        is Text -> node.literal.orEmpty().isBlank()
        is SoftLineBreak, is HardLineBreak -> true
        else -> false
    }
}
