import Foundation
import HapiUI
import Testing

/// URI scheme policy (port of the policy inlined in `markdown-text.tsx`).
/// iOS delta covered below: `http` confirms instead of navigating directly.
@Suite("HrefPolicy")
struct HrefPolicyTests {
    // MARK: - Allowed

    @Test func httpsIsAllowed() {
        #expect(HrefPolicy.classify("https://example.com/a?b=c") == .allowed)
    }

    @Test func mailtoIsAllowed() {
        #expect(HrefPolicy.classify("mailto:x@example.com") == .allowed)
    }

    @Test func ircAndXmppAreAllowed() {
        #expect(HrefPolicy.classify("irc://irc.libera.chat/swift") == .allowed)
        #expect(HrefPolicy.classify("ircs://irc.libera.chat/swift") == .allowed)
        #expect(HrefPolicy.classify("xmpp:romeo@example.net") == .allowed)
    }

    @Test func schemeComparisonIsCaseInsensitive() {
        #expect(HrefPolicy.classify("HTTPS://example.com") == .allowed)
    }

    // MARK: - Confirm first

    @Test func httpRequiresConfirmation() {
        // iOS delta: the web treats http as IANA-safe and navigates directly.
        #expect(HrefPolicy.classify("http://example.com") == .confirmFirst)
    }

    @Test func customSchemesRequireConfirmation() {
        #expect(HrefPolicy.classify("vscode://file/a.swift") == .confirmFirst)
        #expect(HrefPolicy.classify("obsidian://open?vault=x") == .confirmFirst)
        #expect(HrefPolicy.classify("shortcuts://run") == .confirmFirst)
    }

    // MARK: - Blocked

    @Test func denySchemesAreBlocked() {
        #expect(HrefPolicy.classify("javascript:alert(1)") == .blocked)
        #expect(HrefPolicy.classify("data:text/html;base64,PGI+") == .blocked)
        #expect(HrefPolicy.classify("vbscript:msgbox(1)") == .blocked)
        #expect(HrefPolicy.classify("file:///etc/passwd") == .blocked)
    }

    @Test func denyIsCaseInsensitive() {
        #expect(HrefPolicy.classify("JaVaScRiPt:alert(1)") == .blocked)
    }

    @Test func leadingWhitespaceDoesNotBypass() {
        #expect(HrefPolicy.classify("  javascript:alert(1)") == .blocked)
        #expect(HrefPolicy.classify("\tjavascript:alert(1)") == .blocked)
    }

    @Test func controlCharactersInSchemeDoNotBypass() {
        #expect(HrefPolicy.classify("java\nscript:alert(1)") == .blocked)
        #expect(HrefPolicy.classify("java\tscript:alert(1)") == .blocked)
        #expect(HrefPolicy.classify("java\u{01}script:alert(1)") == .blocked)
    }

    @Test func percentEncodedSchemeDoesNotBypass() {
        #expect(HrefPolicy.classify("javascript%3Aalert(1)") == .blocked)
        #expect(HrefPolicy.classify("jav%61script:alert(1)") == .blocked)
    }

    @Test func doublePercentEncodedSchemeDoesNotBypass() {
        #expect(HrefPolicy.classify("javascript%253Aalert(1)") == .blocked)
    }

    @Test func schemelessHrefsAreBlockedByThePolicy() {
        // The renderer never sends scheme-less hrefs here (they go through
        // the file-link path), so the policy fails closed on them.
        #expect(HrefPolicy.classify("/settings") == .blocked)
        #expect(HrefPolicy.classify("./a.md") == .blocked)
        #expect(HrefPolicy.classify("relative/path.md") == .blocked)
        #expect(HrefPolicy.classify("#anchor") == .blocked)
        #expect(HrefPolicy.classify("//example.com/x") == .blocked)
        #expect(HrefPolicy.classify("") == .blocked)
        #expect(HrefPolicy.classify(":missing") == .blocked)
    }

    // MARK: - hasScheme

    @Test func hasSchemeDetection() {
        #expect(HrefPolicy.hasScheme("mailto:foo@bar"))
        #expect(HrefPolicy.hasScheme("https://x"))
        #expect(HrefPolicy.hasScheme("vscode:open"))
        #expect(!HrefPolicy.hasScheme("/settings"))
        #expect(!HrefPolicy.hasScheme("./foo"))
        #expect(!HrefPolicy.hasScheme("#section"))
        #expect(!HrefPolicy.hasScheme("?q=1"))
        #expect(!HrefPolicy.hasScheme("/path:colon"))
        #expect(!HrefPolicy.hasScheme("//host/path"))
        #expect(!HrefPolicy.hasScheme(":lead"))
    }

    // MARK: - normalizedScheme

    @Test func normalizedSchemeExtraction() {
        #expect(HrefPolicy.normalizedScheme(of: "HTTPS://x") == "https")
        #expect(HrefPolicy.normalizedScheme(of: "java\nscript:x") == "javascript")
        #expect(HrefPolicy.normalizedScheme(of: "no-colon-here") == nil)
        #expect(HrefPolicy.normalizedScheme(of: ":starts-with-colon") == nil)
    }
}
