import HapiClient
import HapiProtocol
import HapiUI
import SwiftUI
import UIKit

/// Single-file viewer (A-M4a), the iOS take on web `file.tsx` / Android
/// `FileViewerScreen`: diff mode (raw `git-diff-file` stdout through
/// HapiUI's `UnifiedDiffParser` + `DiffTextView`, staged/unstaged toggle)
/// ⇄ full mode (`CodeBlockView` with highlighting and its own copy button;
/// markdown gets a Source/Preview toggle over the shared `MarkdownView`;
/// images decode via `UIImage(data:)`). The title shows the file name over
/// the middle-truncated path; the toolbar menu copies path/contents.
///
/// Chat citations may carry a line number; per-line highlighting inside the
/// single-`Text` code block isn't cheap, so the viewer shows a "Line N" hint
/// chip instead of scrolling/highlighting (same trade-off as Android B-M4c).
struct FileViewerView: View {
    @State private var model: FileViewerModel

    init(session: HubSession, route: FileViewerRoute) {
        _model = State(initialValue: FileViewerModel(
            sessionId: route.sessionId,
            path: route.path,
            initialStaged: route.staged,
            initialMode: route.mode,
            focusLine: route.line,
            requester: session.api,
            hasRenderableDiff: { !UnifiedDiffParser.parse($0).isEmpty }
        ))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                modeToggleRow
                switch model.mode {
                case .diff:
                    diffContent
                case .file:
                    fileContent
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(model.fileName)
                        .font(.headline)
                        .lineLimit(1)
                    Text(formatFileMetadata(size: model.sizeBytes, modified: model.modifiedAt) ?? model.path)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                actionsMenu
            }
        }
        .onAppear {
            model.start()
        }
    }

    // MARK: - Chrome

    private var actionsMenu: some View {
        Menu {
            Button {
                UIPasteboard.general.string = model.path
            } label: {
                Label("Copy Path", systemImage: "doc.on.doc")
            }
            if case .text(let text, _, _) = model.content {
                Button {
                    UIPasteboard.general.string = text
                } label: {
                    Label("Copy Contents", systemImage: "doc.on.clipboard")
                }
            }
            Button {
                model.refresh()
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("File actions")
    }

    /// Diff ⇄ File chips, the staged side toggle, the markdown
    /// Source/Preview toggle, and the citation line hint — only the
    /// applicable controls show (Android `ModeToggleRow` parity).
    @ViewBuilder
    private var modeToggleRow: some View {
        let hasDiff = isDiffReady
        let isMarkdownText = isMarkdownTextContent
        if hasDiff || isMarkdownText || model.focusLine != nil {
            HStack(spacing: 6) {
                if hasDiff {
                    ModeChip(label: String(localized: "Diff"), selected: model.mode == .diff) {
                        model.setMode(.diff)
                    }
                    ModeChip(label: String(localized: "File"), selected: model.mode == .file) {
                        model.setMode(.file)
                    }
                }
                if hasDiff && model.mode == .diff {
                    Text("·").foregroundStyle(.secondary)
                    ModeChip(label: String(localized: "Unstaged"), selected: !model.staged) {
                        model.setStaged(false)
                    }
                    ModeChip(label: String(localized: "Staged"), selected: model.staged) {
                        model.setStaged(true)
                    }
                }
                if isMarkdownText && model.mode == .file {
                    if hasDiff {
                        Text("·").foregroundStyle(.secondary)
                    }
                    ModeChip(label: String(localized: "Source"), selected: !model.markdownPreview) {
                        model.setMarkdownPreview(false)
                    }
                    ModeChip(label: String(localized: "Preview"), selected: model.markdownPreview) {
                        model.setMarkdownPreview(true)
                    }
                }
                if let line = model.focusLine {
                    Text("Line \(line)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 4)
                }
                Spacer(minLength: 0)
            }
        }
    }

    private var isDiffReady: Bool {
        if case .ready = model.diff { return true }
        return false
    }

    private var isMarkdownTextContent: Bool {
        if case .text(_, _, let isMarkdown) = model.content { return isMarkdown }
        return false
    }

    // MARK: - Content

    @ViewBuilder
    private var diffContent: some View {
        switch model.diff {
        case .loading:
            LoadingBlock()
        case .empty:
            HintBlock(text: String(localized: "No changes in this file"))
        case .failed(let message):
            HintBlock(text: LocalizedNoticeMapper.map(message))
        case .ready(let unifiedDiff):
            ParsedDiffView(unifiedDiff: unifiedDiff)
        }
    }

    @ViewBuilder
    private var fileContent: some View {
        switch model.content {
        case .loading:
            LoadingBlock()
        case .failed(let message):
            HintBlock(text: LocalizedNoticeMapper.map(message))
        case .empty:
            HintBlock(text: String(localized: "This file is empty"))
        case .binary:
            HintBlock(text: String(localized: "Binary file — no preview available"))
        case .image(let data, _):
            if let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel(model.fileName)
            } else {
                // SVG and other formats UIImage can't decode.
                HintBlock(text: String(localized: "Preview not available for this image format"))
            }
        case .text(let text, let language, let isMarkdown):
            if isMarkdown && model.markdownPreview {
                MarkdownView(markdown: text)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                CodeBlockView(language: language, code: text)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

/// Parses once per diff text (off the render path) and renders the shared
/// `DiffTextView`.
private struct ParsedDiffView: View {
    let unifiedDiff: String
    @State private var files: [DiffFile]?

    var body: some View {
        Group {
            if let files {
                DiffTextView(files: files)
            } else {
                LoadingBlock()
            }
        }
        .task(id: unifiedDiff) {
            files = UnifiedDiffParser.parse(unifiedDiff)
        }
    }
}

private struct ModeChip: View {
    let label: String
    let selected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(selected ? Color.white : Color.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(selected ? AnyShapeStyle(.tint) : AnyShapeStyle(.quaternary), in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

private struct LoadingBlock: View {
    var body: some View {
        HStack {
            Spacer(minLength: 0)
            ProgressView()
                .padding(.top, 48)
            Spacer(minLength: 0)
        }
    }
}

private struct HintBlock: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 16)
    }
}
