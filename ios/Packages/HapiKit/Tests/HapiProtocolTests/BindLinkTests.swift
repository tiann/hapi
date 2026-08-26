import Foundation
import HapiProtocol
import Testing

/// Mirrors the Android suite (`android/.../pairing/BindLinkTest.kt`) case for
/// case so the two ports cannot drift, plus the web direct-access form the
/// iOS parser additionally accepts.
@Suite("BindLink parsing")
struct BindLinkTests {
    // MARK: - Companion deeplink form

    @Test func parsesAPlainValidLink() {
        let link = BindLink.parse("hapicompanion://bind?hub=http://192.168.1.20:3006&code=abc123")

        #expect(link == BindLink(hubUrl: "http://192.168.1.20:3006", accessToken: "abc123"))
    }

    @Test func parsesURLEncodedValuesAsTheHubEmitsThem() {
        // Exactly what `new URLSearchParams({hub, code}).toString()` produces
        // for hub=https://demo.hapi.run and code=tok_9f8:default.
        let link = BindLink.parse(
            "hapicompanion://bind?hub=https%3A%2F%2Fdemo.hapi.run&code=tok_9f8%3Adefault"
        )

        #expect(link?.hubUrl == "https://demo.hapi.run")
        #expect(link?.accessToken == "tok_9f8:default")
    }

    @Test func decodesPlusAsSpaceInFormEncodedValues() {
        let link = BindLink.parse("hapicompanion://bind?hub=https%3A%2F%2Fh.example.com&code=a+b")

        #expect(link?.accessToken == "a b")
    }

    @Test func keepsEncodedPlusLiteral() {
        let link = BindLink.parse("hapicompanion://bind?hub=https%3A%2F%2Fh.example.com&code=a%2Bb")

        #expect(link?.accessToken == "a+b")
    }

    @Test func acceptsSchemeAndHostCaseInsensitively() {
        let link = BindLink.parse("HAPICOMPANION://BIND?hub=https%3A%2F%2Fh.example.com&code=x")

        #expect(link?.hubUrl == "https://h.example.com")
    }

    @Test func ignoresExtraParamsAndKeepsFirstOccurrenceOfDuplicates() {
        let link = BindLink.parse(
            "hapicompanion://bind?v=1&hub=https%3A%2F%2Fa.example.com&code=first&code=second"
        )

        #expect(link?.hubUrl == "https://a.example.com")
        #expect(link?.accessToken == "first")
    }

    @Test func returnsNilWhenHubParamIsMissing() {
        #expect(BindLink.parse("hapicompanion://bind?code=abc123") == nil)
    }

    @Test func returnsNilWhenCodeParamIsMissing() {
        #expect(BindLink.parse("hapicompanion://bind?hub=https%3A%2F%2Fh.example.com") == nil)
    }

    @Test func returnsNilWhenQueryIsAbsent() {
        #expect(BindLink.parse("hapicompanion://bind") == nil)
    }

    @Test func returnsNilWhenParamsAreBlank() {
        #expect(BindLink.parse("hapicompanion://bind?hub=&code=x") == nil)
        #expect(BindLink.parse("hapicompanion://bind?hub=https%3A%2F%2Fh.example.com&code=") == nil)
    }

    @Test func returnsNilForAWrongScheme() {
        // https with `code=` is neither a valid deeplink nor a valid web QR
        // (the web form carries `token=`).
        #expect(BindLink.parse("https://bind?hub=https%3A%2F%2Fh.example.com&code=x") == nil)
        #expect(BindLink.parse("hapicompanionx://bind?hub=https%3A%2F%2Fh.example.com&code=x") == nil)
        #expect(BindLink.parse("ftp://bind?hub=https%3A%2F%2Fh.example.com&code=x") == nil)
    }

    @Test func returnsNilForAWrongHost() {
        #expect(BindLink.parse("hapicompanion://pair?hub=https%3A%2F%2Fh.example.com&code=x") == nil)
    }

    @Test func returnsNilWhenHubIsNotAnHTTPURL() {
        #expect(BindLink.parse("hapicompanion://bind?hub=ftp%3A%2F%2Fh.example.com&code=x") == nil)
        #expect(BindLink.parse("hapicompanion://bind?hub=not-a-url&code=x") == nil)
    }

    @Test func returnsNilForMalformedInput() {
        #expect(BindLink.parse("") == nil)
        #expect(BindLink.parse("   ") == nil)
        #expect(BindLink.parse("not a uri at all") == nil)
        // Scheme-relative (no authority): `bind` is a path, not a host.
        #expect(BindLink.parse("hapicompanion:bind?hub=https%3A%2F%2Fh.example.com&code=x") == nil)
    }

    @Test func returnsNilOnInvalidPercentEscapes() {
        #expect(BindLink.parse("hapicompanion://bind?hub=https%3A%2F%2Fh.example.com&code=%zz") == nil)
    }

    @Test func trimsSurroundingWhitespace() {
        let link = BindLink.parse("  hapicompanion://bind?hub=https%3A%2F%2Fh.example.com&code=x\n")

        #expect(link?.hubUrl == "https://h.example.com")
        #expect(link?.accessToken == "x")
    }

    // MARK: - Web direct-access form

    @Test func parsesTheWebDirectAccessQR() {
        // Exactly what `${officialWebUrl}/?${new URLSearchParams({hub, token})}`
        // produces in hub/src/startHub.ts.
        let link = BindLink.parse(
            "https://app.hapi.run/?hub=https%3A%2F%2Fdemo.hapi.run&token=tok_9f8%3Adefault"
        )

        #expect(link?.hubUrl == "https://demo.hapi.run")
        #expect(link?.accessToken == "tok_9f8:default")
    }

    @Test func acceptsAnyWebHostAndPath() {
        // Self-hosted deployments serve the web app anywhere.
        let link = BindLink.parse(
            "http://my-server.local:8080/hapi/?hub=http%3A%2F%2F192.168.1.20%3A3006&token=abc"
        )

        #expect(link?.hubUrl == "http://192.168.1.20:3006")
        #expect(link?.accessToken == "abc")
    }

    @Test func webFormRequiresTokenParamName() {
        // `code=` belongs to the deeplink form only.
        #expect(BindLink.parse("https://app.hapi.run/?hub=https%3A%2F%2Fdemo.hapi.run&code=abc") == nil)
    }

    @Test func webFormRequiresHubParam() {
        #expect(BindLink.parse("https://app.hapi.run/?token=abc") == nil)
    }

    @Test func webFormRejectsBlankValues() {
        #expect(BindLink.parse("https://app.hapi.run/?hub=&token=abc") == nil)
        #expect(BindLink.parse("https://app.hapi.run/?hub=https%3A%2F%2Fdemo.hapi.run&token=") == nil)
    }

    @Test func webFormRequiresAnHTTPHubValue() {
        #expect(BindLink.parse("https://app.hapi.run/?hub=ftp%3A%2F%2Fdemo.hapi.run&token=abc") == nil)
    }
}
