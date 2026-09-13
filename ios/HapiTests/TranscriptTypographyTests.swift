import Observation
import SwiftUI
import UIKit
import XCTest
@testable import HapiUI

@MainActor
final class TranscriptTypographyTests: XCTestCase {
    struct Row: Identifiable, Equatable {
        let id: String
        let text: String
    }

    @Observable @MainActor
    final class Driver {
        let rows = (0..<80).map {
            Row(id: String($0), text: "Message \($0) · 中英文阅读。" + String(repeating: "Dynamic Type keeps long answers readable. ", count: 3))
        }
        var size = DynamicTypeSize.large
        var weight: LegibilityWeight? = .regular
        var width: CGFloat = 390
        var version = 0
        @ObservationIgnored var layouts: [Int] = []
        @ObservationIgnored var typography: HapiTypography?
    }

    private struct Probe: UIViewRepresentable {
        let driver: Driver
        func makeUIView(context: Context) -> UIView { UIView() }
        func updateUIView(_ view: UIView, context: Context) {
            driver.typography = context.environment.hapiTypography
        }
    }

    private struct TextRow: View {
        let row: Row
        @Environment(\.hapiTypography) private var typography
        var body: some View {
            Text(row.text)
                .font(typography.bodyFont)
                .lineSpacing(typography.bodyLineSpacing)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private struct Harness: View {
        let driver: Driver
        var body: some View {
            AnchoredTranscriptList(items: driver.rows, historyVersion: driver.version, jumpToken: 0,
                                   historyControlID: "history", onViewport: { _ in },
                                   onLayout: { version, _ in driver.layouts.append(version) }) { row in
                AnyView(TextRow(row: row))
            }
            .overlay { Probe(driver: driver).frame(width: 0, height: 0) }
            .frame(width: driver.width, height: 700)
            .hapiTypography()
            .environment(\.dynamicTypeSize, driver.size)
            .environment(\.legibilityWeight, driver.weight)
        }
    }

    private func host(_ driver: Driver) throws -> (UIWindow, UICollectionView) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: Harness(driver: driver))
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.layoutIfNeeded()
        func find(_ view: UIView) -> UICollectionView? {
            if let collection = view as? UICollectionView { return collection }
            return view.subviews.lazy.compactMap(find).first
        }
        return (window, try XCTUnwrap(find(host.view)))
    }

    private func settle(_ condition: () -> Bool = { true }, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<100 {
            try? await Task.sleep(for: .milliseconds(20))
            if condition() {
                try? await Task.sleep(for: .milliseconds(160))
                return
            }
        }
        XCTFail("Typography layout did not settle", file: file, line: line)
    }

    private func browse(_ view: UICollectionView, index: Int) async throws -> UICollectionViewCell {
        view.delegate?.scrollViewWillBeginDragging?(view)
        view.scrollToItem(at: IndexPath(item: index, section: 0), at: .top, animated: false)
        await settle()
        view.contentOffset.y += 31
        view.layoutIfNeeded()
        await settle()
        return try XCTUnwrap(view.cellForItem(at: IndexPath(item: index, section: 0)))
    }

    func testEqualItemsResizeAtLargeTextAndKeepTheHistoryAnchor() async throws {
        let driver = Driver()
        let (window, view) = try host(driver)
        defer { window.isHidden = true }
        await settle { driver.layouts.contains(0) }
        XCTAssertEqual(try XCTUnwrap(driver.typography).bodySize, 16, accuracy: 0.01)
        let farHeight = try await browse(view, index: 60).frame.height
        let cell = try await browse(view, index: 25)
        let oldHeight = cell.frame.height
        let offset = cell.frame.minY - view.contentOffset.y
        driver.size = .xxxLarge
        await settle { (driver.typography?.bodySize ?? 0) > 16 && cell.frame.height > oldHeight }
        XCTAssertEqual(cell.frame.minY - view.contentOffset.y, offset, accuracy: 1)
        let typography = try XCTUnwrap(driver.typography)
        XCTAssertEqual(typography.inlineCodeSize / typography.bodySize, 15 / 16, accuracy: 0.001)
        let recycled = try await browse(view, index: 60)
        XCTAssertGreaterThan(recycled.frame.height, farHeight)
    }

    func testMaximumAccessibilitySizeAndBoldTextPreserveBottomFollowing() async throws {
        let driver = Driver()
        let (window, view) = try host(driver)
        defer { window.isHidden = true }
        await settle { driver.layouts.contains(0) }
        driver.size = .accessibility5
        driver.weight = .bold
        await settle { (driver.typography?.bodySize ?? 0) > 40 && driver.typography?.boldText == true }
        XCTAssertEqual(view.contentOffset.y, view.contentSize.height - view.bounds.height, accuracy: 1)
        let cell = try XCTUnwrap(view.cellForItem(at: IndexPath(item: 79, section: 0)))
        XCTAssertGreaterThan(cell.frame.height, 500)
        driver.size = .large
        await settle { driver.typography?.bodySize == 16 }
        XCTAssertEqual(view.contentOffset.y, view.contentSize.height - view.bounds.height, accuracy: 1)
    }

    func testShrinkingTextClampsAnOffsetBeyondTheNewRowHeight() async throws {
        let driver = Driver()
        driver.size = .accessibility5
        let (window, view) = try host(driver)
        defer { window.isHidden = true }
        await settle { driver.layouts.contains(0) }
        let cell = try await browse(view, index: 25)
        view.contentOffset.y = cell.frame.minY + 400
        view.layoutIfNeeded()
        await settle()
        driver.size = .large
        await settle { driver.typography?.bodySize == 16 }
        let resized = try XCTUnwrap(view.cellForItem(at: IndexPath(item: 25, section: 0)))
        XCTAssertEqual(resized.frame.maxY - view.contentOffset.y, 1, accuracy: 1)
    }

    func testGrowingTextDoesNotClampADeepOffsetToAnUnmeasuredEstimate() async throws {
        let driver = Driver()
        driver.size = .accessibility3
        let (window, view) = try host(driver)
        defer { window.isHidden = true }
        await settle { driver.layouts.contains(0) }
        let cell = try await browse(view, index: 25)
        view.contentOffset.y = cell.frame.minY + 350
        view.layoutIfNeeded()
        await settle()
        let previousSize = try XCTUnwrap(driver.typography).bodySize
        driver.size = .accessibility5
        await settle { (driver.typography?.bodySize ?? 0) > previousSize }
        let grown = try XCTUnwrap(view.cellForItem(at: IndexPath(item: 25, section: 0)))
        XCTAssertEqual(view.contentOffset.y - grown.frame.minY, 350, accuracy: 1)
    }

    func testReadingWidthAndBoldTextChangesKeepHistoryInPlace() async throws {
        let driver = Driver()
        let (window, view) = try host(driver)
        defer { window.isHidden = true }
        await settle { driver.layouts.contains(0) }
        let cell = try await browse(view, index: 25)
        let offset = cell.frame.minY - view.contentOffset.y
        for width: CGFloat in [1024, 768, 507, 320] {
            driver.width = width
            await settle { abs(view.bounds.width - width) < 1 }
            let frame = try XCTUnwrap(view.cellForItem(at: IndexPath(item: 25, section: 0))).frame
            XCTAssertEqual(frame.width, HapiReadingLayout.contentWidth(in: width), accuracy: 1)
            XCTAssertEqual(frame.midX, width / 2, accuracy: 1)
            XCTAssertEqual(frame.minY - view.contentOffset.y, offset, accuracy: 1)
        }
        driver.weight = .bold
        await settle { driver.typography?.boldText == true }
        let frame = try XCTUnwrap(view.cellForItem(at: IndexPath(item: 25, section: 0))).frame
        XCTAssertEqual(frame.minY - view.contentOffset.y, offset, accuracy: 1)
    }
}
