import HapiClient
import HapiUI
import SwiftUI
import UIKit
import XCTest
@testable import Hapi
@testable import HapiProtocol

@MainActor
final class CodexPlanActionPresentationTests: XCTestCase {
    private struct NoHTTP: HTTPPerforming {
        func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            throw URLError(.notConnectedToInternet)
        }
    }

    @MainActor
    private final class Driver {
        let store: SessionListStore
        let interactor: ChatInteractor
        var height: CGFloat = 0

        init() throws {
            let url = try XCTUnwrap(URL(string: "http://127.0.0.1:1"))
            let auth = AuthManager(baseURL: url, credentialStore: InMemoryCredentialStore(), performer: NoHTTP())
            let api = APIClient(baseURL: url, authManager: auth, performer: NoHTTP())
            store = SessionListStore(api: api)
            interactor = ChatInteractor(sessionId: "session", api: api, sessionStore: store,
                                        windows: MessageWindowControllers(provider: api))
            let session = Session(
                id: "session", namespace: "default", seq: 1, createdAt: 0, updatedAt: 0,
                active: true, activeAt: 0,
                metadata: SessionMetadata(path: "/repo", host: "host", flavor: "codex",
                                          capabilities: SessionCapabilities(concurrentClients: true)),
                metadataVersion: 1, agentState: AgentState(codexPlanProposalId: "proposal"),
                agentStateVersion: 1, thinking: false, thinkingAt: 0, collaborationMode: .plan
            )
            store.applySessionEvent(.sessionUpdated(namespace: nil, sessionId: "session", data: .session(session)))
        }

        func publish(_ planId: String?, version: Int) {
            store.applySessionEvent(.sessionUpdated(namespace: nil, sessionId: "session", data: .patch(SessionPatch(
                agentState: VersionedValue(version: version, value: AgentState(codexPlanProposalId: planId))
            ))))
        }
    }

    private func block(_ name: String = "ExitPlanMode") -> ToolCallBlock {
        // The wrapper id is intentionally different: the live id matches the
        // native tool call, not the surrounding transcript message.
        ToolCallBlock(id: "transcript-message", localId: nil, createdAt: 0, invokedAt: nil,
                      durationMs: nil, usage: nil, model: nil,
                      tool: ChatToolCall(id: "proposal", name: name, state: .completed,
                                        input: .object(["plan": .string("# Plan\n\nImplement and verify. 中文计划")]),
                                        createdAt: 0, result: .null), children: [], meta: nil)
    }

    private func measuredSize<V: View>(
        _ view: V, width: CGFloat = 320, size: DynamicTypeSize = .large
    ) -> CGSize {
        UIHostingController(rootView: view.hapiTypography().environment(\.dynamicTypeSize, size))
            .sizeThatFits(in: CGSize(width: width, height: CGFloat.greatestFiniteMagnitude))
    }

    private func height<V: View>(_ view: V, size: DynamicTypeSize = .large) -> CGFloat {
        measuredSize(view, size: size).height
    }

    func testActionsUseOneCompactRowAndStackWithoutClippingWhenNeeded() throws {
        let driver = try Driver()
        let actions = CodexPlanActionsView(planId: "proposal", interactions: driver.interactor)
            .environment(\.locale, Locale(identifier: "en"))
        for theme in [HapiTheme.light, .dark, .oled] {
            for width: CGFloat in [320, 390, 720] {
                let measured = measuredSize(actions.hapiTheme(theme), width: width)
                XCTAssertEqual(measured.height, 44 + 24, accuracy: 1,
                               "One 44 pt row plus the card inset, without system button padding")
                XCTAssertLessThanOrEqual(measured.width, width)
            }
            let narrow = measuredSize(actions.hapiTheme(theme), width: 220)
            XCTAssertEqual(narrow.height, 2 * 44 + 8 + 24, accuracy: 1,
                           "Two full-width targets with an 8 pt gap")
            XCTAssertLessThanOrEqual(narrow.width, 220)
            let accessible = measuredSize(actions.hapiTheme(theme), size: .accessibility3)
            XCTAssertGreaterThan(accessible.height, narrow.height,
                                 "Large labels wrap and grow instead of truncating")
            XCTAssertLessThanOrEqual(accessible.width, 320)
            XCTAssertEqual(measuredSize(actions.hapiTheme(theme).disabled(true)).height,
                           measuredSize(actions.hapiTheme(theme)).height,
                           "Disabled styling must not shift the layout")
        }
    }

    func testCompletedProposalsHaveClientActionsWithoutInventingPermissions() throws {
        let driver = try Driver()
        for name in ["ExitPlanMode", "exit_plan_mode"] {
            let block = block(name)
            let readOnly = height(ToolCallBlockView(block: block, basePath: nil))
            let actionable = height(ToolCallBlockView(block: block, basePath: nil)
                .environment(\.chatInteractions, driver.interactor))
            XCTAssertGreaterThan(actionable, readOnly + 44, "A compact row of separate 44 pt action targets")
            let large = height(ToolCallBlockView(block: block, basePath: nil)
                .environment(\.chatInteractions, driver.interactor), size: .accessibility3)
            XCTAssertGreaterThan(large, actionable)
            XCTAssertNil(block.tool.permission)
            // Inspectors remain read-only, even with live interactions nearby.
            XCTAssertEqual(height(ToolCallBody(tool: block.tool, basePath: nil)),
                           height(ToolCallBody(tool: block.tool, basePath: nil)
                            .environment(\.chatInteractions, driver.interactor)), accuracy: 1)
        }
    }

    private struct MeasuredCard: View {
        let driver: Driver
        let block: ToolCallBlock

        var body: some View {
            ToolCallBlockView(block: block, basePath: nil)
                .environment(\.chatInteractions, driver.interactor)
                .background(GeometryReader { geometry in
                    Color.clear
                        .onAppear { driver.height = geometry.size.height }
                        .onChange(of: geometry.size.height) { _, height in driver.height = height }
                })
        }
    }

    func testLiveStateAloneWithdrawsAndRestoresActionsWithoutChangingTheTool() async throws {
        let driver = try Driver()
        let window = try host(ScrollView { MeasuredCard(driver: driver, block: block()) }.hapiTypography())
        defer { window.isHidden = true }
        try await settle { driver.height > 100 }
        let actionable = driver.height
        driver.publish(nil, version: 2)
        try await settle { driver.height < actionable - 44 }
        let readOnly = driver.height
        driver.publish("proposal", version: 1)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(driver.height, readOnly, accuracy: 1, "Stale SSE cannot restore the menu")
        driver.publish("proposal", version: 3)
        try await settle { abs(driver.height - actionable) < 1 }
        driver.publish("child-plan", version: 4)
        try await settle { abs(driver.height - readOnly) < 1 }
    }

    func testContinuePlanningFocusesTheRealComposerWithoutReplacingItsText() async throws {
        let driver = try Driver()
        driver.interactor.setComposerText("Refine step two")
        let window = try host(ChatComposerView(interactor: driver.interactor).hapiTypography())
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertFalse(hasFirstResponder(window))
        driver.interactor.continueCodexPlan(planId: "proposal")
        try await settle { self.hasFirstResponder(window) }
        XCTAssertEqual(driver.interactor.composerText, "Refine step two")
    }

    func testActionCardSpecimensInLightDarkOLEDAndLargeType() async throws {
        let cases: [(String, HapiTheme, DynamicTypeSize, CGFloat)] = [
            ("light", .light, .large, 390), ("dark", .dark, .large, 390),
            ("oled", .oled, .large, 390), ("narrow", .light, .large, 252),
            ("large-type", .dark, .accessibility3, 390),
        ]
        for (name, theme, size, width) in cases {
            let driver = try Driver()
            let view = NavigationStack {
                ScrollView {
                    MeasuredCard(driver: driver, block: block())
                        .hapiReadingColumn()
                        .padding(.vertical, 16)
                }
                .background(theme.background)
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    ChatComposerView(interactor: driver.interactor)
                }
                .navigationTitle("Plan proposal")
                .navigationBarTitleDisplayMode(.inline)
            }
            .hapiTypography().hapiTheme(theme)
            .environment(\.dynamicTypeSize, size)
            .environment(\.locale, Locale(identifier: "en"))
            .preferredColorScheme(theme.isDark ? .dark : .light)
            let window = try host(view, width: width)
            defer { window.isHidden = true }
            try await settle { driver.height > 100 }
            try await Task.sleep(for: .milliseconds(150))
            guard let directory = ProcessInfo.processInfo.environment["HAPI_TOOL_CAPTURE"] else { continue }
            let url = URL(fileURLWithPath: directory, isDirectory: true)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            try XCTUnwrap(image.pngData()).write(to: url.appendingPathComponent("plan-actions-\(name).png"))
        }
    }

    private func host<V: View>(_ view: V, width: CGFloat = 390) throws -> UIWindow {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: width, height: 844)
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        return window
    }

    private func hasFirstResponder(_ view: UIView) -> Bool {
        view.isFirstResponder || view.subviews.contains { hasFirstResponder($0) }
    }

    private func settle(_ condition: () -> Bool) async throws {
        for _ in 0..<100 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("Plan presentation did not settle")
    }
}
