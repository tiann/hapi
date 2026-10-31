import HapiClient
import HapiProtocol
import HapiUI
import SwiftUI
import UniformTypeIdentifiers

/// The chat screen: an anchored UIKit transcript over the reduced
/// `VisibleChatBlock`s, newest at the bottom (M2f), plus the A-M3ab
/// interaction chrome — composer + queued bar (bottom inset), permission
/// action footers (via `\.chatInteractions`), the session config sheet
/// (toolbar gear), supersede renavigation, and toast notices.
///
/// Transcript layout and scroll intent live in `ChatTranscriptView`.
struct ChatView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var model: ChatModel
    /// Adaptive session settings (toolbar gear).
    @State private var configOpen = false
    /// Files browser push (toolbar folder, A-M4a).
    @State private var filesOpen = false
    /// File viewer push for `hapi-file://` chat citations (A-M4a).
    @State private var viewerRoute: FileViewerRoute?
    /// Full inventory; the compact drawer lives with the composer below.
    @State private var scratchlistOpen = false
    @State private var scratchlistEntry: ScratchlistEntry?
    @State private var scratchlistStartsEditing = false
    @State private var renameOpen = false
    @State private var renameText = ""
    @State private var deleteOpen = false
    @State private var forkConfirmOpen = false
    @State private var historyOpen = false

    /// Resume/reopen handed back a superseding session id — the host swaps
    /// its navigation entry (HomeView replaces the path element).
    private let onNavigateToSession: ((String) -> Void)?

    /// Kept for the files/viewer pushes (the model owns its own reference).
    private let session: HubSession
    private let sessionId: String

    /// The iPhone Duo outer screen: 678pt tall, so chrome is kept minimal.
    private var isFoldedOuterScreen: Bool {
        FoldableDevice.shared.hasHinge && horizontalSizeClass == .compact
    }

    init(
        session: HubSession,
        sessionId: String,
        onNavigateToSession: ((String) -> Void)? = nil
    ) {
        self.init(session: session, model: ChatModel(session: session, sessionId: sessionId),
                  onNavigateToSession: onNavigateToSession)
    }

    init(session: HubSession, model: ChatModel, onNavigateToSession: ((String) -> Void)? = nil) {
        _model = State(initialValue: model)
        self.session = session
        self.sessionId = model.sessionId
        self.onNavigateToSession = onNavigateToSession
    }

    var body: some View {
        Group {
            if model.isInitialLoading {
                initialLoading
            } else if model.loadFailed {
                loadFailedState
            } else if model.blocks.isEmpty && !model.hasMore {
                emptyState
            } else {
                ChatTranscriptView(model: model)
            }
        }
        // Reconnection must not resize the transcript and trigger its
        // viewport/bottom-follow layout handlers. Keep it below any warning.
        .overlay(alignment: .top) {
            reconnectNotice
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            warningBanner
        }
        // Toast overlays the thread; applying it before the bottom inset
        // anchors it just above the composer instead of on top of it.
        .overlay(alignment: .bottom) {
            noticeToast
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                QueuedMessagesBarView(interactor: model.interactor)
                    .hapiReadingColumn()
                ChatComposerView(
                    interactor: model.interactor,
                    dictation: model.dictation,
                    hugsBottomEdge: isFoldedOuterScreen
                ) { entry, editing in
                    scratchlistEntry = entry
                    scratchlistStartsEditing = editing
                    scratchlistOpen = true
                }
            }
        }
        .modifier(FoldedTitleMinimization(isActive: isFoldedOuterScreen))
        .modifier(FoldedSystemTitle(
            isActive: isFoldedOuterScreen,
            title: model.header.title,
            subtitle: model.header.subtitle
        ))
        .toolbar {
            // Folded Duo: Back and the actions live in the side bar, so a
            // centered title would float right of an empty gap; the system
            // title (below) sits at the leading margin instead.
            if !isFoldedOuterScreen {
                ToolbarItem(placement: .principal) {
                    headerTitle
                }
            }
            // Two icons max (device feedback: a crowded trailing edge
            // squeezed the title out): gear for the frequent config
            // switches, everything else behind one menu.
            ToolbarItem(placement: .topBarTrailing) {
                SessionConfigButton(isPresented: $configOpen) {
                    SessionConfigView(interactor: model.interactor, notice: model.notice)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        filesOpen = true
                    } label: {
                        Label("Session files", systemImage: "folder")
                    }
                    Button {
                        model.interactor.setComposerDestination(.scratchlist)
                    } label: {
                        let count = model.interactor.scratchlistCount
                        if count > 0 {
                            Label(
                                String(format: String(localized: "Scratchlist (%lld)"), Int64(count)),
                                systemImage: "note.text"
                            )
                        } else {
                            Label("Scratchlist", systemImage: "note.text")
                        }
                    }
                    Divider()
                    if model.interactor.canForkCurrentConversation {
                        Button {
                            forkConfirmOpen = true
                        } label: {
                            Label("Fork Conversation", systemImage: "arrow.triangle.branch")
                        }
                        .disabled(model.interactor.historyActionPending)
                    }
                    if !model.historyPointMessages.isEmpty {
                        Button {
                            historyOpen = true
                        } label: {
                            Label("Rewind or Fork…", systemImage: "clock.arrow.circlepath")
                        }
                    }
                    Button {
                        model.exportConversation()
                    } label: {
                        Label("Export Conversation…", systemImage: "square.and.arrow.up")
                    }
                    .disabled(model.isExporting)
                    Divider()
                    Button {
                        renameText = model.header.title
                        renameOpen = true
                    } label: {
                        Label("Rename…", systemImage: "pencil")
                    }
                    // Web `SessionActionMenu`: reopen/delete only for a known
                    // inactive session; a removal closes this chat.
                    if model.sessionIsActive == false {
                        Button {
                            model.interactor.reopenSession()
                        } label: {
                            Label("Reopen", systemImage: "arrow.clockwise")
                        }
                        .disabled(model.interactor.sessionOpPending)
                        Button(role: .destructive) {
                            deleteOpen = true
                        } label: {
                            Label("Delete…", systemImage: "trash")
                        }
                        .disabled(model.interactor.sessionOpPending)
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("More actions")
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(isPresented: $filesOpen) {
            FilesView(session: session, sessionId: sessionId)
        }
        .navigationDestination(item: $viewerRoute) { route in
            // A replaced route value must rebuild the screen's @State model
            // (HomeView's chat-push precedent).
            FileViewerView(session: session, route: route)
                .id(route)
        }
        // Chat markdown citations open the real viewer in full mode with the
        // cited line as a hint chip (replaces the root placeholder alert for
        // this subtree; the destinations above inherit the handler too).
        .handlesHapiLinks { link in
            viewerRoute = FileViewerRoute(
                sessionId: sessionId,
                path: link.path,
                mode: .file,
                line: link.line
            )
        }
        .sheet(isPresented: $scratchlistOpen) {
            ScratchlistView(
                store: model.scratchlist,
                sessionId: model.sessionId,
                attachments: model.scratchlistAttachments,
                interactor: model.interactor,
                initialEntry: scratchlistEntry,
                initiallyEditing: scratchlistStartsEditing
            )
        }
        .alert("Rename Session", isPresented: $renameOpen) {
            TextField("Session name", text: $renameText)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                let name = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
                // An untouched title must not freeze an agent-generated one.
                if name != model.header.title {
                    model.interactor.renameSession(name)
                }
            }
            .disabled(!SessionNameRules.isValid(renameText))
        }
        .alert("Delete Session", isPresented: $deleteOpen) {
            Button("Delete", role: .destructive) {
                model.interactor.deleteSession()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(SessionNameRules.deleteMessage(title: model.header.title))
        }
        .alert("Fork Conversation", isPresented: $forkConfirmOpen) {
            Button("Fork") { model.interactor.forkConversation() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Create a new session from this point? The current session will not be changed.")
        }
        .alert(
            "Rewind Unavailable",
            isPresented: Binding(
                get: { model.interactor.rewindForkFallbackLocalId != nil },
                set: { if !$0 { model.interactor.dismissRewindForkFallback() } }
            ),
            presenting: model.interactor.rewindForkFallbackLocalId
        ) { localId in
            Button("Fork Here") { model.interactor.forkConversation(fromMessageLocalId: localId) }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("HAPI did not change this session because its native Codex boundary is ambiguous. Create a new session before this point instead? The current session will not be changed.")
        }
        .alert(
            exportPromptTitle,
            isPresented: Binding(
                get: { model.exportPrompt != nil },
                set: { if !$0 { model.exportPrompt = nil } }
            ),
            presenting: model.exportPrompt
        ) { prompt in
            switch prompt {
            case .warning:
                Button("Export Anyway") { model.exportConversation(force: true) }
                Button("Cancel", role: .cancel) {}
            case .tooLarge:
                Button("OK", role: .cancel) {}
            }
        } message: { prompt in
            Text(Self.exportPromptMessage(prompt))
        }
        .fileExporter(
            isPresented: Binding(
                get: { model.exportDocument != nil },
                set: { if !$0 { model.exportDocument = nil } }
            ),
            document: model.exportDocument,
            contentType: .json,
            defaultFilename: model.exportDocument?.file.filename
        ) { result in
            model.exportFinished(result)
        }
        .sheet(isPresented: $historyOpen) {
            ConversationHistorySheet(model: model)
        }
        .toolPresentations(model: model, session: session, owner: "chat") { path in
            viewerRoute = FileViewerRoute(sessionId: sessionId, path: path, mode: .file)
        }
        .environment(\.chatMedia, model.imageLoader)
        .environment(\.chatPresentationState, model.presentationState)
        .environment(\.hapiMarkdownCache, model.markdownCache)
        .environment(\.chatInteractions, model.interactor)
        .onChange(of: model.supersededSessionId) {
            if let superseding = model.supersededSessionId {
                onNavigateToSession?(superseding)
            }
        }
    }

    private var exportPromptTitle: Text {
        switch model.exportPrompt {
        case .some(.tooLarge): Text("Export Too Large")
        default: Text("Large Export")
        }
    }

    static func exportPromptMessage(_ prompt: ChatModel.ExportPrompt) -> String {
        func bytes(_ value: Int) -> String {
            ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .file)
        }
        switch prompt {
        case .warning(let count, let limit, let estimatedBytes):
            return String(
                format: String(localized: "This export contains %lld messages (about %@), above the recommended %lld."),
                Int64(count), bytes(estimatedBytes), Int64(limit)
            )
        case .tooLarge(let count, let estimatedBytes, let maxBytes):
            return String(
                format: String(localized: "This export is too large to prepare safely (%lld messages, %@; maximum %@)."),
                Int64(count), bytes(estimatedBytes), bytes(maxBytes)
            )
        }
    }

    /// Transient interaction notice (Android snackbar analogue).
    @ViewBuilder
    private var noticeToast: some View {
        if let notice = model.notice {
            Text(LocalizedNoticeMapper.map(notice))
                .font(.footnote)
                .lineLimit(3)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .shadow(radius: 4, y: 2)
                .padding(.horizontal, 24)
                .padding(.bottom, 8)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    // MARK: - Chrome

    private var headerTitle: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(model.header.title)
                .font(.headline)
                .lineLimit(1)
            if let subtitle = model.header.subtitle {
                HStack(spacing: 4) {
                    if model.header.flavor != nil {
                        // Inherits .secondary like the meta text (web:
                        // currentColor under --app-hint); color variants
                        // ignore the tint.
                        AgentFlavorIconView(flavor: model.header.flavor, size: 12)
                    }
                    Text(subtitle)
                        .font(.caption2)
                        .lineLimit(1)
                }
                .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var warningBanner: some View {
        if let warning = model.warning {
            HStack(spacing: 8) {
                Text(LocalizedNoticeMapper.map(warning))
                    .font(.footnote)
                    .lineLimit(2)
                Spacer(minLength: 8)
                Button("Retry") {
                    model.retry()
                }
                .font(.footnote.weight(.semibold))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity)
            .background(.red.opacity(0.14))
            .foregroundStyle(.red)
        }
    }

    @ViewBuilder
    private var reconnectNotice: some View {
        if model.isReconnecting {
            Text("Live updates interrupted — reconnecting…")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .foregroundStyle(.orange)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .shadow(radius: 4, y: 2)
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .allowsHitTesting(false)
        }
    }

    // MARK: - Empty / loading / error

    private var initialLoading: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading messages…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var loadFailedState: some View {
        ContentUnavailableView {
            Label("Couldn't load this session", systemImage: "wifi.slash")
        } description: {
            Text("Check the connection to your hub and try again.")
        } actions: {
            Button("Retry") {
                model.retry()
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No messages yet", systemImage: "bubble.left.and.bubble.right")
        } description: {
            Text("Messages will appear here as the agent works.")
        }
    }
}

/// Folded iPhone Duo: once the reader scrolls toward newer output, the title
/// row stays minimized (content reflows into it) until the transcript's top.
/// The system offers no permanently minimized state.
private struct FoldedTitleMinimization: ViewModifier {
    let isActive: Bool

    func body(content: Content) -> some View {
        if #available(iOS 27.0, *), isActive {
            content
                .toolbarMinimizationBehavior(.onScrollDown, for: .navigationBar)
                .toolbarMinimizationRestoration(.atScrollEdge, for: .navigationBar)
                .toolbarMinimizationSafeAreaAdjustment(.enabled, for: .navigationBar)
        } else {
            content
        }
    }
}

/// Folded iPhone Duo: the system inline title is leading-aligned, unlike the
/// fixed centered `.principal` slot (a leading item becomes a glass button).
/// The subtitle is plain text, so the agent icon is omitted here.
private struct FoldedSystemTitle: ViewModifier {
    let isActive: Bool
    let title: String
    let subtitle: String?

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *), isActive {
            content
                .navigationTitle(Text(verbatim: title))
                .navigationSubtitle(Text(verbatim: subtitle ?? ""))
        } else {
            content
        }
    }
}

/// Fork or rewind at a loaded user message with a native history point
/// (web message actions). Kept out of the transcript so its cached row
/// heights and text selection stay untouched.
private struct ConversationHistorySheet: View {
    @Environment(\.dismiss) private var dismiss
    let model: ChatModel
    @State private var pending: PendingAction?

    private enum PendingAction: Identifiable {
        case fork(String)
        case rewind(String)

        var id: String {
            switch self {
            case .fork(let localId): "fork:\(localId)"
            case .rewind(let localId): "rewind:\(localId)"
            }
        }
    }

    var body: some View {
        let messages = model.historyPointMessages
        NavigationStack {
            List {
                Section {
                    ForEach(messages, id: \.id) { message in
                        row(message)
                    }
                } footer: {
                    Text("Only messages with a native history point are listed. Load older messages in the conversation to reach earlier ones.")
                }
            }
            .overlay {
                if messages.isEmpty {
                    ContentUnavailableView("No History Points", systemImage: "clock.arrow.circlepath")
                }
            }
            .disabled(model.interactor.historyActionPending)
            .navigationTitle("Conversation History")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .alert(
                pendingTitle,
                isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
                presenting: pending
            ) { action in
                switch action {
                case .fork(let localId):
                    Button("Fork") {
                        model.interactor.forkConversation(fromMessageLocalId: localId)
                        dismiss()
                    }
                case .rewind(let localId):
                    Button("Rewind", role: .destructive) {
                        model.interactor.rewindConversation(toMessageLocalId: localId)
                        dismiss()
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: { action in
                switch action {
                case .fork:
                    Text("Create a new session from this point? The current session will not be changed.")
                case .rewind:
                    Text("Rewind this session to this point? Later conversation history will be permanently removed. Files will not be changed.")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var pendingTitle: Text {
        switch pending {
        case .some(.rewind): Text("Rewind Conversation")
        default: Text("Fork Conversation")
        }
    }

    private func row(_ message: UserTextBlock) -> some View {
        let actions = model.interactor.historyActions(forMessageLocalId: message.localId)
        return HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: message.text.isEmpty ? " " : message.text)
                    .lineLimit(3)
                Text(verbatim: Date(timeIntervalSince1970: Double(message.createdAt) / 1000)
                    .formatted(date: .abbreviated, time: .shortened))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Menu {
                if actions.fork, let localId = message.localId {
                    Button("Fork from Here", systemImage: "arrow.triangle.branch") {
                        pending = .fork(localId)
                    }
                }
                if actions.rewind, let localId = message.localId {
                    Button("Rewind to Here", systemImage: "arrow.uturn.backward", role: .destructive) {
                        pending = .rewind(localId)
                    }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .frame(minWidth: 44, minHeight: 44)
            }
            .accessibilityLabel("History actions")
        }
    }
}
