import HapiUI
import HapiClient
import SwiftUI
import UIKit
import XCTest
@testable import Hapi
@testable import HapiProtocol

/// Opt-in visual specimens, not product screenshots or pixel-golden tests.
@MainActor
final class TypographySnapshotTests: XCTestCase {
    private struct Specimen: View {
        let width: CGFloat
        let theme: HapiTheme
        let baseline: Bool
        let interactor: ChatInteractor

        var body: some View {
            VStack(alignment: .leading, spacing: 12) {
                Text("HAPI · Typography specimen / 排版测试")
                    .font(.caption).foregroundStyle(.secondary)
                UserTextBlockView(block: UserTextBlock(
                    id: "user", localId: nil, createdAt: 0, invokedAt: nil,
                    text: "请解释这些修改，并给出验证步骤。Explain the changes and how to verify them.",
                    attachments: nil, status: nil, originalText: nil, meta: nil
                ))
                MarkdownView(markdown: """
                ## 更清晰的阅读体验

                统一字体与留白，让长回答更容易阅读。Native typography keeps **important information** clear, including 中文、English、数字 123 和 emoji 👩🏽‍💻.

                ### Verification / 验证

                1. 调整系统文字大小，检查 `Dynamic Type` 与正文比例。
                2. Read a longer response without losing your place while new messages arrive.
                   - Keep nested lists aligned with their first text baseline.
                   - [x] 保留链接 [documentation](https://example.com) 和代码样式。

                > 正文应该是视觉主角。Controls should support the content, not compete with it.

                ```text
                bun run test --filter typography
                let message = "你好，HAPI 👋"
                a_long_command --workspace /projects/native-client --output readable-results.json
                ```

                | 内容 | 验证重点 |
                | --- | --- |
                | 正文 Body | 中英文混排、换行与段落间距 |
                | 代码 Code | 等宽、可读性与横向滚动 |
                """)
                DiffTextView(unifiedDiff: """
                --- a/reading.swift
                +++ b/reading.swift
                @@ -1,2 +1,2 @@
                -let body = 15
                +let body = 17
                 // 阅读体验 / readable text
                """)
                ToolCallBlockView(block: ToolCallBlock(
                    id: "tool", localId: nil, createdAt: 0, invokedAt: nil,
                    durationMs: nil, usage: nil, model: nil,
                    tool: ChatToolCall(id: "tool", name: "Bash", state: .pending,
                        input: .object(["command": .string("git diff -- ios/Packages/HapiKit/Sources/HapiUI")]),
                        createdAt: 0, permission: ToolPermission(id: "approval", status: .pending)),
                    children: [], meta: nil
                ), basePath: "/workspace/hapi")
                .environment(\.chatInteractions, interactor)
            }
            .modifier(SpecimenColumn(baseline: baseline))
            .padding(.vertical, 16)
            .frame(width: width, alignment: .leading)
            .background(theme.background)
            .hapiTheme(theme)
        }
    }

    private struct NoHTTP: HTTPPerforming {
        func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            throw URLError(.notConnectedToInternet)
        }
    }

    private func makeInteractor() -> ChatInteractor {
        let baseURL = URL(string: "http://127.0.0.1:1")!
        let auth = AuthManager(baseURL: baseURL, credentialStore: InMemoryCredentialStore(), performer: NoHTTP())
        let api = APIClient(baseURL: baseURL, authManager: auth, performer: NoHTTP())
        // Never activated; no network, real credentials, or saved drafts.
        return ChatInteractor(sessionId: "typography-specimen", api: api,
                              sessionStore: SessionListStore(api: api), windows: MessageWindowControllers(provider: api))
    }

    private struct SpecimenColumn: ViewModifier {
        let baseline: Bool
        func body(content: Content) -> some View {
            if baseline {
                content.padding(.horizontal, 12)
            } else {
                content.hapiReadingColumn()
            }
        }
    }

    func testCaptureReadingSpecimens() async throws {
        let path = ProcessInfo.processInfo.environment["HAPI_TYPOGRAPHY_CAPTURE"]
        try XCTSkipIf(path == nil, "Opt in with TEST_RUNNER_HAPI_TYPOGRAPHY_CAPTURE=/tmp/…")
        let directory = URL(fileURLWithPath: try XCTUnwrap(path), isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let cases: [(String, CGFloat, DynamicTypeSize, HapiTheme)] = [
            ("phone-small", 320, .large, .light),
            ("phone-light", 390, .large, .light),
            ("phone-dark", 390, .large, .dark),
            ("phone-oled", 390, .large, .oled),
            ("phone-xxxl", 430, .xxxLarge, .dark),
            ("phone-ax5", 390, .accessibility5, .light),
            ("ipad", 1024, .large, .light),
            ("ipad-xxxl", 768, .xxxLarge, .dark),
            ("split-ax5", 507, .accessibility5, .oled),
        ]
        for (name, width, size, theme) in cases {
            let height: CGFloat = width >= 768 ? 1024 : 844
            let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: width, height: height)
            let baseline = ProcessInfo.processInfo.environment["HAPI_TYPOGRAPHY_BASELINE"] == "1"
            let interactor = makeInteractor()
            let root = ScrollView {
                Specimen(width: width, theme: theme, baseline: baseline, interactor: interactor)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                ChatComposerView(interactor: interactor)
            }
            .frame(width: width, height: height)
            .background(theme.background)
            .hapiTypography()
            .hapiTheme(theme)
            .environment(\.dynamicTypeSize, size)
            .environment(\.colorScheme, theme.isDark ? .dark : .light)
            let host = UIHostingController(rootView: root
                .ignoresSafeArea()
                .environment(\.dynamicTypeSize, size)
                .environment(\.colorScheme, theme.isDark ? .dark : .light))
            window.rootViewController = host
            window.makeKeyAndVisible()
            host.view.frame = window.bounds
            host.view.layoutIfNeeded()
            defer { window.isHidden = true }
            try await Task.sleep(for: .milliseconds(250))
            func find(_ view: UIView) -> UIScrollView? {
                if let scroll = view as? UIScrollView { return scroll }
                return view.subviews.lazy.compactMap(find).first
            }
            let scroll = try XCTUnwrap(find(host.view))
            let format = UIGraphicsImageRendererFormat()
            format.scale = 2
            let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
            for (region, fraction) in [("top", CGFloat(0)), ("middle", CGFloat(0.5)), ("bottom", CGFloat(1))] {
                let top = -scroll.adjustedContentInset.top
                let bottom = max(top, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
                scroll.setContentOffset(CGPoint(x: 0, y: top + (bottom - top) * fraction), animated: false)
                try await Task.sleep(for: .milliseconds(150))
                let image = renderer.image { _ in
                    host.view.drawHierarchy(in: CGRect(x: 0, y: 0, width: width, height: height), afterScreenUpdates: true)
                }
                let data = try XCTUnwrap(image.pngData(), name)
                try data.write(to: directory.appendingPathComponent(name + "-" + region + ".png"))
            }
        }
    }
}
