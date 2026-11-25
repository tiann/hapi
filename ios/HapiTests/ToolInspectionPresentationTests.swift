import HapiUI
import SwiftUI
import UIKit
import XCTest
@testable import Hapi
@testable import HapiProtocol

/// Real UIKit sheet presentation over deterministic, non-networked content.
@MainActor
final class ToolInspectionPresentationTests: XCTestCase {
    private struct Harness: View {
        let inspection: ToolInspectionState
        let group: ToolGroupBlock
        let theme: HapiTheme
        var body: some View {
            let inspectorPresented = inspection.owner != nil
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("检查原生工具显示，并验证测试结果。")
                        ToolGroupBlockView(presentation: ToolGroupPresentation(group))
                        Text("工具详情独立阅读；关闭后继续对话。")
                    }
                    .hapiReadingColumn().padding(.vertical, 16)
                }
                .background(theme.background)
                .navigationTitle("HAPI · UI specimen")
                .navigationBarTitleDisplayMode(.inline)
                .sheet(isPresented: Binding(get: { inspectorPresented }, set: { if !$0 { inspection.dismiss(owner: "chat") } })) {
                    ToolInspectionSheet(inspection: inspection, basePath: "/workspace/hapi", openFile: { _ in })
                }
                .environment(\.openChatTool, { inspection.open($0, owner: "chat") })
                .environment(\.openChatToolGroup, { inspection.openGroup($0, owner: "chat") })
            }
            .hapiTypography()
            .hapiTheme(theme)
            .preferredColorScheme(theme.isDark ? .dark : .light)
        }
    }

    func testSheetRemainsPresentedDuringSelectionAndLiveUpdates() async throws {
        let tools = [
            tool("read", name: "Read", input: ["file_path": .string("/workspace/hapi/ios/Hapi/Features/Chat/ChatView.swift")],
                 result: "import SwiftUI\n\n// 保持聊天上下文\nstruct ChatView: View {\n    var body: some View {\n        ChatTranscriptView(model: model)\n    }\n}"),
            tool("test", name: "Bash", input: ["command": .string("swift test --package-path ios/Packages/HapiKit")],
                 result: "Build complete.\n✓ Protocol fixtures\n✓ Tool inspection\n✓ Reading position\n\nAll tests passed."),
        ]
        let blocks = buildVisibleChatBlocks(tools.map(ChatBlock.toolCall), options: .init(hasMoreMessages: false))
        guard case .toolGroup(let group)? = blocks.first else { return XCTFail("Expected a tool group") }
        for (name, theme) in [("light", HapiTheme.light), ("dark", HapiTheme.dark)] {
            let inspection = ToolInspectionState()
            inspection.update(blocks)
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
            let host = UIHostingController(rootView: Harness(inspection: inspection, group: group, theme: theme))
            window.rootViewController = host
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            try await Task.sleep(for: .milliseconds(250))
            // Transcript screenshots live in ToolTranscriptPresentationTests,
            // which exercises the actual recycled ChatTranscriptView rows.
            inspection.open(tools[0], owner: "chat")
            try await Task.sleep(for: .milliseconds(600))
            let presented = try XCTUnwrap(host.presentedViewController)
            XCTAssertTrue(presented.presentationController is UISheetPresentationController)
            try capture(window, name: "\(name)-detail")
            inspection.move(by: 1)
            try await Task.sleep(for: .milliseconds(150))
            XCTAssertTrue(host.presentedViewController === presented)
            var changed = tools[1]
            changed.tool.state = .error
            changed.tool.result = .string("A later test failed.")
            inspection.update(buildVisibleChatBlocks([.toolCall(tools[0]), .toolCall(changed)], options: .init(hasMoreMessages: false)))
            try await Task.sleep(for: .milliseconds(150))
            XCTAssertTrue(host.presentedViewController === presented)
            XCTAssertEqual(inspection.selection?.block.tool.state, .error)
            inspection.dismiss(owner: "chat")
            for _ in 0..<100 {
                if host.presentedViewController == nil { break }
                try await Task.sleep(for: .milliseconds(20))
            }
            XCTAssertNil(host.presentedViewController)
        }
    }

    func testGroupListStartsAtLatestWithoutFollowingUpdatesAndSurvivesDetailNavigation() async throws {
        for count in [2, 42, 240] {
            var tools = (0..<count).map { index in
                tool("read-\(index)", name: "Read", input: ["file_path": .string("/workspace/hapi/Source\(index).swift")],
                     result: "import SwiftUI\n// Step \(index)\n")
            }
            let blocks = buildVisibleChatBlocks(tools.map(ChatBlock.toolCall), options: .init(hasMoreMessages: false))
            guard case .toolGroup(let group) = blocks[0] else { return XCTFail("Expected group") }
            let inspection = ToolInspectionState()
            inspection.update(blocks)
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
            let host = UIHostingController(rootView: Harness(inspection: inspection, group: group, theme: .light))
            window.rootViewController = host
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            host.view.layoutIfNeeded()
            inspection.openGroup(group.id, owner: "chat")
            try await eventually { host.presentedViewController != nil }
            let presented = try XCTUnwrap(host.presentedViewController)
            try await eventually {
                guard let list = self.findCollection(presented.view) else { return false }
                return list.indexPathsForVisibleItems.contains(IndexPath(item: count - 1, section: 0))
            }
            // Allow native sheet presentation and initial self-sizing to settle.
            try await Task.sleep(for: .milliseconds(600))
            let list = try XCTUnwrap(findCollection(presented.view))
            XCTAssertEqual(list.numberOfItems(inSection: 0), count)
            let initialOffset = list.contentOffset.y
            tools.append(tool("while-at-latest", name: "Read", input: ["file_path": .string("/workspace/Latest.swift")], result: "live"))
            inspection.update(buildVisibleChatBlocks(tools.map(ChatBlock.toolCall), options: .init(hasMoreMessages: false)))
            try await eventually { list.numberOfItems(inSection: 0) == count + 1 }
            try await Task.sleep(for: .milliseconds(150))
            XCTAssertEqual(list.contentOffset.y, initialOffset, accuracy: 1, "Starting at latest must not enable tail following")
            let readIndex = count > 2 ? count / 2 : 0
            if count > 2 {
                list.scrollToItem(at: IndexPath(item: readIndex, section: 0), at: .top, animated: false)
                list.layoutIfNeeded()
                try await Task.sleep(for: .milliseconds(150))
            }
            let before = list.contentOffset.y
            tools[count - 1].tool.state = .error
            tools[count - 1].tool.result = .string("A later update")
            tools.append(tool("new-tool", name: "Read", input: ["file_path": .string("/workspace/New.swift")], result: "new"))
            inspection.update(buildVisibleChatBlocks(tools.map(ChatBlock.toolCall), options: .init(hasMoreMessages: false)))
            try await eventually { list.numberOfItems(inSection: 0) == count + 2 }
            try await Task.sleep(for: .milliseconds(150))
            XCTAssertEqual(list.contentOffset.y, before, accuracy: 1, "Live updates are not a scroll command")
            XCTAssertTrue(host.presentedViewController === presented)
            XCTAssertNil(inspection.selection)

            inspection.selectGroupTool(tools[readIndex].id)
            try await eventually { self.findNavigation(presented)?.viewControllers.count == 2 }
            let navigation = try XCTUnwrap(findNavigation(presented))
            tools[readIndex].tool.result = .string("Updated selected result")
            inspection.update(buildVisibleChatBlocks(tools.map(ChatBlock.toolCall), options: .init(hasMoreMessages: false)))
            XCTAssertEqual(inspection.selection?.block.id, tools[readIndex].id)
            XCTAssertEqual(inspection.selection?.block.tool.result, .string("Updated selected result"))
            XCTAssertTrue(host.presentedViewController === presented)
            XCTAssertEqual(navigation.viewControllers.count, 2)
            if count == 42 {
                try await Task.sleep(for: .milliseconds(400))
                try capture(window, name: "group-tool-detail")
            }
            navigation.popViewController(animated: true)
            try await eventually { inspection.selection == nil && navigation.viewControllers.count == 1 }
            try await Task.sleep(for: .milliseconds(400))
            let returned = try XCTUnwrap(findCollection(presented.view))
            XCTAssertTrue(returned === list, "Navigation must retain the native list")
            XCTAssertEqual(returned.contentOffset.y, before, accuracy: 1, "Back must not replay the initial latest positioning")
            if count == 42 { try capture(window, name: "group-browser-history") }
            inspection.dismiss(owner: "chat")
            try await eventually { host.presentedViewController == nil }
            if count == 42 {
                inspection.openGroup(group.id, owner: "chat")
                try await eventually {
                    guard let reopened = host.presentedViewController,
                          let list = self.findCollection(reopened.view) else { return false }
                    return list.indexPathsForVisibleItems.contains(IndexPath(item: tools.count - 1, section: 0))
                }
                XCTAssertNil(inspection.selection)
                inspection.selectGroupTool(tools[0].id)
                try await eventually {
                    host.presentedViewController.flatMap(self.findNavigation)?.viewControllers.count == 2
                }
                inspection.dismiss(owner: "chat")
                try await eventually { host.presentedViewController == nil }
                XCTAssertNil(inspection.owner)
            }
        }
    }

    private func eventually(_ condition: () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("Inspector did not settle")
    }

    private func findCollection(_ view: UIView) -> UICollectionView? {
        if let list = view as? UICollectionView { return list }
        return view.subviews.lazy.compactMap(findCollection).first
    }

    private func findNavigation(_ controller: UIViewController) -> UINavigationController? {
        if let navigation = controller as? UINavigationController { return navigation }
        return controller.children.lazy.compactMap(findNavigation).first
    }

    private func tool(_ id: String, name: String, input: [String: JSONValue], result: String) -> ToolCallBlock {
        ToolCallBlock(id: id, localId: nil, createdAt: 0, invokedAt: nil, durationMs: nil, usage: nil, model: nil,
                      tool: ChatToolCall(id: id, name: name, state: .completed, input: .object(input), createdAt: 0, result: .string(result)),
                      children: [], meta: nil)
    }

    private func capture(_ window: UIWindow, name: String) throws {
        guard let path = ProcessInfo.processInfo.environment["HAPI_TOOL_CAPTURE"] else { return }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
        let image = renderer.image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent("\(name).png"))
    }
}
