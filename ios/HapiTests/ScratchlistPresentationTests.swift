import HapiClient
import HapiProtocol
import HapiUI
import SwiftUI
import UIKit
import XCTest
@testable import Hapi

private struct ScratchlistOfflineHTTP: HTTPPerforming {
    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) { throw URLError(.notConnectedToInternet) }
}

@MainActor
final class ScratchlistPresentationTests: XCTestCase {
    private func hasAccessibilityIdentifier(_ identifier: String, in view: UIView) -> Bool {
        if view.accessibilityIdentifier == identifier { return true }
        if let elements = view.accessibilityElements {
            for element in elements {
                if let identifiable = element as? UIAccessibilityIdentification,
                   identifiable.accessibilityIdentifier == identifier {
                    return true
                }
            }
        }
        let elementCount = view.accessibilityElementCount()
        if elementCount != NSNotFound {
            for index in 0..<elementCount {
                guard let element = view.accessibilityElement(at: index) else { continue }
                if let identifiable = element as? UIAccessibilityIdentification,
                   identifiable.accessibilityIdentifier == identifier {
                    return true
                }
                if let child = element as? UIView,
                   hasAccessibilityIdentifier(identifier, in: child) {
                    return true
                }
            }
        }
        for child in view.subviews {
            if hasAccessibilityIdentifier(identifier, in: child) { return true }
        }
        return false
    }

    private func interactor() -> ChatInteractor {
        let url = URL(string: "https://scratchlist.invalid")!
        let http = ScratchlistOfflineHTTP()
        let auth = AuthManager(baseURL: url, credentialStore: InMemoryCredentialStore(), performer: http)
        let api = APIClient(baseURL: url, authManager: auth, performer: http)
        let interactor = ChatInteractor(sessionId: "preview", api: api, sessionStore: SessionListStore(api: api), windows: MessageWindowControllers(provider: api))
        let stamp = Int(Date().timeIntervalSince1970 * 1000) - 120_000
        interactor.scratchlist = ScratchlistTestStore(entries: [
            ScratchlistEntry(entryId: "first", text: "检查登录后偶发的白屏，先补回归测试，再修复根因。", createdAt: stamp, updatedAt: stamp),
            ScratchlistEntry(entryId: "second", text: "主流程完成后，再补充深色模式和大字号的界面截图。", createdAt: stamp - 180_000, updatedAt: stamp - 180_000,
                attachments: [ScratchlistAttachment(id: "reference", filename: "dark-mode-reference.png", mimeType: "image/png", size: 100, path: "hub-reference")]),
            ScratchlistEntry(entryId: "third", text: "Review the release notes", createdAt: stamp - 600_000, updatedAt: stamp - 600_000),
        ])
        interactor.setComposerDestination(.scratchlist)
        return interactor
    }

    private struct Harness: View {
        let interactor: ChatInteractor
        let size: DynamicTypeSize
        let dark: Bool
        var locale = "zh-Hans"
        var body: some View {
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("先梳理登录流程，修复问题后补上测试。")
                            .padding(14).background(.quaternary, in: RoundedRectangle(cornerRadius: 16))
                        Text("正在检查会话恢复和登录状态切换。你可以先把后续想法暂存在草稿夹，不打断当前任务。")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }.padding(16)
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    ChatComposerView(interactor: interactor)
                }
                .navigationTitle("登录流程优化")
                .navigationBarTitleDisplayMode(.inline)
            }
            .hapiTypography()
            .environment(\.dynamicTypeSize, size)
            .environment(\.locale, Locale(identifier: locale))
            .preferredColorScheme(dark ? .dark : .light)
        }
    }

    func testComposerRendersAtCompactRegularAndAccessibleSizes() async throws {
        for (name, width, size, dark, locale) in [
            ("light", CGFloat(402), DynamicTypeSize.large, false, "zh-Hans"),
            ("dark", CGFloat(402), DynamicTypeSize.large, true, "zh-Hans"),
            ("compact", CGFloat(320), DynamicTypeSize.large, false, "zh-Hans"),
            ("large-text", CGFloat(390), DynamicTypeSize.accessibility3, false, "zh-Hans"),
            ("english", CGFloat(320), DynamicTypeSize.large, false, "en"),
        ] {
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: width, height: 874)
            let interactor = interactor()
            let host = UIHostingController(rootView: Harness(interactor: interactor, size: size, dark: dark, locale: locale))
            window.rootViewController = host
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            try await Task.sleep(for: .milliseconds(350))
            window.layoutIfNeeded()
            XCTAssertEqual(host.view.bounds.width, width, accuracy: 1)
            XCTAssertEqual(interactor.composerDestination, .scratchlist)
            XCTAssertEqual(interactor.scratchlistCount, 3)
            let format = UIGraphicsImageRendererFormat()
            format.scale = 2
            let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "scratchlist-\(name)"
            attachment.lifetime = .keepAlways
            add(attachment)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("scratchlist-\(name).png")
            try XCTUnwrap(image.pngData()).write(to: url)
            print("SCRATCHLIST_CAPTURE=\(url.path)")
        }
    }

    func testDrawerShowsOneRecentDraftAndOnlyHeaderWhenTypingOrUsingLargeText() throws {
        let interactor = interactor()
        let store = try XCTUnwrap(interactor.scratchlist as? ScratchlistTestStore)
        let entries = store.session.entries
        func measure(count: Int, focused: Bool, size: DynamicTypeSize, locale: String) -> CGSize {
            store.session.entries = Array(entries.prefix(count))
            let view = ScratchlistDrawerView(store: store, sessionId: "preview", interactor: interactor,
                keyboardFocused: focused, onOpen: { _, _ in })
                .hapiTypography().environment(\.dynamicTypeSize, size).environment(\.locale, Locale(identifier: locale))
            let host = UIHostingController(rootView: view)
            return host.sizeThatFits(in: CGSize(width: 320, height: 2000))
        }
        for locale in ["en", "zh-Hans"] {
            let summary = measure(count: 3, focused: true, size: .large, locale: locale)
            XCTAssertLessThan(summary.height, 70, "Typing should leave just one header, not a draft preview")
            XCTAssertLessThanOrEqual(summary.width, 320)
            XCTAssertEqual(measure(count: 0, focused: true, size: .large, locale: locale).height, summary.height, accuracy: 1)
            let one = measure(count: 1, focused: false, size: .large, locale: locale)
            XCTAssertGreaterThan(one.height, summary.height + 40)
            XCTAssertLessThan(one.height, 150)
            XCTAssertEqual(measure(count: 3, focused: false, size: .large, locale: locale).height, one.height, accuracy: 1)
            for size in [DynamicTypeSize.accessibility3, .accessibility5] {
                let empty = measure(count: 0, focused: false, size: size, locale: locale)
                let populated = measure(count: 3, focused: false, size: size, locale: locale)
                XCTAssertEqual(populated.height, empty.height, accuracy: 1, "Large text uses a summary even without the keyboard")
                XCTAssertLessThanOrEqual(populated.width, 320)
                XCTAssertLessThan(populated.height, 170)
            }
        }
    }

    func testRowsRemainCompactAndAdaptActionsAtAccessibleSizes() throws {
        let interactor = interactor()
        let entry = try XCTUnwrap(interactor.scratchlist?.state("preview").entries[1])
        for locale in ["en", "zh-Hans"] {
            for size in [DynamicTypeSize.large, .accessibility3, .accessibility5] {
                for compact in [false, true] {
                    let row = ScratchlistEntryRow(entry: entry, interactor: interactor,
                        onOpen: {}, onEdit: {}, onDelete: {}, compact: compact)
                        .hapiTypography().environment(\.dynamicTypeSize, size)
                        .environment(\.locale, Locale(identifier: locale))
                    let host = UIHostingController(rootView: row)
                    let fitting = host.sizeThatFits(in: CGSize(width: 256, height: 2000))
                    XCTAssertLessThanOrEqual(fitting.width, 256)
                    XCTAssertGreaterThanOrEqual(fitting.height, 44)
                    if size == .large { XCTAssertLessThan(fitting.height, compact ? 70 : 100) }
                }
            }
        }
    }

    func testFocusingTheRealComposerCollapsesThePreviewWithoutChangingInput() async throws {
        let interactor = interactor()
        interactor.setComposerText("补充一条回归测试")
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        let host = UIHostingController(rootView: ChatComposerView(interactor: interactor)
            .hapiTypography().environment(\.locale, Locale(identifier: "zh-Hans")))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.endEditing(true); window.isHidden = true }
        try await Task.sleep(for: .milliseconds(250))
        window.layoutIfNeeded()
        host.view.layoutIfNeeded()
        var hasPreview = hasAccessibilityIdentifier("scratchlist.recent", in: window)
        for _ in 0..<50 {
            if hasPreview { break }
            try await Task.sleep(for: .milliseconds(10))
            window.layoutIfNeeded()
            host.view.layoutIfNeeded()
            hasPreview = hasAccessibilityIdentifier("scratchlist.recent", in: window)
        }
        XCTAssertTrue(hasPreview, "The recent Scratchlist preview should be visible before focusing the composer")
        interactor.focusComposer()
        func hasFirstResponder(_ view: UIView) -> Bool {
            view.isFirstResponder || view.subviews.contains(where: hasFirstResponder)
        }
        for _ in 0..<50 {
            if hasFirstResponder(window) { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(hasFirstResponder(window))
        hasPreview = hasAccessibilityIdentifier("scratchlist.recent", in: window)
        for _ in 0..<50 {
            if !hasPreview { break }
            try await Task.sleep(for: .milliseconds(10))
            window.layoutIfNeeded()
            host.view.layoutIfNeeded()
            hasPreview = hasAccessibilityIdentifier("scratchlist.recent", in: window)
        }
        XCTAssertFalse(hasPreview, "The recent Scratchlist preview should disappear after focusing the composer")
        XCTAssertEqual(interactor.composerText, "补充一条回归测试")
        XCTAssertEqual(interactor.composerDestination, .scratchlist)
        XCTAssertEqual(interactor.scratchlistCount, 3)
    }

    func testInlineScratchlistErrorsDoNotAlsoProduceToasts() throws {
        let hub = try XCTUnwrap(HubSession(hubUrl: "http://127.0.0.1:1/scratchlist-notices-\(UUID().uuidString)",
            credentialStore: InMemoryCredentialStore(), performer: ScratchlistOfflineHTTP()))
        let model = ChatModel(session: hub, sessionId: "preview")
        defer { model.stop(); hub.shutdown() }
        model.start()
        let message = "Couldn't park the draft — check the hub connection"
        model.interactor.reportScratchlistError(message)
        model.interactor.onEvent?(.notice(message))
        XCTAssertNil(model.notice)
        // Dismissing the inline error must not uncover a duplicate toast.
        model.interactor.retryScratchlistComposerOperation()
        XCTAssertNil(model.notice)
        model.interactor.onEvent?(.notice("Draft parked to scratchlist"))
        XCTAssertEqual(model.notice, "Draft parked to scratchlist")
        model.interactor.onEvent?(.notice("An unrelated error"))
        XCTAssertEqual(model.notice, "An unrelated error")
    }
}

extension ScratchlistPresentationTests {
    private struct ScrollRow: Identifiable, Equatable { let id: String }
    private struct ScrollHarness: View {
        let interactor: ChatInteractor
        let rows = (0..<100).map { ScrollRow(id: "message-\($0)") }
        var body: some View {
            AnchoredTranscriptList(items: rows, historyVersion: 0, jumpToken: 0,
                historyControlID: "history", onViewport: { _ in }, onLayout: { _, _ in }) { row in
                    AnyView(Text(verbatim: row.id).frame(maxWidth: .infinity).frame(height: 90))
                }
                .safeAreaInset(edge: .bottom, spacing: 0) { ChatComposerView(interactor: interactor) }
                .hapiTypography()
        }
    }

    func testTogglingDrawerPreservesTranscriptIdentityAndReadingAnchor() async throws {
        let interactor = interactor()
        interactor.setComposerDestination(.chat)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        let host = UIHostingController(rootView: ScrollHarness(interactor: interactor))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(250))
        func find(_ view: UIView) -> UICollectionView? {
            if let collection = view as? UICollectionView { return collection }
            return view.subviews.lazy.compactMap(find).first
        }
        let list = try XCTUnwrap(find(host.view))
        list.delegate?.scrollViewWillBeginDragging?(list)
        list.scrollToItem(at: IndexPath(item: 25, section: 0), at: .top, animated: false)
        list.contentOffset.y += 13
        list.delegate?.scrollViewDidEndDragging?(list, willDecelerate: false)
        try await Task.sleep(for: .milliseconds(180))
        func anchor() -> (String, CGFloat)? {
            list.visibleCells.filter { $0.frame.maxY > list.contentOffset.y }
                .sorted { $0.frame.minY < $1.frame.minY }.first.map {
                    ($0.accessibilityIdentifier ?? "", $0.frame.minY - list.contentOffset.y)
                }
        }
        let before = try XCTUnwrap(anchor())
        for mode in [ComposerDestination.scratchlist, .chat] {
            interactor.setComposerDestination(mode)
            try await Task.sleep(for: .milliseconds(250))
            XCTAssertTrue(find(host.view) === list)
            let after = try XCTUnwrap(anchor())
            XCTAssertEqual(after.0, before.0)
            XCTAssertEqual(after.1, before.1, accuracy: 1)
        }
    }

    func testInventoryAndSingleStackEditorRender() async throws {
        let interactor = interactor()
        let store = try XCTUnwrap(interactor.scratchlist)
        let http = ScratchlistOfflineHTTP()
        let url = URL(string: "https://scratchlist.invalid")!
        let api = APIClient(baseURL: url,
            authManager: AuthManager(baseURL: url, credentialStore: InMemoryCredentialStore(), performer: http), performer: http)
        let loader = ScratchlistAttachmentLoader(api: api, sessionId: "preview")
        for (name, detail, editing, width, size, dark) in [
            ("inventory", false, false, CGFloat(402), DynamicTypeSize.large, false),
            ("inventory-dark", false, false, CGFloat(402), DynamicTypeSize.large, true),
            ("inventory-compact", false, false, CGFloat(320), DynamicTypeSize.large, false),
            ("inventory-large-text", false, false, CGFloat(390), DynamicTypeSize.accessibility3, false),
            ("detail", true, false, CGFloat(402), DynamicTypeSize.large, false),
            ("editor", true, true, CGFloat(402), DynamicTypeSize.large, false),
            ("empty", false, false, CGFloat(402), DynamicTypeSize.large, false),
        ] {
            if name == "empty" { (store as? ScratchlistTestStore)?.session.entries = [] }
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: width, height: 874)
            let view = ScratchlistView(store: store, sessionId: "preview", attachments: loader, interactor: interactor,
                initialEntry: detail ? store.state("preview").entries[1] : nil, initiallyEditing: editing)
                .hapiTypography().environment(\.locale, Locale(identifier: "zh-Hans"))
                .environment(\.dynamicTypeSize, size).preferredColorScheme(dark ? .dark : .light)
            window.rootViewController = UIHostingController(rootView: view)
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            try await Task.sleep(for: .milliseconds(350))
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let name = "scratchlist-\(name)"
            let attachment = XCTAttachment(image: image)
            attachment.name = name
            attachment.lifetime = .keepAlways
            add(attachment)
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("\(name).png")
            try XCTUnwrap(image.pngData()).write(to: file)
            print("SCRATCHLIST_CAPTURE=\(file.path)")
            XCTAssertEqual(store.state("preview").entries.count, name == "scratchlist-empty" ? 0 : 3)
        }
    }
}
