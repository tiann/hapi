import Foundation
import HapiProtocol
import Observation

// The viewer's published state types and pure file-kind helpers live at file
// scope (not nested in the @MainActor model) so they stay nonisolated — same
// layout as ChatInteractionState.swift.

public enum FileViewerMode: String, Sendable, Hashable, CaseIterable {
    case diff
    case file
}

public enum FileViewerDiffState: Equatable, Sendable {
    case loading
    /// Diff succeeded but printed nothing (no changes on this side).
    case empty
    case failed(String)
    /// Raw unified-diff stdout, non-empty per the model's
    /// `hasRenderableDiff` probe.
    case ready(unifiedDiff: String)
}

public enum FileViewerContentState: Equatable, Sendable {
    case loading
    case failed(String)
    case empty
    /// Undecodable or heuristically binary (web `isBinaryContent`).
    case binary
    /// Raw image bytes for `UIImage(data:)`.
    case image(data: Data, mimeType: String)
    /// `language` is the lowercased extension, fed to the code highlighter.
    case text(String, language: String?, isMarkdown: Bool)
}

/// Pure ports of the web `file.tsx` file-kind helpers, shared by
/// ``FileViewerModel`` and its tests.
public enum FileContentHeuristics {
    /// Web `IMAGE_MIME_BY_EXTENSION` (`file.tsx`).
    private static let imageMimeByExtension: [String: String] = [
        "apng": "image/apng",
        "avif": "image/avif",
        "bmp": "image/bmp",
        "gif": "image/gif",
        "ico": "image/x-icon",
        "jpeg": "image/jpeg",
        "jpg": "image/jpeg",
        "png": "image/png",
        "svg": "image/svg+xml",
        "tif": "image/tiff",
        "tiff": "image/tiff",
        "webp": "image/webp",
    ]

    public static func fileExtension(of path: String) -> String? {
        let parts = path.components(separatedBy: ".")
        guard parts.count > 1 else { return nil }
        let ext = (parts.last ?? "").lowercased()
        return ext.isEmpty ? nil : ext
    }

    public static func imageMimeType(of path: String) -> String? {
        fileExtension(of: path).flatMap { imageMimeByExtension[$0] }
    }

    /// Web `isMarkdownFile` (`file-markdown-preview.ts`): md / mdx only.
    public static func isMarkdownFile(_ path: String) -> Bool {
        let ext = fileExtension(of: path)
        return ext == "md" || ext == "mdx"
    }

    /// Web `isBinaryContent`: NUL, or > 10% control chars (excluding \t \n \r).
    public static func isBinaryContent(_ content: String) -> Bool {
        if content.isEmpty { return false }
        var total = 0
        var nonPrintable = 0
        for scalar in content.unicodeScalars {
            total += 1
            if scalar.value == 0 { return true }
            if scalar.value < 32 && scalar.value != 9 && scalar.value != 10 && scalar.value != 13 {
                nonPrintable += 1
            }
        }
        return Double(nonPrintable) / Double(total) > 0.1
    }

    /// Tolerant base64: strict first, then whitespace-stripped + re-padded
    /// (the hub emits clean padded base64; MIME-style line breaks and missing
    /// padding are accepted like the Android `Base64.getMimeDecoder()`).
    static func decodeBase64(_ base64: String) -> Data? {
        if let data = Data(base64Encoded: base64) {
            return data
        }
        let stripped = base64.filter { !$0.isWhitespace }
        let remainder = stripped.count % 4
        guard remainder != 1 else { return nil }
        let padded = remainder == 0
            ? stripped
            : stripped + String(repeating: "=", count: 4 - remainder)
        return Data(base64Encoded: padded)
    }

    /// `FileReadResponse` → viewer content (+ metadata), the Android
    /// `decodeContent` port: RPC failure → failed, empty/missing base64 →
    /// empty, undecodable → binary, image extension → image bytes, then the
    /// lossy-UTF-8 text with the binary heuristic.
    static func decode(
        _ response: FileReadResponse,
        path: String
    ) -> (state: FileViewerContentState, size: Int?, modified: Double?) {
        guard response.success else {
            return (.failed(response.error ?? "Failed to read file"), response.size, response.modified)
        }
        guard let base64 = response.content, !base64.isEmpty else {
            return (.empty, response.size, response.modified)
        }

        guard let bytes = decodeBase64(base64) else {
            // Undecodable payload — treat like the web's failed decode: binary.
            return (.binary, response.size, response.modified)
        }

        if let mime = imageMimeType(of: path) {
            return (.image(data: bytes, mimeType: mime), response.size, response.modified)
        }

        // Lossy UTF-8 (replacement characters), like the Android/web decode.
        let text = String(decoding: bytes, as: UTF8.self)
        if isBinaryContent(text) {
            return (.binary, response.size, response.modified)
        }
        if text.isEmpty {
            return (.empty, response.size, response.modified)
        }
        return (
            .text(text, language: fileExtension(of: path), isMarkdown: isMarkdownFile(path)),
            response.size,
            response.modified
        )
    }
}

/// One file, two modes (A-M4a; mirror of the Android `FileViewerViewModel`,
/// which mirrors web `file.tsx`): **diff** — `git-diff-file` stdout rendered
/// by the app through HapiUI's `DiffTextView`, with a staged/unstaged toggle
/// — and **full** — `file` read, base64-decoded into highlighted text,
/// markdown preview, or an image. Both loads run in parallel; like the web
/// page, the viewer auto-falls to full mode when the diff is empty/failed or
/// the file is an image, until the user (or the opening route) picked a mode
/// explicitly.
///
/// Layering note: the unified-diff *parser* lives in HapiUI (a rendering
/// model), which HapiClient must not depend on — so the diff state carries
/// the raw stdout and emptiness is judged through the injected
/// `hasRenderableDiff` probe (the app passes
/// `{ !UnifiedDiffParser.parse($0).isEmpty }`; the default only checks for
/// non-empty text).
@MainActor @Observable
public final class FileViewerModel {
    public typealias Mode = FileViewerMode
    public typealias DiffState = FileViewerDiffState
    public typealias ContentState = FileViewerContentState

    // MARK: - Observable state

    public let path: String
    public let fileName: String
    public private(set) var mode: Mode
    /// Which diff side is showing (the staged/unstaged toggle).
    public private(set) var staged: Bool
    public private(set) var diff: DiffState = .loading
    public private(set) var content: ContentState = .loading
    /// Markdown files: render preview instead of source (web default: preview).
    public private(set) var markdownPreview = true
    public private(set) var sizeBytes: Int?
    public private(set) var modifiedAt: Double?
    /// Requested line from a chat citation; shown as a hint chip (no
    /// per-line highlight — same trade-off as the Android screen).
    public let focusLine: Int?

    // MARK: - Wiring

    private let sessionId: String
    private let requester: any FilesRequesting
    private let hasRenderableDiff: @Sendable (String) -> Bool
    /// Explicit mode choice (initial `mode` arg or a chip tap) disables
    /// auto-fallback.
    private var modeChosen: Bool
    private var started = false
    @ObservationIgnored private var diffTask: Task<Void, Never>?

    public init(
        sessionId: String,
        path: String,
        initialStaged: Bool? = nil,
        initialMode: Mode? = nil,
        focusLine: Int? = nil,
        requester: any FilesRequesting,
        hasRenderableDiff: @escaping @Sendable (String) -> Bool = { !$0.isEmpty }
    ) {
        self.sessionId = sessionId
        self.path = path
        let lastSegment = path.components(separatedBy: "/").last ?? path
        self.fileName = lastSegment.isEmpty ? path : lastSegment
        self.mode = initialMode ?? .diff
        self.staged = initialStaged ?? false
        self.focusLine = focusLine
        self.requester = requester
        self.hasRenderableDiff = hasRenderableDiff
        self.modeChosen = initialMode != nil
    }

    public func start() {
        guard !started else { return }
        started = true
        loadDiff()
        loadContent()
    }

    public func refresh() {
        loadDiff()
        loadContent()
    }

    public func setMode(_ mode: Mode) {
        modeChosen = true
        self.mode = mode
    }

    /// Staged/unstaged toggle: reloads the diff for the other side.
    public func setStaged(_ staged: Bool) {
        guard self.staged != staged else { return }
        self.staged = staged
        loadDiff()
    }

    public func setMarkdownPreview(_ preview: Bool) {
        markdownPreview = preview
    }

    // MARK: - Diff

    private func loadDiff() {
        diffTask?.cancel()
        diff = .loading
        let staged = self.staged
        diffTask = Task {
            let next: DiffState
            do {
                let response = try await self.requester.gitDiffFile(
                    sessionId: self.sessionId,
                    path: self.path,
                    staged: staged
                )
                if !response.success {
                    next = .failed(response.error ?? response.stderr ?? "Failed to load diff")
                } else if let stdout = response.stdout, !stdout.isEmpty {
                    next = self.hasRenderableDiff(stdout) ? .ready(unifiedDiff: stdout) : .empty
                } else {
                    next = .empty
                }
            } catch is CancellationError {
                return
            } catch {
                next = .failed(FilesModel.errorMessage(error) ?? "Failed to load diff")
            }
            guard !Task.isCancelled else { return } // a newer side superseded this load
            self.diff = next
            self.autoSelectMode()
        }
    }

    // MARK: - Content

    private func loadContent() {
        Task {
            let decoded: (state: ContentState, size: Int?, modified: Double?)
            do {
                let response = try await self.requester.readSessionFile(
                    sessionId: self.sessionId,
                    path: self.path
                )
                decoded = FileContentHeuristics.decode(response, path: self.path)
            } catch is CancellationError {
                return
            } catch {
                self.content = .failed(FilesModel.errorMessage(error) ?? "Failed to read file")
                return
            }
            self.content = decoded.state
            self.sizeBytes = decoded.size
            self.modifiedAt = decoded.modified
            self.autoSelectMode()
        }
    }

    // MARK: - Mode

    /// Web `file.tsx` effect: images always open full; an empty or failed
    /// diff falls back to full. Skipped once the user (or the route) chose a
    /// mode.
    private func autoSelectMode() {
        guard !modeChosen else { return }
        let shouldShowFile: Bool
        switch (content, diff) {
        case (.image, _), (_, .empty), (_, .failed):
            shouldShowFile = true
        default:
            shouldShowFile = false
        }
        if shouldShowFile && mode == .diff {
            mode = .file
        }
    }
}
