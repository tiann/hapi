import Foundation

// Wire types of the git & files surface (A-M4a):
// `docs/api/client-contract/rest.md` "Git & files"; shapes from
// `shared/src/apiTypes.ts` (`CommandResponse`, `FileReadResponse`,
// `FileSearchResponse`, `ListDirectoryResponse`), field-for-field in lockstep
// with the Android port (`app.hapi.protocol.wire.FilesApi`). All are
// RPC-wrapped — HTTP 200 with `success: false` is a normal failure, callers
// must check. The session `DirectoryEntry` row already lives in
// `ApiResponses.swift` (shared with the machine list-directory RPC family).

/// `GET /api/sessions/:id/git-status|git-diff-numstat|git-diff-file` —
/// `CommandResponse`: the hub relays raw git stdout verbatim; clients parse
/// it themselves (`HapiProtocol/Git/` twins `web/src/lib/gitParsers.ts`).
public struct GitCommandResponse: Codable, Equatable, Sendable {
    public var success: Bool
    public var stdout: String?
    public var stderr: String?
    public var exitCode: Int?
    public var error: String?

    public init(
        success: Bool,
        stdout: String? = nil,
        stderr: String? = nil,
        exitCode: Int? = nil,
        error: String? = nil
    ) {
        self.success = success
        self.stdout = stdout
        self.stderr = stderr
        self.exitCode = exitCode
        self.error = error
    }
}

/// `GET /api/sessions/:id/file?path=` — `content` is **base64** (decode
/// before display).
public struct FileReadResponse: Codable, Equatable, Sendable {
    public var success: Bool
    public var content: String?
    /// Bytes on disk.
    public var size: Int?
    /// Epoch ms.
    public var modified: Double?
    public var error: String?

    public init(
        success: Bool,
        content: String? = nil,
        size: Int? = nil,
        modified: Double? = nil,
        error: String? = nil
    ) {
        self.success = success
        self.content = content
        self.size = size
        self.modified = modified
        self.error = error
    }
}

/// `GET /api/sessions/:id/files?query=&limit=` (ripgrep-backed search).
public struct FileSearchResponse: Codable, Equatable, Sendable {
    public var success: Bool
    public var files: [FileSearchItem]?
    public var error: String?

    public init(success: Bool, files: [FileSearchItem]? = nil, error: String? = nil) {
        self.success = success
        self.files = files
        self.error = error
    }
}

public struct FileSearchItem: Codable, Equatable, Sendable {
    public var fileName: String
    /// Directory part; empty at the session root.
    public var filePath: String
    public var fullPath: String
    /// `'file' | 'folder'` (search results are files in practice).
    public var fileType: String
    public var size: Int?
    /// Epoch ms.
    public var modified: Double?

    public init(
        fileName: String,
        filePath: String,
        fullPath: String,
        fileType: String,
        size: Int? = nil,
        modified: Double? = nil
    ) {
        self.fileName = fileName
        self.filePath = filePath
        self.fullPath = fullPath
        self.fileType = fileType
        self.size = size
        self.modified = modified
    }
}

/// `GET /api/sessions/:id/directory?path=` — empty path = session root.
/// Entries are the shared session `DirectoryEntry` rows (`ApiResponses.swift`).
public struct ListDirectoryResponse: Codable, Equatable, Sendable {
    public var success: Bool
    public var entries: [DirectoryEntry]?
    public var error: String?

    public init(success: Bool, entries: [DirectoryEntry]? = nil, error: String? = nil) {
        self.success = success
        self.entries = entries
        self.error = error
    }
}
