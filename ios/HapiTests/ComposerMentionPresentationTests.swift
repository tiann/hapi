import HapiClient
import HapiProtocol
import HapiUI
import Observation
import SwiftUI
import UIKit
import XCTest
@testable import Hapi

@MainActor
final class ComposerMentionPresentationTests: XCTestCase {
    private struct OfflineHTTP: HTTPPerforming {
        func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            throw URLError(.notConnectedToInternet)
        }
    }

    private func makeInteractor() throws -> ChatInteractor {
        let url = try XCTUnwrap(URL(string: "https://mentions.invalid"))
        let http = OfflineHTTP()
        let auth = AuthManager(baseURL: url, credentialStore: InMemoryCredentialStore(), performer: http)
        let api = APIClient(baseURL: url, authManager: auth, performer: http)
        let store = SessionListStore(api: api)
        for (id, title) in [("current", "Current"), ("peer", "会话参考"), ("other", "Another session")] {
            let session = Session(hasConversationContent: true, id: id, namespace: "default", seq: 1,
                createdAt: 1, updatedAt: 2, active: true, activeAt: 0,
                metadata: SessionMetadata(path: "/repo", host: "host", name: title, flavor: "claude"),
                metadataVersion: 1, agentStateVersion: 1, thinking: false, thinkingAt: 0)
            store.applySessionEvent(.sessionUpdated(namespace: nil, sessionId: id, data: .session(session)))
        }
        return ChatInteractor(sessionId: "current", api: api, sessionStore: store,
                              windows: MessageWindowControllers(provider: api))
    }

    @Observable fileprivate final class ComposerLayout {
        var height: CGFloat = 0
    }

    private struct ComposerHarness: View {
        let interactor: ChatInteractor
        let layout: ComposerLayout

        var body: some View {
            VStack {
                Spacer()
                ChatComposerView(interactor: interactor)
                    .background(GeometryReader { geometry in
                        Color.clear
                            .onAppear { layout.height = geometry.size.height }
                            .onChange(of: geometry.size.height) { _, height in layout.height = height }
                    })
            }
            .hapiTypography()
        }
    }

    func testTypingAtShowsThePickerAtTheCaretAndPreservesFocus() async throws {
        let interactor = try makeInteractor()
        let layout = ComposerLayout()
        let window = try host(ComposerHarness(interactor: interactor, layout: layout))
        defer { window.isHidden = true }
        try await settle()
        let input = try textView(in: window)
        input.becomeFirstResponder()
        input.insertText("😀 请参考 @会话Old, thanks")
        input.selectedRange = NSRange(location: "😀 请参考 @会话".utf16.count, length: 0)
        try await settle()
        let hits = interactor.mentionSuggestions(selection: input.selectedRange)
        XCTAssertEqual(hits.map(\.id), ["session:peer"])
        XCTAssertTrue(input.isFirstResponder, "Expanding the compact composer retains focus")
        let pickerHeight = layout.height
        input.selectedRange = NSRange(location: 0, length: 0)
        try await settle()
        // SwiftUI does not vend its virtual accessibility tree to app-hosted
        // XCTest. Measure the real production picker, not an AX test probe.
        XCTAssertGreaterThan(pickerHeight, layout.height + 50)
        XCTAssertEqual(interactor.composerText, "😀 请参考 @会话Old, thanks")
        XCTAssertTrue(input.isFirstResponder)
    }

    func testSelectedTextMarkedTextBlurAndScratchlistSuppressThePicker() async throws {
        let interactor = try makeInteractor()
        let layout = ComposerLayout()
        let window = try host(ComposerHarness(interactor: interactor, layout: layout))
        defer { window.isHidden = true }
        try await settle()
        let input = try textView(in: window)
        input.becomeFirstResponder()
        input.insertText("@")
        try await settle()
        let shortlistHeight = layout.height
        input.setMarkedText("会话", selectedRange: NSRange(location: 2, length: 0))
        try await settle()
        XCTAssertNotNil(input.markedTextRange)
        let hiddenHeight = layout.height
        XCTAssertGreaterThan(shortlistHeight, hiddenHeight + 100,
                             "IME candidates must not compete with HAPI suggestions")
        input.unmarkText()
        try await settle()
        XCTAssertGreaterThan(layout.height, hiddenHeight + 50)
        input.selectedRange = NSRange(location: 1, length: 1)
        try await settle()
        XCTAssertEqual(layout.height, hiddenHeight, accuracy: 2)
        input.selectedRange = NSRange(location: input.text.utf16.count, length: 0)
        input.resignFirstResponder()
        try await settle()
        XCTAssertEqual(layout.height, hiddenHeight, accuracy: 2)
        input.becomeFirstResponder()
        try await settle()
        XCTAssertGreaterThan(layout.height, hiddenHeight + 50)
        interactor.setComposerDestination(.scratchlist)
        try await settle()
        XCTAssertEqual(layout.height, hiddenHeight, accuracy: 2)
        XCTAssertEqual(interactor.composerText, "@会话")
    }

    func testProgrammaticPrefillAndSlashCommandKeepTheCaretAtTheEnd() async throws {
        let interactor = try makeInteractor()
        let window = try host(ChatComposerView(interactor: interactor).hapiTypography())
        defer { window.isHidden = true }
        try await settle()
        let input = try textView(in: window)
        input.becomeFirstResponder()
        input.insertText("old")
        try await settle()
        interactor.setComposerText("A restored 😀 draft")
        try await settle()
        XCTAssertEqual(input.selectedRange, NSRange(location: interactor.composerText.utf16.count, length: 0))
        interactor.selectSlashCommand(.init(name: "compact", source: "builtin"))
        try await settle()
        XCTAssertEqual(input.text, "/compact ")
        XCTAssertEqual(input.selectedRange, NSRange(location: 9, length: 0))
        XCTAssertTrue(input.isFirstResponder)
        input.insertText("x")
        interactor.setComposerText("A prefill arriving in the same turn as typing")
        try await settle()
        XCTAssertEqual(input.selectedRange.location, interactor.composerText.utf16.count)
        interactor.setComposerText("")
        try await settle()
        XCTAssertEqual(input.selectedRange, NSRange(location: 0, length: 0))
    }

    @Observable fileprivate final class TextDriver {
        var text = ""
        var selection = NSRange(location: 0, length: 0)
        var focused = false
        var composing = false
    }

    private struct EditorHarness: View {
        @Bindable var driver: TextDriver
        var body: some View {
            ComposerTextView(text: $driver.text, selection: $driver.selection,
                isFocused: $driver.focused, isComposing: $driver.composing,
                font: .systemFont(ofSize: 16), accessibilityLabel: "Message")
        }
    }

    func testMentionEditHonorsTheExplicitMidDraftCaretAndSupportsAnotherMention() async throws {
        let driver = TextDriver()
        let window = try host(VStack { EditorHarness(driver: driver); Spacer() })
        defer { window.isHidden = true }
        try await settle()
        let input = try textView(in: window)
        input.becomeFirstResponder()
        input.insertText("😀 看 @peerOld, thanks")
        input.selectedRange = NSRange(location: "😀 看 @pe".utf16.count, length: 0)
        try await settle()
        let hit = ComposerMentionSuggestion(id: "session:peer", text: "[Peer](/sessions/peer)",
            label: "@Peer", detail: "peer", source: .session(active: true))
        let edit = try XCTUnwrap(ComposerMentionSuggestions.inserting(hit, into: driver.text, selection: driver.selection))
        driver.text = edit.text
        driver.selection = edit.selection
        try await settle()
        XCTAssertEqual(input.text, "😀 看 [Peer](/sessions/peer) , thanks")
        XCTAssertEqual(input.selectedRange, edit.selection)
        XCTAssertTrue(input.isFirstResponder)
        input.insertText("@")
        try await settle()
        XCTAssertEqual(ComposerMentionSuggestions.query(in: driver.text, selection: driver.selection)?.search, "")
        XCTAssertTrue(input.text.hasSuffix(", thanks"))
    }

    func testEditorGrowsToSixLinesAndScrollsWithoutLosingTheSelection() async throws {
        let driver = TextDriver()
        let window = try host(VStack { EditorHarness(driver: driver); Spacer() })
        defer { window.isHidden = true }
        try await settle()
        let input = try textView(in: window)
        let oneLine = input.bounds.height
        XCTAssertGreaterThan(oneLine, 15)
        driver.text = "one\ntwo\nthree"
        try await settle()
        XCTAssertGreaterThan(input.bounds.height, oneLine * 2)
        XCTAssertFalse(input.isScrollEnabled)
        driver.text = (1...12).map { "Line \($0)" }.joined(separator: "\n")
        try await settle()
        XCTAssertLessThanOrEqual(input.bounds.height, ceil(try XCTUnwrap(input.font).lineHeight * 6) + 1)
        XCTAssertTrue(input.isScrollEnabled)
        driver.selection = NSRange(location: 5, length: 0)
        try await settle()
        XCTAssertEqual(input.selectedRange.location, 5)
        driver.text = "short"
        try await settle()
        XCTAssertEqual(input.bounds.height, oneLine, accuracy: 1)
    }

    func testMentionListFitsNarrowAndAccessibleLayouts() throws {
        let hits = (0..<8).map { index in
            ComposerMentionSuggestion(id: "session:\(index)", text: "reference", label: "@很长的会话标题 / A long session title \(index)",
                detail: "12345678", source: .session(active: true))
        }
        for size in [DynamicTypeSize.large, .accessibility3] {
            let view = ComposerMentionList(suggestions: hits, surface: .white) { _ in }
                .environment(\.dynamicTypeSize, size)
            let measured = UIHostingController(rootView: view).sizeThatFits(in: .init(width: 252, height: 1000))
            XCTAssertLessThanOrEqual(measured.width, 252)
            XCTAssertGreaterThanOrEqual(measured.height, 4 * 44)
            XCTAssertLessThan(measured.height, 1000)
        }
    }

    private func host<V: View>(_ view: V) throws -> UIWindow {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        window.rootViewController = UIHostingController(rootView: view.environment(\.locale, Locale(identifier: "en")))
        window.makeKeyAndVisible()
        return window
    }

    private func settle() async throws { try await Task.sleep(for: .milliseconds(600)) }

    private func textView(in view: UIView) throws -> UITextView {
        func find(_ view: UIView) -> UITextView? {
            if let input = view as? UITextView, input.accessibilityIdentifier == "composer.text" { return input }
            return view.subviews.lazy.compactMap(find).first
        }
        return try XCTUnwrap(find(view))
    }

}
