import Foundation

/// Pure string-level ports of the web client's markdown pre-processing
/// (`web/src/lib/remark-*.ts` + `markdown-href-policy.ts` + the URI scheme
/// policy inlined in `markdown-text.tsx`). These run on the raw markdown
/// source BEFORE swift-markdown parses it, or provide pure classification
/// helpers the renderer applies to the parsed tree.
///
/// Known deltas vs the web (documented per function):
/// - `disableIndentedCode` cannot disable the parser feature (cmark has no
///   such option), so it de-indents would-be indented-code lines instead.
/// - Windows absolute paths are never linked on iOS (the web routes them
///   through session-workspace containment which HapiUI does not have).
public enum MarkdownTransforms {

    // MARK: - Table repair (remark-repair-tables.ts)

    /// Regex for one GFM separator cell: `^\s*:?-+:?\s*$`.
    // NSRegularExpression is immutable and thread-safe; nonisolated(unsafe)
    // sidesteps SDK-dependent Sendable annotation gaps under Swift 6.
    nonisolated(unsafe) private static let separatorCellRegex = try! NSRegularExpression(pattern: #"^\s*:?-+:?\s*$"#)
    /// Backtick code spans (so pipes inside them are not counted as cells).
    nonisolated(unsafe) private static let codeSpanRegex = try! NSRegularExpression(pattern: "`+[^`]*?`+")
    /// Fence opener/closer: up to 3 leading spaces, then ``` / ~~~ runs.
    nonisolated(unsafe) private static let fenceRegex = try! NSRegularExpression(pattern: #"^ {0,3}(`{3,}|~{3,})(.*)$"#)

    private static func fullRange(of string: String) -> NSRange {
        NSRange(string.startIndex..<string.endIndex, in: string)
    }

    private static func matchesWhole(_ regex: NSRegularExpression, _ string: String) -> Bool {
        guard let match = regex.firstMatch(in: string, range: fullRange(of: string)) else { return false }
        return match.range == fullRange(of: string)
    }

    /// Count pipe-delimited cells in one table row line of raw source.
    /// Strips backtick code spans first so pipes inside them are not counted.
    /// Skips escaped pipes (`\|`) which are literal characters, not boundaries.
    static func countSourceCells(_ line: String) -> Int {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        let masked = codeSpanRegex.stringByReplacingMatches(
            in: trimmed,
            range: fullRange(of: trimmed),
            withTemplate: "\u{FFFC}"
        )
        let inner = masked.hasPrefix("|") ? String(masked.dropFirst()) : masked
        let stripped = inner.hasSuffix("|") ? String(inner.dropLast()) : inner
        var cells = 1
        var escaped = false
        for ch in stripped {
            if escaped { escaped = false; continue }
            if ch == "\\" { escaped = true; continue }
            if ch == "|" { cells += 1 }
        }
        return cells
    }

    /// True when every pipe-delimited cell matches the GFM separator pattern.
    static func isSeparatorLine(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.contains("-") else { return false }
        let inner = trimmed.hasPrefix("|") ? String(trimmed.dropFirst()) : trimmed
        let stripped = inner.hasSuffix("|") ? String(inner.dropLast()) : inner
        let cells = stripped.components(separatedBy: "|")
        return !cells.isEmpty && cells.allSatisfy { matchesWhole(separatorCellRegex, $0) }
    }

    /// Cell count of a separator line, or nil when the line is not a separator.
    static func countSeparatorCells(_ line: String) -> Int? {
        guard isSeparatorLine(line) else { return nil }
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        let inner = trimmed.hasPrefix("|") ? String(trimmed.dropFirst()) : trimmed
        let stripped = inner.hasSuffix("|") ? String(inner.dropLast()) : inner
        return stripped.components(separatedBy: "|").count
    }

    /// Pad `sepLine` to `targetCols` cells, preserving existing alignment
    /// hints. Returns nil when the line already has enough cells or is not a
    /// valid separator.
    static func padSeparatorLine(_ sepLine: String, targetCols: Int) -> String? {
        let trimmed = sepLine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let hasLeading = trimmed.hasPrefix("|")
        let hasTrailing = trimmed.hasSuffix("|")

        let inner = hasLeading ? String(trimmed.dropFirst()) : trimmed
        let stripped = inner.hasSuffix("|") ? String(inner.dropLast()) : inner
        let cells = stripped.components(separatedBy: "|")

        guard cells.count < targetCols else { return nil }
        guard cells.allSatisfy({ matchesWhole(separatorCellRegex, $0) }) else { return nil }

        let padded = (cells + Array(repeating: " --- ", count: targetCols - cells.count))
            .joined(separator: "|")
        return (hasLeading ? "|" : "") + padded + (hasTrailing ? "|" : "")
    }

    /// Scan raw markdown for GFM tables whose separator row has fewer columns
    /// than the header row (the streaming-truncation / LLM-output failure
    /// mode) and pad the separator in place, so the parser produces a table
    /// with all columns intact instead of degrading the block to a paragraph.
    ///
    /// Table-like lines inside ``` / ~~~ fenced code blocks are never
    /// modified; leading whitespace of the separator line is preserved.
    public static func repairTables(_ source: String) -> String {
        var lines = source.components(separatedBy: "\n")
        var changed = false
        // Track fence character AND opening length: a ```` fence must not be
        // closed by ``` (GFM 4.5: closer must match the marker family AND be
        // at least as long); closers must be whitespace-only after the marker.
        var fenceChar: Character? = nil
        var fenceLength = 0

        for i in lines.indices {
            let line = lines[i]
            if let match = fenceRegex.firstMatch(in: line, range: fullRange(of: line)),
               let markerRange = Range(match.range(at: 1), in: line),
               let restRange = Range(match.range(at: 2), in: line) {
                let marker = line[markerRange]
                let rest = line[restRange]
                let ch = marker.first!
                let len = marker.count
                if fenceChar == nil {
                    fenceChar = ch
                    fenceLength = len
                } else if ch == fenceChar && len >= fenceLength
                    && rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    fenceChar = nil
                    fenceLength = 0
                }
                continue
            }
            if fenceChar != nil { continue }
            if i == lines.startIndex { continue }

            let sep = lines[i]
            guard isSeparatorLine(sep) else { continue }

            let hdr = lines[i - 1]
            // Only repair when the header row starts with | (common LLM form).
            guard hdr.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("|") else { continue }

            let headerCols = countSourceCells(hdr)
            guard let sepCols = countSeparatorCells(sep), sepCols < headerCols else { continue }

            guard let repaired = padSeparatorLine(sep, targetCols: headerCols) else { continue }
            // Preserve original leading whitespace so indented tables keep it.
            let prefix = String(sep.prefix(while: { $0 == " " || $0 == "\t" }))
            lines[i] = prefix + repaired
            changed = true
        }

        return changed ? lines.joined(separator: "\n") : source
    }

    // MARK: - Indented code disable (remark-disable-indented-code.ts)

    /// List-item marker at the start of (whitespace-stripped) line content:
    /// `-`, `*`, `+`, or `1.` / `1)` followed by space/tab or end of line.
    nonisolated(unsafe) private static let listMarkerRegex = try! NSRegularExpression(
        pattern: #"^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)"#
    )

    /// Neutralize CommonMark indented code blocks (4+ leading spaces).
    ///
    /// The web disables micromark's `codeIndented` construct; cmark offers no
    /// such switch, so this transform reduces the indentation of would-be
    /// indented-code lines to 3 spaces before parsing. LLM output frequently
    /// indents quoted text or continuation prose by 4 spaces, which would
    /// otherwise misrender as a code block. Fenced code still works normally.
    ///
    /// Conservative deltas vs the web:
    /// - lines inside an active list block are left untouched (so deeply
    ///   nested lists keep their required indentation); on the web, indented
    ///   code inside list items also degrades to a paragraph,
    /// - an indented line that itself looks like a list marker becomes a real
    ///   list after de-indenting (the web renders it as paragraph text),
    /// - blockquote-prefixed indented code (`>     x`) is left untouched.
    public static func disableIndentedCode(_ source: String) -> String {
        var lines = source.components(separatedBy: "\n")
        var changed = false
        var fenceChar: Character? = nil
        var fenceLength = 0
        // ```/~~~ marker at 4+ spaces of indent: not a real fence for the
        // parser, but the author clearly meant a code block — suppress all
        // rewriting until its matching closer so the block stays one unit.
        var indentedFenceChar: Character? = nil
        var indentedFenceLength = 0
        var listActive = false
        var previousLineBlank = true

        for i in lines.indices {
            let line = lines[i]

            if let match = fenceRegex.firstMatch(in: line, range: fullRange(of: line)),
               let markerRange = Range(match.range(at: 1), in: line),
               let restRange = Range(match.range(at: 2), in: line) {
                let marker = line[markerRange]
                let rest = line[restRange]
                let ch = marker.first!
                let len = marker.count
                if fenceChar == nil {
                    fenceChar = ch
                    fenceLength = len
                } else if ch == fenceChar && len >= fenceLength
                    && rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    fenceChar = nil
                    fenceLength = 0
                }
                previousLineBlank = false
                continue
            }
            if fenceChar != nil { continue }

            // Leading indentation width: space = 1 column, tab = 4 columns.
            var indentWidth = 0
            var contentStart = line.startIndex
            for ch in line {
                if ch == " " { indentWidth += 1 } else if ch == "\t" { indentWidth += 4 } else { break }
                contentStart = line.index(after: contentStart)
            }
            let content = String(line[contentStart...])
            let contentFenceMatch = fenceRegex.firstMatch(in: content, range: fullRange(of: content))

            if let pseudo = indentedFenceChar {
                // Inside an indented fence-lookalike block: leave everything
                // untouched, closing on a matching marker of >= length.
                if let match = contentFenceMatch,
                   let markerRange = Range(match.range(at: 1), in: content),
                   let restRange = Range(match.range(at: 2), in: content) {
                    let marker = content[markerRange]
                    if marker.first == pseudo && marker.count >= indentedFenceLength
                        && content[restRange].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        indentedFenceChar = nil
                        indentedFenceLength = 0
                    }
                }
                previousLineBlank = content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                continue
            }

            if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                previousLineBlank = true
                continue
            }

            if listMarkerRegex.firstMatch(in: content, range: fullRange(of: content)) != nil {
                // A list item starts here (the pattern is `^`-anchored).
                // A 4+-space marker outside any list would be indented code;
                // de-indent it so it starts a list. Inside a list, deeper
                // indentation is nesting — leave it untouched.
                if !listActive && indentWidth >= 4 {
                    lines[i] = "   " + content
                    changed = true
                }
                listActive = true
                previousLineBlank = false
                continue
            }

            if listActive {
                if indentWidth == 0 && previousLineBlank {
                    // Column-0 paragraph after a blank line ends the list.
                    listActive = false
                } else {
                    // List item continuation / nested content — untouched.
                    previousLineBlank = false
                    continue
                }
            }

            if indentWidth >= 4, let match = contentFenceMatch,
               let markerRange = Range(match.range(at: 1), in: content) {
                // Opening marker of an indented fence-lookalike block.
                let marker = content[markerRange]
                indentedFenceChar = marker.first
                indentedFenceLength = marker.count
                previousLineBlank = false
                continue
            }

            if indentWidth >= 4 {
                lines[i] = "   " + content
                changed = true
            }
            previousLineBlank = false
        }

        return changed ? lines.joined(separator: "\n") : source
    }

    // MARK: - CJK autolink artifacts (remark-strip-cjk-autolink.ts)

    /// CJK / fullwidth sentence-ending punctuation that should never be part
    /// of a URL, optionally followed by closing brackets (valid URL chars on
    /// their own, stripped only when trailing sentence-enders).
    nonisolated(unsafe) private static let trailingCJKPunctRegex = try! NSRegularExpression(
        pattern: "(?:[，。、；：！？\u{3000}\u{FF0E}]+[）】」』》〉]*)$"
    )

    /// Split trailing CJK punctuation off an autolinked URL.
    /// Returns nil when the URL has no trailing CJK punctuation.
    ///
    /// Applies only to autolinks (where link text == URL) — explicit
    /// `[text](url)` links are never modified, matching the web plugin.
    public static func splitTrailingCJKPunctuation(fromAutolink url: String) -> (url: String, trailing: String)? {
        guard let match = trailingCJKPunctRegex.firstMatch(in: url, range: fullRange(of: url)),
              let range = Range(match.range, in: url),
              !range.isEmpty
        else { return nil }
        return (String(url[..<range.lowerBound]), String(url[range]))
    }

    // MARK: - Bare URL autolinking (remark-non-https-autolink.ts + GFM autolink)

    /// swift-markdown does not attach cmark's autolink extension, so bare
    /// URLs are linked here instead. One detector covers both web plugins:
    /// GFM's `http(s)://` autolinks and the non-https `scheme://` plugin.
    /// Deliberately no scheme allowlist — `HrefPolicy` blocks/confirms
    /// downstream (matching the web's layering).
    ///
    /// Delta vs GFM: bare `www.` (scheme-less) and bare email autolinks are
    /// not supported.
    nonisolated(unsafe) private static let uriRegex = try! NSRegularExpression(
        pattern: #"\b[A-Za-z][A-Za-z0-9+.\-]*://[^\s]*"#
    )

    /// ASCII characters strippable from the end of a matched URI. `)` and `]`
    /// are only stripped when the URL body has no unmatched opening
    /// counterpart (keeps `obsidian://open?file=Note(1)` intact).
    private static let uriTrailingPunct: Set<Character> = [".", ",", ";", "!", "?", ":", ")", ">", "]", "'", "\""]

    static func stripTrailingURIPunctuation(_ uri: String) -> String {
        var stripped = Substring(uri)
        while let last = stripped.last, uriTrailingPunct.contains(last) {
            if last == ")" || last == "]" {
                let open: Character = last == ")" ? "(" : "["
                let inner = stripped.dropLast()
                let opens = inner.filter { $0 == open }.count
                let closes = inner.filter { $0 == last }.count
                // The closer balances an earlier opener — belongs to the URL.
                if closes < opens { break }
            }
            stripped = stripped.dropLast()
        }
        return String(stripped)
    }

    /// Detect bare `scheme://…` URIs in plain text. The returned range covers
    /// the linkable URL with trailing ASCII and CJK punctuation excluded; the
    /// `url` string equals the text at that range.
    public static func detectAutolinkRanges(in text: String) -> [(range: Range<String.Index>, url: String)] {
        var results: [(Range<String.Index>, String)] = []
        let matches = uriRegex.matches(in: text, range: fullRange(of: text))
        for match in matches {
            guard let matchRange = Range(match.range, in: text) else { continue }
            var url = String(text[matchRange])
            // ASCII trailing punctuation first (GFM behavior), then CJK
            // sentence punctuation (remark-strip-cjk-autolink behavior).
            url = stripTrailingURIPunctuation(url)
            if let split = splitTrailingCJKPunctuation(fromAutolink: url) {
                url = split.url
            }
            // Require something after "://".
            guard let schemeSepRange = url.range(of: "://"), schemeSepRange.upperBound < url.endIndex else { continue }
            let end = text.index(matchRange.lowerBound, offsetBy: url.count)
            results.append((matchRange.lowerBound..<end, url))
        }
        return results
    }

    // MARK: - File path detection (remark-file-path-links.ts)

    /// Extensions that autolink to the session file viewer. Intentionally an
    /// allowlist (not "any dotted word") so prose like `example.org` does not
    /// become a dead file link. Mirrors COMMON_FILE_EXTENSIONS on the web.
    public static let commonFileExtensions: Set<String> = [
        "adoc", "astro", "avif", "bat", "bmp", "c", "cfg", "cjs", "conf", "cpp", "css", "csv",
        "env", "gif", "go", "gql", "gradle", "graphql", "h", "hpp", "html", "ico", "ini", "java",
        "jpeg", "jpg", "js", "json", "jsx", "kt", "lock", "md", "mdx", "mjs", "mmd", "php", "png",
        "prisma", "properties", "proto", "ps1", "puml", "py", "rb", "rs", "rst", "scss", "sh",
        "sql", "svelte", "svg", "swift", "tex", "toml", "ts", "tsv", "tsx", "txt", "vue", "webp",
        "xml", "yaml", "yml", "zsh",
    ]

    /// PATH_PATTERN port: `dir/…/file.ext[:line[:col]]` or bare
    /// `file.ext[:line[:col]]` (extension validated separately against the
    /// allowlist).
    nonisolated(unsafe) private static let pathRegex = try! NSRegularExpression(
        pattern: #"(?:[A-Za-z]:[\\/]|\./|[A-Za-z0-9_.-]+/)[^\s`"'<>]*?\.(?:[A-Za-z0-9]{1,12}|lock)(?::\d+(?::\d+)?)?|(?:[A-Za-z0-9_.-]+\.(?:[A-Za-z0-9]{1,12}|lock))(?::\d+(?::\d+)?)?"#
    )

    nonisolated(unsafe) private static let lineSuffixRegex = try! NSRegularExpression(pattern: #":(\d+)(?::\d+)?$"#)

    private static let trailingPunctuation: Set<Character> = [".", ",", ";", ":", "!", "?"]

    static func splitTrailingPunctuation(_ value: String) -> (path: String, trailing: String) {
        var path = Substring(value)
        var trailing = ""

        while let last = path.last {
            if trailingPunctuation.contains(last) {
                trailing = String(last) + trailing
                path = path.dropLast()
                continue
            }
            if last == ")" {
                // Strip only when the parens are balanced-or-over-closed
                // (counts include the trailing `)` itself, like the web's
                // `path.split('(').length <= path.split(')').length`).
                let opens = path.filter { $0 == "(" }.count
                let closes = path.filter { $0 == ")" }.count
                if opens <= closes {
                    trailing = String(last) + trailing
                    path = path.dropLast()
                    continue
                }
                break
            }
            if last == "]" || last == "}" {
                trailing = String(last) + trailing
                path = path.dropLast()
                continue
            }
            break
        }

        return (String(path), trailing)
    }

    /// Strip a `:line[:col]` suffix.
    static func stripLineSuffix(_ value: String) -> String {
        guard let match = lineSuffixRegex.firstMatch(in: value, range: fullRange(of: value)),
              let range = Range(match.range, in: value)
        else { return value }
        return String(value[..<range.lowerBound])
    }

    /// Parse the line number out of a `:line[:col]` suffix, if present.
    static func lineNumber(fromSuffixOf value: String) -> Int? {
        guard let match = lineSuffixRegex.firstMatch(in: value, range: fullRange(of: value)),
              let range = Range(match.range(at: 1), in: value)
        else { return nil }
        return Int(value[range])
    }

    /// `^[A-Za-z]:[\\/]` port.
    static func isWindowsAbsolutePath(_ value: String) -> Bool {
        var iterator = value.makeIterator()
        guard let first = iterator.next(), first.isASCII, first.isLetter else { return false }
        guard let second = iterator.next(), second == ":" else { return false }
        guard let third = iterator.next(), third == "/" || third == "\\" else { return false }
        return true
    }

    public static func hasKnownFileExtension(_ value: String) -> Bool {
        let path = stripLineSuffix(value).lowercased()
        guard let dot = path.lastIndex(of: "."), path.index(after: dot) < path.endIndex else { return false }
        let ext = String(path[path.index(after: dot)...])
        return commonFileExtensions.contains(ext)
    }

    /// shouldLinkPath port. iOS delta: Windows absolute paths are rejected
    /// outright (the web autolinks them behind workspace containment, which
    /// HapiUI cannot evaluate — fail closed).
    static func shouldLinkPath(_ value: String) -> Bool {
        if value.contains("://") { return false }
        let path = stripLineSuffix(value)
        if path.count < 3 { return false }
        if path.hasPrefix("/") || path.hasPrefix("~/") { return false }
        if path.hasPrefix("../") || path.contains("/../") { return false }
        if isWindowsAbsolutePath(path) { return false }
        return hasKnownFileExtension(path)
    }

    /// Detect linkable file paths in plain text. The range covers the display
    /// text (path plus any `:line[:col]` suffix, trailing punctuation
    /// excluded); the link carries the clean path and parsed line number.
    public static func detectFilePathRanges(in text: String) -> [(range: Range<String.Index>, link: FilePathLink)] {
        var results: [(Range<String.Index>, FilePathLink)] = []
        let matches = pathRegex.matches(in: text, range: fullRange(of: text))
        for match in matches {
            guard let matchRange = Range(match.range, in: text) else { continue }
            if matchRange.lowerBound > text.startIndex {
                let previous = text[text.index(before: matchRange.lowerBound)]
                if previous == ":" || previous == "/" || previous == "\\" || previous == "." {
                    continue
                }
            }
            let raw = String(text[matchRange])
            let (displayPath, _) = splitTrailingPunctuation(raw)
            let filePath = stripLineSuffix(displayPath)
            guard shouldLinkPath(filePath) else { continue }

            let end = text.index(matchRange.lowerBound, offsetBy: displayPath.count)
            let link = FilePathLink(path: filePath, line: lineNumber(fromSuffixOf: displayPath))
            results.append((matchRange.lowerBound..<end, link))
        }
        return results
    }

    /// Whole-value inline-code file link (linkInlineCodeNode port).
    /// Conservative: only whitespace-free values the path pattern matches
    /// end-to-end are linked, keeping real code (`npm run build`, `Math.PI`,
    /// `a=b.js`) untouched.
    public static func filePathLink(forInlineCode code: String) -> FilePathLink? {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard trimmed.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else { return nil }

        guard let match = pathRegex.firstMatch(in: trimmed, range: fullRange(of: trimmed)),
              match.range == fullRange(of: trimmed)
        else { return nil }

        let filePath = stripLineSuffix(trimmed)
        guard shouldLinkPath(filePath) else { return nil }
        return FilePathLink(path: filePath, line: lineNumber(fromSuffixOf: trimmed))
    }

    /// Explicit `[label](relative/file.ext)` rewrite target (rewriteFileLinkNode
    /// port). Returns the file link for scheme-less repo-relative allowlisted
    /// paths (with `#fragment` / `?query` / `:line` stripped); nil for
    /// absolute / parent / scheme-bearing / non-file targets (fail closed).
    /// iOS delta: Windows absolute paths are rejected instead of deferred to
    /// containment; the line number is preserved on the link (the web drops it).
    public static func fileLinkTarget(forExplicitHref href: String) -> FilePathLink? {
        guard !href.lowercased().hasPrefix("hapi-file:") else { return nil }

        // Strip #fragment / ?query so `file.md#section` can still rewrite.
        var withoutMeta = href
        let hashIndex = href.firstIndex(of: "#")
        let queryIndex = href.firstIndex(of: "?")
        let cut: String.Index?
        switch (hashIndex, queryIndex) {
        case let (h?, q?): cut = min(h, q)
        case let (h?, nil): cut = h
        case let (nil, q?): cut = q
        default: cut = nil
        }
        if let cut { withoutMeta = String(href[..<cut]) }

        let target = stripLineSuffix(withoutMeta)
        if isWindowsAbsolutePath(target) { return nil }
        if target.hasPrefix("/") { return nil }
        if target.contains(":") { return nil }
        guard shouldLinkPath(target) else { return nil }
        return FilePathLink(path: target, line: lineNumber(fromSuffixOf: withoutMeta))
    }
}

// MARK: - FilePathLink

/// A detected workspace file reference (`src/foo.ts:12`).
public struct FilePathLink: Equatable, Hashable, Sendable {
    public var path: String
    public var line: Int?

    public init(path: String, line: Int? = nil) {
        self.path = path
        self.line = line
    }

    /// Custom URL scheme carrying the reference through `AttributedString`
    /// link attributes: `hapi-file://?path=<path>&line=<line>`.
    public static let urlScheme = "hapi-file"

    public var url: URL? {
        var components = URLComponents()
        components.scheme = Self.urlScheme
        components.host = ""
        var items = [URLQueryItem(name: "path", value: path)]
        if let line { items.append(URLQueryItem(name: "line", value: String(line))) }
        components.queryItems = items
        return components.url
    }

    /// Parse a `hapi-file://?path=&line=` URL back into a link.
    public init?(url: URL) {
        guard url.scheme?.lowercased() == Self.urlScheme else { return nil }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let items = components.queryItems,
              let path = items.first(where: { $0.name == "path" })?.value,
              !path.isEmpty
        else { return nil }
        self.path = path
        self.line = items.first(where: { $0.name == "line" })?.value.flatMap(Int.init)
    }
}

// MARK: - HrefPolicy

/// URI scheme policy for markdown links (port of the policy inlined in
/// `markdown-text.tsx`). Fail closed: anything without a recognizable scheme
/// is blocked (the renderer handles scheme-less hrefs separately via
/// `MarkdownTransforms.fileLinkTarget`).
///
/// iOS delta vs web: `http` requires confirmation (the web treats it as an
/// IANA-safe scheme and navigates directly; on iOS cleartext HTTP is both an
/// ATS concern and a phishing vector, so it goes through the confirm sheet).
public enum HrefPolicy {
    public enum Decision: Equatable, Sendable {
        /// Open directly.
        case allowed
        /// Ask the user before opening (http + custom schemes).
        case confirmFirst
        /// Never open; render as plain text.
        case blocked
    }

    /// Schemes that must always be blocked regardless of user preference.
    public static let denySchemes: Set<String> = ["javascript", "data", "vbscript", "file"]

    /// Schemes safe to open without confirmation. `http` is intentionally
    /// absent (see type-level note).
    public static let allowedSchemes: Set<String> = ["https", "mailto", "irc", "ircs", "xmpp"]

    /// Extract the normalized scheme: up to two rounds of percent-decoding
    /// (so `javascript%253A` is unwrapped), then ASCII control characters and
    /// all whitespace are stripped from the scheme (browsers discard exactly
    /// these during navigation, so `java\nscript:` normalizes to
    /// `javascript`). Returns nil when no valid `scheme:` prefix exists.
    public static func normalizedScheme(of url: String) -> String? {
        var value = String(url.drop(while: { $0.isWhitespace }))
        for _ in 0..<2 {
            guard let next = value.removingPercentEncoding, next != value else { break }
            value = next
        }
        guard let colon = value.firstIndex(of: ":"), colon != value.startIndex else { return nil }
        let rawScheme = value[..<colon]
        let cleaned = rawScheme.unicodeScalars.filter { scalar in
            if scalar.value <= 0x1F || scalar.value == 0x7F { return false }
            if scalar.properties.isWhitespace { return false }
            if scalar.value == 0xFEFF { return false }
            return true
        }
        return String(String.UnicodeScalarView(cleaned)).lowercased()
    }

    /// True when `href` carries a URL scheme (a `:` before any `/?#`).
    /// `mailto:x` → true; `/settings`, `./a`, `#f`, `/path:colon` → false.
    public static func hasScheme(_ href: String) -> Bool {
        guard let colon = href.firstIndex(of: ":"), colon != href.startIndex else { return false }
        guard let boundary = href.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) else { return true }
        return colon < boundary
    }

    public static func classify(_ url: String) -> Decision {
        guard let scheme = normalizedScheme(of: url) else { return .blocked }
        if denySchemes.contains(scheme) { return .blocked }
        if allowedSchemes.contains(scheme) { return .allowed }
        return .confirmFirst
    }

    public static func classify(_ url: URL) -> Decision {
        classify(url.absoluteString)
    }
}
