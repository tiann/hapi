import HapiUI
import SwiftUI
import UIKit
import XCTest
@testable import Hapi
@testable import HapiProtocol

@MainActor
final class ToolCallLayoutTests: XCTestCase {
    private let prefix = "cat <<'EOF'\nx"
    private var script: String { prefix + String(repeating: "\nx", count: 100) + "\nEOF" }

    private func block(name: String, command: String) -> ToolCallBlock {
        // Cover both string commands and Codex's array representation.
        let input: JSONValue = name == "CodexBash"
            ? .array([.string("cat"), .string(String(command.dropFirst(4)))])
            : .string(command)
        return ToolCallBlock(
            id: "tool", localId: nil, createdAt: 0, invokedAt: nil,
            durationMs: nil, usage: nil, model: nil,
            tool: ChatToolCall(id: "tool", name: name, state: .completed,
                              input: .object(["command": input]), createdAt: 0),
            children: [], meta: nil
        )
    }

    private func height(of block: ToolCallBlock, size: DynamicTypeSize, details: Bool = false) -> CGFloat {
        let content = details
            ? AnyView(ToolCallBody(tool: block.tool, basePath: nil))
            : AnyView(ToolCallBlockView(block: block, basePath: nil))
        let host = UIHostingController(rootView: content
            .hapiTypography()
            .environment(\.dynamicTypeSize, size))
        return host.sizeThatFits(in: CGSize(width: 320, height: CGFloat.greatestFiniteMagnitude)).height
    }

    func testSummaryPreviewIsOneLineAndRemainsBoundedAtAccessibilitySizes() {
        for name in ["Bash", "CodexBash", "exec_command", "functions.exec_command"] {
            for size in [DynamicTypeSize.large, .accessibility5] {
                let oneLine = height(of: block(name: name, command: "cat <<'EOF'"), size: size)
                let longScript = height(of: block(name: name, command: script), size: size)
                let longerScript = height(of: block(name: name, command: script + script), size: size)
                XCTAssertEqual(longScript, longerScript, accuracy: 1, "\(name), \(size): summary must not grow with output")
                if size == .large {
                    XCTAssertEqual(longScript, oneLine, accuracy: 1)
                    XCTAssertLessThanOrEqual(longScript, 60)
                }
            }
        }
    }

    func testFileAndImageSummariesKeepTheFilenameWithoutChangingInspectorInput() {
        for (name, key, action) in [("view_image", "path", "View image"), ("Read", "file_path", "Read file"),
                                     ("Edit", "file_path", "Edit file"), ("mcp__hapi__display_image", "path", "Show image")] {
            var value = block(name: name, command: "")
            let path = "/tmp/review/a-very-long-parent-directory/light-summary.png"
            value.tool.input = .object([key: .string(path)])
            let summary = toolSummaryPresentation(value.tool, basePath: nil)
            XCTAssertEqual(summary.title, "\(action) · light-summary.png")
            XCTAssertNil(summary.subtitle)
            XCTAssertEqual(value.tool.input?[chatKey: key]?.chatString, path)
            XCTAssertEqual(height(of: value, size: .large), 44, accuracy: 1)
        }
    }

    func testGroupSummaryDiffIgnoresMemberOutputButKeepsVisibleChanges() {
        let first = block(name: "Read", command: "")
        var second = first
        second.id = "second"
        second.tool.id = "second"
        let blocks = buildVisibleChatBlocks([.toolCall(first), .toolCall(second)], options: .init(hasMoreMessages: false))
        guard case .toolGroup(var group) = blocks[0] else { return XCTFail("Expected group") }
        let original = TranscriptRow.group(ToolGroupPresentation(group))
        group.tools[1].tool.result = .string(String(repeating: "streamed output", count: 1000))
        let streamed = TranscriptRow.group(ToolGroupPresentation(group))
        XCTAssertEqual(original, streamed)
        XCTAssertEqual(streamed.spacing(after: original), 8)
        group.summary.errorCount += 1
        XCTAssertNotEqual(original, .group(ToolGroupPresentation(group)))
    }

    func testInspectorCommandKeepsTheCompleteScript() {
        for name in ["Bash", "CodexBash", "exec_command", "functions.exec_command"] {
            let longBlock = block(name: name, command: script)
            XCTAssertEqual(toolCardPresentation(longBlock.tool, basePath: nil).subtitle, script)
            XCTAssertEqual(chatTerminalCommand(longBlock.tool.input), script)
            let shortHeight = height(of: block(name: name, command: prefix + "\nEOF"), size: .large, details: true)
            let fullHeight = height(of: longBlock, size: .large, details: true)
            XCTAssertGreaterThan(fullHeight, shortHeight + 1000, "\(name): inspector body must retain all 100 extra lines")
        }
    }
}
