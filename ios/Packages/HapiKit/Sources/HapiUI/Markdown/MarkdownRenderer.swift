import Foundation
import Markdown
import SwiftUI

// MARK: - hapiOpenURL environment

/// Link-open handler for everything the markdown renderer emits: regular
/// URLs (after `HrefPolicy` filtering) and `hapi-file://?path=&line=` file
/// references (decode with `FilePathLink(url:)`). The app decides what to do
/// (SFSafariViewController, session file viewer, confirm sheet for
/// `.confirmFirst` schemes); HapiUI never opens anything by itself.
public struct HapiOpenURLAction: Sendable {
    public typealias Handler = @Sendable (URL) -> Void

    private let handler: Handler

    public init(handler: @escaping Handler) {
        self.handler = handler
    }

    public func callAsFunction(_ url: URL) {
        handler(url)
    }
}

private struct HapiOpenURLKey: EnvironmentKey {
    static let defaultValue = HapiOpenURLAction { _ in }
}

public extension EnvironmentValues {
    /// Handler invoked for links tapped inside HapiUI markdown content.
    /// Defaults to a no-op; the app must install its own handler.
    var hapiOpenURL: HapiOpenURLAction {
        get { self[HapiOpenURLKey.self] }
        set { self[HapiOpenURLKey.self] = newValue }
    }
}

// MARK: - Block model

public struct MarkdownTableModel: Equatable, Sendable {
    public enum Alignment: Equatable, Sendable {
        case left
        case center
        case right
    }

    public var columnAlignments: [Alignment?]
    public var header: [AttributedString]
    public var rows: [[AttributedString]]

    public init(columnAlignments: [Alignment?], header: [AttributedString], rows: [[AttributedString]]) {
        self.columnAlignments = columnAlignments
        self.header = header
        self.rows = rows
    }
}

public struct MarkdownListModel: Equatable, Sendable {
    public struct Item: Equatable, Sendable {
        /// nil for plain list items; true/false for GFM task list items.
        public var checkbox: Bool?
        public var blocks: [MarkdownBlockNode]

        public init(checkbox: Bool? = nil, blocks: [MarkdownBlockNode]) {
            self.checkbox = checkbox
            self.blocks = blocks
        }
    }

    public var isOrdered: Bool
    public var startIndex: Int
    public var items: [Item]

    public init(isOrdered: Bool, startIndex: Int = 1, items: [Item]) {
        self.isOrdered = isOrdered
        self.startIndex = startIndex
        self.items = items
    }
}

/// Renderer-ready markdown block tree. Built from source text by
/// `MarkdownBlockTree.build(from:)`; pure data, so the conversion is unit
/// testable without rendering any view.
public indirect enum MarkdownBlockNode: Equatable, Sendable {
    case paragraph(AttributedString)
    case heading(level: Int, AttributedString)
    case codeBlock(language: String?, code: String)
    case blockquote([MarkdownBlockNode])
    case list(MarkdownListModel)
    case table(MarkdownTableModel)
    case thematicBreak
    /// Markdown image reference. Chat images arrive via tool results, not
    /// markdown, so this renders as a placeholder link row.
    case image(alt: String, destination: String?)
}

// MARK: - Block tree builder

public enum MarkdownBlockTree {
    /// Pre-processes the raw source (table repair + indented-code disable,
    /// mirroring the web's remark plugin order), parses it with
    /// swift-markdown (GFM tables/strikethrough/task lists; smart-quote
    /// substitution disabled to match remark output), and folds the tree
    /// into renderer-ready blocks.
    public static func build(from markdown: String) -> [MarkdownBlockNode] {
        let prepared = MarkdownTransforms.disableIndentedCode(
            MarkdownTransforms.repairTables(markdown)
        )
        let document = Document(parsing: prepared, options: [.disableSmartOpts])
        var builder = BlockBuilder()
        return builder.visit(document)
    }
}

struct BlockBuilder: MarkupVisitor {
    typealias Result = [MarkdownBlockNode]

    mutating func defaultVisit(_ markup: Markup) -> [MarkdownBlockNode] {
        // Unknown containers (custom blocks, directives): flatten children.
        markup.children.flatMap { visit($0) }
    }

    mutating func visitDocument(_ document: Document) -> [MarkdownBlockNode] {
        document.children.flatMap { visit($0) }
    }

    mutating func visitParagraph(_ paragraph: Paragraph) -> [MarkdownBlockNode] {
        let children = Array(paragraph.children)
        if children.count == 1, let image = children[0] as? Markdown.Image {
            var inline = InlineBuilder(insideLink: true)
            let alt = String(inline.content(of: image).characters)
            return [.image(alt: alt, destination: image.source)]
        }
        var inline = InlineBuilder()
        return [.paragraph(inline.content(of: paragraph))]
    }

    mutating func visitHeading(_ heading: Heading) -> [MarkdownBlockNode] {
        var inline = InlineBuilder()
        let level = min(max(heading.level, 1), 6)
        return [.heading(level: level, inline.content(of: heading))]
    }

    mutating func visitCodeBlock(_ codeBlock: CodeBlock) -> [MarkdownBlockNode] {
        var code = codeBlock.code
        if code.hasSuffix("\n") {
            code = String(code.dropLast())
        }
        // The fence info string may carry extra tokens ("swift lineNumbers");
        // only the first token is the language.
        var language: String? = nil
        if let info = codeBlock.language {
            let token = info.split(separator: " ").first.map(String.init) ?? info
            language = token.isEmpty ? nil : token
        }
        return [.codeBlock(language: language, code: code)]
    }

    mutating func visitHTMLBlock(_ html: HTMLBlock) -> [MarkdownBlockNode] {
        // The web drops raw HTML (react-markdown default). Showing the
        // literal source is the conservative visible choice on iOS.
        var raw = html.rawHTML
        if raw.hasSuffix("\n") {
            raw = String(raw.dropLast())
        }
        return [.paragraph(AttributedString(raw))]
    }

    mutating func visitBlockQuote(_ blockQuote: BlockQuote) -> [MarkdownBlockNode] {
        [.blockquote(blockQuote.children.flatMap { visit($0) })]
    }

    mutating func visitUnorderedList(_ unorderedList: UnorderedList) -> [MarkdownBlockNode] {
        [.list(makeList(from: unorderedList, ordered: false, start: 1))]
    }

    mutating func visitOrderedList(_ orderedList: OrderedList) -> [MarkdownBlockNode] {
        [.list(makeList(from: orderedList, ordered: true, start: Int(clamping: orderedList.startIndex)))]
    }

    mutating func visitThematicBreak(_ thematicBreak: ThematicBreak) -> [MarkdownBlockNode] {
        [.thematicBreak]
    }

    mutating func visitTable(_ table: Markdown.Table) -> [MarkdownBlockNode] {
        let columnCount = max(table.maxColumnCount, 1)
        var inline = InlineBuilder()

        var header: [AttributedString] = []
        for cell in table.head.cells {
            header.append(inline.content(of: cell))
        }
        while header.count < columnCount {
            header.append(AttributedString())
        }

        var rows: [[AttributedString]] = []
        for row in table.body.rows {
            var cells: [AttributedString] = []
            for cell in row.cells {
                cells.append(inline.content(of: cell))
            }
            while cells.count < columnCount {
                cells.append(AttributedString())
            }
            rows.append(cells)
        }

        var alignments: [MarkdownTableModel.Alignment?] = table.columnAlignments.map { alignment -> MarkdownTableModel.Alignment? in
            switch alignment {
            case .left: return .left
            case .center: return .center
            case .right: return .right
            case nil: return nil
            }
        }
        while alignments.count < columnCount {
            alignments.append(nil)
        }

        return [.table(MarkdownTableModel(
            columnAlignments: alignments,
            header: header,
            rows: rows
        ))]
    }

    private mutating func makeList(
        from container: some ListItemContainer,
        ordered: Bool,
        start: Int
    ) -> MarkdownListModel {
        var items: [MarkdownListModel.Item] = []
        for item in container.listItems {
            let checkbox: Bool? = item.checkbox.map { $0 == .checked }
            let blocks = item.children.flatMap { visit($0) }
            items.append(MarkdownListModel.Item(checkbox: checkbox, blocks: blocks))
        }
        return MarkdownListModel(isOrdered: ordered, startIndex: start, items: items)
    }
}

// MARK: - Inline builder

/// Folds inline markup into an `AttributedString`:
/// - bold / italic / strikethrough / inline code via
///   `InlinePresentationIntent` (theme styling is applied at render time),
/// - links via the `.link` attribute after `HrefPolicy` filtering (blocked
///   schemes render as plain text; scheme-less hrefs only survive as
///   workspace file links — anything else is inert, matching the web's
///   fail-closed rule),
/// - bare `scheme://` URLs and workspace file paths in plain text are
///   auto-linked (`MarkdownTransforms.detectAutolinkRanges` /
///   `detectFilePathRanges`); file references use `hapi-file://` URLs.
struct InlineBuilder: MarkupVisitor {
    typealias Result = AttributedString

    /// Inside a link (or alt text) no nested autolinking happens — mirrors
    /// the web plugin skipping `link` parents.
    var insideLink: Bool

    init(insideLink: Bool = false) {
        self.insideLink = insideLink
    }

    /// Concatenated visit of all children.
    mutating func content(of markup: Markup) -> AttributedString {
        var output = AttributedString()
        for child in markup.children {
            output += visit(child)
        }
        return output
    }

    mutating func defaultVisit(_ markup: Markup) -> AttributedString {
        content(of: markup)
    }

    mutating func visitText(_ text: Markdown.Text) -> AttributedString {
        insideLink ? AttributedString(text.string) : Self.linkified(text.string)
    }

    mutating func visitSoftBreak(_ softBreak: SoftBreak) -> AttributedString {
        AttributedString(" ")
    }

    mutating func visitLineBreak(_ lineBreak: LineBreak) -> AttributedString {
        AttributedString("\n")
    }

    mutating func visitInlineHTML(_ inlineHTML: InlineHTML) -> AttributedString {
        AttributedString(inlineHTML.rawHTML)
    }

    mutating func visitSymbolLink(_ symbolLink: SymbolLink) -> AttributedString {
        var piece = AttributedString(symbolLink.destination ?? "")
        piece.inlinePresentationIntent = .code
        return piece
    }

    mutating func visitEmphasis(_ emphasis: Emphasis) -> AttributedString {
        Self.addingIntent(.emphasized, to: content(of: emphasis))
    }

    mutating func visitStrong(_ strong: Strong) -> AttributedString {
        Self.addingIntent(.stronglyEmphasized, to: content(of: strong))
    }

    mutating func visitStrikethrough(_ strikethrough: Strikethrough) -> AttributedString {
        Self.addingIntent(.strikethrough, to: content(of: strikethrough))
    }

    mutating func visitInlineCode(_ inlineCode: InlineCode) -> AttributedString {
        var piece = AttributedString(inlineCode.code)
        piece.inlinePresentationIntent = .code
        if !insideLink,
           let fileLink = MarkdownTransforms.filePathLink(forInlineCode: inlineCode.code),
           let url = fileLink.url {
            piece.link = url
        }
        return piece
    }

    mutating func visitLink(_ link: Markdown.Link) -> AttributedString {
        let wasInsideLink = insideLink
        insideLink = true
        var label = content(of: link)
        insideLink = wasInsideLink

        var target = link.destination ?? ""
        var trailing: AttributedString? = nil

        // Angle autolinks (`<https://x，>`) have text == destination; strip
        // trailing CJK punctuation out of the link (remark-strip-cjk-autolink
        // parity — explicit `[text](url)` links are never modified).
        let plain = String(label.characters)
        if !target.isEmpty, plain == target,
           let split = MarkdownTransforms.splitTrailingCJKPunctuation(fromAutolink: target) {
            target = split.url
            label = AttributedString(split.url)
            trailing = AttributedString(split.trailing)
        }

        var result = label
        if target.isEmpty {
            // No destination — plain text.
        } else if !HrefPolicy.hasScheme(target) {
            // Scheme-less: only repo-relative workspace files become links;
            // everything else path-like renders inert (web #1452 rule; SPA
            // routes have no iOS equivalent).
            if let fileLink = MarkdownTransforms.fileLinkTarget(forExplicitHref: target),
               let url = fileLink.url {
                result.link = url
            }
        } else {
            switch HrefPolicy.classify(target) {
            case .blocked:
                break
            case .allowed, .confirmFirst:
                if let url = Self.makeURL(from: target) {
                    result.link = url
                }
            }
        }

        if let trailing {
            result += trailing
        }
        return result
    }

    mutating func visitImage(_ image: Markdown.Image) -> AttributedString {
        let wasInsideLink = insideLink
        insideLink = true
        let altText = content(of: image)
        insideLink = wasInsideLink

        let alt = String(altText.characters)
        let label = alt.isEmpty ? (image.source ?? "image") : alt
        var piece = AttributedString(label)
        if let source = image.source,
           HrefPolicy.hasScheme(source),
           HrefPolicy.classify(source) != .blocked,
           let url = Self.makeURL(from: source) {
            piece.link = url
        }
        return piece
    }

    // MARK: helpers

    static func addingIntent(
        _ intent: InlinePresentationIntent,
        to attributed: AttributedString
    ) -> AttributedString {
        // Rebuild run-by-run instead of mutating in place: attribute writes
        // count as mutations and would invalidate the run iterator.
        var output = AttributedString()
        for run in attributed.runs {
            var piece = AttributedString(attributed[run.range])
            let existing = run.inlinePresentationIntent ?? []
            piece.inlinePresentationIntent = existing.union(intent)
            output.append(piece)
        }
        return output
    }

    static func linkified(_ string: String) -> AttributedString {
        var output = AttributedString()
        var cursor = string.startIndex
        for hit in MarkdownTransforms.detectAutolinkRanges(in: string) {
            if hit.range.lowerBound > cursor {
                output += filePathLinked(String(string[cursor..<hit.range.lowerBound]))
            }
            var piece = AttributedString(hit.url)
            if HrefPolicy.classify(hit.url) != .blocked, let url = makeURL(from: hit.url) {
                piece.link = url
            }
            output += piece
            cursor = hit.range.upperBound
        }
        if cursor < string.endIndex {
            output += filePathLinked(String(string[cursor...]))
        }
        return output
    }

    static func filePathLinked(_ string: String) -> AttributedString {
        let hits = MarkdownTransforms.detectFilePathRanges(in: string)
        guard !hits.isEmpty else { return AttributedString(string) }
        var output = AttributedString()
        var cursor = string.startIndex
        for (range, link) in hits {
            if range.lowerBound > cursor {
                output += AttributedString(String(string[cursor..<range.lowerBound]))
            }
            var piece = AttributedString(String(string[range]))
            if let url = link.url {
                piece.link = url
            }
            output += piece
            cursor = range.upperBound
        }
        if cursor < string.endIndex {
            output += AttributedString(String(string[cursor...]))
        }
        return output
    }

    static func makeURL(from string: String) -> URL? {
        if let url = URL(string: string) { return url }
        guard let encoded = string.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else {
            return nil
        }
        return URL(string: encoded)
    }
}

// MARK: - Theme application

/// Applies palette-dependent styling to a built inline string: inline-code
/// runs get the monospaced font + chip colors, link runs get the link color
/// and underline. Bold/italic/strikethrough render natively from
/// `InlinePresentationIntent`.
func hapiStyledText(_ source: AttributedString, theme: HapiTheme) -> AttributedString {
    var output = AttributedString()
    for run in source.runs {
        var piece = AttributedString(source[run.range])
        if let intent = run.inlinePresentationIntent, intent.contains(.code) {
            piece[AttributeScopes.SwiftUIAttributes.FontAttribute.self] = theme.inlineCodeFont
            piece[AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute.self] = theme.inlineCodeForeground
            piece[AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self] = theme.inlineCodeBackground
        }
        if run.link != nil {
            piece[AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute.self] = theme.link
            piece[AttributeScopes.SwiftUIAttributes.UnderlineStyleAttribute.self] = .single
        }
        output.append(piece)
    }
    return output
}

// MARK: - Views

/// SwiftUI markdown renderer. Parses in `init` (cheap enough for chat-sized
/// content; streaming updates re-parse on each source change) and renders the
/// block tree. Link taps — including `hapi-file://` workspace references —
/// are delivered to `\.hapiOpenURL`.
public struct MarkdownView: View {
    private let blocks: [MarkdownBlockNode]
    @Environment(\.hapiOpenURL) private var hapiOpenURL

    public init(markdown: String) {
        self.blocks = MarkdownBlockTree.build(from: markdown)
    }

    public init(blocks: [MarkdownBlockNode]) {
        self.blocks = blocks
    }

    public var body: some View {
        let open = hapiOpenURL
        MarkdownBlockListView(blocks: blocks)
            .environment(\.openURL, OpenURLAction { url in
                // Route AttributedString link taps into the app handler.
                open(url)
                return .handled
            })
    }
}

struct MarkdownBlockListView: View {
    let blocks: [MarkdownBlockNode]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                MarkdownBlockView(block: block)
            }
        }
    }
}

struct MarkdownBlockView: View {
    let block: MarkdownBlockNode
    @Environment(\.hapiTheme) private var theme

    var body: some View {
        switch block {
        case .paragraph(let text):
            SwiftUI.Text(hapiStyledText(text, theme: theme))
                .font(theme.bodyFont)
                .foregroundStyle(theme.textPrimary)
                .textSelection(.enabled)
        case .heading(let level, let text):
            SwiftUI.Text(hapiStyledText(text, theme: theme))
                .font(headingFont(level))
                .foregroundStyle(theme.textPrimary)
                .textSelection(.enabled)
        case .codeBlock(let language, let code):
            CodeBlockView(language: language, code: code)
        case .blockquote(let children):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(theme.quoteBar)
                    .frame(width: 3)
                MarkdownBlockListView(blocks: children)
            }
            .padding(10)
            .background(theme.quoteBackground)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        case .list(let model):
            MarkdownListView(model: model)
        case .table(let model):
            MarkdownTableView(model: model)
        case .thematicBreak:
            Rectangle()
                .fill(theme.divider)
                .frame(height: 1)
                .padding(.vertical, 4)
        case .image(let alt, let destination):
            MarkdownImageRow(alt: alt, destination: destination)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        let size: CGFloat
        switch level {
        case 1: size = theme.bodySize + 6
        case 2: size = theme.bodySize + 4
        case 3: size = theme.bodySize + 2.5
        case 4: size = theme.bodySize + 1.5
        case 5: size = theme.bodySize + 1
        default: size = theme.bodySize + 0.5
        }
        return .system(size: size, weight: .semibold)
    }
}

struct MarkdownListView: View {
    let model: MarkdownListModel
    @Environment(\.hapiTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(model.items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    marker(for: item, index: index)
                    MarkdownBlockListView(blocks: item.blocks)
                }
            }
        }
    }

    @ViewBuilder
    private func marker(for item: MarkdownListModel.Item, index: Int) -> some View {
        if let checked = item.checkbox {
            SwiftUI.Image(systemName: checked ? "checkmark.square.fill" : "square")
                .font(.system(size: theme.bodySize - 2))
                .foregroundStyle(checked ? theme.accent : theme.textHint)
                .accessibilityLabel(SwiftUI.Text(checked ? "Completed" : "Not completed"))
        } else if model.isOrdered {
            SwiftUI.Text("\(model.startIndex + index).")
                .font(theme.bodyFont.monospacedDigit())
                .foregroundStyle(theme.textHint)
        } else {
            SwiftUI.Text("•")
                .font(theme.bodyFont)
                .foregroundStyle(theme.textHint)
        }
    }
}

struct MarkdownTableView: View {
    let model: MarkdownTableModel
    @Environment(\.hapiTheme) private var theme

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(model.header.enumerated()), id: \.offset) { index, cell in
                        SwiftUI.Text(hapiStyledText(cell, theme: theme))
                            .fontWeight(.semibold)
                            .font(theme.bodyFont)
                            .foregroundStyle(theme.textPrimary)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .gridColumnAlignment(columnAlignment(index))
                            .background(theme.tableHeaderBackground)
                    }
                }
                ForEach(Array(model.rows.enumerated()), id: \.offset) { _, row in
                    Divider()
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { index, cell in
                            SwiftUI.Text(hapiStyledText(cell, theme: theme))
                                .font(theme.bodyFont)
                                .foregroundStyle(theme.textPrimary)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .gridColumnAlignment(columnAlignment(index))
                        }
                    }
                }
            }
        }
        .background(theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func columnAlignment(_ index: Int) -> HorizontalAlignment {
        guard index < model.columnAlignments.count, let alignment = model.columnAlignments[index] else {
            return .leading
        }
        switch alignment {
        case .left: return .leading
        case .center: return .center
        case .right: return .trailing
        }
    }
}

struct MarkdownImageRow: View {
    let alt: String
    let destination: String?
    @Environment(\.hapiTheme) private var theme
    @Environment(\.hapiOpenURL) private var hapiOpenURL

    var body: some View {
        let label = alt.isEmpty ? (destination ?? "image") : alt
        let url: URL? = destination.flatMap { dest in
            guard HrefPolicy.hasScheme(dest), HrefPolicy.classify(dest) != .blocked else { return nil }
            return InlineBuilder.makeURL(from: dest)
        }

        HStack(spacing: 6) {
            SwiftUI.Image(systemName: "photo")
                .font(.system(size: theme.captionSize))
                .foregroundStyle(theme.textHint)
            if let url {
                Button {
                    hapiOpenURL(url)
                } label: {
                    SwiftUI.Text(label)
                        .font(theme.captionFont)
                        .foregroundStyle(theme.link)
                        .underline()
                        .lineLimit(1)
                }
                .buttonStyle(.plain)
            } else {
                SwiftUI.Text(label)
                    .font(theme.captionFont)
                    .foregroundStyle(theme.textSecondary)
                    .lineLimit(1)
            }
        }
        .padding(8)
        .background(theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}
