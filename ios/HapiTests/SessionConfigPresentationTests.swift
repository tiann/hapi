import HapiClient
import HapiProtocol
import Observation
import SwiftUI
import UIKit
import XCTest
@testable import Hapi

/// The production toolbar presenter over the non-networked config harness.
/// Run on both iPhone and iPad; synthetic widths alone cannot test adaptation.
@MainActor
final class SessionConfigPresentationTests: XCTestCase {
    @Observable
    fileprivate final class Presentation {
        let model: SessionConfigModel
        var isPresented = false
        var notice: String?
        init(model: SessionConfigModel) { self.model = model }
    }

    private struct Host: View {
        let presentation: Presentation
        var size: DynamicTypeSize = .large
        var dark = false
        var locale = Locale(identifier: "en")

        var body: some View {
            @Bindable var presentation = presentation
            NavigationStack {
                Text("Session settings specimen")
                    .navigationTitle("HAPI")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            SessionConfigButton(isPresented: $presentation.isPresented) {
                                SessionConfigView(model: presentation.model, notice: presentation.notice)
                                    .environment(\.dynamicTypeSize, size)
                                    .environment(\.locale, locale)
                            }
                            .environment(\.dynamicTypeSize, size)
                        }
                        ToolbarItem(placement: .topBarTrailing) {
                            Image(systemName: "ellipsis.circle")
                        }
                    }
            }
            .environment(\.dynamicTypeSize, size)
            .environment(\.locale, locale)
            .preferredColorScheme(dark ? .dark : .light)
        }
    }

    func testMenusKeepTheSamePageAndSheetHeightWhenSelecting() async throws {
        let harness = try await SessionConfigTestHarness(model: "sonnet")
        let presentation = Presentation(model: harness.model)
        let (window, host) = try await show(Host(presentation: presentation))
        defer { window.isHidden = true }
        let sheet = try XCTUnwrap(host.presentedViewController)
        let rootList = try XCTUnwrap(findList(sheet.view))
        XCTAssertEqual(itemCount(rootList), 3)
        XCTAssertTrue(rootList.visibleCells.allSatisfy { $0.bounds.height >= 44 })
        let rootHeight = sheet.view.bounds.height
        try capture(window, name: "root")

        harness.model.selectModel("sonnet")
        harness.model.selectPermission(.default)
        let initialPosts = await harness.http.posts
        XCTAssertTrue(initialPosts.isEmpty, "Reselecting the current value is read-only")
        harness.model.selectModel("opus")
        try await configEventually { !harness.model.isApplying }
        harness.model.selectEffort("high")
        try await configEventually { !harness.model.isApplying }
        harness.model.selectPermission(.bypassPermissions)
        try await configEventually { !harness.model.isApplying }
        try await settle()
        XCTAssertTrue(host.presentedViewController === sheet)
        XCTAssertNil(sheet.presentedViewController, "Selections must not open another modal")
        XCTAssertTrue(findList(sheet.view) === rootList, "No detail page replaces the settings list")
        XCTAssertEqual(itemCount(rootList), 3)
        XCTAssertEqual(sheet.view.bounds.height, rootHeight, accuracy: 2)
        XCTAssertEqual(harness.model.modelLabel, "Opus")
        XCTAssertEqual(harness.model.permission, .bypassPermissions)
        try capture(window, name: "selected")
        presentation.isPresented = false
        try await configEventually { host.presentedViewController == nil }
        let posts = await harness.http.posts
        XCTAssertEqual(posts.count, 3, "Dismissal does not apply or revert settings")
    }

    func testCodexRootShowsCollaborationAlongsidePermissionsModelAndEffort() async throws {
        let harness = try await SessionConfigTestHarness(flavor: "codex")
        let presentation = Presentation(model: harness.model)
        let (window, host) = try await show(Host(presentation: presentation, locale: Locale(identifier: "zh-Hans")))
        defer { window.isHidden = true }
        try await configEventually { harness.model.showsEffort }
        try await settle()
        let sheet = try XCTUnwrap(host.presentedViewController)
        let list = try XCTUnwrap(findList(sheet.view))
        XCTAssertEqual(itemCount(list), 4)
        XCTAssertTrue(list.visibleCells.allSatisfy { $0.bounds.height >= 44 })
        harness.model.selectCollaborationMode(.plan)
        try await settle()
        XCTAssertTrue(host.presentedViewController === sheet)
        XCTAssertEqual(harness.model.collaborationMode, .plan)
        XCTAssertEqual(harness.model.permission, .default)
        XCTAssertEqual(itemCount(list), 4)
    }

    func testBusyAndFailureFeedbackRemainInsideTheOpenSheet() async throws {
        let harness = try await SessionConfigTestHarness(model: "sonnet")
        let presentation = Presentation(model: harness.model)
        harness.interactor.onEvent = {
            if case .notice(let message) = $0 { presentation.notice = message }
        }
        let (window, host) = try await show(Host(presentation: presentation))
        defer { window.isHidden = true }
        let sheet = try XCTUnwrap(host.presentedViewController)
        await harness.http.holdPosts()
        await harness.http.rejectChanges()
        defer { Task { await harness.http.releasePosts() } }
        harness.model.selectModel("opus")
        try await settle()
        XCTAssertTrue(harness.model.isApplying)
        XCTAssertTrue(host.presentedViewController === sheet)
        try capture(window, name: "applying")
        await harness.http.releasePosts()
        try await configEventually { presentation.notice == "HTTP 409 (Config rejected)" && !harness.model.isApplying }
        try await settle()
        XCTAssertEqual(harness.model.modelLabel, "Sonnet")
        XCTAssertTrue(host.presentedViewController === sheet)
        try capture(window, name: "failure")
        presentation.notice = nil
        try await settle()
        XCTAssertEqual(itemCount(try XCTUnwrap(findList(sheet.view))), 3)
    }

    func testFailedCatalogCanRetryInlineWithoutLeavingSettings() async throws {
        let harness = try await SessionConfigTestHarness(flavor: "codex")
        await harness.http.setModelsFailure(true)
        let presentation = Presentation(model: harness.model)
        let (window, host) = try await show(Host(presentation: presentation))
        defer { window.isHidden = true }
        try await configEventually { harness.model.modelLoadFailed }
        try await settle()
        let sheet = try XCTUnwrap(host.presentedViewController)
        XCTAssertEqual(itemCount(try XCTUnwrap(findList(sheet.view))), 3, "Model status stays in its row beside the other settings")
        try capture(window, name: "catalog-failure")
        await harness.http.setModelsFailure(false)
        harness.model.loadModels()
        try await configEventually { !harness.model.config.modelOptionsLoading }
        try await settle()
        XCTAssertTrue(host.presentedViewController === sheet)
        XCTAssertEqual(harness.model.currentModel, "deep")
        XCTAssertEqual(itemCount(try XCTUnwrap(findList(sheet.view))), 4)
    }

    func testLayoutSpecimensSupportNarrowWideDarkChineseAndLargeType() async throws {
        let cases: [(String, CGSize, DynamicTypeSize, Bool, String)] = [
            ("compact", CGSize(width: 320, height: 667), .large, false, "en"),
            ("dark", CGSize(width: 390, height: 844), .large, true, "en"),
            ("chinese", CGSize(width: 390, height: 844), .large, false, "zh-Hans"),
            ("large-type", CGSize(width: 390, height: 844), .accessibility3, false, "zh-Hans"),
            ("wide", CGSize(width: 820, height: 1180), .large, false, "en"),
            ("landscape", CGSize(width: 1180, height: 820), .large, false, "en"),
            ("wide-large-type", CGSize(width: 820, height: 1180), .accessibility3, false, "zh-Hans"),
        ]
        for (name, dimensions, typeSize, dark, locale) in cases {
            let shortModel = name == "compact" || name == "chinese"
            let harness = try await SessionConfigTestHarness(
                model: shortModel ? "sonnet" : "custom-model-with-a-very-long-name-用于长名称换行验证"
            )
            harness.store.updateDetailLocal("config") { $0.permissionMode = .bypassPermissions }
            let presentation = Presentation(model: harness.model)
            let (window, host) = try await show(
                Host(presentation: presentation, size: typeSize, dark: dark, locale: Locale(identifier: locale)),
                dimensions: dimensions
            )
            let sheet = try XCTUnwrap(host.presentedViewController)
            let list = try XCTUnwrap(findList(sheet.view))
            XCTAssertEqual(itemCount(list), 3)
            XCTAssertTrue(list.visibleCells.allSatisfy { $0.bounds.height >= 44 })
            if !typeSize.isAccessibilitySize {
                XCTAssertLessThan(
                    try XCTUnwrap(list.cellForItem(at: IndexPath(item: 0, section: 1))).bounds.height, 120,
                    "The warning subtitle must not stretch into a separate Form row"
                )
            }
            if typeSize.isAccessibilitySize && host.traitCollection.horizontalSizeClass == .compact {
                let controller = try XCTUnwrap(adaptiveSheet(of: sheet))
                XCTAssertEqual(controller.detents.count, 1, "Accessibility text uses a large sheet")
            }
            try capture(window, name: name)
            presentation.isPresented = false
            try await configEventually { host.presentedViewController == nil }
            window.isHidden = true
        }
    }

    func testNativeDevicePresentationIsAnchoredOnIPadAndAdaptsOnIPhone() async throws {
        let harness = try await SessionConfigTestHarness(model: "sonnet")
        let presentation = Presentation(model: harness.model)
        // No fake dimensions or trait overrides: this test needs a real iPad run.
        let (window, host) = try await show(Host(presentation: presentation), dimensions: nil)
        defer { window.isHidden = true }
        // Optional pause for AXe-driven menu/Done interaction over this fake session.
        if let value = ProcessInfo.processInfo.environment["HAPI_SESSION_CONFIG_INTERACTIVE_SECONDS"],
           let seconds = Double(value), seconds > 0 {
            try await Task.sleep(for: .seconds(min(seconds, 180)))
        }
        let panel = try XCTUnwrap(host.presentedViewController)
        XCTAssertEqual(itemCount(try XCTUnwrap(findList(panel.view))), 3)
        if host.traitCollection.horizontalSizeClass == .regular {
            let popover = try XCTUnwrap(panel.presentationController as? UIPopoverPresentationController)
            if popover.sourceItem != nil {
                XCTAssertNotNil(popover.sourceItem as? UIBarButtonItem, "Toolbar anchors use a native bar item")
            } else {
                let source = try XCTUnwrap(popover.sourceView)
                let rect = popover.sourceRect.isEmpty || popover.sourceRect.isNull ? source.bounds : popover.sourceRect
                let anchor = source.convert(rect, to: window)
                XCTAssertLessThan(anchor.width, 100, "Anchor must be the gear, not the page")
                XCTAssertGreaterThan(anchor.midX, window.bounds.midX)
                XCTAssertLessThan(anchor.maxY, window.bounds.height / 3)
            }
            let panelFrame = panel.view.convert(panel.view.bounds, to: window)
            XCTAssertGreaterThan(panelFrame.midX, window.bounds.midX, "Popover belongs beside the toolbar, not in the center")
            XCTAssertLessThan(panelFrame.minY, window.bounds.height / 3)
            XCTAssertLessThanOrEqual(panel.view.bounds.width, 420)
        } else {
            let sheet = try XCTUnwrap(adaptiveSheet(of: panel))
            XCTAssertEqual(sheet.detents.count, 2)
        }
        try capture(window, name: "device-root")
        harness.model.selectModel("opus")
        try await configEventually { !harness.model.isApplying }
        try await settle()
        XCTAssertTrue(host.presentedViewController === panel)
        XCTAssertEqual(itemCount(try XCTUnwrap(findList(panel.view))), 3)
    }

    func testSizeClassAdaptationPreservesOpenConfigurationAndDoesNotResubmit() async throws {
        let harness = try await SessionConfigTestHarness(flavor: "codex")
        let presentation = Presentation(model: harness.model)
        let (window, host) = try await show(Host(presentation: presentation), dimensions: CGSize(width: 820, height: 1180))
        defer { window.isHidden = true }
        try await configEventually { harness.model.showsEffort }
        harness.model.selectModel("fast")
        try await configEventually { !harness.model.isApplying }
        presentation.notice = "Config rejected"
        for sizeClass in [UIUserInterfaceSizeClass.compact, .regular] {
            host.traitOverrides.horizontalSizeClass = sizeClass
            try await Task.sleep(for: .seconds(2))
            XCTAssertTrue(presentation.isPresented)
            let panel = try XCTUnwrap(host.presentedViewController)
            XCTAssertEqual(itemCount(try XCTUnwrap(findList(panel.view))), 4)
            XCTAssertEqual(harness.model.currentModel, "fast")
            XCTAssertEqual(presentation.notice, "Config rejected")
        }
        let posts = await harness.http.posts
        XCTAssertEqual(posts.count, 1)
        let requests = await harness.http.modelRequests
        XCTAssertEqual(requests, 1, "Adaptation must not reload the catalog")
        try capture(window, name: "adapted")
    }

    private func show(
        _ content: Host, dimensions: CGSize? = CGSize(width: 390, height: 844)
    ) async throws -> (UIWindow, UIHostingController<Host>) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: dimensions ?? scene.coordinateSpace.bounds.size)
        let host = UIHostingController(rootView: content)
        if let dimensions {
            host.traitOverrides.horizontalSizeClass = dimensions.width < 600 ? .compact : .regular
        }
        window.rootViewController = host
        window.makeKeyAndVisible()
        try await Task.sleep(for: .milliseconds(100))
        content.presentation.isPresented = true
        try await configEventually { host.presentedViewController != nil }
        try await settle()
        return (window, host)
    }

    private func adaptiveSheet(of controller: UIViewController) -> UISheetPresentationController? {
        // An adapted popover keeps its UIPopoverPresentationController; the
        // actual sheet configuration is exposed through the adaptive accessor.
        controller.popoverPresentationController?.adaptiveSheetPresentationController
            ?? controller.sheetPresentationController
    }

    private func settle() async throws {
        try await Task.sleep(for: .milliseconds(650))
    }

    private func findList(_ view: UIView) -> UICollectionView? {
        if let list = view as? UICollectionView, list.window != nil, !list.isHidden { return list }
        for child in view.subviews.reversed() {
            if let list = findList(child) { return list }
        }
        return nil
    }

    private func itemCount(_ list: UICollectionView) -> Int {
        (0..<list.numberOfSections).reduce(0) { $0 + list.numberOfItems(inSection: $1) }
    }

    private func capture(_ window: UIWindow, name: String) throws {
        guard let path = ProcessInfo.processInfo.environment["HAPI_SESSION_CONFIG_CAPTURE"] else { return }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent("\(name).png"))
    }
}
