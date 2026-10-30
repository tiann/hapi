import XCTest
@testable import Hapi

final class MessageTextPageTests: XCTestCase {
    func testShortPromptsPreserveLiteralTextAndWhitespace() {
        for source in ["", "  **not markdown**\n中👩🏽‍💻\t  ", "a\r\nb\n", String(repeating: "a", count: 2_000)] {
            let preview = MessageTextPage.preview(source)
            XCTAssertEqual(preview.text, source)
            XCTAssertEqual(preview.end, source.endIndex)
        }
    }

    func testPreviewBoundsBothSingleLinePayloadsAndNewlineFloods() {
        let longLine = String(repeating: "中👩🏽‍💻", count: 150_000)
        let preview = MessageTextPage.preview(longLine)
        XCTAssertEqual(preview.text.count, MessageTextPage.previewCharacters)
        XCTAssertLessThan(preview.end, longLine.endIndex)
        let newlines = String(repeating: "\r\n", count: 10_000)
        XCTAssertEqual(MessageTextPage.preview(newlines).text,
                       String(repeating: "\r\n", count: MessageTextPage.previewLines - 1))
    }

    func testNormalMultiScreenPromptsStayCompleteUntilTheSeparateFoldingThreshold() {
        for source in [String(repeating: "中", count: 3_000),
                       Array(repeating: "An ordinary multi-line prompt.", count: 80).joined(separator: "\n"),
                       String(repeating: "a", count: MessageTextPage.inlineCharacters)] {
            let preview = MessageTextPage.preview(source)
            XCTAssertEqual(preview.text, source)
            XCTAssertEqual(preview.end, source.endIndex)
        }
        let overCharacters = String(repeating: "a", count: MessageTextPage.inlineCharacters + 1)
        XCTAssertEqual(MessageTextPage.preview(overCharacters).text.count, MessageTextPage.previewCharacters)
        let exact = Array(repeating: "log", count: MessageTextPage.inlineLines).joined(separator: "\r\n")
        XCTAssertEqual(MessageTextPage.preview(exact).text, exact)
        let extended = exact + "\r\nnext"
        XCTAssertLessThan(MessageTextPage.preview(extended).end, extended.endIndex)
        XCTAssertEqual(MessageTextPage.preview(extended).text.filter(\.isNewline).count,
                       MessageTextPage.previewLines - 1)
    }

    func testPagingRoundTripsUnicodeWhitespaceAndCanGoBack() {
        let sources = [
            String(repeating: "日志 👩🏽‍💻 e\u{301}\r\n", count: 3_000) + "\t  END\n",
            String(repeating: "x", count: 20_001),
            String(repeating: "\n", count: 200),
            "",
        ]
        for source in sources {
            var pager = MessageTextPager(source: source)
            var pages = [pager.page.text]
            while pager.hasNext {
                pager.next()
                XCTAssertLessThanOrEqual(pager.page.text.count, MessageTextPage.pageCharacters)
                XCTAssertLessThanOrEqual(pager.page.text.filter(\.isNewline).count, MessageTextPage.pageLines - 1)
                XCTAssertFalse(pager.page.text.isEmpty)
                pages.append(pager.page.text)
            }
            XCTAssertEqual(pages.joined(), source)
            XCTAssertEqual(pager.source, source, "Full copy must not use the preview/current page")
            let last = pager.page
            pager.next()
            XCTAssertEqual(pager.page, last)
            for expected in pages.dropLast().reversed() {
                pager.previous()
                XCTAssertEqual(pager.page.text, expected)
            }
            XCTAssertEqual(pager.number, 1)
            XCTAssertFalse(pager.hasPrevious)
            pager.previous()
            XCTAssertEqual(pager.page.text, pages[0])
        }
    }
}
