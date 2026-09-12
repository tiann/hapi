import HapiUI
import Observation
import SwiftUI
import UIKit
import XCTest
@testable import Hapi
@testable import HapiProtocol

@MainActor
final class TranscriptLayoutTests: XCTestCase {
    struct Row: Identifiable, Equatable {
        let id: String
        var height: CGFloat
    }

    @MainActor @Observable
    final class Driver {
        var rows: [Row]
        var version = 0
        var inspecting = false
        var jump = 0
        var layouts: [Int] = []
        var viewport: TranscriptViewport?
        let presentation = ChatPresentationState()
        init(_ rows: [Row]) { self.rows = rows }
    }

    private struct Harness: View {
        var driver: Driver
        var body: some View {
            AnchoredTranscriptList(
                items: driver.rows, historyVersion: driver.version, jumpToken: driver.jump,
                historyControlID: "history",
                isInspectionPresented: driver.inspecting,
                onViewport: { driver.viewport = $0 },
                onLayout: { version, _ in driver.layouts.append(version) }
            ) { row in
                AnyView(StatefulRow(row: row).environment(\.chatPresentationState, driver.presentation))
            }
        }
    }

    private struct StatefulRow: View {
        let row: Row
        @ChatStoredState private var expanded: Bool
        init(row: Row) {
            self.row = row
            _expanded = ChatStoredState(wrappedValue: false, id: row.id, field: "expanded")
        }
        var body: some View {
            Text(row.id).frame(maxWidth: .infinity).frame(height: row.height + (expanded ? 90 : 0))
        }
    }

    private func rows(_ range: Range<Int>) -> [Row] {
        range.map { Row(id: "message-\($0)", height: CGFloat(65 + ($0 % 5) * 29)) }
    }

    private func host(_ driver: Driver) -> (UIWindow, UICollectionView) {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first!
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        let host = UIHostingController(rootView: Harness(driver: driver))
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        func find(_ view: UIView) -> UICollectionView? {
            if let collection = view as? UICollectionView { return collection }
            return view.subviews.lazy.compactMap(find).first
        }
        return (window, find(host.view)!)
    }

    private func settle(_ condition: () -> Bool = { true }) async {
        for _ in 0..<100 {
            try? await Task.sleep(for: .milliseconds(20))
            if condition() {
                try? await Task.sleep(for: .milliseconds(80))
                return
            }
        }
        XCTFail("Transcript did not finish layout")
    }

    private func browse(_ view: UICollectionView, index: Int, inset: CGFloat = 31) async {
        view.delegate?.scrollViewWillBeginDragging?(view)
        view.scrollToItem(at: IndexPath(item: index, section: 0), at: .top, animated: false)
        view.contentOffset.y += inset
        view.layoutIfNeeded()
        view.delegate?.scrollViewDidEndDragging?(view, willDecelerate: false)
        await settle()
        view.layoutIfNeeded()
    }

    private func readingAnchor(_ view: UICollectionView) -> (id: String, y: CGFloat)? {
        view.visibleCells
            .filter { $0.frame.maxY > view.contentOffset.y && $0.frame.minY < view.contentOffset.y + view.bounds.height && $0.accessibilityIdentifier != "chat-row-history" }
            .sorted { $0.frame.minY < $1.frame.minY }
            .first.map { ($0.accessibilityIdentifier!, $0.frame.minY - view.contentOffset.y) }
    }

    private func anchorY(_ id: String, in view: UICollectionView) -> CGFloat? {
        view.visibleCells.first { $0.accessibilityIdentifier == id }.map { $0.frame.minY - view.contentOffset.y }
    }

    private func diagnostic(_ driver: Driver, _ view: UICollectionView) -> String {
        let cells = view.visibleCells.map { ($0.accessibilityIdentifier ?? "?") + ":" + String(describing: $0.frame.minY - view.contentOffset.y) }
        return "offset=\(view.contentOffset.y) height=\(view.contentSize.height) follows=\(String(describing: driver.viewport?.followsTail)) cells=\(cells)"
    }

    func testInspectorPausesTailAndPreservesAnchorUntilExplicitJump() async throws {
        let driver = Driver(rows(0..<50))
        let (window, view) = host(driver)
        defer { window.isHidden = true }
        await settle { driver.layouts.contains(0) }
        XCTAssertEqual(driver.viewport?.followsTail, true)
        let anchor = try XCTUnwrap(readingAnchor(view))
        driver.inspecting = true
        await settle { driver.viewport?.followsTail == false }
        XCTAssertEqual(driver.viewport?.needsOlder, false)
        driver.rows.append(contentsOf: rows(50..<65))
        driver.version += 1
        await settle { driver.layouts.contains(1) }
        XCTAssertEqual(try XCTUnwrap(anchorY(anchor.id, in: view)), anchor.y, accuracy: 1)
        driver.inspecting = false
        await settle()
        XCTAssertEqual(try XCTUnwrap(anchorY(anchor.id, in: view)), anchor.y, accuracy: 1)
        XCTAssertEqual(driver.viewport?.followsTail, false)
        driver.jump += 1
        await settle { driver.viewport?.followsTail == true }
        XCTAssertEqual(driver.viewport?.isAtBottom, true)
    }

    func testInspectorPausesShortTranscriptHistoryDemand() async {
        let driver = Driver(rows(0..<1))
        let (window, _) = host(driver)
        defer { window.isHidden = true }
        await settle { driver.layouts.contains(0) }
        XCTAssertEqual(driver.viewport?.needsOlder, true)
        driver.inspecting = true
        await settle { driver.viewport?.needsOlder == false }
        driver.inspecting = false
        await settle { driver.viewport?.needsOlder == true }
    }

    func testPrependKeepsTheCurrentPartialRowNotTheRequestStartRow() async throws {
        let driver = Driver(rows(100..<180))
        let (window, view) = host(driver)
        defer { window.isHidden = true }
        await settle { driver.layouts.contains(0) }
        await browse(view, index: 12)
        // The reader moves again while the hypothetical HTTP request waits.
        await browse(view, index: 17, inset: 47)
        let anchor = try XCTUnwrap(readingAnchor(view))
        XCTAssertLessThanOrEqual(anchor.y, 0)
        driver.rows = rows(80..<100) + Array(driver.rows.dropLast(20))
        driver.version = 1
        await settle { driver.layouts.contains(1) }
        XCTAssertEqual(try XCTUnwrap(anchorY(anchor.id, in: view), "anchor=\(anchor); \(diagnostic(driver, view))"), anchor.y, accuracy: 1)
        XCTAssertEqual(driver.viewport?.followsTail, false)
    }

    func testStreamingTailAndRowResizeDoNotMoveHistoryAnchor() async throws {
        let driver = Driver(rows(0..<80))
        let (window, view) = host(driver)
        defer { window.isHidden = true }
        await settle { driver.layouts.contains(0) }
        await browse(view, index: 25)
        let anchor = try XCTUnwrap(readingAnchor(view))
        driver.rows[79].height += 400
        await settle()
        XCTAssertEqual(try XCTUnwrap(anchorY(anchor.id, in: view), "anchor=\(anchor); \(diagnostic(driver, view))"), anchor.y, accuracy: 1)
        let id = anchor.id.replacingOccurrences(of: "chat-row-", with: "")
        let index = try XCTUnwrap(driver.rows.firstIndex { $0.id == id })
        driver.rows[index].height += 160
        await settle()
        XCTAssertEqual(try XCTUnwrap(anchorY(anchor.id, in: view)), anchor.y, accuracy: 1)
        let resized = try XCTUnwrap(view.visibleCells.first { $0.accessibilityIdentifier == anchor.id })
        XCTAssertEqual(resized.frame.height, driver.rows[index].height, accuracy: 1)
    }

    func testTailFollowsSelfSizingAndViewportResize() async throws {
        let driver = Driver(rows(0..<30))
        let (window, view) = host(driver)
        defer { window.isHidden = true }
        await settle { driver.layouts.contains(0) }
        let id = "chat-row-message-29"
        XCTAssertEqual(try XCTUnwrap(view.visibleCells.first { $0.accessibilityIdentifier == id }).frame.height,
                       driver.rows[29].height, accuracy: 1)
        driver.rows[29].height += 250
        await settle()
        XCTAssertEqual(view.contentOffset.y, view.contentSize.height - view.bounds.height, accuracy: 1)
        window.frame.size.height -= 250 // composer / keyboard changes viewport
        window.layoutIfNeeded()
        await settle()
        XCTAssertEqual(view.contentOffset.y, view.contentSize.height - view.bounds.height, accuracy: 1)
        XCTAssertEqual(driver.viewport?.followsTail, true)
    }

    func testShortAndHiddenOnlyPagesStillAcknowledgeLayout() async {
        let driver = Driver([Row(id: "history", height: 44), Row(id: "message", height: 55)])
        let (window, _) = host(driver)
        defer { window.isHidden = true }
        await settle { driver.layouts.contains(0) }
        XCTAssertEqual(driver.viewport?.needsOlder, true)
        driver.version = 1 // hidden-only page; no new views or resize signal
        await settle { driver.layouts.contains(1) }
        XCTAssertEqual(driver.viewport?.needsOlder, true)
    }

    func testRepeatedRowIDsAreCoalescedBeforeEverySnapshotConsumer() async throws {
        let id = "tool-group:exec-3a551efc-3d25-4093-831e-f7fd43482fae"
        let driver = Driver([Row(id: id, height: 65), Row(id: id, height: 115)] + rows(0..<40))
        let (window, view) = host(driver)
        defer { window.isHidden = true }
        await settle { driver.layouts.contains(0) }
        XCTAssertEqual(view.numberOfItems(inSection: 0), 41)
        await browse(view, index: 0, inset: 17)
        let anchor = try XCTUnwrap(readingAnchor(view))
        XCTAssertEqual(anchor.id, "chat-row-" + id)
        let cell = try XCTUnwrap(view.visibleCells.first { $0.accessibilityIdentifier == anchor.id })
        XCTAssertEqual(cell.frame.height, 115, accuracy: 1)
        driver.rows = [Row(id: "older", height: 80)] + driver.rows + [Row(id: id, height: 135)]
        driver.version = 1
        await settle { driver.layouts.contains(1) }
        XCTAssertEqual(view.numberOfItems(inSection: 0), 42)
        XCTAssertEqual(try XCTUnwrap(anchorY(anchor.id, in: view)), anchor.y, accuracy: 1)
        let updated = try XCTUnwrap(view.visibleCells.first { $0.accessibilityIdentifier == anchor.id })
        XCTAssertEqual(updated.frame.height, 135, accuracy: 1)
    }

    func testRegroupedHistoryRetainsBothGroupsAndTheExistingReadingAnchor() async throws {
        func tool(_ id: String) -> ChatBlock {
            .toolCall(ToolCallBlock(
                id: id, localId: nil, createdAt: 0, invokedAt: nil, durationMs: nil, usage: nil, model: nil,
                tool: ChatToolCall(id: id, name: "Read", state: .completed, createdAt: 0), children: [], meta: nil
            ))
        }
        func group(_ blocks: [ChatBlock], previous: [VisibleChatBlock] = [], more: Bool = false) -> [VisibleChatBlock] {
            let oldGroups = previous.compactMap { if case .toolGroup(let group) = $0 { group } else { nil as ToolGroupBlock? } }
            return buildVisibleChatBlocks(blocks, options: .init(hasMoreMessages: more, previousGroups: oldGroups))
        }
        func displayRows(_ blocks: [VisibleChatBlock]) -> [Row] {
            blocks.map { Row(id: $0.stableId, height: 100) }
        }
        let original = group(["c", "d", "e"].map(tool))
        let trimmed = group([tool("d"), tool("e")], previous: original)
        let tail = rows(0..<40)
        let driver = Driver(displayRows(trimmed) + tail)
        let (window, view) = host(driver)
        defer { window.isHidden = true }
        await settle { driver.layouts.contains(0) }
        await browse(view, index: 0, inset: 23)
        let anchor = try XCTUnwrap(readingAnchor(view))
        let separator = ChatBlock.agentText(AgentTextBlock(
            id: "separator", localId: nil, createdAt: 0, invokedAt: nil,
            durationMs: nil, usage: nil, model: nil, text: "Between groups", meta: nil
        ))
        let prepended = group([tool("a"), tool("b"), tool("c"), separator, tool("d"), tool("e")], previous: trimmed, more: true)
        driver.rows = displayRows(prepended) + tail
        driver.version = 1
        await settle { driver.layouts.contains(1) }
        // Two distinct groups plus their separator; no duplicate-key crash
        // and no silently dropped group in the collection's fallback path.
        XCTAssertEqual(view.numberOfItems(inSection: 0), 43)
        XCTAssertEqual(try XCTUnwrap(anchorY(anchor.id, in: view)), anchor.y, accuracy: 1)
    }

    func testRecycledPresentationStateIsKeyedAndPruned() {
        let state = ChatPresentationState()
        let key = ChatPresentationState.Key(id: "tool-a", field: "expanded")
        state.values[key] = true
        state.values[.init(id: "tool-b", field: "answer")] = "unsent"
        state.prune(to: ["tool-b"])
        XCTAssertNil(state.values[key])
        XCTAssertEqual(state.values[.init(id: "tool-b", field: "answer")] as? String, "unsent")
    }

    func testHostedCellKeepsExpansionAcrossRecycling() async throws {
        let driver = Driver(rows(0..<80))
        let (window, view) = host(driver)
        defer { window.isHidden = true }
        await settle { driver.layouts.contains(0) }
        await browse(view, index: 15, inset: 0)
        let anchor = try XCTUnwrap(readingAnchor(view))
        let id = anchor.id.replacingOccurrences(of: "chat-row-", with: "")
        let index = try XCTUnwrap(driver.rows.firstIndex { $0.id == id })
        driver.presentation.values[.init(id: id, field: "expanded")] = true
        await settle()
        XCTAssertEqual(try XCTUnwrap(anchorY(anchor.id, in: view)), anchor.y, accuracy: 1)
        for destination in [55, 35, 65, 45] {
            await browse(view, index: destination)
            XCTAssertLessThan(view.visibleCells.count, 25, diagnostic(driver, view))
        }
        // UIKit may cache offscreen hosting cells. Force their destruction so
        // this test proves restoration, not merely reuse of a surviving view.
        view.reloadData()
        view.layoutIfNeeded()
        await settle()
        XCTAssertNil(anchorY(anchor.id, in: view), diagnostic(driver, view))
        await browse(view, index: index, inset: 0)
        let cell = try XCTUnwrap(view.visibleCells.first { $0.accessibilityIdentifier == anchor.id })
        XCTAssertEqual(cell.frame.height, driver.rows[index].height + 90, accuracy: 1)
    }
}
