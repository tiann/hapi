import HapiProtocol
import HapiUI
import Observation
import SwiftUI
import UIKit
import XCTest
@testable import Hapi

/// Render the production row, without pairing, network, or UI test hooks in
/// the app. Pixel bounds pin the actual unread dot, not just its container.
@MainActor
final class SessionRowPresentationTests: XCTestCase {
    private static let now = Date(timeIntervalSince1970: 1_800_000_000)

    @MainActor @Observable
    fileprivate final class Driver {
        var summary = HomeFilterTestData.summary("row", machine: nil)
        var unread = true
        var typeSize = DynamicTypeSize.large
        @ObservationIgnored var height: CGFloat = 0
        @ObservationIgnored var appearances = 0

        var row: SessionRowUI {
            SessionRowUI(summary: summary, title: summary.metadata?.name ?? "Session",
                         project: SessionListModel.projectLabel(summary),
                         flavor: "codex", unread: unread)
        }
    }

    private struct Harness: View {
        let driver: Driver
        var theme: HapiTheme = .light
        var locale = Locale(identifier: "en")

        var body: some View {
            VStack(spacing: 0) {
                SessionRowView(row: driver.row, now: SessionRowPresentationTests.now)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(GeometryReader { geometry in
                        Color.clear
                            .onAppear { driver.height = geometry.size.height; driver.appearances += 1 }
                            .onChange(of: geometry.size.height) { _, height in driver.height = height }
                    })
                Spacer(minLength: 0)
            }
            .background(theme.background)
            .hapiTheme(theme)
            .environment(\.locale, locale)
            .environment(\.dynamicTypeSize, driver.typeSize)
            .preferredColorScheme(theme.isDark ? .dark : .light)
            .ignoresSafeArea()
        }
    }

    func testUnreadDotHasOneColumnAcrossTitlesAgesAndStates() async throws {
        for width in [CGFloat(320), 390] {
            let driver = Driver()
            let window = try makeWindow(Harness(driver: driver), width: width)
            defer { window.isHidden = true }
            var firstCenter: CGPoint?
            let cases: [(String, Int, Int, Bool)] = [
                ("Short", 0, 0, false),
                ("很长的中文标题用于验证未读圆点不会随着标题移动", 59 * 60_000, 1, true),
                ("A very long English title that must truncate before the time", 330 * 86_400_000, 7, true),
                ("Running", 2 * 3_600_000, 0, true),
            ]
            for (title, age, pending, thinking) in cases {
                driver.summary.metadata?.name = title
                driver.summary.updatedAt = Int(Self.now.timeIntervalSince1970 * 1_000) - age
                driver.summary.pendingRequestsCount = pending
                driver.summary.pendingRequestKinds = [.input]
                driver.summary.thinking = thinking
                try await settle()
                let dot = try XCTUnwrap(colorBounds(render(window)))
                XCTAssertEqual(dot.midX, width - 16 - 6, accuracy: 0.6)
                XCTAssertEqual(dot.width, 8, accuracy: 2)
                if let firstCenter {
                    XCTAssertEqual(dot.midX, firstCenter.x, accuracy: 0.1)
                    XCTAssertEqual(dot.midY, firstCenter.y, accuracy: 0.1)
                } else {
                    firstCenter = CGPoint(x: dot.midX, y: dot.midY)
                }
            }
            let height = driver.height
            let scale: CGFloat = 3
            // The final case has a short title; isolate the trailing region
            // so antialiased title pixels cannot be mistaken for the time.
            let timeBand = CGRect(x: (width - 100) * scale, y: 0, width: 100 * scale, height: (height - 12 - 16 - 4) * scale)
            let unreadTime = try XCTUnwrap(colorBounds(render(window, scale: scale), matching: (82, 85, 94), within: timeBand))
            driver.unread = false
            try await settle()
            XCTAssertNil(try colorBounds(render(window)), "Read rows have no unread dot")
            let readTime = try XCTUnwrap(colorBounds(render(window, scale: scale), matching: (82, 85, 94), within: timeBand))
            XCTAssertEqual(readTime.maxX / scale, width - 16, accuracy: 2, "Without a dot, the timestamp aligns to the right margin")
            XCTAssertEqual((readTime.minX - unreadTime.minX) / scale, 18, accuracy: 1, "Remove both the 12pt dot slot and its 6pt gap")
            XCTAssertEqual(driver.height, height, accuracy: 0.1)
            XCTAssertEqual(driver.appearances, 1, "State updates must not rebuild the row")
        }
    }

    func testRowsStayTwoLinesAndOmitPreviewsAndProgress() async throws {
        let driver = Driver()
        driver.summary.updatedAt = Int(Self.now.timeIntervalSince1970 * 1_000)
        let window = try makeWindow(Harness(driver: driver), width: 390)
        defer { window.isHidden = true }
        try await settle()
        let restingHeight = driver.height
        XCTAssertGreaterThanOrEqual(restingHeight, 60)
        XCTAssertLessThanOrEqual(restingHeight, 70, "The normal row contains only title and project/status")
        driver.summary.pendingRequestsCount = 7
        driver.summary.pendingRequestKinds = [.input, .permission]
        driver.summary.todoProgress = .init(completed: 3, total: 5)
        try await settle()
        XCTAssertEqual(driver.height, restingHeight, accuracy: 1)
        // Source progress and summary changes must have no visible effect.
        let before = render(window).pngData()
        driver.summary.todoProgress = .init(completed: 50, total: 100)
        driver.summary.metadata?.summary = .init(text: "A long summary that should not appear in the home list")
        try await settle()
        XCTAssertEqual(render(window).pngData(), before)
        driver.summary.active = false
        try await settle()
        XCTAssertNotNil(try colorBounds(render(window)), "Disconnecting must not dim the unread accent")
        driver.summary.pendingRequestsCount = 0
        try await settle()
        XCTAssertEqual(driver.height, restingHeight, accuracy: 1)

        driver.typeSize = .accessibility3
        driver.summary.pendingRequestsCount = 123
        try await settle()
        XCTAssertGreaterThan(driver.height, restingHeight + 40, "Large text must grow naturally rather than shrink")
        XCTAssertLessThan(driver.height, window.bounds.height)
        let scaledImage = render(window, scale: 3)
        XCTAssertNotNil(try colorBounds(scaledImage, matching: (154, 103, 0)), "Disconnected attention remains visible at large text sizes")
        XCTAssertEqual(driver.appearances, 1)
    }

    func testStatusIsACompactTrailingSymbolWithoutCrowdingTheProject() async throws {
        let cases: [(HapiTheme, CGFloat, String, [PendingRequestKind])] = [
            (.light, 320, "en", [.input]),
            (.light, 390, "zh-Hans", [.permission]),
            (.dark, 320, "en", [.input, .permission]),
            (.oled, 390, "zh-Hans", [.input]),
        ]
        for (theme, width, locale, kinds) in cases {
            let driver = Driver()
            driver.summary.pendingRequestsCount = 2
            driver.summary.pendingRequestKinds = kinds
            driver.summary.metadata?.path = "/workspace/a-very-long-project-name-that-must-truncate-before-the-status"
            let window = try makeWindow(Harness(driver: driver, theme: theme, locale: Locale(identifier: locale)), width: width)
            defer { window.isHidden = true }
            try await settle()
            let scale: CGFloat = 3
            let amber = theme.isDark ? (210, 153, 34) : (154, 103, 0)
            let secondary = theme.isDark ? (168, 173, 184) : (82, 85, 94)
            let accent = theme.isDark ? (108, 158, 255) : (59, 130, 246)
            let snapshot = render(window, scale: scale)
            let status = try XCTUnwrap(colorBounds(snapshot, matching: amber))
            let dot = try XCTUnwrap(colorBounds(snapshot, matching: accent))
            XCTAssertEqual(status.midX / scale, width - 16 - 8, accuracy: 2, "Status symbols share one trailing slot")
            XCTAssertLessThanOrEqual(status.width / scale, 18, "No visible status text or badge")
            XCTAssertLessThanOrEqual(status.height / scale, 18)
            XCTAssertGreaterThan(status.minY, dot.maxY, "Attention belongs to the second line, not the title")
            let detailBand = CGRect(x: 0, y: (driver.height - 12 - 16) * scale, width: width * scale, height: 16 * scale)
            let project = try XCTUnwrap(colorBounds(snapshot, matching: secondary, within: detailBand))
            XCTAssertEqual(project.minX / scale, 40, accuracy: 3)
            XCTAssertLessThanOrEqual(project.maxX / scale + 12, status.minX / scale, "Project and status cannot overlap")

            driver.summary.metadata?.path = ""
            try await settle()
            let statusWithoutProject = try XCTUnwrap(colorBounds(render(window, scale: scale), matching: amber))
            assertSameSymbolBounds(statusWithoutProject, status)

            driver.typeSize = .accessibility3
            try await settle()
            let largeStatus = try XCTUnwrap(colorBounds(render(window, scale: scale), matching: amber))
            XCTAssertGreaterThan(largeStatus.height, status.height, "Symbols scale with Dynamic Type")
            XCTAssertLessThanOrEqual(largeStatus.maxX / scale, width - 14)
            driver.summary.metadata?.path = "/workspace/another-very-long-project-name"
            try await settle()
            let largeStatusWithProject = try XCTUnwrap(colorBounds(render(window, scale: scale), matching: amber))
            assertSameSymbolBounds(largeStatusWithProject, largeStatus)

            driver.typeSize = .large
            driver.summary.metadata?.path = ""
            driver.summary.pendingRequestsCount = 0
            driver.summary.thinking = true
            try await settle()
            let runningImage = render(window, scale: scale)
            XCTAssertNil(try colorBounds(runningImage, matching: amber), "Routine activity stays neutral")
            let spinner = try XCTUnwrap(findActivityIndicator(window), "Running reuses native loading, not a static symbol")
            XCTAssertTrue(spinner.isAnimating)
            let running = spinner.convert(spinner.bounds, to: window)
            XCTAssertEqual(running.midX, width - 16 - 8, accuracy: 1)
            XCTAssertGreaterThan(running.minY, dot.maxY / scale, "Loading stays in the second line")
            XCTAssertEqual(running.width, 14, accuracy: 1)
            XCTAssertEqual(running.height, 14, accuracy: 1)

            driver.typeSize = .accessibility3
            try await settle()
            let largeSpinner = try XCTUnwrap(findActivityIndicator(window))
            let largeRunning = largeSpinner.convert(largeSpinner.bounds, to: window)
            XCTAssertGreaterThan(largeRunning.width, running.width)
            XCTAssertLessThanOrEqual(largeRunning.maxX, width - 14, "Dynamic Type must not double-scale loading beyond its slot")
            XCTAssertLessThanOrEqual(largeRunning.maxY, driver.height - 10, "Loading stays inside the row")
            driver.typeSize = .large
            driver.summary.pendingRequestsCount = 1
            try await settle()
            XCTAssertNil(findActivityIndicator(window), "Pending attention replaces loading even while thinking remains true")
            XCTAssertNotNil(try colorBounds(render(window, scale: scale), matching: amber))
            driver.summary.pendingRequestsCount = 0
            driver.summary.thinking = false
            try await settle()
            let idleImage = render(window, scale: scale)
            XCTAssertNil(try colorBounds(idleImage, matching: amber))
            XCTAssertNil(try colorBounds(idleImage, matching: secondary, within: detailBand), "Idle sessions have no status symbol")
            XCTAssertNil(findActivityIndicator(window))
        }
    }

    func testStatusSymbolsAreAvailableAndDistinct() {
        let statuses: [SessionRowStatus] = [.needsReply(1), .needsApproval(2), .needsAttention(3)]
        let symbols = statuses.compactMap(\.symbolName)
        XCTAssertEqual(symbols, ["bubble.left", "hand.raised", "exclamationmark.bubble"])
        for symbol in symbols { XCTAssertNotNil(UIImage(systemName: symbol)) }
        XCTAssertNil(SessionRowStatus.running.symbolName, "Loading is not represented by a static SF Symbol")
    }

    private func findActivityIndicator(_ view: UIView) -> UIActivityIndicatorView? {
        if let spinner = view as? UIActivityIndicatorView { return spinner }
        return view.subviews.lazy.compactMap(findActivityIndicator).first
    }

    private func assertSameSymbolBounds(_ actual: CGRect, _ expected: CGRect, file: StaticString = #filePath, line: UInt = #line) {
        // Allow one raster pixel of rounding, not compressed or moved symbols.
        XCTAssertEqual(actual.minX, expected.minX, accuracy: 1, file: file, line: line)
        XCTAssertEqual(actual.minY, expected.minY, accuracy: 1, file: file, line: line)
        XCTAssertEqual(actual.width, expected.width, accuracy: 1, file: file, line: line)
        XCTAssertEqual(actual.height, expected.height, accuracy: 1, file: file, line: line)
    }

    private func makeWindow<V: View>(_ view: V, width: CGFloat) throws -> UIWindow {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: width, height: 800)
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        window.layoutIfNeeded()
        return window
    }

    private func settle() async throws {
        try await Task.sleep(for: .milliseconds(180))
    }

    private func render(_ window: UIWindow, scale: CGFloat = 1) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.preferredRange = .standard
        return UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
    }

    private func colorBounds(_ image: UIImage, matching rgb: (Int, Int, Int) = (59, 130, 246), within region: CGRect? = nil) throws -> CGRect? {
        let source = try XCTUnwrap(image.cgImage)
        let width = source.width
        let height = source.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        try pixels.withUnsafeMutableBytes { buffer in
            let context = try XCTUnwrap(CGContext(
                data: buffer.baseAddress, width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: width * 4,
                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
            ))
            context.draw(source, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        var bounds: CGRect?
        for y in 0..<height {
            for x in 0..<width {
                if let region, !region.contains(CGPoint(x: x, y: y)) { continue }
                let offset = (y * width + x) * 4
                // Match the theme token, excluding antialias fringes.
                if abs(Int(pixels[offset]) - rgb.0) <= 4,
                   abs(Int(pixels[offset + 1]) - rgb.1) <= 4,
                   abs(Int(pixels[offset + 2]) - rgb.2) <= 4 {
                    let pixel = CGRect(x: x, y: y, width: 1, height: 1)
                    bounds = bounds.map { $0.union(pixel) } ?? pixel
                }
            }
        }
        return bounds
    }
}
