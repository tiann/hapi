import HapiClient
import HapiProtocol
import HapiUI
import SwiftUI
import UIKit

/// Installed on screens, never on transcript cells. Each visible screen has
/// one presenter; all presenters share the chat's single live inspector.
private struct ToolPresentationHost: ViewModifier {
    let model: ChatModel
    let session: HubSession
    let owner: String
    let openFile: (String) -> Void
    @State private var processRoute: ToolProcessRoute?
    @State private var pendingFile: String?

    func body(content: Content) -> some View {
        // Read in the host's observation scope, not solely inside Binding's
        // escaping getter (which SwiftUI may evaluate in the sheet's scope).
        let inspectorPresented = model.toolInspection.selection?.owner == owner
        content
            .environment(\.openChatTool, { block in
                model.beginContentInspection()
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                if opensToolProcess(block) {
                    // Acquire before navigation hides the parent. The child's
                    // appearance takes over this same idempotent lease.
                    model.retainSurface("process:\(block.id)")
                    processRoute = ToolProcessRoute(block: block)
                } else {
                    model.retainSurface("inspector:\(owner)")
                    model.toolInspection.open(block, owner: owner)
                }
            })
            .sheet(isPresented: Binding(
                get: { inspectorPresented },
                set: { if !$0 { model.toolInspection.dismiss(owner: owner) } }
            ), onDismiss: {
                model.toolInspection.dismiss(owner: owner)
                model.releaseSurface("inspector:\(owner)")
                if let pendingFile {
                    openFile(pendingFile)
                    self.pendingFile = nil
                }
            }) {
                ToolDetailSheet(inspection: model.toolInspection, basePath: model.basePath,
                                isReconnecting: model.isReconnecting) { path in
                    pendingFile = path
                    model.toolInspection.dismiss(owner: owner)
                }
            }
            .navigationDestination(item: $processRoute) { route in
                ToolProcessView(model: model, session: session, initialBlock: route.block)
                    .id(route.id)
            }
            .onChange(of: processRoute?.id) { old, new in
                if let old, old != new { model.releaseSurface("process:\(old)") }
            }
            .onChange(of: model.toolInspection.invalidation) {
                pendingFile = nil
                processRoute = nil
            }
            .onAppear { model.retainSurface(owner) }
            .onDisappear {
                if owner == "chat" { model.dictation.cancel() }
                model.releaseSurface(owner)
            }
    }
}

extension View {
    func toolPresentations(model: ChatModel, session: HubSession, owner: String,
                           openFile: @escaping (String) -> Void) -> some View {
        modifier(ToolPresentationHost(model: model, session: session, owner: owner, openFile: openFile))
            .modifier(MessagePresentationHost(model: model, owner: owner))
    }
}

private struct ToolProcessRoute: Identifiable, Hashable {
    let block: ToolCallBlock
    var id: String { block.id }
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

struct ToolDetailSheet: View {
    let inspection: ToolInspectionState
    let basePath: String?
    var isReconnecting = false
    let openFile: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var lastBlock: ToolCallBlock?

    init(inspection: ToolInspectionState, basePath: String?, isReconnecting: Bool = false,
         openFile: @escaping (String) -> Void) {
        self.inspection = inspection
        self.basePath = basePath
        self.isReconnecting = isReconnecting
        self.openFile = openFile
        _lastBlock = State(initialValue: inspection.selection?.block)
    }

    var body: some View {
        NavigationStack {
            if let block = inspection.selection?.block ?? lastBlock {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if inspection.isStale {
                            ToolSnapshotNotice()
                        } else if isReconnecting {
                            Label("Live updates interrupted — reconnecting…", systemImage: "wifi.slash")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        ToolDetailHeader(block: block, basePath: basePath, openFile: openFile)
                        ToolCallBody(tool: block.tool, basePath: basePath)
                    }
                    .hapiReadingColumn()
                    .padding(.vertical, 16)
                }
                // Only explicit selection changes reset the scroll position.
                .id(block.id)
                .navigationTitle("Tool details")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close", systemImage: "xmark") { dismiss() }
                    }
                    ToolbarItem(placement: .primaryAction) {
                        ToolCopyMenu(tool: block.tool)
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if inspection.siblingIDs.count > 1 { siblingNavigation }
                }
            }
        }
        .hapiTypography()
        .onChange(of: inspection.selection?.block) { _, latest in
            if let latest { lastBlock = latest }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private var siblingNavigation: some View {
        HStack {
            Button { inspection.move(by: -1) } label: {
                Label("Previous tool", systemImage: "chevron.left")
                    .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
            }
            .disabled((inspection.selectedIndex ?? 0) == 0)
            Spacer()
            Text("\((inspection.selectedIndex ?? 0) + 1) / \(inspection.siblingIDs.count)")
                .font(.footnote.monospacedDigit())
                .accessibilityLabel(String(format: String(localized: "Tool %lld of %lld"),
                                           Int64((inspection.selectedIndex ?? 0) + 1), Int64(inspection.siblingIDs.count)))
            Spacer()
            Button { inspection.move(by: 1) } label: {
                Label("Next tool", systemImage: "chevron.right")
                    .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
            }
            .disabled((inspection.selectedIndex ?? 0) >= inspection.siblingIDs.count - 1)
        }
        .hapiReadingColumn()
        .padding(.vertical, 4)
        .background(.bar)
    }
}

private struct ToolDetailHeader: View {
    let block: ToolCallBlock
    let basePath: String?
    var openFile: ((String) -> Void)?
    var permissionActionsInline = false

    var body: some View {
        let presentation = toolCardPresentation(block.tool, basePath: basePath)
        VStack(alignment: .leading, spacing: 10) {
            Label(presentation.title, systemImage: presentation.icon)
                .font(.headline).textSelection(.enabled)
            HStack(spacing: 8) {
                ToolStatusIndicator(state: block.tool.state)
                Text(statusLabel).font(.footnote).foregroundStyle(.secondary)
            }
            if let permission = block.tool.permission {
                PermissionStateRow(permission: permission)
                if permission.status == .pending && !permissionActionsInline {
                    Text("Close details to approve or answer in the conversation.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            if let path = toolFilePath(block.tool) {
                Text(path).font(.footnote.monospaced()).textSelection(.enabled)
                if let openFile {
                    Button { openFile(path) } label: {
                        Label("View current file", systemImage: "doc.text.magnifyingglass")
                            .frame(minHeight: 44)
                    }
                }
            }

        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var statusLabel: String {
        switch block.tool.state {
        case .pending: String(localized: "pending")
        case .running: String(localized: "Running")
        case .completed: String(localized: "Completed")
        case .error: String(localized: "error")
        }
    }
}

private struct ToolCopyMenu: View {
    let tool: ChatToolCall
    @Environment(\.hapiPasteboard) private var pasteboard
    var body: some View {
        Menu {
            if let input = tool.input {
                Button("Copy input") { pasteboard.copy(input.chatString ?? chatPrettyJSON(input)) }
            }
            if let result = tool.result {
                Button("Copy result") { pasteboard.copy(result.chatString ?? chatPrettyJSON(result)) }
            }
            if let path = toolFilePath(tool) {
                Button("Copy Path") { pasteboard.copy(path) }
            }
        } label: {
            Label("Copy", systemImage: "doc.on.doc")
                .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
        }
    }
}

func toolFilePath(_ tool: ChatToolCall) -> String? {
    if let value = chatInputString(tool.input, ["file_path", "file", "filePath", "notebook_path"]), !value.isEmpty {
        return value
    }
    // Generic `path` often identifies a directory (LS, search, MCP). Do not
    // offer a file viewer unless this is a known file operation.
    guard ["Read", "Write", "Edit", "MultiEdit", "NotebookRead", "NotebookEdit"].contains(toolPresentationName(tool.name)),
          let path = chatInputString(tool.input, ["path"]), !path.isEmpty else { return nil }
    return path
}

private struct ToolSnapshotNotice: View {
    var body: some View {
        Label("Showing the last available record. Live updates are unavailable for this tool.", systemImage: "clock.arrow.circlepath")
            .font(.footnote).foregroundStyle(.secondary)
    }
}

private struct ToolProcessView: View {
    let model: ChatModel
    let session: HubSession
    @State private var snapshot: ToolCallBlock
    @State private var fileRoute: FileViewerRoute?

    init(model: ChatModel, session: HubSession, initialBlock: ToolCallBlock) {
        self.model = model
        self.session = session
        _snapshot = State(initialValue: initialBlock)
    }

    private var block: ToolCallBlock { model.toolInspection.tools[snapshot.id] ?? snapshot }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                if model.toolInspection.tools[snapshot.id] == nil { ToolSnapshotNotice() }
                ToolDetailHeader(block: block, basePath: model.basePath, openFile: { path in
                    fileRoute = FileViewerRoute(sessionId: model.sessionId, path: path, mode: .file)
                }, permissionActionsInline: true)
                if model.toolInspection.tools[snapshot.id] != nil,
                   let permission = block.tool.permission, permission.status == .pending {
                    PendingPermissionFooter(tool: block.tool, requestId: permission.id, interactions: model.interactor)
                }
                ToolCallBody(tool: block.tool, basePath: model.basePath)
                Text("Agent process").font(.headline)
                if block.children.isEmpty {
                    Text("No agent steps available yet.").font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(block.children, id: \.id) { child in
                    ChatSubBlockView(block: child, basePath: model.basePath)
                }
            }
            .hapiReadingColumn()
            .padding(.vertical, 16)
        }
        .navigationTitle("Agent process")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) { ToolCopyMenu(tool: block.tool) }
        }
        .navigationDestination(item: $fileRoute) { route in
            FileViewerView(session: session, route: route).id(route)
        }
        .onChange(of: model.toolInspection.tools[snapshot.id]) { _, latest in
            if let latest { snapshot = latest }
        }
        .hapiTypography()
        .environment(\.chatInteractions, model.toolInspection.tools[snapshot.id] == nil ? nil : model.interactor)
        .toolPresentations(model: model, session: session, owner: "process:\(snapshot.id)") { path in
            fileRoute = FileViewerRoute(sessionId: model.sessionId, path: path, mode: .file)
        }
    }
}
