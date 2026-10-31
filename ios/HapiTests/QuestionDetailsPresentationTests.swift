import HapiUI
import SwiftUI
import UIKit
import XCTest
@testable import Hapi
@testable import HapiProtocol

/// Non-networked real-sheet specimens, using the same read-only body as chat.
@MainActor
final class QuestionDetailsPresentationTests: XCTestCase {
    private struct Harness: View {
        let inspection: ToolInspectionState
        let initial: ToolCallBlock
        let theme: HapiTheme
        let typeSize: DynamicTypeSize

        var body: some View {
            let presented = inspection.selection != nil
            NavigationStack {
                ToolCallBlockView(block: initial, basePath: nil).padding()
                    .navigationTitle("HAPI · 问答")
                    .sheet(isPresented: Binding(get: { presented }, set: { if !$0 { inspection.dismiss(owner: "chat") } })) {
                        ToolInspectionSheet(inspection: inspection, basePath: nil, openFile: { _ in })
                            .environment(\.dynamicTypeSize, typeSize)
                    }
            }
            .hapiTypography()
            .environment(\.dynamicTypeSize, typeSize)
            .hapiTheme(theme)
            .preferredColorScheme(theme.isDark ? .dark : .light)
        }
    }

    func testQuestionSheetKeepsLiveIdentityAndRendersAnswersAcrossThemesAndTypeSizes() async throws {
        let input = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"questions":[{"header":"存储方案","question":"原型应使用哪种数据库？\n\nChoose **storage** for the prototype.","multiSelect":false,"options":[{"label":"SQLite","description":"无需配置的本地文件，适合快速验证。"},{"label":"Postgres","description":"与生产环境一致，支持复杂查询。"}]}]}"#.utf8))
        var call = ChatToolCall(id: "question", name: "AskUserQuestion", state: .running, input: input, createdAt: 0,
                               permission: ToolPermission(id: "reply", status: .pending))
        let initial = block(call)
        for (name, theme, typeSize) in [("light", HapiTheme.light, DynamicTypeSize.large),
                                      ("dark", HapiTheme.dark, .large), ("large-type", HapiTheme.light, .accessibility2)] {
            let inspection = ToolInspectionState()
            inspection.update(visible(initial))
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
            let host = UIHostingController(rootView: Harness(inspection: inspection, initial: initial, theme: theme, typeSize: typeSize))
            window.rootViewController = host
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            try await Task.sleep(for: .milliseconds(250))
            inspection.open(initial, owner: "chat")
            try await Task.sleep(for: .milliseconds(650))
            let sheet = try XCTUnwrap(host.presentedViewController)
            XCTAssertTrue(sheet.presentationController is UISheetPresentationController)
            XCTAssertFalse(questionToolDetails(try XCTUnwrap(inspection.selection?.block.tool)).hasAnswers)
            call.state = .completed
            call.result = .string("User selected SQLite.")
            call.permission = ToolPermission(id: "reply", status: .approved, answers: .object(["0": .array([.string("SQLite")])]))
            inspection.update(visible(block(call)))
            try await Task.sleep(for: .milliseconds(650))
            XCTAssertTrue(host.presentedViewController === sheet)
            let details = questionToolDetails(try XCTUnwrap(inspection.selection?.block.tool))
            XCTAssertEqual(details.questions[0].options.map(\.selected), [true, false])
            XCTAssertFalse(details.showResult)
            try capture(window, name: "question-\(name)")
            inspection.dismiss(owner: "chat")
            for _ in 0..<100 {
                if host.presentedViewController == nil { break }
                try await Task.sleep(for: .milliseconds(20))
            }
            XCTAssertNil(host.presentedViewController)
        }
    }

    private func block(_ tool: ChatToolCall) -> ToolCallBlock {
        ToolCallBlock(id: tool.id, localId: nil, createdAt: 0, invokedAt: nil, durationMs: nil, usage: nil, model: nil,
                      tool: tool, children: [], meta: nil)
    }

    private func visible(_ block: ToolCallBlock) -> [VisibleChatBlock] {
        buildVisibleChatBlocks([.toolCall(block)], options: .init(hasMoreMessages: false))
    }

    private func capture(_ window: UIWindow, name: String) throws {
        guard let path = ProcessInfo.processInfo.environment["HAPI_TOOL_CAPTURE"] else { return }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent("\(name).png"))
    }
}
