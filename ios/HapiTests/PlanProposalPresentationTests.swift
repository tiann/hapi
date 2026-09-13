import HapiUI
import SwiftUI
import UIKit
import XCTest
@testable import Hapi
@testable import HapiProtocol

@MainActor
final class PlanProposalPresentationTests: XCTestCase {
    private let plan = """
    # 实施计划

    1. Read **input.plan**, not the result.
    2. Render the complete document on both native clients.

    | Client | Renderer |
    | --- | --- |
    | iOS | SwiftUI Markdown |
    | Android | Compose Markdown |

    ```swift
    let ready = true
    ```

    [HAPI documentation](https://hapi.run)
    """

    private func block(_ name: String, plan: String?, result: JSONValue? = .null) -> ToolCallBlock {
        ToolCallBlock(id: "proposal", localId: nil, createdAt: 0, invokedAt: nil,
                      durationMs: nil, usage: nil, model: nil,
                      tool: ChatToolCall(id: "proposal", name: name, state: .completed,
                                        input: plan.map { .object(["plan": .string($0)]) },
                                        createdAt: 0, result: result), children: [], meta: nil)
    }

    private func height<V: View>(_ view: V, width: CGFloat = 320, size: DynamicTypeSize = .large) -> CGFloat {
        UIHostingController(rootView: view.hapiTypography().environment(\.dynamicTypeSize, size))
            .sizeThatFits(in: CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)).height
    }

    func testBothAliasesShowTheEntireMarkdownLayoutWithoutOpeningDetails() {
        let longPlan = plan + "\n\n" + String(repeating: "Complete paragraph 中文 👩🏽‍💻. ", count: 900) + "\n\nLast paragraph."
        XCTAssertGreaterThan(longPlan.count, toolTextPageSize)
        for name in ["ExitPlanMode", "exit_plan_mode"] {
            for source in [plan, longPlan] {
                // Compare with the full production Markdown renderer, not the
                // plan component itself: truncation/paged source must fail.
                let markdownHeight = height(CachedMarkdownView(markdown: source), width: 296)
                let headerHeight = height(ToolCallBlockView(block: block(name, plan: nil), basePath: nil))
                let inline = height(ToolCallBlockView(block: block(name, plan: source), basePath: nil))
                XCTAssertEqual(inline, markdownHeight + headerHeight + 24, accuracy: 2, name)
                let details = height(ToolCallBody(tool: block(name, plan: source).tool, basePath: nil))
                XCTAssertGreaterThan(details, height(CachedMarkdownView(markdown: source)))
            }
        }
    }

    func testNullResultDoesNotAddAnOutputPlaceholderAndDynamicTypeStillReflows() {
        let withoutResult = block("ExitPlanMode", plan: plan, result: nil)
        let nullResult = block("ExitPlanMode", plan: plan)
        XCTAssertEqual(height(ToolCallBody(tool: withoutResult.tool, basePath: nil)),
                       height(ToolCallBody(tool: nullResult.tool, basePath: nil)), accuracy: 1)
        let normal = height(ToolCallBlockView(block: nullResult, basePath: nil))
        let accessible = height(ToolCallBlockView(block: nullResult, basePath: nil), size: .accessibility3)
        XCTAssertGreaterThan(accessible, normal)
        var pending = nullResult
        pending.tool.permission = ToolPermission(id: "approval", status: .pending)
        XCTAssertGreaterThan(height(ToolCallBlockView(block: pending, basePath: nil)), normal)
        XCTAssertNil(nullResult.tool.permission, "A completed proposal must not invent approval")
    }

    func testPlanSpecimensInLightDarkAndLargeType() async throws {
        guard let directory = ProcessInfo.processInfo.environment["HAPI_TOOL_CAPTURE"] else { return }
        for (name, theme, size) in [("light", HapiTheme.light, DynamicTypeSize.large),
                                    ("dark", HapiTheme.dark, .large), ("large-type", HapiTheme.light, .accessibility2)] {
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
            let cache = MarkdownRenderCache()
            await cache.prepare([plan])
            let view = NavigationStack {
                ScrollView {
                    ToolCallBlockView(block: block("ExitPlanMode", plan: plan), basePath: nil)
                        .hapiReadingColumn().padding(.vertical, 16)
                }
                .background(theme.background)
                .navigationTitle("Plan proposal")
                .navigationBarTitleDisplayMode(.inline)
            }
            .hapiTypography().hapiTheme(theme)
            .environment(\.hapiMarkdownCache, cache)
            .environment(\.dynamicTypeSize, size)
            .preferredColorScheme(theme.isDark ? .dark : .light)
            window.rootViewController = UIHostingController(rootView: view)
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            try await Task.sleep(for: .milliseconds(350))
            let url = URL(fileURLWithPath: directory, isDirectory: true)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            try XCTUnwrap(image.pngData()).write(to: url.appendingPathComponent("plan-\(name).png"))
        }
    }
}
