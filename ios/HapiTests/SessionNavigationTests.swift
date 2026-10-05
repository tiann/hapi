import HapiClient
import HapiProtocol
import SwiftUI
import XCTest
@testable import Hapi

@MainActor
final class SessionNavigationTests: XCTestCase {
    func testColdStartAndHubReplacementHaveNoSelection() {
        let navigation = SessionNavigationState()
        XCTAssertNil(navigation.selectedSessionId)
        XCTAssertTrue(navigation.detailPath.isEmpty)
        XCTAssertEqual(navigation.columnVisibility, .all)
        XCTAssertEqual(navigation.preferredCompactColumn, .sidebar)
        navigation.open("a")
        XCTAssertNil(SessionNavigationState().selectedSessionId)
    }

    func testOpenIsIdempotentAndNewSessionClearsNestedNavigation() {
        let navigation = SessionNavigationState()
        navigation.open("a")
        navigation.detailPath.append("files")
        navigation.open("a")
        XCTAssertEqual(navigation.detailPath.count, 1)
        navigation.open("created-before-list-refresh")
        XCTAssertEqual(navigation.selectedSessionId, "created-before-list-refresh")
        XCTAssertTrue(navigation.detailPath.isEmpty)
        XCTAssertEqual(navigation.preferredCompactColumn, .detail)
    }

    func testColumnChangesDoNotDiscardSelectionOrDetailPath() {
        let navigation = SessionNavigationState()
        navigation.open("a")
        navigation.detailPath.append("file.swift")
        navigation.columnVisibility = .detailOnly
        navigation.preferredCompactColumn = .sidebar
        XCTAssertEqual(navigation.selectedSessionId, "a")
        XCTAssertEqual(navigation.detailPath.count, 1)
        navigation.open("a")
        navigation.columnVisibility = .all
        XCTAssertEqual(navigation.preferredCompactColumn, .detail)
        XCTAssertEqual(navigation.detailPath.count, 1)
    }

    func testSupersedingAndRemovalCannotStealAnotherChatsFocus() {
        let navigation = SessionNavigationState()
        navigation.open("a")
        navigation.open("b")
        navigation.detailPath.append("files")
        navigation.supersede("a", with: "a-resumed")
        navigation.remove("a")
        XCTAssertEqual(navigation.selectedSessionId, "b")
        XCTAssertEqual(navigation.detailPath.count, 1)
        navigation.supersede("b", with: "b-resumed")
        XCTAssertEqual(navigation.selectedSessionId, "b-resumed")
        XCTAssertTrue(navigation.detailPath.isEmpty)
        navigation.remove("b-resumed")
        XCTAssertNil(navigation.selectedSessionId)
        XCTAssertEqual(navigation.preferredCompactColumn, .sidebar)
    }

    func testHubPublishesExplicitRemovalsEvenForAnUnlistedSession() throws {
        let hub = try XCTUnwrap(HubSession(hubUrl: "http://127.0.0.1:1/ipad-removal-\(UUID())",
                                         credentialStore: InMemoryCredentialStore()))
        defer { hub.shutdown() }
        hub.sessionStore.applySessionEvent(.sessionRemoved(namespace: nil, sessionId: "a"))
        let first = try XCTUnwrap(hub.sessionRemoval)
        XCTAssertEqual(first.sessionId, "a")
        hub.sessionStore.applySessionEvent(.sessionRemoved(namespace: nil, sessionId: "a"))
        XCTAssertNotEqual(hub.sessionRemoval, first)
    }

    func testAppUsesOneSceneWithoutRequiringFullScreen() {
        let manifest = Bundle.main.object(forInfoDictionaryKey: "UIApplicationSceneManifest") as? [String: Any]
        XCTAssertEqual(manifest?["UIApplicationSupportsMultipleScenes"] as? Bool, false)
        XCTAssertNotEqual(Bundle.main.object(forInfoDictionaryKey: "UIRequiresFullScreen") as? Bool, true)
    }

    func testLastSurfaceReleaseStopsTransportBeforeModelDeallocation() async throws {
        let hub = try XCTUnwrap(HubSession(hubUrl: "http://127.0.0.1:1/ipad-release-\(UUID())",
                                         credentialStore: InMemoryCredentialStore()))
        defer { hub.shutdown() }
        var model: ChatModel? = ChatModel(session: hub, sessionId: "a")
        weak var released = model
        model?.retainSurface("chat")
        for _ in 0..<100 {
            if hub.openChatSessionId == "a" { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(hub.openChatSessionId, "a")
        model?.releaseSurface("chat")
        model = nil
        for _ in 0..<100 {
            if hub.openChatSessionId == nil && released == nil { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertNil(hub.openChatSessionId, "Teardown must not depend on the view retaining its old model")
        XCTAssertNil(released)
    }
}
