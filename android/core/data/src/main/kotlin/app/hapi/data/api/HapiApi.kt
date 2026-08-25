package app.hapi.data.api

import app.hapi.data.auth.HubUrls
import app.hapi.protocol.wire.AgentAvailabilityResponse
import app.hapi.protocol.wire.ApprovePermissionRequest
import app.hapi.protocol.wire.AuthRequest
import app.hapi.protocol.wire.AuthResponse
import app.hapi.protocol.wire.CancelMessageResponse
import app.hapi.protocol.wire.RetryIndeterminateMessageResponse
import app.hapi.protocol.wire.CodexModelsResponse
import app.hapi.protocol.wire.DeleteUploadRequest
import app.hapi.protocol.wire.DeleteUploadResponse
import app.hapi.protocol.wire.DenyPermissionRequest
import app.hapi.protocol.wire.FileReadResponse
import app.hapi.protocol.wire.FileSearchResponse
import app.hapi.protocol.wire.GitCommandResponse
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.HubHealthResponse
import app.hapi.protocol.wire.ListDirectoryResponse
import app.hapi.protocol.wire.MachineListDirectoryRequest
import app.hapi.protocol.wire.MachineListDirectoryResponse
import app.hapi.protocol.wire.MachinePathsExistsRequest
import app.hapi.protocol.wire.MachinePathsExistsResponse
import app.hapi.protocol.wire.MachinesResponse
import app.hapi.protocol.wire.MessagesResponse
import app.hapi.protocol.wire.QueuedStateRequest
import app.hapi.protocol.wire.QueuedStateResponse
import app.hapi.protocol.wire.RegisterDeviceRequest
import app.hapi.protocol.wire.RenameMachineRequest
import app.hapi.protocol.wire.RenameSessionRequest
import app.hapi.protocol.wire.ReopenSessionResponse
import app.hapi.protocol.wire.ResumeSessionRequest
import app.hapi.protocol.wire.ResumeSessionResponse
import app.hapi.protocol.wire.ScratchlistEntriesResponse
import app.hapi.protocol.wire.ScratchlistEntryCreateRequest
import app.hapi.protocol.wire.ScratchlistEntryResponse
import app.hapi.protocol.wire.ScratchlistEntryUpdateRequest
import app.hapi.protocol.wire.ScratchlistLimitsResponse
import app.hapi.protocol.wire.ScratchlistUploadResponse
import app.hapi.protocol.wire.SendMessageRequest
import app.hapi.protocol.wire.SessionResponse
import app.hapi.protocol.wire.SessionsResponse
import app.hapi.protocol.wire.SetSessionPinRequest
import app.hapi.protocol.wire.SkillsResponse
import app.hapi.protocol.wire.SlashCommandsResponse
import app.hapi.protocol.wire.SpawnResponse
import app.hapi.protocol.wire.SpawnSessionRequest
import app.hapi.protocol.wire.SqliteStorageUsageResponse
import app.hapi.protocol.wire.SteerQueuedMessageResponse
import app.hapi.protocol.wire.TranscriptionProvidersResponse
import app.hapi.protocol.wire.TranscriptionResponse
import app.hapi.protocol.wire.UnregisterDeviceRequest
import app.hapi.protocol.wire.UpdateSessionSummaryRequest
import app.hapi.protocol.wire.UploadFileRequest
import app.hapi.protocol.wire.UploadFileResponse
import app.hapi.protocol.wire.UsageSummaryResponse
import app.hapi.protocol.wire.VisibilityRequest
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/** Raw generated-image payload (`GET /api/sessions/:id/generated-images/:imageId`). */
class GeneratedImage(
    val bytes: ByteArray,
    /** `Content-Type` response header, e.g. `image/png`. */
    val mimeType: String?,
)

/** Raw scratchlist-attachment payload (`GET /api/sessions/:id/scratchlist/attachments/:attachmentId`). */
class ScratchlistAttachmentFile(
    val bytes: ByteArray,
    /** `Content-Type` response header (stored attachment metadata). */
    val mimeType: String?,
)

/**
 * Typed REST surface of one hub — plain OkHttp + kotlinx.serialization
 * ([HapiJson]), one suspend method per endpoint, all funneled through
 * [request]. Paths/queries/bodies per `docs/api/client-contract/rest.md`;
 * `web/src/api/client.ts` is the reference consumer.
 *
 * - [client] carries `AuthInterceptor` + `TokenAuthenticator` (silent 401
 *   re-auth); every `/api` method uses it.
 * - [imageClient] is [client] plus a disk `Cache` for the immutable
 *   generated-image bytes (the hub sends `ETag` + `immutable`, so OkHttp
 *   revalidates with `If-None-Match` and answers 304s from disk).
 * - [authClient] is the bare client: `POST /api/auth` (unauthenticated by
 *   definition, and must not recurse into the authenticator) and `GET /health`
 *   (outside `/api`, no auth).
 *
 * Non-2xx responses throw [ApiError]. RPC-wrapped endpoints (slash-commands,
 * skills, uploads, list-directory, spawn, …) can also fail with HTTP 200 +
 * `{success: false}` — callers must check the envelope
 * (`docs/api/client-contract/errors.md#rpc-wrapped-endpoints`).
 */
class HapiApi internal constructor(
    baseUrl: HttpUrl,
    private val client: OkHttpClient,
    private val imageClient: OkHttpClient = client,
    private val authClient: OkHttpClient = client,
) : ChatSessionApi {
    /** Public production entry point: cleartext hub origins are rejected. */
    constructor(
        hubUrl: String,
        client: OkHttpClient,
        imageClient: OkHttpClient = client,
        authClient: OkHttpClient = client,
    ) : this(
        baseUrl = requireHttpsBaseUrl(hubUrl),
        client = client,
        imageClient = imageClient,
        authClient = authClient,
    )

    private val baseUrl: HttpUrl = baseUrl.newBuilder()
        .encodedPath("/")
        .query(null)
        .fragment(null)
        .build()

    /** Normalized hub origin this instance talks to. */
    val hubUrl: String = baseUrl.toString().removeSuffix("/")

    // ---------------------------------------------------------------- core --

    /**
     * Shared transport: build → await → status check → decode. `Unit` reads
     * skip decoding (the many `{ok: true}` bodies carry no information beyond
     * 2xx). OkHttp follows the request's `Accept-Encoding: gzip` default, so
     * hub-gzipped JSON is decompressed transparently.
     */
    @Suppress("UNCHECKED_CAST")
    private suspend inline fun <reified T> request(
        method: String,
        url: HttpUrl,
        body: RequestBody? = null,
        client: OkHttpClient = this.client,
    ): T {
        val request = Request.Builder().url(url).method(method, body).build()
        return client.newCall(request).await().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw ApiError.from(response.code, text)
            if (T::class == Unit::class) Unit as T else HapiJson.decodeFromString(text)
        }
    }

    /** URL builder; each segment is percent-encoded (`encodeURIComponent` twin). */
    private fun url(vararg segments: String): HttpUrl.Builder =
        baseUrl.newBuilder().apply { segments.forEach(::addPathSegment) }

    private inline fun <reified T> T.toJsonBody(): RequestBody =
        HapiJson.encodeToString(this).toRequestBody(JSON_MEDIA_TYPE)

    private fun jsonBody(element: JsonElement): RequestBody =
        element.toString().toRequestBody(JSON_MEDIA_TYPE)

    // ------------------------------------------------------ health & auth --

    /** `GET /health` — no auth, outside `/api`. */
    suspend fun health(): HubHealthResponse =
        request("GET", url("health").build(), client = authClient)

    /**
     * `POST /api/auth` — exchanges the pairing access token for a 4-hour JWT.
     * Initial pairing entry point; steady-state refresh belongs to
     * `TokenAuthenticator`. 401 here means the token was rejected (re-pair).
     */
    suspend fun authenticate(accessToken: String): AuthResponse =
        request("POST", url("api", "auth").build(), AuthRequest(accessToken).toJsonBody(), authClient)

    // ------------------------------------------------------------ sessions --

    /** `GET /api/sessions` — `order = "updatedAt"` for pure recency. */
    suspend fun getSessions(limit: Int? = null, order: String? = null): SessionsResponse {
        val target = url("api", "sessions").apply {
            limit?.let { addQueryParameter("limit", it.toString()) }
            order?.let { addQueryParameter("order", it) }
        }
        return request("GET", target.build())
    }

    /** `GET /api/sessions/:id`. */
    suspend fun getSession(sessionId: String): SessionResponse =
        request("GET", url("api", "sessions", sessionId).build())

    /**
     * `GET /api/sessions/:id/messages`. Cursors are `(seq, at)` pairs that
     * always travel together; `epoch` accompanies the `after` cursor and a
     * mismatch makes the hub answer the latest page with `reset: true`
     * (`docs/api/client-contract/pagination.md`). Parameters pass through
     * unvalidated, like the web reference — the hub 400s bad combinations.
     */
    suspend fun getMessages(
        sessionId: String,
        limit: Int? = null,
        beforeSeq: Long? = null,
        beforeAt: Long? = null,
        afterSeq: Long? = null,
        afterAt: Long? = null,
        untilSeq: Long? = null,
        untilAt: Long? = null,
        epoch: Long? = null,
    ): MessagesResponse {
        val target = url("api", "sessions", sessionId, "messages").apply {
            beforeAt?.let { addQueryParameter("beforeAt", it.toString()) }
            beforeSeq?.let { addQueryParameter("beforeSeq", it.toString()) }
            afterAt?.let { addQueryParameter("afterAt", it.toString()) }
            afterSeq?.let { addQueryParameter("afterSeq", it.toString()) }
            untilAt?.let { addQueryParameter("untilAt", it.toString()) }
            untilSeq?.let { addQueryParameter("untilSeq", it.toString()) }
            epoch?.let { addQueryParameter("epoch", it.toString()) }
            limit?.let { addQueryParameter("limit", it.toString()) }
        }
        return request("GET", target.build())
    }

    /** [MessagesApi] seam over [getMessages] — the window store's transport. */
    override suspend fun getMessages(sessionId: String, query: MessagesQuery): MessagesResponse = when (query) {
        is MessagesQuery.Latest -> getMessages(sessionId, limit = query.limit)
        is MessagesQuery.Before -> getMessages(
            sessionId,
            limit = query.limit,
            beforeSeq = query.beforeSeq,
            beforeAt = query.beforeAt,
        )
        is MessagesQuery.After -> getMessages(
            sessionId,
            limit = query.limit,
            afterSeq = query.afterSeq,
            afterAt = query.afterAt,
            untilSeq = query.untilSeq,
            untilAt = query.untilAt,
            epoch = query.epoch,
        )
    }

    /**
     * `POST /api/sessions/:id/messages` — responds `{ok: true}` only; the
     * message itself arrives via SSE (`message-received`), reconciled by
     * `localId`.
     */
    override suspend fun sendMessage(sessionId: String, message: SendMessageRequest) {
        request<Unit>("POST", url("api", "sessions", sessionId, "messages").build(), message.toJsonBody())
    }

    /** `DELETE /api/sessions/:id/messages/:messageId` — cancel a queued message. */
    override suspend fun cancelMessage(sessionId: String, messageId: String): CancelMessageResponse =
        request("DELETE", url("api", "sessions", sessionId, "messages", messageId).build())

    override suspend fun retryIndeterminateMessage(sessionId: String, messageId: String): RetryIndeterminateMessageResponse =
        request("POST", url("api", "sessions", sessionId, "messages", messageId, "retry").build(), EMPTY_JSON)

    /** `POST /api/sessions/:id/messages/:messageId/steer`. */
    override suspend fun steerMessage(sessionId: String, messageId: String): SteerQueuedMessageResponse =
        request("POST", url("api", "sessions", sessionId, "messages", messageId, "steer").build(), EMPTY_JSON)

    /** `POST /api/sessions/:id/messages/queued-state` — resync optimistic sends after reconnect. */
    override suspend fun getQueuedState(sessionId: String, localIds: List<String>): QueuedStateResponse =
        request(
            "POST",
            url("api", "sessions", sessionId, "messages", "queued-state").build(),
            QueuedStateRequest(localIds).toJsonBody(),
        )

    /** `POST /api/sessions/:id/abort` — active sessions only. */
    override suspend fun abortSession(sessionId: String) {
        request<Unit>("POST", url("api", "sessions", sessionId, "abort").build(), EMPTY_JSON)
    }

    /** `POST /api/sessions/:id/switch` — hand a terminal-controlled session to remote control. */
    suspend fun switchSession(sessionId: String) {
        request<Unit>("POST", url("api", "sessions", sessionId, "switch").build(), EMPTY_JSON)
    }

    /**
     * `POST /api/sessions/:id/resume`. The returned `sessionId` may differ
     * from [sessionId] (superseding spawn) — migrate drafts and navigation.
     */
    override suspend fun resumeSession(sessionId: String, permissionMode: String?): ResumeSessionResponse =
        request(
            "POST",
            url("api", "sessions", sessionId, "resume").build(),
            ResumeSessionRequest(permissionMode).toJsonBody(),
        )

    /** `POST /api/sessions/:id/reopen` — same superseding-id caveat as resume; 422 when metadata is incomplete. */
    suspend fun reopenSession(sessionId: String): ReopenSessionResponse =
        request("POST", url("api", "sessions", sessionId, "reopen").build(), EMPTY_JSON)

    /** `POST /api/sessions/:id/archive` — 409 for a plain inactive session. */
    suspend fun archiveSession(sessionId: String) {
        request<Unit>("POST", url("api", "sessions", sessionId, "archive").build(), EMPTY_JSON)
    }

    /** `DELETE /api/sessions/:id` — 409 while active (archive first). */
    suspend fun deleteSession(sessionId: String) {
        request<Unit>("DELETE", url("api", "sessions", sessionId).build())
    }

    /** `PATCH /api/sessions/:id` — rename (1–255 chars). */
    suspend fun renameSession(sessionId: String, name: String) {
        request<Unit>("PATCH", url("api", "sessions", sessionId).build(), RenameSessionRequest(name).toJsonBody())
    }

    /** `PATCH /api/sessions/:id/summary` (1–255 chars). */
    suspend fun updateSessionSummary(sessionId: String, text: String) {
        request<Unit>(
            "PATCH",
            url("api", "sessions", sessionId, "summary").build(),
            UpdateSessionSummaryRequest(text).toJsonBody(),
        )
    }

    /** `PUT /api/sessions/:id/pin` — mode `'none' | 'project' | 'global'`. */
    suspend fun setSessionPinMode(sessionId: String, mode: String) {
        request<Unit>("PUT", url("api", "sessions", sessionId, "pin").build(), SetSessionPinRequest(mode).toJsonBody())
    }

    // --------------------------------------------------------- permissions --

    /**
     * `POST /api/sessions/:id/permissions/:requestId/approve`. 404 when the
     * request is no longer pending; 409 `session_inactive` on an inactive
     * session (offer Reopen).
     */
    override suspend fun approvePermission(
        sessionId: String,
        requestId: String,
        options: ApprovePermissionRequest,
    ) {
        request<Unit>(
            "POST",
            url("api", "sessions", sessionId, "permissions", requestId, "approve").build(),
            options.toJsonBody(),
        )
    }

    /** `POST /api/sessions/:id/permissions/:requestId/deny`. */
    override suspend fun denyPermission(sessionId: String, requestId: String, decision: String?) {
        request<Unit>(
            "POST",
            url("api", "sessions", sessionId, "permissions", requestId, "deny").build(),
            DenyPermissionRequest(decision).toJsonBody(),
        )
    }

    // ------------------------------------------- session config (per flavor) --
    // All respond `{ok: true}`; wrong flavor → 400, apply-failure → 409.
    // Clearing endpoints need an explicit JSON `null`, which HapiJson's
    // `explicitNulls = false` would drop from a DTO — hence raw JsonObjects.

    /** `POST /api/sessions/:id/permission-mode` — allowed set per flavor (`modes.ts`). */
    override suspend fun setPermissionMode(sessionId: String, mode: String) {
        request<Unit>(
            "POST",
            url("api", "sessions", sessionId, "permission-mode").build(),
            jsonBody(buildJsonObject { put("mode", mode) }),
        )
    }

    /** `POST /api/sessions/:id/model` — string id, or null to clear back to the agent default. */
    override suspend fun setModel(sessionId: String, model: String?) {
        setModelElement(sessionId, model?.let(::JsonPrimitive) ?: JsonNull)
    }

    /** `POST /api/sessions/:id/model` — `{provider, modelId}` variant (pi). */
    suspend fun setModel(sessionId: String, provider: String, modelId: String) {
        setModelElement(
            sessionId,
            buildJsonObject {
                put("provider", provider)
                put("modelId", modelId)
            },
        )
    }

    private suspend fun setModelElement(sessionId: String, model: JsonElement) {
        request<Unit>(
            "POST",
            url("api", "sessions", sessionId, "model").build(),
            jsonBody(buildJsonObject { put("model", model) }),
        )
    }

    /** `POST /api/sessions/:id/model-reasoning-effort` (codex, opencode) — null clears. */
    override suspend fun setModelReasoningEffort(sessionId: String, modelReasoningEffort: String?) {
        request<Unit>(
            "POST",
            url("api", "sessions", sessionId, "model-reasoning-effort").build(),
            jsonBody(
                buildJsonObject {
                    put("modelReasoningEffort", modelReasoningEffort?.let(::JsonPrimitive) ?: JsonNull)
                }
            ),
        )
    }

    /** `POST /api/sessions/:id/effort` (claude, grok, pi) — null clears. */
    override suspend fun setEffort(sessionId: String, effort: String?) {
        request<Unit>(
            "POST",
            url("api", "sessions", sessionId, "effort").build(),
            jsonBody(buildJsonObject { put("effort", effort?.let(::JsonPrimitive) ?: JsonNull) }),
        )
    }

    /** `POST /api/sessions/:id/service-tier` (codex) — `'fast' | 'standard'` (standard = explicit off). */
    suspend fun setServiceTier(sessionId: String, serviceTier: String) {
        request<Unit>(
            "POST",
            url("api", "sessions", sessionId, "service-tier").build(),
            jsonBody(buildJsonObject { put("serviceTier", serviceTier) }),
        )
    }

    /** `POST /api/sessions/:id/collaboration-mode` (codex) — `'default' | 'plan'`. */
    suspend fun setCollaborationMode(sessionId: String, mode: String) {
        request<Unit>(
            "POST",
            url("api", "sessions", sessionId, "collaboration-mode").build(),
            jsonBody(buildJsonObject { put("mode", mode) }),
        )
    }

    /** `POST /api/sessions/:id/copilot-agent-mode` (copilot). */
    suspend fun setCopilotAgentMode(sessionId: String, mode: String) {
        request<Unit>(
            "POST",
            url("api", "sessions", sessionId, "copilot-agent-mode").build(),
            jsonBody(buildJsonObject { put("mode", mode) }),
        )
    }

    /**
     * `GET /api/sessions/:id/codex-models` — active codex session's model
     * catalog (RPC-wrapped: check `success`; 400 on other flavors).
     */
    override suspend fun getSessionCodexModels(sessionId: String): CodexModelsResponse =
        request("GET", url("api", "sessions", sessionId, "codex-models").build())

    // ------------------------------------------------- commands & skills --

    /** `GET /api/sessions/:id/slash-commands` (RPC-wrapped: check `success`). */
    override suspend fun getSlashCommands(sessionId: String): SlashCommandsResponse =
        request("GET", url("api", "sessions", sessionId, "slash-commands").build())

    /** `GET /api/sessions/:id/skills` (RPC-wrapped: check `success`). */
    suspend fun getSkills(sessionId: String): SkillsResponse =
        request("GET", url("api", "sessions", sessionId, "skills").build())

    // ------------------------------------------------------------ machines --

    /** `GET /api/machines` — online machines in the caller's namespace. */
    suspend fun getMachines(): MachinesResponse =
        request("GET", url("api", "machines").build())

    /** `PATCH /api/machines/:id` — empty [displayName] clears back to the hostname. */
    suspend fun renameMachine(machineId: String, displayName: String) {
        request<Unit>(
            "PATCH",
            url("api", "machines", machineId).build(),
            RenameMachineRequest(displayName).toJsonBody(),
        )
    }

    /**
     * `POST /api/machines/:id/spawn`. The response discriminates on `type`,
     * not HTTP status — a failed spawn is still HTTP 200 with `type: 'error'`.
     */
    suspend fun spawnSession(machineId: String, spawn: SpawnSessionRequest): SpawnResponse =
        request("POST", url("api", "machines", machineId, "spawn").build(), spawn.toJsonBody())

    /** Installed/static-configured Agents reported by the selected runner. */
    suspend fun getMachineAgentAvailability(machineId: String): AgentAvailabilityResponse =
        request("GET", url("api", "machines", machineId, "agent-availability").build())

    /** `POST /api/machines/:id/list-directory` (RPC-wrapped: check `success`). */
    suspend fun listMachineDirectory(
        machineId: String,
        path: String,
        includeHidden: Boolean = false,
    ): MachineListDirectoryResponse =
        request(
            "POST",
            url("api", "machines", machineId, "list-directory").build(),
            MachineListDirectoryRequest(path, includeHidden).toJsonBody(),
        )

    /** `POST /api/machines/:id/paths/exists` (≤ 1000 paths). */
    suspend fun checkMachinePathsExist(machineId: String, paths: List<String>): MachinePathsExistsResponse =
        request(
            "POST",
            url("api", "machines", machineId, "paths", "exists").build(),
            MachinePathsExistsRequest(paths).toJsonBody(),
        )

    /**
     * `GET /api/machines/:id/codex-models` — pre-spawn codex model catalog
     * (RPC-wrapped: check `success`). A runner without the machine RPC answers
     * 503 with code `rpc_target_missing` → [ApiError]; callers hide the picker
     * (web ref: `useCodexModels`). Added in B-M3d.
     */
    suspend fun getMachineCodexModels(machineId: String): CodexModelsResponse =
        request("GET", url("api", "machines", machineId, "codex-models").build())

    // --------------------------------------------------------- git & files --
    // RAW-stdout contract (`docs/api/client-contract/rest.md` "Git & files"):
    // the hub relays git output verbatim inside `GitCommandResponse.stdout`;
    // parsing happens client-side in `app.hapi.protocol.git`. All six are
    // RPC-wrapped — check `success` (HTTP 200 + `{success:false}` is normal).

    /** `GET /api/sessions/:id/git-status` — raw `git status --porcelain=v2 --branch` stdout. */
    suspend fun getGitStatus(sessionId: String): GitCommandResponse =
        request("GET", url("api", "sessions", sessionId, "git-status").build())

    /** `GET /api/sessions/:id/git-diff-numstat?staged=` — raw `git diff --numstat` stdout. */
    suspend fun getGitDiffNumstat(sessionId: String, staged: Boolean): GitCommandResponse {
        val target = url("api", "sessions", sessionId, "git-diff-numstat")
            .addQueryParameter("staged", staged.toString())
        return request("GET", target.build())
    }

    /** `GET /api/sessions/:id/git-diff-file?path=&staged=` — raw unified diff for one file. */
    suspend fun getGitDiffFile(sessionId: String, path: String, staged: Boolean? = null): GitCommandResponse {
        val target = url("api", "sessions", sessionId, "git-diff-file")
            .addQueryParameter("path", path)
            .apply { staged?.let { addQueryParameter("staged", it.toString()) } }
        return request("GET", target.build())
    }

    /** `GET /api/sessions/:id/file?path=` — `content` is base64; decode before display. */
    suspend fun readSessionFile(sessionId: String, path: String): FileReadResponse {
        val target = url("api", "sessions", sessionId, "file")
            .addQueryParameter("path", path)
        return request("GET", target.build())
    }

    /** `GET /api/sessions/:id/files?query=&limit=` — ripgrep-backed search (limit 1–500, default 200). */
    suspend fun searchSessionFiles(sessionId: String, query: String, limit: Int? = null): FileSearchResponse {
        val target = url("api", "sessions", sessionId, "files").apply {
            if (query.isNotEmpty()) addQueryParameter("query", query)
            limit?.let { addQueryParameter("limit", it.toString()) }
        }
        return request("GET", target.build())
    }

    /** `GET /api/sessions/:id/directory?path=` — omitted path lists the session root. */
    suspend fun listSessionDirectory(sessionId: String, path: String? = null): ListDirectoryResponse {
        val target = url("api", "sessions", sessionId, "directory").apply {
            if (!path.isNullOrEmpty()) addQueryParameter("path", path)
        }
        return request("GET", target.build())
    }

    // ---------------------------------------------------------- visibility --

    /**
     * `POST /api/visibility` — report foreground/background for the SSE
     * subscription so the hub can suppress redundant push. 404 when the
     * subscription is gone (reconnect will mint a new id).
     */
    suspend fun setVisibility(subscriptionId: String, visibility: String) {
        request<Unit>(
            "POST",
            url("api", "visibility").build(),
            VisibilityRequest(subscriptionId, visibility).toJsonBody(),
        )
    }

    // ------------------------------------------------------------- images --

    /**
     * `GET /api/sessions/:id/generated-images/:imageId` — raw bytes. Rides
     * [imageClient]'s disk cache: the image id is an immutable content
     * fingerprint doubling as the `ETag`, so revalidation is a 304 without the
     * CLI round-trip and repeat views are served from disk.
     */
    suspend fun getGeneratedImage(sessionId: String, imageId: String): GeneratedImage {
        val target = url("api", "sessions", sessionId, "generated-images", imageId).build()
        return imageClient.newCall(Request.Builder().url(target).build()).await().use { response ->
            if (!response.isSuccessful) {
                throw ApiError.from(response.code, response.body?.string().orEmpty())
            }
            GeneratedImage(
                bytes = response.body?.bytes() ?: ByteArray(0),
                mimeType = response.header("Content-Type"),
            )
        }
    }

    // ------------------------------------------------------------ uploads --

    /**
     * `POST /api/sessions/:id/upload` — JSON + base64 [contentBase64] (NOT
     * multipart), ≤ 50 MB decoded → 413. The returned `path` feeds the
     * `attachments` of send-message.
     */
    override suspend fun uploadFile(
        sessionId: String,
        filename: String,
        contentBase64: String,
        mimeType: String,
    ): UploadFileResponse =
        request(
            "POST",
            url("api", "sessions", sessionId, "upload").build(),
            UploadFileRequest(filename, contentBase64, mimeType).toJsonBody(),
        )

    /** `POST /api/sessions/:id/upload/delete`. */
    override suspend fun deleteUpload(sessionId: String, path: String): DeleteUploadResponse =
        request(
            "POST",
            url("api", "sessions", sessionId, "upload", "delete").build(),
            DeleteUploadRequest(path).toJsonBody(),
        )

    // ---------------------------------------------------- usage & storage --
    // Owner-only dashboards: both 403 unless the JWT namespace is `default`
    // (`docs/api/client-contract/rest.md#usage--storage-owner-only`).

    /**
     * `GET /api/usage/summary?range=7d|30d|all&timeZone=<IANA>` — token-usage
     * dashboard aggregates. The hub validates [timeZone] (400 when invalid)
     * and buckets `daily` by that zone's calendar days.
     */
    suspend fun getUsageSummary(range: String = "7d", timeZone: String = "UTC"): UsageSummaryResponse {
        val target = url("api", "usage", "summary")
            .addQueryParameter("range", range)
            .addQueryParameter("timeZone", timeZone)
        return request("GET", target.build())
    }

    /** `GET /api/storage/sqlite` — hub db/wal/shm file sizes. */
    suspend fun getSqliteStorageUsage(): SqliteStorageUsageResponse =
        request("GET", url("api", "storage", "sqlite").build())

    // --------------------------------------------------------- scratchlist --
    // Per-session operator notes (tiann/hapi#893, B-M4d). Mutations bump
    // `scratchlistUpdatedAt` in the session's SSE patch — a bare refetch
    // trigger for [getScratchlist]. Error codes:
    // `app.hapi.protocol.wire.ScratchlistErrorCodes`.

    /** `GET /api/sessions/:id/scratchlist` — all entries, `createdAt DESC`. */
    suspend fun getScratchlist(sessionId: String): ScratchlistEntriesResponse =
        request("GET", url("api", "sessions", sessionId, "scratchlist").build())

    /**
     * `POST /api/sessions/:id/scratchlist` — 201 with the canonical row; 200
     * when [ScratchlistEntryCreateRequest.entryId] already exists (idempotent
     * retry); 409 `scratchlist_at_cap` at 200 entries.
     */
    suspend fun createScratchlistEntry(
        sessionId: String,
        body: ScratchlistEntryCreateRequest,
    ): ScratchlistEntryResponse =
        request("POST", url("api", "sessions", sessionId, "scratchlist").build(), body.toJsonBody())

    /** `PUT /api/sessions/:id/scratchlist/:entryId` — 404 when the entry is gone. */
    suspend fun updateScratchlistEntry(
        sessionId: String,
        entryId: String,
        body: ScratchlistEntryUpdateRequest,
    ): ScratchlistEntryResponse =
        request("PUT", url("api", "sessions", sessionId, "scratchlist", entryId).build(), body.toJsonBody())

    /** `DELETE /api/sessions/:id/scratchlist/:entryId` — 404 when already gone. */
    suspend fun deleteScratchlistEntry(sessionId: String, entryId: String) {
        request<Unit>("DELETE", url("api", "sessions", sessionId, "scratchlist", entryId).build())
    }

    /** `GET /api/sessions/:id/scratchlist/limits` — attachment size/count/byte budgets. */
    suspend fun getScratchlistLimits(sessionId: String): ScratchlistLimitsResponse =
        request("GET", url("api", "sessions", sessionId, "scratchlist", "limits").build())

    /**
     * `POST /api/sessions/:id/scratchlist/upload` — JSON + base64 (NOT
     * multipart), same body shape as the CLI upload. Over
     * `limits.maxBytesPerFile` → 413 `scratchlist_attachment_too_large`.
     */
    suspend fun uploadScratchlistAttachment(
        sessionId: String,
        filename: String,
        contentBase64: String,
        mimeType: String,
    ): ScratchlistUploadResponse =
        request(
            "POST",
            url("api", "sessions", sessionId, "scratchlist", "upload").build(),
            UploadFileRequest(filename, contentBase64, mimeType).toJsonBody(),
        )

    /**
     * `GET /api/sessions/:id/scratchlist/attachments/:attachmentId` — raw
     * bytes. Rides [imageClient] (auth + disk cache) like generated images;
     * attachment content is immutable per id, so any cache hit is safe.
     */
    suspend fun getScratchlistAttachment(sessionId: String, attachmentId: String): ScratchlistAttachmentFile {
        val target = url("api", "sessions", sessionId, "scratchlist", "attachments", attachmentId).build()
        return imageClient.newCall(Request.Builder().url(target).build()).await().use { response ->
            if (!response.isSuccessful) {
                throw ApiError.from(response.code, response.body?.string().orEmpty())
            }
            ScratchlistAttachmentFile(
                bytes = response.body?.bytes() ?: ByteArray(0),
                mimeType = response.header("Content-Type"),
            )
        }
    }

    /**
     * `DELETE /api/sessions/:id/scratchlist/attachments/:attachmentId` — 409
     * `scratchlist_attachment_in_use` while an entry still references it.
     */
    suspend fun deleteScratchlistAttachment(sessionId: String, attachmentId: String) {
        request<Unit>(
            "DELETE",
            url("api", "sessions", sessionId, "scratchlist", "attachments", attachmentId).build(),
        )
    }

    // ------------------------------------------------------------- devices --

    /** `POST /api/devices/register` (upsert) — FCM contract (`native-companion-contract.md`). */
    suspend fun registerDevice(token: String, deviceId: String, platform: String = "phone") {
        request<Unit>(
            "POST",
            url("api", "devices", "register").build(),
            RegisterDeviceRequest(token = token, platform = platform, deviceId = deviceId).toJsonBody(),
        )
    }

    /** `DELETE /api/devices/register` — call on unpair while the JWT is still valid. */
    suspend fun unregisterDevice(token: String) {
        request<Unit>(
            "DELETE",
            url("api", "devices", "register").build(),
            UnregisterDeviceRequest(token).toJsonBody(),
        )
    }

    // --------------------------------------------------------------- voice --

    /**
     * `GET /api/voice/transcription/providers` — providers whose keys are
     * configured on the hub. Dictation (B-M3ce) picks the first entry
     * supporting `standard`; an empty list means "no transcription provider
     * configured on hub".
     */
    suspend fun getTranscriptionProviders(): TranscriptionProvidersResponse =
        request("GET", url("api", "voice", "transcription", "providers").build())

    /**
     * `POST /api/voice/transcription` — the one `multipart/form-data`
     * endpoint: `file` (≤ 25 MB audio), `provider`, `mode`, optional
     * `language` (BCP-47-ish). Dictation lands in M3e; the transport helper
     * lives here with the rest of the surface.
     */
    suspend fun transcribeVoice(
        audio: ByteArray,
        filename: String,
        mimeType: String,
        provider: String,
        mode: String = "standard",
        language: String? = null,
    ): TranscriptionResponse {
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("file", filename, audio.toRequestBody(mimeType.toMediaType()))
            .addFormDataPart("provider", provider)
            .addFormDataPart("mode", mode)
            .apply { language?.let { addFormDataPart("language", it) } }
            .build()
        return request("POST", url("api", "voice", "transcription").build(), body)
    }

    private companion object {
        fun requireHttpsBaseUrl(raw: String): HttpUrl = HubUrls.normalize(raw)
            ?.toHttpUrl()
            ?: throw IllegalArgumentException("Invalid HTTPS hub URL: $raw")

        val JSON_MEDIA_TYPE = "application/json".toMediaType()

        /** Reusable `{}` body for POSTs whose zod schema is an empty object. */
        val EMPTY_JSON: RequestBody = "{}".toRequestBody(JSON_MEDIA_TYPE)
    }
}

/** Suspends over [Call.enqueue]; cancelling the coroutine cancels the call. */
internal suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) {
            // Close the response when the coroutine was cancelled in the
            // hand-off window, so the connection is not leaked.
            continuation.resume(response) { _, resp, _ -> resp.close() }
        }

        override fun onFailure(call: Call, e: IOException) {
            if (!continuation.isCancelled) continuation.resumeWithException(e)
        }
    })
    continuation.invokeOnCancellation { cancel() }
}
