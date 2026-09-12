import HapiClient
import HapiUI
import Observation
import SwiftUI
import UIKit
import XCTest
@testable import Hapi

/// Real list/menu/summary components over observable, non-networked stores.
/// The test navigation shell has no pairing, push coordinator or live sessions.
@MainActor
final class HomeFilterPresentationTests: XCTestCase {
    @Observable
    fileprivate final class Navigation {
        var path: [String] = []
    }

    private struct Harness: View {
        let model: SessionListModel
        let navigation: Navigation
        var theme: HapiTheme = .light
        var size: DynamicTypeSize = .large

        var body: some View {
            @Bindable var navigation = navigation
            NavigationStack(path: $navigation.path) {
                VStack(spacing: 0) {
                    SessionConnectionNotice(state: .connected, showsCachedSessions: false)
                    SessionListView(model: model) { navigation.path.append($0) }
                }
                .navigationTitle("Sessions")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {} label: {
                            Label("Hubs", systemImage: "server.rack").frame(minWidth: 44, minHeight: 44)
                        }
                    }
                    if model.showsFilterMenu {
                        ToolbarItem(placement: .topBarTrailing) { SessionFilterMenu(model: model) }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {} label: {
                            Label("New Session", systemImage: "plus").frame(minWidth: 44, minHeight: 44)
                        }
                    }
                }
                .navigationDestination(for: String.self) { id in Text(verbatim: id) }
            }
            .hapiTypography()
            .hapiTheme(theme)
            .environment(\.dynamicTypeSize, size)
            .environment(\.colorScheme, theme.isDark ? .dark : .light)
            .preferredColorScheme(theme.isDark ? .dark : .light)
        }
    }

    func testFilteringResetsScrollButLiveUpdatesAndChatReturnPreserveIt() async throws {
        let sessions = HomeFilterTestSessions((0..<100).map {
            HomeFilterTestData.summary("session-\($0)", machine: $0.isMultiple(of: 2) ? "mac" : "debian")
        })
        let model = HomeFilterTestData.model(sessions: sessions)
        let navigation = Navigation()
        let window = try makeWindow(Harness(model: model, navigation: navigation), width: 402)
        defer { window.isHidden = true }
        try await settle()
        let list = try XCTUnwrap(findCollection(window))
        list.setContentOffset(CGPoint(x: 0, y: 600), animated: false)
        try await settle()
        let offset = list.contentOffset.y
        sessions.sessions[99].updatedAt += 1
        try await settle()
        XCTAssertTrue(findCollection(window) === list)
        XCTAssertEqual(list.contentOffset.y, offset, accuracy: 1)
        XCTAssertEqual(sessions.refreshCount, 1)

        model.selectMachine("mac")
        try await settle()
        let filtered = try XCTUnwrap(findCollection(window))
        XCTAssertEqual(filtered.contentOffset.y, -filtered.adjustedContentInset.top, accuracy: 1)
        XCTAssertEqual(model.rows.count, 50)
        XCTAssertEqual(sessions.refreshCount, 1, "Filtering must not fetch or subscribe again")
        filtered.setContentOffset(CGPoint(x: 0, y: 450), animated: false)
        try await settle()
        let filteredOffset = filtered.contentOffset.y
        navigation.path.append("session-20")
        try await settle()
        navigation.path.removeAll()
        try await settle()
        XCTAssertEqual(model.activeMachineFilter, "mac")
        let returned = try XCTUnwrap(findCollection(window))
        XCTAssertEqual(returned.contentOffset.y, filteredOffset, accuracy: 1)

        model.clearFilters()
        try await settle()
        let all = try XCTUnwrap(findCollection(window))
        XCTAssertEqual(all.contentOffset.y, -all.adjustedContentInset.top, accuracy: 1)
        XCTAssertEqual(model.rows.count, 100)
    }

    func testSessionRemovalReconcilesSelectionWithoutResurrectingIt() async throws {
        let mac = HomeFilterTestData.summary("a", machine: "mac")
        let sessions = HomeFilterTestSessions([mac, HomeFilterTestData.summary("b", machine: "debian")])
        let model = HomeFilterTestData.model(sessions: sessions)
        let window = try makeWindow(Harness(model: model, navigation: Navigation()), width: 390)
        defer { window.isHidden = true }
        try await settle()
        model.selectMachine("mac")
        try await settle()
        sessions.sessions.removeAll { $0.id == "a" }
        try await settle()
        XCTAssertFalse(model.filters.isActive, "The view must reconcile session-store changes")
        XCTAssertFalse(model.showsFilterMenu)
        sessions.sessions.append(mac)
        try await settle()
        XCTAssertNil(model.activeMachineFilter)
        XCTAssertTrue(model.showsFilterMenu)
    }

    func testHomeLayoutSpecimens() async throws {
        let sessions = HomeFilterTestSessions((0..<36).map {
            var row = HomeFilterTestData.summary("session-\($0)", machine: $0.isMultiple(of: 2) ? "mac" : "debian")
            row.metadata?.name = ["Review session filtering", "检查离线状态与筛选反馈", "Keep the reading position"][($0 / 2) % 3]
            return row
        })
        let machines = HomeFilterTestMachines([
            HomeFilterTestData.machine("mac", host: "MacBook Pro"),
            HomeFilterTestData.machine("debian", host: "debian"),
        ])
        let model = HomeFilterTestData.model(sessions: sessions, machines: machines)
        let cases: [(String, HapiTheme, DynamicTypeSize, CGFloat)] = [
            ("light", .light, .large, 402), ("dark", .dark, .large, 402),
            ("compact", .light, .large, 320), ("large-text", .light, .accessibility3, 390),
            ("wide", .light, .large, 768),
        ]
        for (name, theme, size, width) in cases {
            model.clearFilters()
            machines.machines[0].metadata?.displayName = name == "compact" || name == "large-text"
                ? "MacBook Pro · 上海开发环境 · very-long-machine-name.example.com" : nil
            let window = try makeWindow(Harness(model: model, navigation: Navigation(), theme: theme, size: size), width: width)
            defer { window.isHidden = true }
            try await settle()
            let all = try XCTUnwrap(findCollection(window))
            let allTop = try firstRowTop(all, in: window)
            try capture(window, name: "\(name)-all")
            model.selectMachine("mac")
            try await settle()
            let filtered = try XCTUnwrap(findCollection(window))
            let filteredTop = try firstRowTop(filtered, in: window)
            XCTAssertGreaterThanOrEqual(filteredTop - allTop, 43, "Applied summary has a 44pt clear target")
            XCTAssertLessThanOrEqual(filtered.frame.width, width + 1)
            XCTAssertEqual(model.rows.count, 18)
            try capture(window, name: "\(name)-filtered")
        }
    }

    private func makeWindow<V: View>(_ view: V, width: CGFloat) throws -> UIWindow {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: width, height: 874)
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        window.layoutIfNeeded()
        return window
    }

    private func findCollection(_ view: UIView) -> UICollectionView? {
        if let list = view as? UICollectionView { return list }
        return view.subviews.lazy.compactMap(findCollection).first
    }

    private func firstRowTop(_ list: UICollectionView, in window: UIWindow) throws -> CGFloat {
        let row = try XCTUnwrap(list.layoutAttributesForItem(at: IndexPath(item: 0, section: 0)))
        return list.convert(row.frame, to: window).minY
    }

    private func settle() async throws {
        try await Task.sleep(for: .milliseconds(350))
    }

    private func capture(_ window: UIWindow, name: String) throws {
        guard let path = ProcessInfo.processInfo.environment["HAPI_HOME_CAPTURE"] else { return }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
        let image = renderer.image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent("\(name).png"))
    }
}
