package app.hapi.protocol.markdown

import org.commonmark.ext.autolink.AutolinkExtension
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.node.Block
import org.commonmark.node.BlockQuote
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.Heading
import org.commonmark.node.HtmlBlock
import org.commonmark.node.ListBlock
import org.commonmark.node.Node
import org.commonmark.node.ThematicBreak
import org.commonmark.parser.Parser

/**
 * Source-level markdown transforms + parser configuration, ported from the web
 * client so both renderers agree on how agent output is interpreted:
 *
 * - [repairTables]            <- `web/src/lib/remark-repair-tables.ts`
 * - [disableIndentedCode]     <- `web/src/lib/remark-disable-indented-code.ts`
 *                                (micromark `disable: codeIndented` == commonmark-java
 *                                `enabledBlockTypes` without `IndentedCodeBlock`)
 * - [stripCjkAutolinkArtifacts] <- `web/src/lib/remark-strip-cjk-autolink.ts`
 * - [detectFilePathLinks] / [matchWholeFilePath] / [rewriteExplicitLinkTarget]
 *                             <- `web/src/lib/remark-file-path-links.ts`
 *
 * Pure JVM on purpose: everything here is unit-tested in `:core:protocol`.
 */
object MarkdownTransforms {

    // ── Table repair (remark-repair-tables port) ─────────────────────────────

    /** Matches one GFM separator cell: optional colons around at least one dash. */
    private val SEPARATOR_CELL = Regex("""^\s*:?-+:?\s*$""")

    /** Code spans are blanked before counting pipes so `a|b` does not add a cell. */
    private val CODE_SPAN = Regex("`+[^`]*?`+")

    /** Fence opener/closer: up to 3 leading spaces, then ``` or ~~~ (3+), then rest. */
    private val FENCE_LINE = Regex("""^ {0,3}(`{3,}|~{3,})(.*)$""")

    private val LEADING_WHITESPACE = Regex("""^\s*""")

    /**
     * Count pipe-delimited cells in one table row line of raw source.
     * Strips backtick code spans first so pipes inside them are not counted.
     * Skips escaped pipes (`\|`) which are literal characters, not boundaries.
     */
    private fun countSourceCells(line: String): Int {
        val trimmed = line.trim().replace(CODE_SPAN, "\u0000")
        val inner = if (trimmed.startsWith("|")) trimmed.drop(1) else trimmed
        val stripped = if (inner.endsWith("|")) inner.dropLast(1) else inner
        var cells = 1
        var escaped = false
        for (ch in stripped) {
            when {
                escaped -> escaped = false
                ch == '\\' -> escaped = true
                ch == '|' -> cells++
            }
        }
        return cells
    }

    /** True if every pipe-delimited cell matches the GFM separator pattern. */
    private fun isSeparatorLine(line: String): Boolean {
        val trimmed = line.trim()
        if (!trimmed.contains('-')) return false
        val inner = if (trimmed.startsWith("|")) trimmed.drop(1) else trimmed
        val stripped = if (inner.endsWith("|")) inner.dropLast(1) else inner
        val cells = stripped.split('|')
        return cells.isNotEmpty() && cells.all { SEPARATOR_CELL.matches(it) }
    }

    /** Cell count of a separator line, or null if the line is not a separator. */
    private fun countSeparatorCells(line: String): Int? {
        if (!isSeparatorLine(line)) return null
        val trimmed = line.trim()
        val inner = if (trimmed.startsWith("|")) trimmed.drop(1) else trimmed
        val stripped = if (inner.endsWith("|")) inner.dropLast(1) else inner
        return stripped.split('|').size
    }

    /**
     * Pad [sepLine] to [targetCols] cells, preserving existing alignment hints.
     * Returns null when the line already has enough cells or is not a separator.
     */
    private fun padSeparatorLine(sepLine: String, targetCols: Int): String? {
        val trimmed = sepLine.trim()
        if (trimmed.isEmpty()) return null

        val hasLeading = trimmed.startsWith("|")
        val hasTrailing = trimmed.endsWith("|")

        val inner = if (hasLeading) trimmed.drop(1) else trimmed
        val stripped = if (inner.endsWith("|")) inner.dropLast(1) else inner
        val cells = stripped.split('|')

        if (cells.size >= targetCols) return null
        if (!cells.all { SEPARATOR_CELL.matches(it) }) return null

        val padded = cells + List(targetCols - cells.size) { " --- " }
        val paddedInner = padded.joinToString("|")
        return (if (hasLeading) "|" else "") + paddedInner + (if (hasTrailing) "|" else "")
    }

    /**
     * Scan raw markdown for broken table separator rows (streaming-truncated GFM
     * tables where the delimiter row has fewer cells than the header row) and pad
     * them in place BEFORE parsing. GFM parsers degrade a mismatched-separator
     * table block to a paragraph, so this must run at the source level.
     *
     * Fenced code blocks are tracked so table-like lines inside ``` / ~~~ fences
     * are never modified (closing fence must match the opener's marker family and
     * be at least as long, GFM 4.5). Leading whitespace of the separator line is
     * preserved so indented tables are unaffected.
     */
    fun repairTables(source: String): String {
        val lines = source.split("\n").toMutableList()
        var changed = false
        var fenceChar: Char? = null
        var fenceLength = 0

        for (i in lines.indices) {
            val fenceMatch = FENCE_LINE.find(lines[i])
            if (fenceMatch != null) {
                val marker = fenceMatch.groupValues[1]
                val ch = marker[0]
                val rest = fenceMatch.groupValues[2]
                if (fenceChar == null) {
                    fenceChar = ch
                    fenceLength = marker.length
                } else if (ch == fenceChar && marker.length >= fenceLength && rest.isBlank()) {
                    fenceChar = null
                    fenceLength = 0
                }
                continue
            }
            if (fenceChar != null) continue
            if (i == 0) continue

            val sep = lines[i]
            if (!isSeparatorLine(sep)) continue

            val hdr = lines[i - 1]
            // Only repair when the header row starts with | (the common LLM form).
            if (!hdr.trim().startsWith("|")) continue

            val headerCols = countSourceCells(hdr)
            val sepCols = countSeparatorCells(sep) ?: continue
            if (sepCols >= headerCols) continue

            val repaired = padSeparatorLine(sep, headerCols) ?: continue
            val prefix = LEADING_WHITESPACE.find(sep)?.value ?: ""
            lines[i] = prefix + repaired
            changed = true
        }

        return if (changed) lines.joinToString("\n") else source
    }

    // ── Indented-code disable + parser factory ───────────────────────────────

    /**
     * Every commonmark-java core block type EXCEPT [org.commonmark.node.IndentedCodeBlock].
     * Passing this to [Parser.Builder.enabledBlockTypes] replicates the web's
     * micromark `disable: ['codeIndented']`: 4-space-indented text stays prose
     * (LLM output frequently indents list continuations), fenced code still works.
     */
    val BLOCK_TYPES_WITHOUT_INDENTED_CODE: Set<Class<out Block>> = setOf(
        BlockQuote::class.java,
        Heading::class.java,
        FencedCodeBlock::class.java,
        HtmlBlock::class.java,
        ThematicBreak::class.java,
        ListBlock::class.java,
    )

    /** Apply the indented-code disable to a parser builder (web-parity transform). */
    fun disableIndentedCode(builder: Parser.Builder): Parser.Builder =
        builder.enabledBlockTypes(BLOCK_TYPES_WITHOUT_INDENTED_CODE)

    /**
     * The canonical HAPI markdown parser: GFM tables + strikethrough (double
     * tilde only, matching web `remark-gfm {singleTilde: false}` -- a single
     * tilde is common in shell prompts) + bare-URL autolink, with indented code
     * blocks disabled. Thread-safe and reusable.
     */
    fun newParser(): Parser = disableIndentedCode(
        Parser.builder().extensions(
            listOf(
                TablesExtension.create(),
                StrikethroughExtension.builder().requireTwoTildes(true).build(),
                AutolinkExtension.create(),
            )
        )
    ).build()

    private val sharedParser: Parser by lazy { newParser() }

    /** Full source pipeline: [repairTables] then parse with [newParser] config. */
    fun parse(source: String): Node = sharedParser.parse(repairTables(source))

    // ── CJK autolink artifact strip (remark-strip-cjk-autolink port) ─────────

    /**
     * CJK / fullwidth sentence-ending punctuation that should never be part of a
     * URL, optionally followed by closing brackets (valid URL chars on their own,
     * stripped only when they trail sentence-enders).
     */
    private val TRAILING_CJK_PUNCT = Regex("(?:[\uFF0C\u3002\u3001\uFF1B\uFF1A\uFF01\uFF1F\u3000\uFF0E]+[\uFF09\u3011\u300D\u300F\u300B\u3009]*)$")

    /** Result of [stripCjkAutolinkArtifacts]: clean URL + punctuation to re-emit as text. */
    data class AutolinkSplit(val url: String, val trailing: String)

    /**
     * Auto-linkers only understand ASCII boundaries, so a URL directly followed by
     * CJK punctuation (`https://x.dev/a，`) swallows the punctuation into the link.
     * Splits the swallowed trailing punctuation off the URL. Apply to autolinked
     * Link nodes only (link text == destination); explicit `[text](url)` links are
     * left alone by the caller, mirroring the web plugin.
     */
    fun stripCjkAutolinkArtifacts(url: String): AutolinkSplit {
        val match = TRAILING_CJK_PUNCT.find(url) ?: return AutolinkSplit(url, "")
        val punct = match.value
        return AutolinkSplit(url.dropLast(punct.length), punct)
    }

    // ── File path link detection (remark-file-path-links port) ───────────────

    /**
     * Extensions that autolink to the session file viewer. Intentionally
     * allowlisted (not "any dotted word") so prose like `example.org` or version
     * numbers never become dead file links; TLD lookalikes (org/com/io/dev/co)
     * are deliberately excluded. Mirrors `COMMON_FILE_EXTENSIONS` on the web.
     */
    val COMMON_FILE_EXTENSIONS: Set<String> = setOf(
        "adoc", "astro", "avif", "bat", "bmp", "c", "cfg", "cjs", "conf", "cpp", "css", "csv",
        "env", "gif", "go", "gql", "gradle", "graphql", "h", "hpp", "html", "ico", "ini", "java",
        "jpeg", "jpg", "js", "json", "jsx", "kt", "lock", "md", "mdx", "mjs", "mmd", "php", "png",
        "prisma", "properties", "proto", "ps1", "puml", "py", "rb", "rs", "rst", "scss", "sh",
        "sql", "svelte", "svg", "swift", "tex", "toml", "ts", "tsv", "tsx", "txt", "vue", "webp",
        "xml", "yaml", "yml", "zsh",
    )

    /**
     * Same alternation as the web `PATH_PATTERN`:
     * 1. prefixed paths -- `C:\`/`C:/`, `./`, or `segment/` -- lazily up to a dotted
     *    extension (1-12 alphanumerics or `lock`), optional `:line(:col)` suffix;
     * 2. bare `name.ext`, optional `:line(:col)` suffix.
     */
    private val PATH_PATTERN = Regex(
        """(?:[A-Za-z]:[\\/]|\./|[A-Za-z0-9_.-]+/)[^\s`"'<>]*?\.(?:[A-Za-z0-9]{1,12}|lock)(?::\d+(?::\d+)?)?|(?:[A-Za-z0-9_.-]+\.(?:[A-Za-z0-9]{1,12}|lock))(?::\d+(?::\d+)?)?"""
    )

    private val LINE_SUFFIX = Regex(""":(\d+)(?::(\d+))?$""")

    private val WINDOWS_ABS_PATH = Regex("""^[A-Za-z]:[\\/]""")

    private val TRAILING_PUNCTUATION = setOf('.', ',', ';', ':', '!', '?')

    /**
     * A linkable file path found in plain text.
     *
     * @param range indices in the input covering the displayed path (line suffix
     *   included, trailing punctuation excluded)
     * @param path the path with any `:line(:col)` suffix stripped
     * @param line 1-based line from a `path:line` / `path:line:col` suffix
     * @param column 1-based column from a `path:line:col` suffix
     * @param display the exact matched text (path plus any line suffix)
     */
    data class FilePathLink(
        val range: IntRange,
        val path: String,
        val line: Int?,
        val column: Int? = null,
        val display: String = path,
    )

    /** Strip trailing prose punctuation and unbalanced closing brackets. */
    private fun splitTrailingPunctuation(value: String): Pair<String, String> {
        var path = value
        var trailing = ""
        while (path.isNotEmpty()) {
            val last = path.last()
            when {
                last in TRAILING_PUNCTUATION -> {
                    trailing = last + trailing
                    path = path.dropLast(1)
                }
                last == ')' && path.count { it == '(' } <= path.count { it == ')' } -> {
                    trailing = last + trailing
                    path = path.dropLast(1)
                }
                last == ']' || last == '}' -> {
                    trailing = last + trailing
                    path = path.dropLast(1)
                }
                else -> return path to trailing
            }
        }
        return path to trailing
    }

    private fun stripLineSuffix(value: String): String = LINE_SUFFIX.replace(value, "")

    private fun parseLineSuffix(value: String): Pair<Int?, Int?> {
        val match = LINE_SUFFIX.find(value) ?: return null to null
        val line = match.groupValues[1].toIntOrNull()
        val column = match.groupValues[2].takeIf { it.isNotEmpty() }?.toIntOrNull()
        return line to column
    }

    /** True when the value (line suffix ignored) ends in an allowlisted extension. */
    fun hasKnownFileExtension(value: String): Boolean {
        val path = stripLineSuffix(value).lowercase()
        val dot = path.lastIndexOf('.')
        if (dot < 0 || dot == path.length - 1) return false
        return path.substring(dot + 1) in COMMON_FILE_EXTENSIONS
    }

    fun isWindowsAbsolutePath(value: String): Boolean = WINDOWS_ABS_PATH.containsMatchIn(value)

    /**
     * Web `shouldLinkPath`: no scheme, length >= 3, not POSIX-absolute or `~/`
     * (those need workspace containment, applied by the click handler), no parent
     * traversal, and an allowlisted extension. Windows-absolute paths pass here
     * (the web encodes them as containment-checked "candidates"); the native
     * link handler owns that decision.
     */
    fun shouldLinkPath(value: String): Boolean {
        if (value.contains("://")) return false
        val path = stripLineSuffix(value)
        if (path.length < 3) return false
        if (path.startsWith("/") || path.startsWith("~/")) return false
        if (path.startsWith("../") || path.contains("/../")) return false
        return hasKnownFileExtension(path)
    }

    /**
     * Find linkable file paths in plain prose (the text-node pass of the web
     * plugin). Skips matches directly preceded by `:`/`/`/`\`/`.` (mid-URL or
     * mid-path fragments) and everything rejected by [shouldLinkPath].
     */
    fun detectFilePathLinks(text: String): List<FilePathLink> {
        val results = mutableListOf<FilePathLink>()
        for (match in PATH_PATTERN.findAll(text)) {
            val start = match.range.first
            if (start > 0) {
                val prev = text[start - 1]
                if (prev == ':' || prev == '/' || prev == '\\' || prev == '.') continue
            }
            val (display, _) = splitTrailingPunctuation(match.value)
            if (display.isEmpty()) continue
            val path = stripLineSuffix(display)
            if (!shouldLinkPath(path)) continue
            val (line, column) = parseLineSuffix(display)
            results += FilePathLink(
                range = start until start + display.length,
                path = path,
                line = line,
                column = column,
                display = display,
            )
        }
        return results
    }

    /**
     * Inline-code pass: link a code span only when its ENTIRE value is a single
     * linkable path (whitespace-free, pattern covers the whole value). Keeps real
     * snippets (`npm run build`, `str.split()`) untouched, like the web plugin.
     */
    fun matchWholeFilePath(rawValue: String): FilePathLink? {
        val trimmed = rawValue.trim()
        if (trimmed.isEmpty()) return null
        if (trimmed.any { it.isWhitespace() }) return null

        val match = PATH_PATTERN.find(trimmed) ?: return null
        if (match.value != trimmed) return null

        val path = stripLineSuffix(trimmed)
        if (!shouldLinkPath(path)) return null
        val (line, column) = parseLineSuffix(trimmed)
        return FilePathLink(
            range = 0 until trimmed.length,
            path = path,
            line = line,
            column = column,
            display = trimmed,
        )
    }

    /**
     * Explicit `[label](target)` rewrite (web `rewriteFileLinkNode`): returns the
     * workspace file path a markdown link should open, or null when the target
     * must keep its URL semantics. `#fragment` / `?query` / `:line` suffixes are
     * stripped; POSIX-absolute and scheme-bearing (colon) targets are rejected;
     * Windows-absolute targets require an allowlisted extension.
     */
    fun rewriteExplicitLinkTarget(url: String): String? {
        if (url.isEmpty()) return null

        val hashIdx = url.indexOf('#')
        val queryIdx = url.indexOf('?')
        val cut = when {
            hashIdx >= 0 && queryIdx >= 0 -> minOf(hashIdx, queryIdx)
            hashIdx >= 0 -> hashIdx
            queryIdx >= 0 -> queryIdx
            else -> -1
        }
        val withoutMeta = if (cut >= 0) url.substring(0, cut) else url
        val target = stripLineSuffix(withoutMeta)

        if (isWindowsAbsolutePath(target)) {
            return if (hasKnownFileExtension(target)) target else null
        }
        if (target.startsWith("/") && !target.startsWith("//")) return null
        if (target.contains(':')) return null
        if (!shouldLinkPath(target)) return null
        return target
    }
}
