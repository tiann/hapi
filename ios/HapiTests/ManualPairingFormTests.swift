import XCTest
@testable import Hapi

final class ManualPairingFormTests: XCTestCase {
    private let companion = "hapicompanion://bind?hub=https%3A%2F%2FHub.Example.com%3A443%2F&code=Tok%2BValue%3Ateam"
    private let web = "https://app.hapi.run/?hub=http%3A%2F%2F192.168.1.20%3A3006&token=Tok%2BValue%3Ateam"

    func testPristineFormHasNoExampleValuesOrErrors() {
        var form = ManualPairingForm()
        XCTAssertEqual(form.scheme, .https)
        XCTAssertEqual(form.address, "")
        XCTAssertEqual(form.accessToken, "")
        XCTAssertNil(form.submission)
        XCTAssertNil(form.error(for: .address))
        XCTAssertNil(form.error(for: .accessToken))
        form.selectScheme(.http)
        XCTAssertEqual(form.address, "")
        XCTAssertNil(form.error(for: .address), "Selecting a protocol must not validate an untouched empty address")
    }

    func testTypingIsNotRewrittenUntilEditingEnds() {
        var form = ManualPairingForm()
        for input in ["h", "https:", "https://", " HTTPS://Hub.Example.com:443/path?q=1#f "] {
            form.edit(input, in: .address)
            XCTAssertEqual(form.address, input)
            XCTAssertNil(form.error(for: .address))
        }
        form.finishEditing(.address)
        XCTAssertEqual(form.address, "hub.example.com")
        XCTAssertEqual(form.scheme, .https)
        XCTAssertNil(form.error(for: .address))
    }

    func testBareAddressesUseTheSelectedSchemeWithoutGuessing() throws {
        for scheme in ManualPairingForm.Scheme.allCases {
            for host in ["Hub.Example.com", "192.168.1.20:3006", "localhost:3006", "[::1]:3006"] {
                var form = readyForm()
                form.selectScheme(scheme)
                form.edit(host, in: .address)
                form.finishEditing(.address)
                XCTAssertEqual(try XCTUnwrap(form.submission).hubURL, scheme.prefix + host.lowercased())
            }
        }
    }

    func testURLPastesReplaceAddressAndSynchronizeSchemeWithoutChangingToken() throws {
        var form = readyForm()
        for (url, origin, scheme) in [
            ("  HTTP://192.168.1.20:3006/path\n", "http://192.168.1.20:3006", ManualPairingForm.Scheme.http),
            ("https://Hub.Example.com:443/", "https://hub.example.com", .https),
            ("http://hub.example.com:80/?q=1#f", "http://hub.example.com", .http),
            ("https://[2001:db8::1]:8443/", "https://[2001:db8::1]:8443", .https),
        ] {
            for _ in 0..<2 {
                XCTAssertTrue(form.paste(url, into: .address))
                XCTAssertEqual(form.scheme, scheme)
                XCTAssertEqual(form.scheme.prefix + form.address, origin)
                XCTAssertEqual(try XCTUnwrap(form.submission).hubURL, origin)
                XCTAssertEqual(form.accessToken, "original:team")
                XCTAssertFalse(form.didImportLink)
            }
        }
    }

    func testMenuSelectionWinsOverAnExplicitSchemeStillBeingEdited() throws {
        var form = readyForm()
        form.edit("https://hub.example.com:8443", in: .address)
        form.selectScheme(.http)
        XCTAssertEqual(form.address, "hub.example.com:8443")
        XCTAssertEqual(try XCTUnwrap(form.submission).hubURL, "http://hub.example.com:8443")
    }

    func testBothLinkFormsImportFromEitherFieldAndReplaceTheWholeForm() throws {
        for field in [ManualPairingForm.Field.address, .accessToken] {
            for (link, origin) in [(companion, "https://hub.example.com"), (web, "http://192.168.1.20:3006")] {
                var form = readyForm()
                for _ in 0..<2 {
                    XCTAssertTrue(form.paste(" \n" + link + " \n", into: field))
                    XCTAssertTrue(form.didImportLink)
                    XCTAssertEqual(form.scheme.prefix + form.address, origin)
                    XCTAssertEqual(form.accessToken, "Tok+Value:team")
                    XCTAssertEqual(try XCTUnwrap(form.submission), .init(hubURL: origin, accessToken: "Tok+Value:team"))
                    XCTAssertNil(form.error(for: .address))
                    XCTAssertNil(form.error(for: .accessToken))
                }
            }
        }
    }

    func testAHandTypedLinkIsOnlyImportedAtEndEditing() {
        var form = ManualPairingForm()
        for input in ["hapicompanion:", "hapicompanion://bind?hub=https://hub.test&code=t", companion] {
            form.edit(input, in: .address)
            XCTAssertEqual(form.address, input)
            XCTAssertEqual(form.accessToken, "")
            XCTAssertFalse(form.didImportLink)
            XCTAssertNil(form.submission, "Raw links are never a hidden submit source")
        }
        form.finishEditing(.address)
        XCTAssertEqual(form.address, "hub.example.com")
        XCTAssertTrue(form.didImportLink)
        XCTAssertNotNil(form.submission)
    }

    func testEditsAfterImportAreTheOnlySubmissionSource() throws {
        var form = ManualPairingForm()
        form.paste(companion, into: .accessToken)
        form.edit("new:namespace", in: .accessToken)
        form.edit("different.example.com:8443", in: .address)
        form.selectScheme(.http)
        XCTAssertFalse(form.didImportLink)
        XCTAssertEqual(try XCTUnwrap(form.submission), .init(hubURL: "http://different.example.com:8443", accessToken: "new:namespace"))
        form.edit("", in: .address)
        XCTAssertNil(form.submission)
        form.edit("hub.test", in: .address)
        form.edit(" \n ", in: .accessToken)
        XCTAssertNil(form.submission)
    }

    func testMalformedLinksStayVisibleAndNeverFallBackToTheWebHost() {
        let invalidLinks = [
            "hapicompanion://bind?hub=https://hub.test",
            "hapicompanion://pair?hub=https://hub.test&code=secret",
            "https://app.hapi.run/?hub=https://hub.test",
            "https://app.hapi.run/?token=secret",
            "https://app.hapi.run/?hub=https://hub.test&token=",
            "https://app.hapi.run/?hub=ftp://hub.test&token=secret",
            "https://app.hapi.run/?hub=https://hub.test&token=%zz",
            "https://app.hapi.run/?%68ub=https://hub.test&code=secret",
            "hapicompanion://bind?hub=https://hub.test:99999&code=secret",
        ]
        for field in [ManualPairingForm.Field.address, .accessToken] {
            for link in invalidLinks {
                var form = readyForm()
                XCTAssertTrue(form.paste(link, into: field))
                XCTAssertEqual(form.text(for: field), link)
                XCTAssertEqual(form.error(for: field), .invalidLink, link)
                XCTAssertEqual(form.scheme, .https)
                XCTAssertEqual(field == .address ? form.accessToken : form.address,
                               field == .address ? "original:team" : "original.test")
                XCTAssertFalse(form.didImportLink)
                XCTAssertNil(form.submission)
            }
        }
    }

    func testInvalidAddressesBlockSubmissionAndErrorsAppearAfterEditingEnds() {
        for input in ["", " ", "https://", "ftp://hub.test", "file:///tmp/hub", "bad host", "https://user:pass@hub.test", "hub.test:99999", "hub.test:0", "https://hub.test/%zz", "::1"] {
            var form = readyForm()
            form.edit(input, in: .address)
            XCTAssertNil(form.error(for: .address))
            XCTAssertNil(form.submission, input)
            form.finishEditing(.address)
            XCTAssertEqual(form.error(for: .address), .invalidAddress, input)
            form.edit("valid.test", in: .address)
            XCTAssertNil(form.error(for: .address))
            XCTAssertNotNil(form.submission)
        }
    }

    func testOrdinaryTextUsesTheTextControlsInsertionRules() {
        var form = readyForm()
        for field in [ManualPairingForm.Field.address, .accessToken] {
            for text in ["hub.test", "secret:team", "segment", "\n"] {
                XCTAssertFalse(form.paste(text, into: field))
                XCTAssertEqual(form.address, "original.test")
                XCTAssertEqual(form.accessToken, "original:team")
            }
        }
        XCTAssertFalse(form.paste("https://not-a-pairing-link.test", into: .accessToken))
    }

    func testTokenRemainsOpaqueExceptForSurroundingWhitespace() throws {
        var form = readyForm()
        for token in [" AbC+Def%2B:namespace ", "token?token=value", "a b:team", "https://an-opaque-token.test"] {
            form.edit(token, in: .accessToken)
            form.finishEditing(.accessToken)
            let expected = token.trimmingCharacters(in: .whitespacesAndNewlines)
            XCTAssertEqual(form.accessToken, expected)
            XCTAssertEqual(try XCTUnwrap(form.submission).accessToken, expected)
        }
        form.edit("\n ", in: .accessToken)
        form.finishEditing(.accessToken)
        XCTAssertEqual(form.error(for: .accessToken), .missingToken)
        XCTAssertNil(form.submission)
    }

    private func readyForm() -> ManualPairingForm {
        var form = ManualPairingForm()
        form.edit("original.test", in: .address)
        form.edit("original:team", in: .accessToken)
        return form
    }
}
