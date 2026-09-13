import HapiClient
@testable import HapiProtocol
import Observation
import SwiftUI
import UIKit
import XCTest
@testable import Hapi
@testable import HapiUI

/// Real native question cards with deterministic data, no live conversations.
@MainActor
final class QuestionCardPresentationTests: XCTestCase {
    private static let input = #"{"questions":[{"id":"skill","header":"超能力选择","question":"如果能瞬间学会一项技能，你最想选哪个？","options":[{"label":"精通一门外语 (Recommended)","description":"旅行、看剧、交流都不再有语言障碍。"},{"label":"精通一种乐器","description":"随时演奏自己喜欢的音乐。"},{"label":"拥有顶级厨艺","description":"想吃什么美食，都能自己做出来。"}]}]}"#

    private struct NoHTTP: HTTPPerforming {
        func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            throw URLError(.notConnectedToInternet)
        }
    }

    @Observable @MainActor
    final class Driver {
        var tool: ChatToolCall
        let presentation = ChatPresentationState()
        let interactor: ChatInteractor
        @ObservationIgnored var height: CGFloat = 0
        @ObservationIgnored var appeared = 0
        init(tool: ChatToolCall) {
            self.tool = tool
            let url = URL(string: "http://127.0.0.1:1")!
            let auth = AuthManager(baseURL: url, credentialStore: InMemoryCredentialStore(), performer: NoHTTP())
            let api = APIClient(baseURL: url, authManager: auth, performer: NoHTTP())
            interactor = ChatInteractor(sessionId: "question-specimen", api: api,
                                       sessionStore: SessionListStore(api: api), windows: MessageWindowControllers(provider: api))
        }

        var block: ToolCallBlock {
            ToolCallBlock(id: tool.id, localId: nil, createdAt: 0, invokedAt: nil, durationMs: nil,
                          usage: nil, model: nil, tool: tool, children: [], meta: nil)
        }

        var draft: QuestionAnswerDraft {
            get { presentation.values[.init(id: "reply", field: QuestionAnswerDraft.storageField)] as? QuestionAnswerDraft ?? .init() }
            set { presentation.values[.init(id: "reply", field: QuestionAnswerDraft.storageField)] = newValue }
        }
    }

    private struct Card: View {
        let driver: Driver
        var body: some View {
            ToolCallBlockView(block: driver.block, basePath: nil)
                .environment(\.chatInteractions, driver.interactor)
                .environment(\.chatPresentationState, driver.presentation)
                .background(GeometryReader { geometry in
                    Color.clear
                        .onAppear { driver.height = geometry.size.height; driver.appeared += 1 }
                        .onChange(of: geometry.size.height) { _, height in driver.height = height }
                })
                .hapiReadingColumn()
        }
    }

    private struct Specimen: View {
        let driver: Driver
        let theme: HapiTheme
        let typeSize: DynamicTypeSize
        var body: some View {
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        UserTextBlockView(block: UserTextBlock(
                            id: "user", localId: nil, createdAt: 0, invokedAt: nil,
                            text: "再问我一个问题", attachments: nil, status: nil, originalText: nil, meta: nil
                        )).hapiReadingColumn()
                        Card(driver: driver)
                    }
                    .padding(.vertical, 16)
                }
                .background(theme.background)
                .safeAreaInset(edge: .bottom, spacing: 0) { ChatComposerView(interactor: driver.interactor) }
                .navigationTitle("问答测试")
                .navigationBarTitleDisplayMode(.inline)
            }
            .hapiTheme(theme)
            .hapiTypography()
            .environment(\.dynamicTypeSize, typeSize)
            .preferredColorScheme(theme.isDark ? .dark : .light)
        }
    }

    private func makeTool(_ input: String = QuestionCardPresentationTests.input) throws -> ChatToolCall {
        ChatToolCall(id: "question", name: "functions.request_user_input", state: .running,
                     input: try JSONDecoder().decode(JSONValue.self, from: Data(input.utf8)), createdAt: 0,
                     permission: ToolPermission(id: "reply", status: .pending))
    }

    func testQuestionCardsFitThemesAndTypeSizesAndCollapseOnlyWithRecordedAnswers() async throws {
        for (name, theme, size, width) in [
            ("light", HapiTheme.light, DynamicTypeSize.large, CGFloat(390)),
            ("dark", .dark, .large, 390), ("oled", .oled, .large, 390),
            ("small", .light, .large, 320), ("large-type", .light, .accessibility3, 390),
            ("long-option", .light, .large, 320),
        ] {
            let source = name == "long-option"
                ? #"{"questions":[{"id":"skill","header":"部署与数据存储方案","question":"原型应该采用哪种 **部署方案**？请考虑后续维护成本。","options":[{"label":"使用本地 SQLite 数据库并将应用部署到自有服务器 (Recommended)","description":"保留完整数据控制权，使用 `sqlite` 文件进行备份。"},{"label":"使用托管数据库与云平台","description":"减少服务器维护，但需要管理额外成本。"}]}]}"#
                : Self.input
            let driver = Driver(tool: try makeTool(source))
            let (window, host) = try host(Specimen(driver: driver, theme: theme, typeSize: size), width: width)
            defer { window.isHidden = true }
            try await settle { driver.height > 100 }
            XCTAssertTrue(driver.draft.selections.isEmpty)
            let initial = driver.height
            if size == .large { XCTAssertLessThan(initial, 720, "The default card must not require a second viewport") }
            try capture(window, name: name)
            if size.isAccessibilitySize, let scroll = findScroll(host.view) {
                let bottom = max(-scroll.adjustedContentInset.top,
                                 scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
                scroll.setContentOffset(CGPoint(x: 0, y: bottom), animated: false)
                try await Task.sleep(for: .milliseconds(150))
                try capture(window, name: "large-type-bottom")
                scroll.setContentOffset(CGPoint(x: 0, y: -scroll.adjustedContentInset.top), animated: false)
            }
            let form = QuestionAnswerForm(tool: driver.tool)
            driver.draft.select(0, at: 0, in: form)
            if name == "light" {
                try await Task.sleep(for: .milliseconds(150))
                try capture(window, name: "selected")
            }
            driver.draft.toggleText(at: 0, in: form)
            driver.draft.setText("希望先学好英语。\nKeep my selection and this note.", at: 0, in: form)
            try await settle { driver.height > initial + 30 }
            let edited = driver.draft
            driver.tool.description = "An SSE update unrelated to the answers"
            try await Task.sleep(for: .milliseconds(100))
            XCTAssertEqual(driver.draft, edited)
            // Local selections are not a recorded answer or a successful POST.
            XCTAssertFalse(questionToolDetails(driver.tool).hasAnswers)
            XCTAssertNil(host.presentedViewController, "Answering stays in the conversation")
            if name == "light" { try capture(window, name: "light-note") }
            driver.tool.permission = ToolPermission(id: "reply", status: .resolved)
            driver.tool.state = .completed
            let chosen = try XCTUnwrap(form.fields.first?.options.first?.label)
            driver.tool.result = .object(["answers": .object(["skill": .object([
                "answers": .array([.string(chosen)]),
            ])])])
            try await settle { driver.height < initial }
            XCTAssertEqual(questionAnswerSummary(questionToolDetails(driver.tool).questions[0]), QuestionOptionTitle(chosen).text)
            if name == "light" { try capture(window, name: "answered") }
        }
    }

    private struct Row: Identifiable, Equatable {
        let index: Int
        var id: String { String(index) }
    }

    private struct Transcript: View {
        let driver: Driver
        var body: some View {
            AnchoredTranscriptList(
                items: (0..<40).map { Row(index: $0) }, historyVersion: 0, jumpToken: 0,
                historyControlID: "-1", onViewport: { _ in }, onLayout: { _, _ in }
            ) { row in
                AnyView(Group {
                    if row.index == 10 { Card(driver: driver) }
                    else { Text("Message \(row.id)").frame(maxWidth: .infinity).frame(height: 100) }
                })
            }
            .hapiTypography()
        }
    }

    func testSteppingEditingRecyclingAndCompletionPreserveTranscriptStateAndAnchor() async throws {
        let input = #"{"questions":[{"id":"a","header":"First","question":"Choose one","options":[{"label":"A"},{"label":"B"}]},{"id":"b","header":"Second","question":"Choose multiple","multiple":true,"options":[{"label":"C"},{"label":"D"}]}]}"#
        let driver = Driver(tool: try makeTool(input))
        let (window, host) = try host(Transcript(driver: driver), width: 390)
        defer { window.isHidden = true }
        let collection = try XCTUnwrap(findCollection(host.view))
        try await settle { collection.numberOfItems(inSection: 0) == 40 }
        func browse(_ index: Int) async throws {
            collection.delegate?.scrollViewWillBeginDragging?(collection)
            collection.scrollToItem(at: IndexPath(item: index, section: 0), at: .top, animated: false)
            try await settle { collection.cellForItem(at: IndexPath(item: index, section: 0)) != nil }
        }
        try await browse(10)
        let cell = try XCTUnwrap(collection.cellForItem(at: IndexPath(item: 10, section: 0)))
        let offset = cell.frame.minY - collection.contentOffset.y
        let form = QuestionAnswerForm(tool: driver.tool)
        driver.draft.select(0, at: 0, in: form)
        driver.draft.select(1, at: 1, in: form)
        driver.draft.toggleText(at: 1, in: form)
        driver.draft.setText("A multiline draft\nthat must survive recycling", at: 1, in: form)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(cell.frame.minY - collection.contentOffset.y, offset, accuracy: 1)
        let draft = driver.draft
        let appearances = driver.appeared
        try await browse(32)
        try await browse(10)
        XCTAssertEqual(driver.draft, draft)
        XCTAssertGreaterThan(driver.appeared, appearances, "The card must actually leave and reenter the viewport")
        XCTAssertEqual(driver.draft.page, 1, "Restoring the selected step must not advance it")
        driver.draft.previous(in: form)
        driver.draft.setText("Retained note", at: 0, in: form)
        let anchor = try XCTUnwrap(collection.cellForItem(at: IndexPath(item: 10, section: 0)))
        let anchorOffset = anchor.frame.minY - collection.contentOffset.y
        let expandedHeight = driver.height
        driver.tool.permission = ToolPermission(id: "reply", status: .approved, answers: .object([
            "a": .object(["answers": .array([.string("A")])]),
            "b": .object(["answers": .array([.string("D")])]),
        ]))
        try await settle { driver.height < expandedHeight }
        XCTAssertEqual(anchor.frame.minY - collection.contentOffset.y, anchorOffset, accuracy: 1)
    }

    private func host<V: View>(_ view: V, width: CGFloat) throws -> (UIWindow, UIHostingController<V>) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: width, height: 844)
        let host = UIHostingController(rootView: view)
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.layoutIfNeeded()
        return (window, host)
    }

    private func findCollection(_ view: UIView) -> UICollectionView? {
        if let collection = view as? UICollectionView { return collection }
        return view.subviews.lazy.compactMap(findCollection).first
    }

    private func findScroll(_ view: UIView) -> UIScrollView? {
        if let scroll = view as? UIScrollView { return scroll }
        return view.subviews.lazy.compactMap(findScroll).first
    }

    private func settle(_ condition: () -> Bool) async throws {
        for _ in 0..<100 {
            try await Task.sleep(for: .milliseconds(30))
            if condition() { try await Task.sleep(for: .milliseconds(150)); return }
        }
        XCTFail("Question layout did not settle")
    }

    private func capture(_ window: UIWindow, name: String) throws {
        guard let path = ProcessInfo.processInfo.environment["HAPI_QUESTION_CAPTURE"] else { return }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent("question-\(name).png"))
    }
}
