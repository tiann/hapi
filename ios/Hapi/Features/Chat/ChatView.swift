import HapiClient
import HapiProtocol
import HapiUI
import SwiftUI

/// The chat screen: `ScrollView + LazyVStack` over the reduced
/// `VisibleChatBlock`s, newest at the bottom (M2f), plus the A-M3ab
/// interaction chrome — composer + queued bar (bottom inset), permission
/// action footers (via `\.chatInteractions`), the session config sheet
/// (toolbar gear), supersede renavigation, and toast notices.
///
/// Transcript layout and scroll intent live in `ChatTranscriptView`.
struct ChatView: View {
    @State private var model: ChatModel
    /// Session config sheet (toolbar gear).
    @State private var configSheetOpen = false
    /// Files browser push (toolbar folder, A-M4a).
    @State private var filesOpen = false
    /// File viewer push for `hapi-file://` chat citations (A-M4a).
    @State private var viewerRoute: FileViewerRoute?
    /// Scratchlist sheet (toolbar note icon, A-M4b).
    @State private var scratchlistOpen = false

    /// Resume/reopen handed back a superseding session id — the host swaps
    /// its navigation entry (HomeView replaces the path element).
    private let onNavigateToSession: ((String) -> Void)?

    /// Kept for the files/viewer pushes (the model owns its own reference).
    private let session: HubSession
    private let sessionId: String

    init(
        session: HubSession,
        sessionId: String,
        onNavigateToSession: ((String) -> Void)? = nil
    ) {
        _model = State(initialValue: ChatModel(session: session, sessionId: sessionId))
        self.session = session
        self.sessionId = sessionId
        self.onNavigateToSession = onNavigateToSession
    }

    var body: some View {
        Group {
            if model.isInitialLoading {
                initialLoading
            } else if model.loadFailed {
                loadFailedState
            } else if model.blocks.isEmpty {
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
                ChatComposerView(interactor: model.interactor, dictation: model.dictation)
            }
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                headerTitle
            }
            // Two icons max (device feedback: a crowded trailing edge
            // squeezed the title out): gear for the frequent config
            // switches, everything else behind one menu.
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    configSheetOpen = true
                } label: {
                    Image(systemName: "gearshape")
                }
                .accessibilityLabel("Session settings")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        filesOpen = true
                    } label: {
                        Label("Session files", systemImage: "folder")
                    }
                    Button {
                        scratchlistOpen = true
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
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("More actions")
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $configSheetOpen) {
            SessionConfigView(interactor: model.interactor)
        }
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
                interactor: model.interactor
            )
        }
        .environment(\.chatMedia, model.imageLoader)
        .environment(\.chatInteractions, model.interactor)
        .onChange(of: model.supersededSessionId) {
            if let superseding = model.supersededSessionId {
                onNavigateToSession?(superseding)
            }
        }
        .onAppear {
            model.start()
        }
        .onDisappear {
            // Closed, or a files/viewer push covered the chat — either way
            // the pipe parks; start() rebuilds fresh wiring at the saved
            // cursor when the screen returns.
            model.stop()
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
