import HapiClient
import HapiProtocol
import HapiUI
import SwiftUI

/// The session list (A-M2a) — standalone screen: navigation and hub chrome
/// stay outside; taps surface through `onOpenSession`.
///
/// Inventory (mirrors the web sidebar semantics via the Android port):
/// - an active-filter summary, pull-to-refresh, empty/loading states;
///   home owns the filter menu and connection notice;
/// - pinned section first (the sort already puts globalPinned/pinned rows on
///   top; a header makes the boundary visible);
/// - per row: flavor brand icon + title, trailing relative `updatedAt` and
///   an optional unread dot; a quiet second line has project left and a small status
///   indicator right. No preview, task progress, machine/path details or badges.
///   Disconnected titles/icons are secondary, without dimming attention;
/// - long-press context menu → pin (none/project/global) + archive with
///   optimistic store updates; failures land in an alert.
struct SessionListView: View {
    @Environment(\.hapiTheme) private var theme
    let model: SessionListModel
    var selection: Binding<String?>? = nil
    let onOpenSession: (String) -> Void

    var body: some View {
        // Minute-tick timeline keeps the relative-age labels honest without
        // any store churn.
        TimelineView(.periodic(from: .now, by: 60)) { context in
            sessionList(now: context.date)
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let summary = model.filterSummary {
                SessionFilterSummary(summary: summary, onClear: model.clearFilters)
            }
        }
        .onChange(of: model.machineFilterIds, initial: true) { _, _ in
            model.reconcileFilters()
        }
        .task {
            // Explicit fetch on entry: the snapshot may be stale and a
            // `resume: ok` handshake deliberately skips the REST resync.
            if selection != nil {
                await model.refreshOnFirstAppearance()
            } else {
                await model.refresh()
            }
        }
        .refreshable {
            await model.refresh()
        }
        .alert(
            "Action failed",
            isPresented: Binding(
                get: { model.actionError != nil },
                set: { presented in
                    if !presented {
                        model.actionError = nil
                    }
                }
            )
        ) {
            Button("OK") {
                model.actionError = nil
            }
        } message: {
            Text(model.actionError ?? "")
        }
    }

    // MARK: - List

    private func sessionList(now: Date) -> some View {
        let rows = model.rows
        let pinnedCount = SessionListModel.pinnedCount(of: rows)
        return List(selection: selection) {
            if pinnedCount > 0 {
                Section("Pinned") {
                    ForEach(rows.prefix(pinnedCount)) { row in
                        rowCell(row, now: now)
                    }
                }
                .listSectionSeparator(.hidden, edges: .top)
            }
            if rows.count > pinnedCount {
                // Headerless when nothing is pinned: an empty-string Section
                // header still reserves a blank sticky band above the list
                // (device feedback: "一片空白").
                if pinnedCount > 0 {
                    Section(String(localized: "Sessions")) {
                        ForEach(rows.dropFirst(pinnedCount)) { row in
                            rowCell(row, now: now)
                        }
                    }
                    .listSectionSeparator(.hidden, edges: .top)
                } else {
                    // Top edge hidden: a plain list otherwise draws a stray
                    // separator above the very first row (device feedback).
                    Section {
                        ForEach(rows) { row in
                            rowCell(row, now: now)
                        }
                    }
                    .listSectionSeparator(.hidden, edges: .top)
                }
            }
        }
        .listStyle(.plain)
        // An explicit filter change starts at the top. SSE/count/name changes
        // keep this identity (and the reading position), as does chat return.
        .id(model.filters)
        .accessibilityIdentifier("home.sessions")
        .overlay {
            if rows.isEmpty {
                emptyState
                    .allowsHitTesting(false) // keep the pull-to-refresh gesture
            }
        }
    }

    private func rowCell(_ row: SessionRowUI, now: Date) -> some View {
        Group {
            if selection != nil {
                NavigationLink(value: row.id) {
                    rowLabel(row, now: now)
                }
                .tag(row.id)
            } else {
                Button {
                    model.onSessionOpened(row.id)
                    onOpenSession(row.id)
                } label: {
                    rowLabel(row, now: now)
                }
                .buttonStyle(.plain)
            }
        }
        .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
        // Default separator color reads heavy against these rows; the theme
        // divider is the WeChat-style faint hairline.
        .listRowSeparatorTint(theme.divider)
        .contextMenu {
            contextMenuActions(row)
        }
    }

    private func rowLabel(_ row: SessionRowUI, now: Date) -> some View {
        SessionRowView(row: row, now: now)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
    }

    @ViewBuilder
    private func contextMenuActions(_ row: SessionRowUI) -> some View {
        let summary = row.summary
        if summary.pinned == true || summary.globalPinned == true {
            Button {
                model.setPinMode(sessionId: row.id, mode: .none)
            } label: {
                Label("Unpin", systemImage: "pin.slash")
            }
        }
        if summary.pinned != true {
            Button {
                model.setPinMode(sessionId: row.id, mode: .project)
            } label: {
                Label("Pin to Project", systemImage: "pin")
            }
        }
        if summary.globalPinned != true {
            Button {
                model.setPinMode(sessionId: row.id, mode: .global)
            } label: {
                Label("Pin Globally", systemImage: "pin.circle")
            }
        }
        Button(role: .destructive) {
            model.archiveSession(sessionId: row.id)
        } label: {
            Label("Archive", systemImage: "archivebox")
        }
    }

    // MARK: - Chrome

    @ViewBuilder
    private var emptyState: some View {
        if !model.hasLoaded && !model.isOffline {
            ContentUnavailableView {
                Label("Loading sessions…", systemImage: "arrow.triangle.2.circlepath")
            } description: {
                Text("Fetching the session list from the hub.")
            }
        } else if model.isOffline {
            ContentUnavailableView {
                Label("Hub unreachable", systemImage: "wifi.slash")
            } description: {
                Text("Pull to retry once you are back online.")
            }
        } else {
            ContentUnavailableView {
                Label("No sessions yet", systemImage: "tray")
            } description: {
                Text("Start an agent with the hapi CLI and it will appear here.")
            }
        }
    }
}

// MARK: - Row

struct SessionRowView: View {
    @Environment(\.hapiTheme) private var theme
    @ScaledMetric(relativeTo: .footnote) private var statusSlotSize: CGFloat = 16

    let row: SessionRowUI
    let now: Date

    // The agent owns the leading column; one quiet line of secondary text
    // keeps the row focused on the title rather than a stack of indicators.
    private let textInset: CGFloat = 24

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            titleLine
            detailLine
                .padding(.leading, textInset)
        }
        .alignmentGuide(.listRowSeparatorLeading) { _ in textInset }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("home.session.\(row.id)")
    }

    private var titleLine: some View {
        HStack(spacing: 8) {
            AgentFlavorIconView(flavor: row.flavor)
                .foregroundStyle(row.summary.active ? theme.textPrimary : theme.textSecondary)
                .opacity(row.summary.active ? 1 : 0.5)
            Text(verbatim: row.title)
                .font(.body)
                .fontWeight(row.unread ? .semibold : .regular)
                .foregroundStyle(row.summary.active ? theme.textPrimary : theme.textSecondary)
                .lineLimit(1)
            Spacer(minLength: 4)
            HStack(spacing: 6) {
                Text(verbatim: formatRelativeAge(now: now, thenEpochMs: row.summary.updatedAt))
                    .font(.caption2)
                    .foregroundStyle(theme.textSecondary)
                    .monospacedDigit()
                    .fixedSize()
                // Unread dots always occupy the trailing edge. Read rows
                // remove the slot so the timestamp itself aligns right.
                if row.unread {
                    Circle()
                        .fill(theme.accent)
                        .frame(width: 8, height: 8)
                        .frame(width: 12)
                        .accessibilityLabel("Unread")
                }
            }
            .fixedSize()
        }
    }

    @ViewBuilder
    private var detailLine: some View {
        if row.project != nil || row.status != nil {
            HStack(alignment: .center, spacing: 0) {
                // Keep the same text line height when metadata is missing,
                // so the symbol does not jump vertically at large text sizes.
                Text(verbatim: row.project ?? " ")
                    .lineLimit(1)
                    .accessibilityHidden(row.project == nil)
                Spacer(minLength: 12)
                if let status = row.status {
                    statusIndicator(status)
                }
            }
            .font(.footnote)
            .foregroundStyle(theme.textSecondary)
        }
    }

    private func statusIndicator(_ status: SessionRowStatus) -> some View {
        Group {
            if let symbol = status.symbolName {
                Image(systemName: symbol)
                    .symbolVariant(.none)
                    .symbolRenderingMode(.monochrome)
                    .foregroundStyle(attentionColor)
            } else {
                ProgressView()
                    // Native small loading already scales with Dynamic Type;
                    // an extra scaleEffect would overflow the shared slot.
                    .controlSize(.small)
                    .tint(theme.textSecondary)
            }
        }
        // One shared slot keeps attention symbols and loading aligned.
        // Footnote is 13pt at the default size and scales for AX.
        .frame(width: statusSlotSize, height: statusSlotSize)
        .fixedSize()
        .layoutPriority(1)
        .accessibilityLabel(statusAccessibilityText(status))
    }

    // Darker amber keeps thin strokes visible on white without a filled
    // symbol, background badge or animation competing with the session title.
    private var attentionColor: Color {
        theme.isDark ? theme.warning : Color(hex: 0x9A6700)
    }

    /// Keep the exact request count available to VoiceOver without adding
    /// another visible number or badge to every waiting conversation.
    private func statusAccessibilityText(_ status: SessionRowStatus) -> Text {
        let title = Text(LocalizedStringKey(status.titleKey))
        if let count = status.count, count > 1 {
            return Text("\(title) · \(count) requests")
        }
        return title
    }
}

// MARK: - Recent-directory chip (used by NewSessionView)

struct FilterChip: View {
    let label: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.footnote)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(
                    selected
                        ? AnyShapeStyle(.tint.opacity(0.18))
                        : AnyShapeStyle(Color.secondary.opacity(0.12)),
                    in: Capsule()
                )
                .foregroundStyle(selected ? AnyShapeStyle(.tint) : AnyShapeStyle(.primary))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
