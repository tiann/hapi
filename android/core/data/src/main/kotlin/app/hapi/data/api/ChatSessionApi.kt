package app.hapi.data.api

import app.hapi.protocol.wire.ApprovePermissionRequest
import app.hapi.protocol.wire.CancelMessageResponse
import app.hapi.protocol.wire.RetryIndeterminateMessageResponse
import app.hapi.protocol.wire.CodexModelsResponse
import app.hapi.protocol.wire.DeleteUploadResponse
import app.hapi.protocol.wire.ResumeSessionResponse
import app.hapi.protocol.wire.SendMessageRequest
import app.hapi.protocol.wire.SlashCommandsResponse
import app.hapi.protocol.wire.SteerQueuedMessageResponse
import app.hapi.protocol.wire.UploadFileResponse

/**
 * Message-attachment upload seam (B-M3f). Split from [ChatSessionApi] so the
 * composer attachment controller can be tested against a two-method fake.
 */
interface AttachmentUploadApi {
    /**
     * `POST /api/sessions/:id/upload` — JSON + base64 (NOT multipart),
     * ≤ 50 MB decoded → 413. The returned `path` becomes
     * `AttachmentMetadata.path` in the send-message body.
     */
    suspend fun uploadFile(
        sessionId: String,
        filename: String,
        contentBase64: String,
        mimeType: String,
    ): UploadFileResponse

    /** `POST /api/sessions/:id/upload/delete` — best-effort orphan cleanup. */
    suspend fun deleteUpload(sessionId: String, path: String): DeleteUploadResponse
}

/**
 * The endpoint seam the chat interaction layer (B-M3ab) drives — send /
 * queued-message actions / abort-resume / permission decisions / per-flavor
 * session config. [HapiApi] is the production implementation; ViewModel tests
 * substitute a scripted fake and assert the exact request bodies.
 *
 * Extends [MessagesApi] so one fake covers the window store's transport too,
 * and [AttachmentUploadApi] for the composer attachment flow (B-M3f).
 */
interface ChatSessionApi : MessagesApi, AttachmentUploadApi {
    /** `POST /api/sessions/:id/messages` — `{ok:true}`; the row arrives via SSE. */
    suspend fun sendMessage(sessionId: String, message: SendMessageRequest)

    /** `DELETE /api/sessions/:id/messages/:messageId` — `cancelled` or `invoked` (too late). */
    suspend fun cancelMessage(sessionId: String, messageId: String): CancelMessageResponse

    /** `POST /api/sessions/:id/messages/:messageId/retry` — explicit unknown-delivery retry. */
    suspend fun retryIndeterminateMessage(sessionId: String, messageId: String): RetryIndeterminateMessageResponse

    /** `POST /api/sessions/:id/messages/:messageId/steer` — `steered`/`invoked`/`failed`. */
    suspend fun steerMessage(sessionId: String, messageId: String): SteerQueuedMessageResponse

    /** `POST /api/sessions/:id/abort` — active sessions only, confirm-free. */
    suspend fun abortSession(sessionId: String)

    /** `POST /api/sessions/:id/resume` — the returned id may differ (superseding spawn). */
    suspend fun resumeSession(sessionId: String, permissionMode: String? = null): ResumeSessionResponse

    /** `POST .../permissions/:rid/approve`; 404 not-pending, 409 `session_inactive`. */
    suspend fun approvePermission(
        sessionId: String,
        requestId: String,
        options: ApprovePermissionRequest = ApprovePermissionRequest(),
    )

    /** `POST .../permissions/:rid/deny` — [decision] is only ever `'abort'` or absent. */
    suspend fun denyPermission(sessionId: String, requestId: String, decision: String? = null)

    /** `POST /api/sessions/:id/permission-mode` — allowed set per flavor. */
    suspend fun setPermissionMode(sessionId: String, mode: String)

    /** `POST /api/sessions/:id/model` — string id, null clears to the agent default. */
    suspend fun setModel(sessionId: String, model: String?)

    /** `POST /api/sessions/:id/effort` (claude, grok, pi) — null clears. */
    suspend fun setEffort(sessionId: String, effort: String?)

    /** `POST /api/sessions/:id/model-reasoning-effort` (codex, opencode) — null clears. */
    suspend fun setModelReasoningEffort(sessionId: String, modelReasoningEffort: String?)

    /** `GET /api/sessions/:id/codex-models` (RPC-wrapped: check `success`). */
    suspend fun getSessionCodexModels(sessionId: String): CodexModelsResponse

    /**
     * `GET /api/sessions/:id/slash-commands` (RPC-wrapped: check `success`) —
     * the composer's `/` autocomplete source (B-M3ce), merged with the
     * session's `metadata.slashCommands` names.
     */
    suspend fun getSlashCommands(sessionId: String): SlashCommandsResponse
}
