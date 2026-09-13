import SwiftUI
import Testing
@testable import HapiUI

@Suite("Reading typography")
struct TypographyTests {
    @Test func baselineAndScaledMetricsKeepTheirHierarchy() {
        let base = HapiTypography()
        #expect(base.bodySize == 16)
        #expect(base.codeSize == 14)
        #expect(base.inlineCodeSize == 15)
        #expect(base.captionSize == 12)
        #expect((1...6).map(base.headingSize) == [24, 20, 18, 17, 17, 17])
        let large = HapiTypography(bodyScale: 3, codeScale: 2, captionScale: 2.5, boldText: true)
        #expect(large.bodySize == 48)
        #expect(large.inlineCodeSize == 45)
        #expect(large.bodyLineSpacing == 9)
        #expect(large.codeLineSpacing == 4)
        #expect(large.headingSize(3) > large.bodySize)
    }

    @Test @MainActor
    func markdownMarginsAreBetweenBlocksNotStackedPadding() {
        let paragraph = MarkdownBlockNode.paragraph(AttributedString("Body"))
        let heading = MarkdownBlockNode.heading(level: 2, AttributedString("Heading"))
        #expect(MarkdownBlockListView.spacing(before: heading, after: nil) == 0)
        #expect(MarkdownBlockListView.spacing(before: paragraph, after: nil) == 0)
        #expect(MarkdownBlockListView.spacing(before: heading, after: paragraph) == 24)
        #expect(MarkdownBlockListView.spacing(before: heading, after: heading) == 24)
        #expect(MarkdownBlockListView.spacing(before: paragraph, after: heading) == 8)
        #expect(MarkdownBlockListView.spacing(before: paragraph, after: paragraph) == 12)
    }

    @Test func conversationRhythmDoesNotMistakeHistoryForANewTurn() {
        #expect(TranscriptRowRole.user.spacing(after: nil) == 12)
        #expect(TranscriptRowRole.user.spacing(after: .history) == 12)
        #expect(TranscriptRowRole.user.spacing(after: .content) == 24)
        #expect(TranscriptRowRole.user.spacing(after: .user) == 8)
        #expect(TranscriptRowRole.tool.spacing(after: .user) == 16)
        #expect(TranscriptRowRole.content.spacing(after: .user) == 16)
        #expect(TranscriptRowRole.tool.spacing(after: .tool) == 8)
        #expect(TranscriptRowRole.content.spacing(after: .tool) == 12)
    }

    @Test func readingWidthsFitSmallScreensAndCapTablets() {
        #expect(HapiReadingLayout.contentWidth(in: 320) == 288)
        #expect(HapiReadingLayout.contentWidth(in: 390) == 358)
        #expect(HapiReadingLayout.contentWidth(in: 507) == 475)
        #expect(HapiReadingLayout.contentWidth(in: 768) == 720)
        #expect(HapiReadingLayout.contentWidth(in: 1024) == 720)
        #expect(HapiReadingLayout.contentWidth(in: 0) == 1)
    }

    @Test func inlineCodeIsNeutralButLinksStillWin() {
        var source = AttributedString("code")
        source.inlinePresentationIntent = .code
        let typography = HapiTypography(bodyScale: 2)
        for theme in [HapiTheme.light, .dark, .oled] {
            let styled = hapiStyledText(source, theme: theme, typography: typography)
            #expect(styled.font == typography.inlineCodeFont)
            #expect(styled.foregroundColor == theme.textPrimary)
            source.link = URL(string: "https://example.com")
            let linked = hapiStyledText(source, theme: theme, typography: typography)
            #expect(linked.foregroundColor == theme.link)
            #expect(linked.underlineStyle == .single)
            source.link = nil
        }
    }
}
