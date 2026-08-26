package app.hapi.companion.feature.files

import app.hapi.data.api.HapiApi
import app.hapi.protocol.wire.FileReadResponse
import app.hapi.protocol.wire.FileSearchResponse
import app.hapi.protocol.wire.GitCommandResponse
import app.hapi.protocol.wire.ListDirectoryResponse

/**
 * The git/files REST surface the files feature consumes — a seam over
 * [HapiApi] so [FilesViewModel]/[FileViewerViewModel] tests run against fakes
 * (same pattern as `NewSessionGateway`). All six endpoints are RPC-wrapped:
 * check `success` on the body; transport failures throw.
 */
interface FilesGateway {
    suspend fun gitStatus(sessionId: String): GitCommandResponse
    suspend fun gitDiffNumstat(sessionId: String, staged: Boolean): GitCommandResponse
    suspend fun gitDiffFile(sessionId: String, path: String, staged: Boolean?): GitCommandResponse
    suspend fun readFile(sessionId: String, path: String): FileReadResponse
    suspend fun searchFiles(sessionId: String, query: String, limit: Int): FileSearchResponse

    /** [path] is relative to the session root; null lists the root itself. */
    suspend fun listDirectory(sessionId: String, path: String?): ListDirectoryResponse
}

class ApiFilesGateway(private val api: HapiApi) : FilesGateway {
    override suspend fun gitStatus(sessionId: String): GitCommandResponse =
        api.getGitStatus(sessionId)

    override suspend fun gitDiffNumstat(sessionId: String, staged: Boolean): GitCommandResponse =
        api.getGitDiffNumstat(sessionId, staged)

    override suspend fun gitDiffFile(sessionId: String, path: String, staged: Boolean?): GitCommandResponse =
        api.getGitDiffFile(sessionId, path, staged)

    override suspend fun readFile(sessionId: String, path: String): FileReadResponse =
        api.readSessionFile(sessionId, path)

    override suspend fun searchFiles(sessionId: String, query: String, limit: Int): FileSearchResponse =
        api.searchSessionFiles(sessionId, query, limit)

    override suspend fun listDirectory(sessionId: String, path: String?): ListDirectoryResponse =
        api.listSessionDirectory(sessionId, path)
}
