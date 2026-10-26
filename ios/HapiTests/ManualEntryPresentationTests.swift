import HapiClient
import Observation
import SwiftUI
import UIKit
import XCTest
@testable import Hapi

@MainActor
final class ManualEntryPresentationTests: XCTestCase {
    @Observable
    fileprivate final class Driver {
        var isPairing = false
        var failure: PairingFailure?
        var submissions: [ManualPairingForm.Submission] = []
        var edits = 0
    }

    private struct Harness: View {
        let driver: Driver
        var locale = Locale(identifier: "en")
        var typeSize: DynamicTypeSize = .large

        var body: some View {
            NavigationStack {
                ManualPairingFormView(isPairing: driver.isPairing, failure: driver.failure) {
                    driver.failure = nil
                    driver.edits += 1
                } onPair: { driver.submissions.append($0) }
                .navigationTitle("Enter Hub Details")
                .navigationBarTitleDisplayMode(.inline)
            }
            .environment(\.locale, locale)
            .environment(\.dynamicTypeSize, typeSize)
        }
    }

    func testEmptyFieldsAndNextKeyThenExplicitSubmission() async throws {
        let driver = Driver()
        let window = try makeWindow(Harness(driver: driver))
        defer { window.isHidden = true }
        try await settle()
        let address = try field(.address, in: window)
        let token = try field(.accessToken, in: window)
        XCTAssertEqual(address.text, "")
        XCTAssertEqual(token.text, "")
        XCTAssertEqual(address.placeholder, "Domain or IP address")
        XCTAssertEqual(address.accessibilityLabel, "Hub URL")
        XCTAssertEqual(address.keyboardType, .URL)
        XCTAssertEqual(address.autocapitalizationType, .none)
        XCTAssertEqual(address.autocorrectionType, .no)
        XCTAssertEqual(address.clearButtonMode, .whileEditing)
        XCTAssertTrue(address.isFirstResponder)

        type("Hub.Example.com", into: address)
        _ = address.delegate?.textFieldShouldReturn?(address)
        try await settle()
        XCTAssertTrue(token.isFirstResponder)
        XCTAssertEqual(address.text, "hub.example.com")
        type(" Secret+Value:team ", into: token)
        try await settle()
        XCTAssertTrue(driver.submissions.isEmpty)
        _ = token.delegate?.textFieldShouldReturn?(token)
        try await settle()
        XCTAssertEqual(driver.submissions, [.init(hubURL: "https://hub.example.com", accessToken: "Secret+Value:team")])
    }

    func testBothSystemPasteLinkFormsFillEitherFieldWithoutSubmitting() async throws {
        let links = [
            ("hapicompanion://bind?hub=https%3A%2F%2FHub.Example.com&code=Tok%2BValue%3Ateam", "hub.example.com"),
            ("https://app.hapi.run/?hub=http%3A%2F%2F192.168.1.20%3A3006&token=Tok%2BValue%3Ateam", "192.168.1.20:3006"),
        ]
        for target in [ManualPairingForm.Field.address, .accessToken] {
            let driver = Driver()
            let window = try makeWindow(Harness(driver: driver))
            defer { window.isHidden = true }
            try await settle()
            let address = try field(.address, in: window)
            let token = try field(.accessToken, in: window)
            type("old.test", into: address)
            type("old:namespace", into: token)
            try await settle()
            for (link, host) in links {
                let input = target == .address ? address : token
                // A complete link is an import even with a caret in old text.
                let start = input.beginningOfDocument
                let caret = try XCTUnwrap(input.textRange(from: start, to: start))
                try paste(link, into: input, range: caret)
                try await settle()
                XCTAssertEqual(address.text, host)
                XCTAssertEqual(token.text, "Tok+Value:team")
                XCTAssertTrue(driver.submissions.isEmpty, "Pasting never invokes the pairing callback")
            }
        }
    }

    func testURLPasteChangesOnlyAddressAndLaterEditsWinAtSubmission() async throws {
        let driver = Driver()
        let window = try makeWindow(Harness(driver: driver))
        defer { window.isHidden = true }
        try await settle()
        let address = try field(.address, in: window)
        let token = try field(.accessToken, in: window)
        try paste("hapicompanion://bind?hub=https://old.test&code=old", into: address)
        try await settle()
        for _ in 0..<2 {
            try paste(" HTTP://New.Test:3006/path?q=1#f \n", into: address)
            try await settle()
            XCTAssertEqual(address.text, "new.test:3006")
            XCTAssertEqual(token.text, "old")
        }
        type("new:team", into: token)
        try await settle()
        _ = token.delegate?.textFieldShouldReturn?(token)
        try await settle()
        XCTAssertEqual(driver.submissions, [.init(hubURL: "http://new.test:3006", accessToken: "new:team")])
    }

    func testOrdinaryPasteHonorsSelectionAndDoesNotReadOrRewriteTheClipboard() async throws {
        let driver = Driver()
        let window = try makeWindow(Harness(driver: driver))
        defer { window.isHidden = true }
        try await settle()
        let address = try field(.address, in: window)
        type("prefix.test", into: address)
        try await settle()
        let start = address.beginningOfDocument
        let end = try XCTUnwrap(address.position(from: start, offset: 6))
        let range = try XCTUnwrap(address.textRange(from: start, to: end))
        try paste("hub", into: address, range: range)
        try await settle()
        XCTAssertEqual(address.text, "hub.test")
        let token = try field(.accessToken, in: window)
        try paste(" \nAbC+%2B:namespace\n ", into: token)
        try await settle()
        XCTAssertEqual(token.text, "AbC+%2B:namespace")
        XCTAssertTrue(driver.submissions.isEmpty)
    }

    func testSystemItemProvidersAcceptTextAndCopiedURLs() async throws {
        let driver = Driver()
        let window = try makeWindow(Harness(driver: driver))
        defer { window.isHidden = true }
        try await settle()
        let address = try field(.address, in: window)
        let token = try field(.accessToken, in: window)
        let link = "hapicompanion://bind?hub=https://provider.test&code=token:team"
        for provider in [NSItemProvider(object: link as NSString), NSItemProvider(object: try XCTUnwrap(URL(string: link)) as NSURL)] {
            type("", into: address)
            type("", into: token)
            try await settle()
            XCTAssertTrue(address.canPaste([provider]))
            address.paste(itemProviders: [provider])
            let clock = ContinuousClock()
            let deadline = clock.now.advanced(by: .seconds(3))
            while token.text != "token:team", clock.now < deadline {
                try await Task.sleep(for: .milliseconds(50))
            }
            XCTAssertEqual(address.text, "provider.test")
            XCTAssertEqual(token.text, "token:team")
            XCTAssertTrue(driver.submissions.isEmpty)
        }
    }

    func testTypingPreservesSelectionAndClearingDoesNotRestoreTheImportedURL() async throws {
        let driver = Driver()
        let window = try makeWindow(Harness(driver: driver))
        defer { window.isHidden = true }
        try await settle()
        let address = try field(.address, in: window)
        try paste("https://hub.example.com", into: address)
        try await settle()
        let position = try XCTUnwrap(address.position(from: address.beginningOfDocument, offset: 3))
        address.selectedTextRange = address.textRange(from: position, to: position)
        address.sendActions(for: .editingChanged)
        try await settle()
        XCTAssertEqual(address.offset(from: address.beginningOfDocument, to: try XCTUnwrap(address.selectedTextRange).start), 3)
        type("", into: address)
        try await settle()
        XCTAssertEqual(address.text, "")
        let token = try field(.accessToken, in: window)
        type("token", into: token)
        try await settle()
        _ = token.delegate?.textFieldShouldReturn?(token)
        try await settle()
        XCTAssertTrue(driver.submissions.isEmpty)
        XCTAssertEqual(address.text, "")
    }

    func testMalformedLinkStaysVisibleAndCannotSubmitAgainstExistingHub() async throws {
        let driver = Driver()
        let window = try makeWindow(Harness(driver: driver))
        defer { window.isHidden = true }
        try await settle()
        let address = try field(.address, in: window)
        let token = try field(.accessToken, in: window)
        type("original.test", into: address)
        try await settle()
        let broken = "https://app.hapi.run/?hub=https://new.test&token="
        try paste(broken, into: token)
        try await settle()
        XCTAssertEqual(address.text, "original.test")
        XCTAssertEqual(token.text, broken)
        _ = token.delegate?.textFieldShouldReturn?(token)
        try await settle()
        XCTAssertTrue(driver.submissions.isEmpty)
        type("corrected:team", into: token)
        try await settle()
        _ = token.delegate?.textFieldShouldReturn?(token)
        try await settle()
        XCTAssertEqual(driver.submissions, [.init(hubURL: "https://original.test", accessToken: "corrected:team")])
    }

    func testEditsClearOldFailureAndBusyFormIgnoresLatePasteAndReturn() async throws {
        let driver = Driver()
        driver.failure = .invalidAccessToken
        let window = try makeWindow(Harness(driver: driver))
        defer { window.isHidden = true }
        try await settle()
        let address = try field(.address, in: window)
        let token = try field(.accessToken, in: window)
        try paste("hapicompanion://bind?hub=https://hub.test&code=token", into: address)
        try await settle()
        XCTAssertNil(driver.failure)
        driver.isPairing = true
        try await settle()
        XCTAssertFalse(address.isEnabled)
        XCTAssertFalse(token.isEnabled)
        XCTAssertEqual(address.delegate?.textField?(address, shouldChangeCharactersIn: NSRange(location: 0, length: 0), replacementString: "late"), false)
        XCTAssertEqual(token.delegate?.textFieldShouldClear?(token), false)
        let edits = driver.edits
        try paste("hapicompanion://bind?hub=http://wrong.test&code=wrong", into: address)
        _ = token.delegate?.textFieldShouldReturn?(token)
        try await settle()
        XCTAssertEqual(address.text, "hub.test")
        XCTAssertEqual(token.text, "token")
        XCTAssertEqual(driver.edits, edits)
        XCTAssertTrue(driver.submissions.isEmpty)
    }

    func testSmallScreenAndLargeTypeKeepTheAddressReadable() async throws {
        for (locale, typeSize, name) in [
            ("en", DynamicTypeSize.large, "empty-en"),
            ("zh-Hans", .large, "empty-zh"),
            ("en", .accessibility3, "large-en"),
        ] {
            let driver = Driver()
            let window = try makeWindow(Harness(driver: driver, locale: Locale(identifier: locale), typeSize: typeSize), width: 320)
            defer { window.isHidden = true }
            try await settle()
            let address = try field(.address, in: window)
            let rect = address.convert(address.bounds, to: window)
            XCTAssertGreaterThanOrEqual(rect.height, 44)
            XCTAssertGreaterThan(rect.width, 130)
            XCTAssertGreaterThanOrEqual(rect.minX, 0)
            XCTAssertLessThanOrEqual(rect.maxX, window.bounds.width)
            XCTAssertEqual(address.placeholder, locale == "zh-Hans" ? "域名或 IP 地址" : "Domain or IP address")
            XCTAssertEqual(address.accessibilityLabel, locale == "zh-Hans" ? "Hub 地址" : "Hub URL")
            if typeSize.isAccessibilitySize {
                XCTAssertGreaterThan(try XCTUnwrap(address.font).pointSize, 25)
            }
            try capture(window, named: name)
        }
    }

    func testImportedHTTPDetailsAreVisibleForReview() async throws {
        let driver = Driver()
        let window = try makeWindow(Harness(driver: driver, locale: Locale(identifier: "zh-Hans")))
        defer { window.isHidden = true }
        try await settle()
        let address = try field(.address, in: window)
        try paste("https://app.hapi.run/?hub=http%3A%2F%2F192.168.1.20%3A3006&token=demo%3Ateam", into: address)
        try await settle()
        XCTAssertEqual(address.text, "192.168.1.20:3006")
        XCTAssertEqual(try field(.accessToken, in: window).text, "demo:team")
        XCTAssertTrue(driver.submissions.isEmpty)
        try capture(window, named: "imported-http-zh")
    }

    private func field(_ field: ManualPairingForm.Field, in window: UIWindow) throws -> UITextField {
        let identifier = field == .address ? "pairing.address" : "pairing.accessToken"
        func find(_ view: UIView) -> UITextField? {
            if let field = view as? UITextField, field.accessibilityIdentifier == identifier { return field }
            return view.subviews.lazy.compactMap(find).first
        }
        return try XCTUnwrap(find(window), identifier)
    }

    private func type(_ value: String, into field: UITextField) {
        field.text = value
        field.sendActions(for: .editingChanged)
    }

    private func paste(_ value: String, into field: UITextField, range: UITextRange? = nil) throws {
        let delegate = try XCTUnwrap(field.pasteDelegate)
        let range = try XCTUnwrap(range ?? field.textRange(from: field.beginningOfDocument, to: field.endOfDocument))
        // Inject the system-delivered payload, never touch the user's clipboard.
        _ = delegate.textPasteConfigurationSupporting?(field, performPasteOf: NSAttributedString(string: value), to: range)
    }

    private func makeWindow<V: View>(_ view: V, width: CGFloat = 390) throws -> UIWindow {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: width, height: 900)
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        window.layoutIfNeeded()
        return window
    }

    private func settle() async throws { try await Task.sleep(for: .milliseconds(220)) }

    private func capture(_ window: UIWindow, named name: String) throws {
        guard let path = ProcessInfo.processInfo.environment["HAPI_PAIRING_CAPTURE"] else { return }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent(name + ".png"))
    }
}
