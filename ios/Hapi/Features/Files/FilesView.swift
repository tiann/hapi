import HapiClient
import HapiProtocol
import SwiftUI

/// Session files browser (A-M4a), pushed from the chat toolbar — the iOS
/// take on web `files.tsx` / Android `FilesScreen`: **Changes** (branch
/// header incl. detached, staged/unstaged sections with status letters and
/// ±counts, degraded-numstat banner), **Browse** (lazily expanded directory
/// outline with per-node cache, dirs-first sort, hidden-file toggle),
/// **Search** (debounced ripgrep query, limit 200). Rows push the file
/// viewer — Changes rows carry their staged side so the viewer opens on the
/// right diff.
struct FilesView: View {
    private let session: HubSession
    private let sessionId: String
    @State private var model: FilesModel
    @State private var tab: FilesTab = .changes
    @State private var viewerRoute: FileViewerRoute?

    init(session: HubSession, sessionId: String) {
        self.session = session
        self.sessionId = sessionId
        _model = State(initialValue: FilesModel(sessionId: sessionId, requester: session.api))
    }

    private enum FilesTab: String, CaseIterable, Identifiable {
        case changes = "Changes"
        case browse = "Browse"
        case search = "Search"

        var id: String { rawValue }

        var label: String {
            switch self {
            case .changes: String(localized: "Changes")
            case .browse: String(localized: "Browse")
            case .search: String(localized: "Search")
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Section", selection: $tab) {
                ForEach(FilesTab.allCases) { tab in
                    Text(tab.label).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)

            switch tab {
            case .changes:
                ChangesTabView(state: model.changes) { path, staged in
                    viewerRoute = FileViewerRoute(sessionId: sessionId, path: path, staged: staged)
                }
            case .browse:
                BrowseTabView(
                    state: model.browse,
                    onToggleDirectory: { model.toggleDirectory(path: $0) },
                    onToggleHidden: { model.setShowHidden($0) },
                    onOpenFile: { path in
                        viewerRoute = FileViewerRoute(sessionId: sessionId, path: path)
                    }
                )
            case .search:
                SearchTabView(
                    state: model.search,
                    onQueryChange: { model.setSearchQuery($0) },
                    onOpenFile: { path in
                        viewerRoute = FileViewerRoute(sessionId: sessionId, path: path)
                    }
                )
            }
        }
        .navigationTitle("Files")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    switch tab {
                    case .changes: model.refreshChanges()
                    case .browse: model.refreshBrowse()
                    case .search: model.refreshSearch()
                    }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh")
            }
        }
        .navigationDestination(item: $viewerRoute) { route in
            // A replaced route value must rebuild the screen's @State model
            // (HomeView's chat-push precedent).
            FileViewerView(session: session, route: route)
                .id(route)
        }
        .onAppear {
            model.start()
        }
    }
}

// MARK: - Changes tab

private struct ChangesTabView: View {
    let state: FilesModel.ChangesState
    let onOpenFile: (_ path: String, _ staged: Bool) -> Void

    var body: some View {
        VStack(spacing: 0) {
            if let error = state.error {
                ErrorBanner(message: LocalizedNoticeMapper.map(error))
            }
            if state.isLoading && state.status == nil {
                CenteredProgress()
            } else if let status = state.status {
                header(status)
                if status.stagedFiles.isEmpty && status.unstagedFiles.isEmpty {
                    CenteredHint(text: String(localized: "No changes in the working tree"))
                    Spacer(minLength: 0)
                } else {
                    changesList(status)
                }
            } else {
                CenteredHint(text: String(localized: "Git status unavailable for this session"))
                Spacer(minLength: 0)
            }
        }
    }

    private func header(_ status: GitStatusFiles) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.triangle.branch")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(status.branch ?? String(localized: "Detached HEAD"))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text("\(status.totalStaged) staged · \(status.totalUnstaged) unstaged")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func changesList(_ status: GitStatusFiles) -> some View {
        List {
            if !status.stagedFiles.isEmpty {
                Section("Staged (\(status.stagedFiles.count))") {
                    ForEach(Array(status.stagedFiles.enumerated()), id: \.offset) { _, file in
                        GitFileRow(file: file) {
                            onOpenFile(file.fullPath, true)
                        }
                    }
                }
            }
            if !status.unstagedFiles.isEmpty {
                Section("Unstaged (\(status.unstagedFiles.count))") {
                    ForEach(Array(status.unstagedFiles.enumerated()), id: \.offset) { _, file in
                        GitFileRow(file: file) {
                            onOpenFile(file.fullPath, false)
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
    }
}

private struct GitFileRow: View {
    let file: GitFileStatus
    let onTap: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(file.fileName)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                if file.linesAdded > 0 || file.linesRemoved > 0 {
                    Text(counts)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
                StatusBadge(status: file.status, dark: colorScheme == .dark)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var subtitle: String {
        if let oldPath = file.oldPath {
            return "\(oldPath) → \(file.fullPath)"
        }
        return file.filePath.isEmpty ? String(localized: "Project root") : file.filePath
    }

    private var counts: String {
        var text = ""
        if file.linesAdded > 0 { text += "+\(file.linesAdded)" }
        if file.linesAdded > 0 && file.linesRemoved > 0 { text += " " }
        if file.linesRemoved > 0 { text += "-\(file.linesRemoved)" }
        return text
    }
}

private struct StatusBadge: View {
    let status: GitFileChange
    let dark: Bool

    var body: some View {
        let color = gitStatusColor(status, dark: dark)
        Text(gitStatusLetter(status))
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .overlay(
                RoundedRectangle(cornerRadius: 4)
                    .stroke(color, lineWidth: 1)
            )
    }
}

// MARK: - Browse tab

private struct BrowseTabView: View {
    let state: FilesModel.BrowseState
    let onToggleDirectory: (String) -> Void
    let onToggleHidden: (Bool) -> Void
    let onOpenFile: (_ path: String) -> Void

    var body: some View {
        VStack(spacing: 0) {
            Toggle(isOn: Binding(get: { state.showHidden }, set: onToggleHidden)) {
                Text("Show hidden files")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 4)

            List(state.rows) { row in
                browseRow(row)
            }
            .listStyle(.plain)
        }
    }

    @ViewBuilder
    private func browseRow(_ row: FilesModel.BrowseRow) -> some View {
        switch row {
        case .directory(let path, let name, let depth, let isExpanded):
            Button {
                onToggleDirectory(path)
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 14)
                    Image(systemName: "folder")
                        .font(.subheadline)
                        .foregroundStyle(.tint)
                    Text(name)
                        .font(.subheadline)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.leading, indent(depth))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        case .file(let path, let name, let depth, let size, let modified):
            Button {
                onOpenFile(path)
            } label: {
                VStack(alignment: .leading, spacing: 1) {
                    Text(name)
                        .font(.subheadline)
                        .lineLimit(1)
                    if let metadata = formatFileMetadata(size: size, modified: modified) {
                        Text(metadata)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                // Files align with sibling directory names (chevron offset).
                .padding(.leading, indent(depth) + 20)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        case .loading(_, let depth):
            ProgressView()
                .controlSize(.small)
                .padding(.leading, indent(depth) + 20)
        case .failure(_, let depth, let message):
            Text(LocalizedNoticeMapper.map(message))
                .font(.caption)
                .foregroundStyle(.red)
                .padding(.leading, indent(depth) + 20)
        }
    }

    private func indent(_ depth: Int) -> CGFloat {
        CGFloat(depth) * 16
    }
}

// MARK: - Search tab

private struct SearchTabView: View {
    let state: FilesModel.SearchState
    let onQueryChange: (String) -> Void
    let onOpenFile: (_ path: String) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Search files…", text: Binding(get: { state.query }, set: onQueryChange))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal, 16)
            .padding(.vertical, 8)

            if state.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                CenteredHint(text: String(localized: "Type to search files in the session directory"))
                Spacer(minLength: 0)
            } else if state.isLoading {
                CenteredProgress()
            } else if let error = state.error {
                ErrorBanner(message: LocalizedNoticeMapper.map(error))
                Spacer(minLength: 0)
            } else if state.hasSearched && state.results.isEmpty {
                CenteredHint(text: String(localized: "No files matched"))
                Spacer(minLength: 0)
            } else {
                List(state.results, id: \.fullPath) { item in
                    Button {
                        onOpenFile(item.fullPath)
                    } label: {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.fullPath)
                                .font(.subheadline)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            if let metadata = formatFileMetadata(size: item.size, modified: item.modified) {
                                Text(metadata)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                .listStyle(.plain)
            }
        }
    }
}

// MARK: - Shared bits

private struct ErrorBanner: View {
    let message: String

    var body: some View {
        Text(message)
            .font(.caption)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(.red.opacity(0.12))
    }
}

private struct CenteredProgress: View {
    var body: some View {
        VStack {
            ProgressView()
                .padding(.top, 48)
            Spacer(minLength: 0)
        }
    }
}

private struct CenteredHint: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 24)
            .padding(.vertical, 48)
    }
}
