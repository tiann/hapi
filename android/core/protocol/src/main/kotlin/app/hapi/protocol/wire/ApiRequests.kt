package app.hapi.protocol.wire

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Request bodies for the hub REST surface (`docs/api/client-contract/rest.md`;
 * zod sources in `shared/src/apiTypes.ts`, named per schema).
 *
 * Encoded with [HapiJson]: `explicitNulls = false` means Kotlin-`null` fields
 * are *omitted* from the wire body — matching the web client's `?? undefined`
 * convention. Bodies where an explicit JSON `null` is semantically different
 * from absence (the model/effort/service-tier config endpoints, which use
 * `null` to mean "clear") are built as raw `JsonObject`s in `:core:data`'s
 * `HapiApi` instead of living here.
 */

/** `POST /api/auth` (`AuthRequestSchema`, accessToken variant — natives never use `initData`). */
@Serializable
data class AuthRequest(
    val accessToken: String,
)

/**
 * `POST /api/sessions/:id/messages` (`SendMessageRequestSchema`).
 *
 * Cross-field rules enforced hub-side (400 on violation): text or attachments
 * required; `scheduledAt` requires [localId], must be ≤ 7 days out, and
 * excludes attachments and `deliveryMode: "steer"`.
 */
@Serializable
data class SendMessageRequest(
    val text: String,
    val localId: String? = null,
    val attachments: List<AttachmentMetadata>? = null,
    val scheduledAt: Long? = null,
    /** `'queue' | 'steer'` (`MessageDeliveryModeSchema`); absent = hub default (queue). */
    val deliveryMode: String? = null,
)

/** `POST /api/sessions/:id/messages/queued-state` (`QueuedStateRequestSchema`, ≤ 1000 ids). */
@Serializable
data class QueuedStateRequest(
    val localIds: List<String>,
)

/**
 * `POST /api/sessions/:id/permissions/:requestId/approve`
 * (`hub/src/web/routes/permissions.ts`).
 *
 * [answers] has two wire formats depending on the requesting tool — flat
 * `{question: [answer, ...]}` (AskUserQuestion) or nested
 * `{question: {answers: [...]}}` (request_user_input) — so it stays a raw
 * [JsonElement] built by the caller.
 */
@Serializable
data class ApprovePermissionRequest(
    /** Optionally switch permission mode while approving (validated per flavor). */
    val mode: String? = null,
    val allowTools: List<String>? = null,
    /** `'approved' | 'approved_for_session' | 'denied' | 'abort'`. */
    val decision: String? = null,
    val answers: JsonElement? = null,
)

/** `POST /api/sessions/:id/permissions/:requestId/deny`. */
@Serializable
data class DenyPermissionRequest(
    /** `'approved' | 'approved_for_session' | 'denied' | 'abort'`. */
    val decision: String? = null,
)

/** `POST /api/sessions/:id/resume` (`ResumeSessionRequestSchema`). */
@Serializable
data class ResumeSessionRequest(
    val permissionMode: String? = null,
)

/** `PATCH /api/sessions/:id` (`RenameSessionRequestSchema`, 1–255 chars). */
@Serializable
data class RenameSessionRequest(
    val name: String,
)

/** `PATCH /api/sessions/:id/summary` (`UpdateSessionSummaryRequestSchema`, 1–255 chars). */
@Serializable
data class UpdateSessionSummaryRequest(
    val text: String,
)

/** `PUT /api/sessions/:id/pin` (`SetSessionPinnedRequestSchema`). */
@Serializable
data class SetSessionPinRequest(
    /** `'none' | 'project' | 'global'`. */
    val mode: String,
)

/** `POST /api/machines/:id/spawn` (`SpawnSessionRequestSchema`). */
@Serializable
data class SpawnSessionRequest(
    val directory: String,
    /** Agent flavor id (`AgentFlavorSchema`); absent = machine default. */
    val agent: String? = null,
    val model: String? = null,
    val effort: String? = null,
    val modelReasoningEffort: String? = null,
    val yolo: Boolean? = null,
    val permissionMode: String? = null,
    /** `'simple' | 'worktree'`. */
    val sessionType: String? = null,
    val worktreeName: String? = null,
    /** `'fast' | 'standard'` (codex). */
    val serviceTier: String? = null,
    /** `'default' | 'plan'` (codex). */
    val collaborationMode: String? = null,
    val copilotAgentMode: String? = null,
    /** `'remote' | 'pty'` (agy accepts only `remote`). */
    val startingMode: String? = null,
)

/**
 * `PATCH /api/machines/:id` (`RenameMachineRequestSchema`). An empty string
 * clears the custom name back to the hostname (hence no min-length).
 */
@Serializable
data class RenameMachineRequest(
    val displayName: String,
)

/** `POST /api/machines/:id/list-directory` (`MachineListDirectoryRequestSchema`). */
@Serializable
data class MachineListDirectoryRequest(
    val path: String,
    val includeHidden: Boolean? = null,
)

/** `POST /api/machines/:id/paths/exists` (`MachinePathsExistsRequestSchema`, ≤ 1000 paths). */
@Serializable
data class MachinePathsExistsRequest(
    val paths: List<String>,
)

/** `POST /api/sessions/:id/upload` (`UploadFileRequestSchema`; [content] is base64, ≤ 50 MB decoded). */
@Serializable
data class UploadFileRequest(
    val filename: String,
    val content: String,
    val mimeType: String,
)

/** `POST /api/sessions/:id/upload/delete` (`DeleteUploadRequestSchema`). */
@Serializable
data class DeleteUploadRequest(
    val path: String,
)

/**
 * `POST /api/devices/register` (upsert) — FCM push contract
 * (`docs/api/native-companion-contract.md`, `hub/src/web/routes/devices.ts`).
 */
@Serializable
data class RegisterDeviceRequest(
    /** FCM registration token. */
    val token: String,
    /** `'phone' | 'wear'`. */
    val platform: String,
    /** Any stable 1–128-char install id (persisted UUID). */
    val deviceId: String,
)

/** `DELETE /api/devices/register`. */
@Serializable
data class UnregisterDeviceRequest(
    val token: String,
)

/**
 * `POST /api/visibility` (`hub/src/web/routes/events.ts`). [subscriptionId]
 * comes from the SSE `connection-changed` event; reporting foreground /
 * background lets the hub suppress redundant push while the app is visible.
 */
@Serializable
data class VisibilityRequest(
    val subscriptionId: String,
    /** `'visible' | 'hidden'`. */
    val visibility: String,
)
