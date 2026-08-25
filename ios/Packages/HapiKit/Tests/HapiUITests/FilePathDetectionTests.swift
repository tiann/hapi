import Foundation
import HapiUI
import Testing

/// File-path autolink detection (remark-file-path-links port) + the
/// `hapi-file://` URL round trip.
@Suite("File path detection")
struct FilePathDetectionTests {
    private func paths(in text: String) -> [String] {
        MarkdownTransforms.detectFilePathRanges(in: text).map { $0.link.path }
    }

    // MARK: - Positive cases

    @Test func linksRelativeCodePath() {
        let text = "see src/lib/foo.ts here"
        let hits = MarkdownTransforms.detectFilePathRanges(in: text)
        #expect(hits.count == 1)
        #expect(hits.first?.link == FilePathLink(path: "src/lib/foo.ts", line: nil))
        if let range = hits.first?.range {
            #expect(String(text[range]) == "src/lib/foo.ts")
        }
    }

    @Test func stripsLineSuffixIntoLineNumber() {
        let text = "open src/lib/foo.ts:12 please"
        let hits = MarkdownTransforms.detectFilePathRanges(in: text)
        #expect(hits.first?.link == FilePathLink(path: "src/lib/foo.ts", line: 12))
        if let range = hits.first?.range {
            // Display range keeps the :12 suffix.
            #expect(String(text[range]) == "src/lib/foo.ts:12")
        }
    }

    @Test func lineColumnSuffixKeepsLineOnly() {
        let hits = MarkdownTransforms.detectFilePathRanges(in: "at foo.ts:12:5")
        #expect(hits.first?.link == FilePathLink(path: "foo.ts", line: 12))
    }

    @Test func linksDotSlashPaths() {
        // The `./` prefix stays in the target path (web parity).
        #expect(paths(in: "run ./x/y.tsx now") == ["./x/y.tsx"])
    }

    @Test func linksBareFilenames() {
        #expect(paths(in: "See screenshot.png and README.md") == ["screenshot.png", "README.md"])
    }

    @Test func excludesTrailingSentencePunctuation() {
        let text = "Edit src/a.ts."
        let hits = MarkdownTransforms.detectFilePathRanges(in: text)
        #expect(hits.first?.link.path == "src/a.ts")
        if let range = hits.first?.range {
            #expect(String(text[range]) == "src/a.ts")
        }
    }

    @Test func linksPathInsideParens() {
        #expect(paths(in: "(src/a.ts)") == ["src/a.ts"])
    }

    @Test func linksNodeJsLikeTokens() {
        // `js` is an allowlisted extension, so `Node.js` links (web parity —
        // the allowlist exists to reject TLD lookalikes, not dotted words
        // with real code extensions).
        #expect(paths(in: "built on Node.js today") == ["Node.js"])
    }

    // MARK: - Negative cases

    @Test func doesNotLinkInsideURLs() {
        #expect(paths(in: "https://example.org/x.ts").isEmpty)
        #expect(paths(in: "see https://example.org today").isEmpty)
    }

    @Test func doesNotLinkTLDLookalikes() {
        #expect(paths(in: "visit example.org and example.com and hapi.dev").isEmpty)
    }

    @Test func doesNotLinkVersionNumbers() {
        #expect(paths(in: "bump to v1.2.3 now").isEmpty)
    }

    @Test func doesNotLinkAbsoluteOrParentPaths() {
        #expect(paths(in: "/abs/path.ts").isEmpty)
        #expect(paths(in: "~/notes.md").isEmpty)
        #expect(paths(in: "../rel/foo.ts").isEmpty)
    }

    @Test func doesNotLinkWindowsAbsolutePaths() {
        // iOS delta: the web autolinks these behind workspace containment;
        // HapiUI has no containment context, so it fails closed.
        #expect(paths(in: #"open C:\src\a.ts now"#).isEmpty)
    }

    @Test func doesNotLinkUnknownExtensions() {
        #expect(paths(in: "cargo build --bin foo.abcxyzqwerty").isEmpty)
    }

    // MARK: - Inline code linking

    @Test func linksWholeValueInlineCodePath() {
        #expect(MarkdownTransforms.filePathLink(forInlineCode: "src/a.ts") == FilePathLink(path: "src/a.ts", line: nil))
    }

    @Test func linksBareFilenameInlineCodeWithLine() {
        #expect(MarkdownTransforms.filePathLink(forInlineCode: "README.md:12") == FilePathLink(path: "README.md", line: 12))
    }

    @Test func linksMermaidSourceInlineCode() {
        #expect(MarkdownTransforms.filePathLink(forInlineCode: "docs/flow.mmd") == FilePathLink(path: "docs/flow.mmd", line: nil))
    }

    @Test func rejectsCodeSnippetsInInlineCode() {
        #expect(MarkdownTransforms.filePathLink(forInlineCode: "npm run build") == nil)
        #expect(MarkdownTransforms.filePathLink(forInlineCode: "str.split()") == nil)
        #expect(MarkdownTransforms.filePathLink(forInlineCode: "Math.PI") == nil)
        #expect(MarkdownTransforms.filePathLink(forInlineCode: "a=b.js") == nil)
        #expect(MarkdownTransforms.filePathLink(forInlineCode: "x.md#y") == nil)
        #expect(MarkdownTransforms.filePathLink(forInlineCode: "") == nil)
    }

    @Test func rejectsUnsafeInlineCodePaths() {
        #expect(MarkdownTransforms.filePathLink(forInlineCode: "/etc/passwd.conf") == nil)
        #expect(MarkdownTransforms.filePathLink(forInlineCode: "../secrets.env") == nil)
    }

    // MARK: - Explicit link rewrite

    @Test func rewritesRelativeMarkdownLink() {
        #expect(MarkdownTransforms.fileLinkTarget(forExplicitHref: "docs/a.md") == FilePathLink(path: "docs/a.md", line: nil))
    }

    @Test func rewritesRelativeLinkWithLineSuffix() {
        #expect(MarkdownTransforms.fileLinkTarget(forExplicitHref: "docs/a.md:7") == FilePathLink(path: "docs/a.md", line: 7))
    }

    @Test func rewritesRelativeLinkStrippingFragment() {
        #expect(MarkdownTransforms.fileLinkTarget(forExplicitHref: "docs/a.md#section") == FilePathLink(path: "docs/a.md", line: nil))
    }

    @Test func rejectsNonFileHrefs() {
        #expect(MarkdownTransforms.fileLinkTarget(forExplicitHref: "/settings") == nil)
        #expect(MarkdownTransforms.fileLinkTarget(forExplicitHref: "/abs/file.md") == nil)
        #expect(MarkdownTransforms.fileLinkTarget(forExplicitHref: "../up.md") == nil)
        #expect(MarkdownTransforms.fileLinkTarget(forExplicitHref: "https://x.com/a.md") == nil)
        #expect(MarkdownTransforms.fileLinkTarget(forExplicitHref: #"C:\x\y.ts"#) == nil)
        #expect(MarkdownTransforms.fileLinkTarget(forExplicitHref: "#section") == nil)
    }

    // MARK: - hapi-file URL round trip

    @Test func filePathLinkURLRoundTripsWithLine() throws {
        let link = FilePathLink(path: "src/a b.ts", line: 12)
        let url = try #require(link.url)
        #expect(url.scheme == "hapi-file")
        #expect(FilePathLink(url: url) == link)
    }

    @Test func filePathLinkURLRoundTripsWithoutLine() throws {
        let link = FilePathLink(path: "README.md")
        let url = try #require(link.url)
        #expect(FilePathLink(url: url) == link)
    }

    @Test func rejectsForeignURLs() throws {
        let https = try #require(URL(string: "https://example.com/?path=x"))
        #expect(FilePathLink(url: https) == nil)
    }
}
