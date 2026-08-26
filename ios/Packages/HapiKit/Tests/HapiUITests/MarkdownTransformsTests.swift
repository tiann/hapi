import Foundation
import HapiUI
import Testing

/// Ports of the web transform tests (`remark-repair-tables.test.ts`,
/// `remark-strip-cjk-autolink.test.ts`, plus the indented-code and autolink
/// behaviors). Inline expectations mirror the web semantics except where a
/// documented iOS delta applies.
@Suite("MarkdownTransforms")
struct MarkdownTransformsTests {
    // MARK: - repairTables

    @Test func padsTwoCellSeparatorForThreeColumnHeader() {
        let input = "| A | B | C |\n|---|---|\n| 1 | 2 | 3 |"
        let output = MarkdownTransforms.repairTables(input)
        let lines = output.components(separatedBy: "\n")
        #expect(lines[1] == "|---|---| --- |")
        #expect(lines[0] == "| A | B | C |")
        #expect(lines[2] == "| 1 | 2 | 3 |")
    }

    @Test func padsOneCellSeparatorForFourColumnHeader() {
        let input = "| a | b | c | d |\n|-|\n| 1 | 2 | 3 | 4 |"
        let output = MarkdownTransforms.repairTables(input)
        let separator = output.components(separatedBy: "\n")[1]
        let cellCount = separator.components(separatedBy: "|")
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .count
        #expect(cellCount == 4)
    }

    @Test func leavesMatchingSeparatorUnchanged() {
        let input = "| A | B |\n|---|---|\n| 1 | 2 |"
        #expect(MarkdownTransforms.repairTables(input) == input)
    }

    @Test func leavesSeparatorWithMoreCellsThanHeaderUnchanged() {
        let input = "| a | b |\n|---|---|---|"
        #expect(MarkdownTransforms.repairTables(input) == input)
    }

    @Test func skipsSeparatorNotFollowingPipeHeader() {
        let input = "A | B | C\n---|---"
        #expect(MarkdownTransforms.repairTables(input) == input)
    }

    @Test func ignoresTableLikeLinesInsideBacktickFence() {
        let input = "```\n| A | B | C |\n|---|---|\n```"
        #expect(MarkdownTransforms.repairTables(input) == input)
    }

    @Test func ignoresTableLikeLinesInsideTildeFence() {
        let input = "~~~\n| A | B | C |\n|---|---|\n~~~"
        #expect(MarkdownTransforms.repairTables(input) == input)
    }

    @Test func fourBacktickFenceIsNotClosedByThreeBackticks() {
        let input = "````\n```\n| A | B | C |\n|---|---|\n````"
        #expect(MarkdownTransforms.repairTables(input) == input)
    }

    @Test func oppositeMarkerInsideFenceDoesNotFlipState() {
        let input = "~~~\n```\n| A | B | C |\n|---|---|\n~~~"
        #expect(MarkdownTransforms.repairTables(input) == input)
    }

    @Test func closingFenceWithInfoTextDoesNotClose() {
        let input = "```\ntext\n``` info\n| A | B | C |\n|---|---|"
        #expect(MarkdownTransforms.repairTables(input) == input)
    }

    @Test func repairsTableAfterFenceCloses() {
        let input = "```\ncode\n```\n| A | B | C |\n|---|---|"
        let output = MarkdownTransforms.repairTables(input)
        let lines = output.components(separatedBy: "\n")
        #expect(lines[4] == "|---|---| --- |")
    }

    @Test func preservesAlignmentHints() {
        let input = "| a | b | c |\n|:--|--:|"
        let output = MarkdownTransforms.repairTables(input)
        #expect(output.components(separatedBy: "\n")[1] == "|:--|--:| --- |")
    }

    @Test func escapedPipeInHeaderIsLiteral() {
        // `\|` is one literal pipe char, so the header has 2 cells — the
        // 2-cell separator already matches and must stay untouched.
        let input = "| a \\| b | c |\n|---|---|"
        #expect(MarkdownTransforms.repairTables(input) == input)
    }

    @Test func pipeInsideCodeSpanIsNotACellBoundary() {
        let input = "| `a|b` | c |\n|---|---|"
        #expect(MarkdownTransforms.repairTables(input) == input)
    }

    @Test func preservesIndentationOfRepairedSeparator() {
        let input = "  | a | b | c |\n  |---|---|"
        let output = MarkdownTransforms.repairTables(input)
        #expect(output.components(separatedBy: "\n")[1] == "  |---|---| --- |")
    }

    @Test func truncatedDataRowIsLeftAlone() {
        // Mid-row streaming truncation: GFM tolerates short body rows, so no
        // string-level repair is needed (web parity).
        let input = "| a | b | c |\n|---|---|---|\n| 1 | 2"
        #expect(MarkdownTransforms.repairTables(input) == input)
    }

    @Test func repairsBrokenTableAndLeavesValidOne() {
        let input = "| A | B |\n|---|---|\n| 1 | 2 |\n\n| X | Y | Z |\n|---|---|\n| 7 | 8 | 9 |"
        let output = MarkdownTransforms.repairTables(input)
        let lines = output.components(separatedBy: "\n")
        #expect(lines[1] == "|---|---|")
        #expect(lines[5] == "|---|---| --- |")
    }

    // MARK: - disableIndentedCode

    @Test func deindentsTopLevelIndentedText() {
        let input = "para:\n\n    quoted reply"
        let output = MarkdownTransforms.disableIndentedCode(input)
        #expect(output == "para:\n\n   quoted reply")
    }

    @Test func deindentsDeeplyIndentedText() {
        let input = "para:\n\n        eight spaces"
        let output = MarkdownTransforms.disableIndentedCode(input)
        #expect(output == "para:\n\n   eight spaces")
    }

    @Test func treatsTabAsIndentation() {
        let input = "para:\n\n\ttabbed"
        let output = MarkdownTransforms.disableIndentedCode(input)
        #expect(output == "para:\n\n   tabbed")
    }

    @Test func leavesFencedCodeAlone() {
        let input = "```\n    indented in fence\n```"
        #expect(MarkdownTransforms.disableIndentedCode(input) == input)
    }

    @Test func leavesListContinuationAlone() {
        let input = "1. item\n\n    continuation text"
        #expect(MarkdownTransforms.disableIndentedCode(input) == input)
    }

    @Test func leavesNestedListsAlone() {
        let input = "- a\n  - b\n    - c\n      - d"
        #expect(MarkdownTransforms.disableIndentedCode(input) == input)
    }

    @Test func deindentsAfterListEnds() {
        let input = "- item\n\ntext\n\n    stray indent"
        let output = MarkdownTransforms.disableIndentedCode(input)
        #expect(output == "- item\n\ntext\n\n   stray indent")
    }

    @Test func deindentsTopLevelIndentedListMarker() {
        // iOS delta: becomes a real list (web renders paragraph text).
        let input = "para\n\n    - foo"
        let output = MarkdownTransforms.disableIndentedCode(input)
        #expect(output == "para\n\n   - foo")
    }

    @Test func leavesIndentedFenceLookalikeBlockIntact() {
        // A 4-space-indented ``` block stays one untouched unit.
        let input = "text\n\n    ```\n    let x = 1\n    ```"
        #expect(MarkdownTransforms.disableIndentedCode(input) == input)
    }

    @Test func resumesDeindentingAfterIndentedFenceLookalikeCloses() {
        let input = "text\n\n    ```\n    body\n    ```\n\n    tail"
        let output = MarkdownTransforms.disableIndentedCode(input)
        #expect(output == "text\n\n    ```\n    body\n    ```\n\n   tail")
    }

    // MARK: - splitTrailingCJKPunctuation

    @Test func stripsTrailingFullwidthComma() {
        let result = MarkdownTransforms.splitTrailingCJKPunctuation(fromAutolink: "https://example.com，")
        #expect(result?.url == "https://example.com")
        #expect(result?.trailing == "，")
    }

    @Test func stripsTrailingIdeographicFullStop() {
        let result = MarkdownTransforms.splitTrailingCJKPunctuation(fromAutolink: "https://example.com/a。")
        #expect(result?.url == "https://example.com/a")
        #expect(result?.trailing == "。")
    }

    @Test func stripsMultipleTrailingCJKPunctuation() {
        let result = MarkdownTransforms.splitTrailingCJKPunctuation(fromAutolink: "https://example.com。，")
        #expect(result?.url == "https://example.com")
        #expect(result?.trailing == "。，")
    }

    @Test func stripsSentenceEnderFollowedByClosingBracket() {
        let result = MarkdownTransforms.splitTrailingCJKPunctuation(fromAutolink: "https://example.com/a。）")
        #expect(result?.url == "https://example.com/a")
        #expect(result?.trailing == "。）")
    }

    @Test func keepsCJKCharactersInsideThePath() {
        #expect(MarkdownTransforms.splitTrailingCJKPunctuation(fromAutolink: "https://example.com/文档") == nil)
    }

    @Test func keepsLoneFullwidthClosingBracket() {
        // Brackets alone (no sentence-ender) may be part of the URL.
        #expect(MarkdownTransforms.splitTrailingCJKPunctuation(fromAutolink: "https://example.com/a）") == nil)
    }

    @Test func returnsNilForCleanURL() {
        #expect(MarkdownTransforms.splitTrailingCJKPunctuation(fromAutolink: "https://example.com/a") == nil)
    }

    // MARK: - detectAutolinkRanges

    @Test func detectsBareHTTPSURL() {
        let text = "see https://example.com/x now"
        let hits = MarkdownTransforms.detectAutolinkRanges(in: text)
        #expect(hits.count == 1)
        #expect(hits.first?.url == "https://example.com/x")
        if let range = hits.first?.range {
            #expect(String(text[range]) == "https://example.com/x")
        }
    }

    @Test func detectsCustomSchemeURL() {
        let hits = MarkdownTransforms.detectAutolinkRanges(in: "open obsidian://vault/Note here")
        #expect(hits.first?.url == "obsidian://vault/Note")
    }

    @Test func stripsTrailingASCIIPunctuation() {
        let hits = MarkdownTransforms.detectAutolinkRanges(in: "See obsidian://x.")
        #expect(hits.first?.url == "obsidian://x")
    }

    @Test func keepsBalancedParensInURL() {
        let hits = MarkdownTransforms.detectAutolinkRanges(in: "x obsidian://open?file=Note(1) y")
        #expect(hits.first?.url == "obsidian://open?file=Note(1)")
    }

    @Test func stripsWikipediaStyleTrailingParen() {
        let hits = MarkdownTransforms.detectAutolinkRanges(
            in: "(https://en.wikipedia.org/wiki/Foo_(bar)) end"
        )
        #expect(hits.first?.url == "https://en.wikipedia.org/wiki/Foo_(bar)")
    }

    @Test func stripsTrailingCJKFromDetectedURL() {
        // Sentence-ending punctuation right after the URL (before whitespace
        // or end of text) must stay out of the link. Note: with NO whitespace
        // after the punctuation, GFM swallows everything into the URL — that
        // (web-matching) behavior is intentional and not stripped here.
        let hits = MarkdownTransforms.detectAutolinkRanges(in: "见 https://example.com， 谢谢")
        #expect(hits.count == 1)
        #expect(hits.first?.url == "https://example.com")

        let atEnd = MarkdownTransforms.detectAutolinkRanges(in: "见 https://example.com。")
        #expect(atEnd.first?.url == "https://example.com")
    }

    @Test func ignoresSchemelessAndNonURIText() {
        #expect(MarkdownTransforms.detectAutolinkRanges(in: "no links here").isEmpty)
        #expect(MarkdownTransforms.detectAutolinkRanges(in: "javascript:alert(1)").isEmpty)
        #expect(MarkdownTransforms.detectAutolinkRanges(in: "a ratio of 3://").isEmpty)
    }
}
