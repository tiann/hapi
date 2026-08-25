import Foundation
import HapiUI
import Testing

/// Markdown source → `MarkdownBlockNode` tree conversion (logic only — no
/// view rendering). This exercises the swift-markdown visitor, the pre-parse
/// transforms wiring, link policy application and file-path autolinking.
@Suite("MarkdownBlockTree")
struct MarkdownBlockTreeTests {
    private typealias Run = (text: String, link: URL?, intent: InlinePresentationIntent?)

    private func runs(_ attributed: AttributedString) -> [Run] {
        attributed.runs.map { run in
            (String(attributed.characters[run.range]), run.link, run.inlinePresentationIntent)
        }
    }

    private func plain(_ attributed: AttributedString) -> String {
        String(attributed.characters)
    }

    private func paragraphText(_ node: MarkdownBlockNode) -> AttributedString? {
        if case .paragraph(let text) = node { return text }
        return nil
    }

    // MARK: - Basic blocks

    @Test func buildsPlainParagraph() throws {
        let blocks = MarkdownBlockTree.build(from: "hello world")
        #expect(blocks.count == 1)
        let text = try #require(paragraphText(blocks[0]))
        #expect(plain(text) == "hello world")
    }

    @Test func buildsInlineIntents() throws {
        let blocks = MarkdownBlockTree.build(from: "**bold** and *it* and ~~gone~~ and `code`")
        let text = try #require(paragraphText(blocks[0]))
        let all = runs(text)
        #expect(all.contains { $0.text == "bold" && $0.intent?.contains(.stronglyEmphasized) == true })
        #expect(all.contains { $0.text == "it" && $0.intent?.contains(.emphasized) == true })
        #expect(all.contains { $0.text == "gone" && $0.intent?.contains(.strikethrough) == true })
        #expect(all.contains { $0.text == "code" && $0.intent?.contains(.code) == true })
    }

    @Test func buildsHeadingWithLevel() throws {
        let blocks = MarkdownBlockTree.build(from: "## Title")
        guard case .heading(let level, let text) = try #require(blocks.first) else {
            Issue.record("expected heading")
            return
        }
        #expect(level == 2)
        #expect(plain(text) == "Title")
    }

    @Test func buildsFencedCodeBlock() throws {
        let blocks = MarkdownBlockTree.build(from: "```swift\nlet x = 1\n```")
        guard case .codeBlock(let language, let code) = try #require(blocks.first) else {
            Issue.record("expected code block")
            return
        }
        #expect(language == "swift")
        #expect(code == "let x = 1")
    }

    @Test func mermaidFenceStaysACodeBlock() throws {
        // v1 plan: mermaid/math degrade to plain code blocks.
        let blocks = MarkdownBlockTree.build(from: "```mermaid\ngraph TD\n```")
        guard case .codeBlock(let language, _) = try #require(blocks.first) else {
            Issue.record("expected code block")
            return
        }
        #expect(language == "mermaid")
    }

    @Test func buildsBlockquote() throws {
        let blocks = MarkdownBlockTree.build(from: "> quoted")
        guard case .blockquote(let children) = try #require(blocks.first) else {
            Issue.record("expected blockquote")
            return
        }
        let child = try #require(children.first)
        let text = try #require(paragraphText(child))
        #expect(plain(text) == "quoted")
    }

    @Test func buildsThematicBreak() {
        let blocks = MarkdownBlockTree.build(from: "a\n\n---\n\nb")
        #expect(blocks.count == 3)
        #expect(blocks[1] == .thematicBreak)
    }

    @Test func buildsImagePlaceholder() throws {
        let blocks = MarkdownBlockTree.build(from: "![shot](https://x.com/y.png)")
        guard case .image(let alt, let destination) = try #require(blocks.first) else {
            Issue.record("expected image")
            return
        }
        #expect(alt == "shot")
        #expect(destination == "https://x.com/y.png")
    }

    @Test func htmlBlockRendersAsLiteralParagraph() throws {
        let blocks = MarkdownBlockTree.build(from: "<div>\nraw\n</div>")
        let block = try #require(blocks.first)
        let text = try #require(paragraphText(block))
        #expect(plain(text).contains("<div>"))
    }

    // MARK: - Lists

    @Test func buildsTaskList() throws {
        let blocks = MarkdownBlockTree.build(from: "- [x] done\n- [ ] todo")
        guard case .list(let model) = try #require(blocks.first) else {
            Issue.record("expected list")
            return
        }
        #expect(model.isOrdered == false)
        #expect(model.items.count == 2)
        #expect(model.items[0].checkbox == true)
        #expect(model.items[1].checkbox == false)
    }

    @Test func buildsOrderedListWithStart() throws {
        let blocks = MarkdownBlockTree.build(from: "3. three\n4. four")
        guard case .list(let model) = try #require(blocks.first) else {
            Issue.record("expected list")
            return
        }
        #expect(model.isOrdered)
        #expect(model.startIndex == 3)
        #expect(model.items.count == 2)
        #expect(model.items[0].checkbox == nil)
    }

    @Test func preservesThreeLevelListNesting() throws {
        let blocks = MarkdownBlockTree.build(from: "- a\n  - b\n    - c")
        guard case .list(let outer) = try #require(blocks.first) else {
            Issue.record("expected list")
            return
        }
        guard case .list(let middle)? = outer.items.first?.blocks.last else {
            Issue.record("expected nested list at depth 2")
            return
        }
        guard case .list(let inner)? = middle.items.first?.blocks.last else {
            Issue.record("expected nested list at depth 3")
            return
        }
        let block = try #require(inner.items.first?.blocks.first)
        let text = try #require(paragraphText(block))
        #expect(plain(text) == "c")
    }

    // MARK: - Tables

    @Test func buildsTableFromValidSource() throws {
        let blocks = MarkdownBlockTree.build(from: "| a | b |\n|:--|--:|\n| 1 | 2 |")
        guard case .table(let model) = try #require(blocks.first) else {
            Issue.record("expected table")
            return
        }
        #expect(model.header.map { String($0.characters) } == ["a", "b"])
        #expect(model.rows.map { row in row.map { String($0.characters) } } == [["1", "2"]])
        #expect(model.columnAlignments == [.left, .right])
    }

    @Test func repairsTruncatedSeparatorIntoFullTable() throws {
        // The broken separator would degrade to a paragraph without the
        // repair transform; the tree must still contain a 3-column table.
        let blocks = MarkdownBlockTree.build(from: "| A | B | C |\n|---|---|\n| 1 | 2 | 3 |")
        guard case .table(let model) = try #require(blocks.first) else {
            Issue.record("expected repaired table")
            return
        }
        #expect(model.header.count == 3)
        #expect(model.rows == [["1", "2", "3"].map { AttributedString($0) }])
    }

    @Test func indentedProseStaysProse() throws {
        let blocks = MarkdownBlockTree.build(from: "intro:\n\n    quoted line")
        #expect(blocks.count == 2)
        let text = try #require(paragraphText(blocks[1]))
        #expect(plain(text) == "quoted line")
    }

    // MARK: - Links

    @Test func explicitHTTPSLinkGetsLinkAttribute() throws {
        let blocks = MarkdownBlockTree.build(from: "[site](https://example.com/a)")
        let text = try #require(paragraphText(blocks[0]))
        let linked = runs(text).compactMap { $0.link }
        #expect(linked == [URL(string: "https://example.com/a")])
    }

    @Test func blockedSchemeRendersAsPlainText() throws {
        let blocks = MarkdownBlockTree.build(from: "[x](javascript:alert(1))")
        let text = try #require(paragraphText(blocks[0]))
        #expect(runs(text).allSatisfy { $0.link == nil })
        #expect(plain(text) == "x")
    }

    @Test func customSchemeKeepsLinkForConfirmFlow() throws {
        let blocks = MarkdownBlockTree.build(from: "[open](vscode://file/a.swift)")
        let text = try #require(paragraphText(blocks[0]))
        #expect(runs(text).compactMap { $0.link } == [URL(string: "vscode://file/a.swift")])
    }

    @Test func relativeFileLinkRewritesToHapiFile() throws {
        let blocks = MarkdownBlockTree.build(from: "[doc](docs/a.md)")
        let text = try #require(paragraphText(blocks[0]))
        let url = try #require(runs(text).compactMap { $0.link }.first)
        #expect(url.scheme == "hapi-file")
        #expect(FilePathLink(url: url) == FilePathLink(path: "docs/a.md", line: nil))
        #expect(plain(text) == "doc")
    }

    @Test func schemelessNonFileLinkIsInert() throws {
        let blocks = MarkdownBlockTree.build(from: "[settings](/settings)")
        let text = try #require(paragraphText(blocks[0]))
        #expect(runs(text).allSatisfy { $0.link == nil })
        #expect(plain(text) == "settings")
    }

    @Test func bareURLIsAutolinked() throws {
        let blocks = MarkdownBlockTree.build(from: "see https://example.com now")
        let text = try #require(paragraphText(blocks[0]))
        let all = runs(text)
        #expect(all.contains { $0.text == "https://example.com" && $0.link == URL(string: "https://example.com") })
    }

    @Test func bareURLDropsTrailingCJKPunctuation() throws {
        let boundary = MarkdownBlockTree.build(from: "见 https://example.com。")
        let text = try #require(paragraphText(boundary[0]))
        let all = runs(text)
        #expect(all.contains { $0.text == "https://example.com" && $0.link == URL(string: "https://example.com") })
        #expect(plain(text) == "见 https://example.com。")
        // The punctuation itself is not part of any link run.
        #expect(all.allSatisfy { !($0.text.contains("。") && $0.link != nil) })
    }

    @Test func filePathInProseGetsHapiFileLink() throws {
        let blocks = MarkdownBlockTree.build(from: "see src/app.ts:12 ok")
        let text = try #require(paragraphText(blocks[0]))
        let hit = try #require(runs(text).first { $0.link != nil })
        #expect(hit.text == "src/app.ts:12")
        let url = try #require(hit.link)
        #expect(FilePathLink(url: url) == FilePathLink(path: "src/app.ts", line: 12))
    }

    @Test func inlineCodePathGetsLinkAndCodeIntent() throws {
        let blocks = MarkdownBlockTree.build(from: "`src/app.ts`")
        let text = try #require(paragraphText(blocks[0]))
        let hit = try #require(runs(text).first)
        #expect(hit.intent?.contains(.code) == true)
        let url = try #require(hit.link)
        #expect(FilePathLink(url: url)?.path == "src/app.ts")
    }

    @Test func inlineCodeSnippetStaysUnlinked() throws {
        let blocks = MarkdownBlockTree.build(from: "`npm run build`")
        let text = try #require(paragraphText(blocks[0]))
        let hit = try #require(runs(text).first)
        #expect(hit.intent?.contains(.code) == true)
        #expect(hit.link == nil)
    }

    @Test func linkLabelTextIsNotAutolinkedAgain() throws {
        // Inside an explicit link, path-like label text must not sprout
        // nested hapi-file links (web: transform skips link parents).
        let blocks = MarkdownBlockTree.build(from: "[src/app.ts](https://example.com)")
        let text = try #require(paragraphText(blocks[0]))
        let linked = Set(runs(text).compactMap { $0.link?.absoluteString })
        #expect(linked == ["https://example.com"])
    }

    @Test func smartPunctuationSubstitutionIsDisabled() throws {
        let blocks = MarkdownBlockTree.build(from: "\"quoted\" -- and...")
        let text = try #require(paragraphText(blocks[0]))
        #expect(plain(text) == "\"quoted\" -- and...")
    }
}
