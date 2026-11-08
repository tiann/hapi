import HapiClient
import HapiUI
import Observation
import SwiftUI
import UIKit
import XCTest
@testable import Hapi
@testable import HapiProtocol

/// A pushed chat covers the list: on a large hub, streaming sessions must
/// not rebuild a list nobody sees, and returning must show the latest rows.
@MainActor
final class SessionListCoveredRefreshTests: XCTestCase {
    @MainActor @Observable
    final class Sessions: SessionListStoring {
        var sessions: [SessionSummary]
        init(_ sessions: [SessionSummary]) { self.sessions = sessions }
        func refresh() async throws {}
        func scheduleRefresh() {}
        func fullResync() async throws {}
        func applySessionEvent(_ event: SyncEvent) {}
        func setPinMode(sessionId: String, mode: SessionPinMode) async throws {}
        func archiveSession(sessionId: String) async throws {}
        func renameSession(sessionId: String, name: String) async throws {}
        func deleteSession(sessionId: String) async throws {}
        func reopenSession(sessionId: String) async throws -> ReopenSessionResponse {
            ReopenSessionResponse(ok: true, sessionId: sessionId, resumed: true)
        }
    }

    @MainActor @Observable
    final class Navigation {
        var path: [String] = []
    }

    private struct Harness: View {
        let model: SessionListModel
        @Bindable var navigation: Navigation

        var body: some View {
            NavigationStack(path: $navigation.path) {
                SessionListView(model: model) { navigation.path.append($0) }
                    .navigationDestination(for: String.self) { Text($0) }
            }
            .hapiTheme(.light)
        }
    }

    func testCoveredListKeepsItsRowsAndRefreshesOnReturn() async throws {
        let sessions = Sessions((0..<3).map { HomeFilterTestData.summary("s\($0)", machine: "mac") })
        let model = SessionListModel(sessionStore: sessions, machineStore: HomeFilterTestMachines(),
                                     lastSeenStore: LastSeenStore(), hubUrl: "test")
        let navigation = Navigation()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        window.rootViewController = UIHostingController(rootView: Harness(model: model, navigation: navigation))
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await settle()
        let list = try XCTUnwrap(findCollection(window))
        XCTAssertEqual(itemCount(list), 3)

        navigation.path = ["s0"]
        try await settle()
        sessions.sessions += (3..<5).map { HomeFilterTestData.summary("s\($0)", machine: "mac") }
        try await settle()
        XCTAssertEqual(itemCount(list), 3, "A covered list must not rebuild for session changes")

        navigation.path = []
        try await settle()
        XCTAssertEqual(itemCount(try XCTUnwrap(findCollection(window))), 5, "Returning shows the latest rows")
    }

    private func itemCount(_ list: UICollectionView) -> Int {
        (0..<list.numberOfSections).reduce(0) { $0 + list.numberOfItems(inSection: $1) }
    }

    private func findCollection(_ view: UIView) -> UICollectionView? {
        if let list = view as? UICollectionView { return list }
        return view.subviews.lazy.compactMap(findCollection).first
    }

    private func settle() async throws {
        try await Task.sleep(for: .milliseconds(600))
    }
}
