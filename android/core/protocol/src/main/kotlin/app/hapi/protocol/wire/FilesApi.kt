package app.hapi.protocol.wire

import kotlinx.serialization.Serializable

// Wire types of the git & files surface (B-M4c):
// `docs/api/client-contract/rest.md` "Git & files"; shapes from
// `shared/src/apiTypes.ts` (`CommandResponse`, `FileReadResponse`,
// `FileSearchResponse`, `ListDirectoryResponse`). All are RPC-wrapped —
// HTTP 200 with `success: false` is a normal failure, callers must check.

/**
 * `GET /api/sessions/:id/git-status|git-diff-numstat|git-diff-file` —
 * `CommandResponse`: the hub relays raw git stdout verbatim; clients parse it
 * themselves (`app.hapi.protocol.git` twins `web/src/lib/gitParsers.ts`).
 */
@Serializable
data class GitCommandResponse(
    val success: Boolean,
    val stdout: String? = null,
    val stderr: String? = null,
    val exitCode: Int? = null,
    val error: String? = null,
)

/** `GET /api/sessions/:id/file?path=` — [content] is **base64** (decode before display). */
@Serializable
data class FileReadResponse(
    val success: Boolean,
    val content: String? = null,
    /** Bytes on disk. */
    val size: Long? = null,
    /** Epoch ms (fs mtime — may arrive fractional; see [LenientEpochMs]). */
    @Serializable(with = LenientEpochMs::class)
    val modified: Long? = null,
    val error: String? = null,
)

/** `GET /api/sessions/:id/files?query=&limit=` (ripgrep-backed search). */
@Serializable
data class FileSearchResponse(
    val success: Boolean,
    val files: List<FileSearchItem>? = null,
    val error: String? = null,
)

@Serializable
data class FileSearchItem(
    val fileName: String,
    /** Directory part; empty at the session root. */
    val filePath: String,
    val fullPath: String,
    /** `'file' | 'folder'` (search results are files in practice). */
    val fileType: String,
    val size: Long? = null,
    /** Epoch ms (fs mtime — may arrive fractional; see [LenientEpochMs]). */
    @Serializable(with = LenientEpochMs::class)
    val modified: Long? = null,
)

/** `GET /api/sessions/:id/directory?path=` — empty path = session root. */
@Serializable
data class ListDirectoryResponse(
    val success: Boolean,
    val entries: List<DirectoryEntry>? = null,
    val error: String? = null,
)

/**
 * `DirectoryEntry` (`shared/src/apiTypes.ts`). The machine-RPC twin with
 * `isGitRepo` is [MachineDirectoryEntry].
 */
@Serializable
data class DirectoryEntry(
    val name: String,
    /** `'file' | 'directory' | 'other'`. */
    val type: String,
    val size: Long? = null,
    /** Epoch ms (fs mtime — may arrive fractional; see [LenientEpochMs]). */
    @Serializable(with = LenientEpochMs::class)
    val modified: Long? = null,
)
