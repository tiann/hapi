import Observation
import SwiftUI
import UIKit
import XCTest
@testable import HapiUI

@MainActor
final class TranscriptRefreshTests: XCTestCase {
    struct Row: Identifiable, Equatable {
        let id: String
        var height: CGFloat = 120
    }

    struct Sample: Equatable {
        let basePath: String
        let dark: Bool
        let size: DynamicTypeSize
        let locale: String
        let direction: LayoutDirection
    }

    @Observable @MainActor
    final class Driver {
        var rows = (0..<80).map { Row(id: String($0)) }
        var version = 0
        var basePath = "/before"
        var dark = false
        var size = DynamicTypeSize.large
        var locale = Locale(identifier: "en")
        var direction = LayoutDirection.leftToRight
        var actionToken = 0
        @ObservationIgnored var lastAction = -1
        @ObservationIgnored var layouts: [Int] = []
        @ObservationIgnored var samples: [String: Sample] = [:]
        @ObservationIgnored var actions: [String: HapiOpenURLAction] = [:]
    }

    private struct Harness: View {
        let driver: Driver
        var body: some View {
            let token = driver.actionToken
            ListView(driver: driver)
                .hapiTheme(driver.dark ? .dark : .light)
                .environment(\.dynamicTypeSize, driver.size)
                .environment(\.locale, driver.locale)
                .environment(\.layoutDirection, driver.direction)
                .environment(\.hapiOpenURL, HapiOpenURLAction { _ in
                    Task { @MainActor in driver.lastAction = token }
                })
        }
    }

    private struct ListView: View {
        let driver: Driver
        var body: some View {
            // An ordinary value capture, not a live observable read in a row.
            let basePath = driver.basePath
            AnchoredTranscriptList(
                items: driver.rows, historyVersion: driver.version, jumpToken: 0,
                historyControlID: "history", onViewport: { _ in },
                onLayout: { version, _ in driver.layouts.append(version) }
            ) { row in
                AnyView(ProbeRow(row: row, basePath: basePath, driver: driver))
            }
        }
    }

    private struct ProbeRow: View {
        let row: Row
        let basePath: String
        let driver: Driver
        @Environment(\.dynamicTypeSize) private var size
        var body: some View {
            Text(row.id)
                .frame(maxWidth: .infinity)
                .frame(height: row.height + (size.isAccessibilitySize ? 60 : 0))
                .background(Probe(id: row.id, basePath: basePath, driver: driver))
        }
    }

    private struct Probe: UIViewRepresentable {
        let id: String
        let basePath: String
        let driver: Driver
        func makeUIView(context: Context) -> UIView { UIView() }
        func updateUIView(_ view: UIView, context: Context) {
            let environment = context.environment
            driver.samples[id] = Sample(basePath: basePath, dark: environment.hapiTheme.isDark,
                                        size: environment.dynamicTypeSize, locale: environment.locale.identifier,
                                        direction: environment.layoutDirection)
            driver.actions[id] = environment.hapiOpenURL
        }
    }

    private func host(_ driver: Driver) throws -> (UIWindow, TranscriptCollectionController<Row>, UICollectionView) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: Harness(driver: driver))
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.layoutIfNeeded()
        func find(_ controller: UIViewController) -> TranscriptCollectionController<Row>? {
            if let result = controller as? TranscriptCollectionController<Row> { return result }
            return controller.children.lazy.compactMap(find).first
        }
        let controller = try XCTUnwrap(find(host))
        return (window, controller, try XCTUnwrap(controller.view as? UICollectionView))
    }

    private func settle(_ condition: () -> Bool = { true }, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<100 {
            try? await Task.sleep(for: .milliseconds(20))
            if condition() {
                try? await Task.sleep(for: .milliseconds(100))
                return
            }
        }
        XCTFail("Transcript did not settle", file: file, line: line)
    }

    private func browse(_ view: UICollectionView, index: Int) async {
        view.delegate?.scrollViewWillBeginDragging?(view)
        view.scrollToItem(at: IndexPath(item: index, section: 0), at: .top, animated: false)
        await settle()
    }

    func testOffscreenUpdatesKeepVisibleHostingConfigurationsAndStillResizeChangedRows() async throws {
        let driver = Driver()
        let (window, controller, view) = try host(driver)
        defer { window.isHidden = true }
        await settle { driver.layouts.contains(0) }
        await browse(view, index: 25)
        let cell = try XCTUnwrap(view.cellForItem(at: IndexPath(item: 25, section: 0)))
        let offset = cell.frame.minY - view.contentOffset.y
        #if DEBUG
        let configurations = controller.cellConfigurationCount
        #endif
        for version in 1...3 {
            driver.rows[79].height += 20
            driver.version = version
            await settle { driver.layouts.contains(version) }
        }
        #if DEBUG
        XCTAssertEqual(controller.cellConfigurationCount, configurations,
                       "Offscreen streaming must not reinstall unchanged visible hosting roots")
        #endif
        XCTAssertEqual(cell.frame.minY - view.contentOffset.y, offset, accuracy: 1)
        driver.rows[25].height += 70
        await settle { abs(cell.frame.height - 190) < 1 }
        XCTAssertEqual(cell.frame.minY - view.contentOffset.y, offset, accuracy: 1)
        await browse(view, index: 79)
        let tail = try XCTUnwrap(view.cellForItem(at: IndexPath(item: 79, section: 0)))
        XCTAssertEqual(tail.frame.height, 180, accuracy: 1, "Recycled cells must use the latest offscreen value")
    }

    func testEqualItemsReceiveLatestEnvironmentValueCapturesAndActions() async throws {
        let driver = Driver()
        let (window, controller, view) = try host(driver)
        defer { window.isHidden = true }
        await settle { driver.layouts.contains(0) }
        await browse(view, index: 25)
        #if DEBUG
        let configurations = controller.cellConfigurationCount
        #endif
        driver.basePath = "/after"
        driver.dark = true
        driver.actionToken = 1
        let expected = Sample(basePath: "/after", dark: true, size: .large, locale: "en", direction: .leftToRight)
        await settle { driver.samples["25"] == expected }
        XCTAssertEqual(driver.samples["25"], expected)
        #if DEBUG
        XCTAssertEqual(controller.cellConfigurationCount, configurations)
        #endif
        try XCTUnwrap(driver.actions["25"])(URL(string: "hapi-file://?path=test")!)
        await settle { driver.lastAction == 1 }
        // UIKit may itself request cells again when layout-direction traits
        // change; only ordinary data/context updates have a zero-config budget.
        driver.locale = Locale(identifier: "ar")
        driver.direction = .rightToLeft
        driver.size = .accessibility2
        let recycled = Sample(basePath: "/after", dark: true, size: .accessibility2, locale: "ar", direction: .rightToLeft)
        await settle { driver.samples["25"] == recycled }
        let cell = try XCTUnwrap(view.cellForItem(at: IndexPath(item: 25, section: 0)))
        XCTAssertEqual(cell.frame.height, 180, accuracy: 1, "Environment-only changes must still self-size")
        await browse(view, index: 60)
        XCTAssertEqual(driver.samples["60"], recycled)
    }
}
