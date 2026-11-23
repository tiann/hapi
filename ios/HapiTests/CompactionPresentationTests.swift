import HapiProtocol
import HapiUI
import Observation
import SwiftUI
import UIKit
import XCTest
@testable import Hapi
@testable import HapiProtocol

@MainActor
final class CompactionPresentationTests: XCTestCase {
    private func event(_ summary: String = "", _ facts: [String: Double] = [:]) -> AgentEvent {
        var object: [String: JSONValue] = ["type": .string("compact-summary"), "summary": .string(summary)]
        for (key, value) in facts { object[key] = .number(value) }
        return AgentEvent(object: object)
    }

    private func block(_ event: AgentEvent) -> AgentEventBlock {
        AgentEventBlock(id: "compact", createdAt: 0, invokedAt: nil, event: event, meta: nil)
    }

    func testExactEstimatedZeroAndInvalidCountsUseOnlyAvailableFacts() {
        let cases: [([String: Double], String?)] = [
            (["tokensBefore": 100, "tokensAfter": 40], "100 → 40 tokens"),
            (["tokensBefore": 100, "estimatedTokensAfter": 40], "100 → ~40 tokens (estimated after)"),
            (["tokensBefore": 0], "0 tokens before"),
            (["tokensAfter": 0], "0 tokens after"),
            (["estimatedTokensAfter": 0], "~0 tokens after (estimated)"),
            (["tokensAfter": 2, "estimatedTokensAfter": 99], "2 tokens after"),
            (["tokensAfter": -1, "estimatedTokensAfter": 3], "~3 tokens after (estimated)"),
            (["tokensBefore": -1, "tokensAfter": .infinity, "estimatedTokensAfter": 1.5], nil),
            (["tokensAfter": 9_007_199_254_740_992], nil),
            ([:], nil)
        ]
        for (facts, expected) in cases {
            XCTAssertEqual(compactionPresentation(event("", facts))?.tokenDelta, expected, "\(facts)")
        }
        XCTAssertNil(compactionPresentation(AgentEvent.message("ordinary")))
        XCTAssertFalse(compactionPresentation(event(" \n\t"))!.hasSummary)
    }

    @Observable fileprivate final class Model {
        var block: AgentEventBlock
        init(_ block: AgentEventBlock) { self.block = block }
    }

    private struct Harness: View {
        let model: Model
        let store: ChatPresentationState
        var body: some View {
            VStack {
                Text("Real prompt")
                AgentEventBlockView(block: model.block)
                Text("Real answer")
            }
            .environment(\.chatPresentationState, store)
            .hapiTypography()
        }
    }

    private func host(_ model: Model, store: ChatPresentationState) throws -> (UIWindow, UIHostingController<Harness>) {
        let hosting = UIHostingController(rootView: Harness(model: model, store: store))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 320, height: 800)
        window.rootViewController = hosting
        window.makeKeyAndVisible()
        return (window, hosting)
    }

    private func settle(_ hosting: UIHostingController<Harness>) async {
        try? await Task.sleep(for: .milliseconds(250))
        hosting.view.window?.layoutIfNeeded()
        hosting.view.setNeedsLayout()
        hosting.view.layoutIfNeeded()
    }

    private func height(_ hosting: UIHostingController<Harness>) -> CGFloat {
        hosting.sizeThatFits(in: CGSize(width: 320, height: 10_000)).height
    }

    private func attach(_ window: UIWindow, name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testActualEventRowShowsCollapsedThenFullMarkdownAndPreservesExpansionDuringEnrichment() async throws {
        let source = "# Checkpoint\n\n" + String(repeating: "Saved **answer**.\n\n", count: 10)
        let model = Model(block(event(source)))
        let store = ChatPresentationState()
        let (window, hosting) = try host(model, store: store)
        defer { window.isHidden = true }
        await settle(hosting)
        let collapsed = height(hosting)
        attach(window, name: "compaction-summary-collapsed")
        // Drive the production transcript-owned disclosure state. Compare the
        // actual row against the independent complete Markdown renderer.
        store.values[.init(id: "compact", field: "expanded")] = true
        await settle(hosting)
        let markdown = UIHostingController(rootView: CachedMarkdownView(markdown: source).hapiTypography())
        let bodyHeight = markdown.sizeThatFits(in: CGSize(width: 296, height: 10_000)).height
        XCTAssertGreaterThan(bodyHeight, 100)
        XCTAssertEqual(height(hosting), collapsed + 4 + bodyHeight, accuracy: 2)
        attach(window, name: "compaction-summary-expanded")
        let revised = source + "\nLast paragraph."
        model.block = block(event(revised, ["estimatedTokensAfter": 40]))
        await settle(hosting)
        XCTAssertGreaterThan(height(hosting), collapsed + 100, "Late facts must preserve the visible summary")
        store.values[.init(id: "compact", field: "expanded")] = false
        await settle(hosting)
        XCTAssertEqual(height(hosting), collapsed, accuracy: 2)
    }

    func testTokenOnlyReflowsAvailableValuesWithoutExpandingAndNoFactsUseTheOrdinaryStatusRow() async throws {
        let model = Model(block(event("", ["tokensAfter": 0, "estimatedTokensAfter": 99])))
        let store = ChatPresentationState()
        let (window, hosting) = try host(model, store: store)
        defer { window.isHidden = true }
        await settle(hosting)
        let exactZero = height(hosting)
        attach(window, name: "compaction-exact-zero-static")
        model.block = block(event("", ["tokensBefore": 437_396, "estimatedTokensAfter": 18_396]))
        await settle(hosting)
        let both = height(hosting)
        XCTAssertGreaterThan(both, exactZero + 5, "The actual header must render and wrap its available counts")
        attach(window, name: "compaction-estimate-static")
        store.values[.init(id: "compact", field: "expanded")] = true
        await settle(hosting)
        XCTAssertEqual(height(hosting), both, accuracy: 1, "A token-only result has no body to expand")
        model.block = block(event(" \n", ["tokensAfter": -1, "estimatedTokensAfter": 1.5]))
        await settle(hosting)
        let noInfo = height(hosting)
        attach(window, name: "compaction-no-info-status")
        model.block = block(.message("Compaction started"))
        await settle(hosting)
        XCTAssertEqual(height(hosting), noInfo, accuracy: 1)
    }
}
