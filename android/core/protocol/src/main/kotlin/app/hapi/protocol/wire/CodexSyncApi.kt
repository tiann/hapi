package app.hapi.protocol.wire

import kotlinx.serialization.Serializable

/**
 * One local Codex session as listed by `GET /api/codex/sessions`
 * (`CodexLocalSessionSummary`, `shared/src/apiTypes.ts`; produced by
 * `hub/src/web/routes/codexDesktop.ts`). Messages are stripped server-side —
 * only the summary fields below ever travel.
 */
@Serializable
data class CodexLocalSessionSummary(
    val id: String,
    val title: String,
    val lastUserMessage: String? = null,
    val cwd: String? = null,
    /** Rollout file backing the session (`file`, always non-empty). */
    val file: String,
    /** Epoch ms. */
    val modifiedAt: Long,
    val originator: String? = null,
    val cliVersion: String? = null,
    val source: String? = null,
    /** `'user' | 'codex' | …` — Original badge when `'user'`. */
    val threadSource: String? = null,
    /** Non-blank ⇒ the session is a fork. */
    val forkedFromId: String? = null,
)

/**
 * `GET /api/codex/sessions?cwd=&machineId=` — flattened union, **not**
 * discriminated on HTTP status: a hub-side lookup failure still answers
 * HTTP 200 with `success:false, sessions:[]` (and a hard RPC failure answers
 * 503, which surfaces as `ApiError` before this body is decoded). Unlike the
 * other RPC-wrapped endpoints, the web caller deliberately ignores
 * `success` here (a failed probe yields an empty list) — callers decide.
 */
@Serializable
data class CodexLocalSessionsResponse(
    val success: Boolean = true,
    val sessions: List<CodexLocalSessionSummary> = emptyList(),
    /** Echoed back only when the request carried a `machineId`. */
    val machineId: String? = null,
    val error: String? = null,
)

/**
 * `POST /api/codex/sync-session` body (`CodexDesktopSyncRequest`,
 * `shared/src/apiTypes.ts`). Null fields are omitted (`explicitNulls=false`),
 * matching the web client's `?? undefined` sends.
 */
@Serializable
data class CodexDesktopSyncRequest(
    val sessionIds: List<String>,
    val cwd: String? = null,
    val machineId: String? = null,
    val model: String? = null,
    val modelReasoningEffort: String? = null,
    val serviceTier: String? = null,
    /** `'default' | 'plan'`; always sent by the import-at-create caller. */
    val collaborationMode: String? = null,
    val yolo: Boolean? = null,
)

/**
 * `POST /api/codex/sync-session` reply (`CodexDesktopScriptResponse`) — the
 * hub reuses one loose script-shaped envelope across desktop-helper calls.
 * Sync failures are **HTTP 200** with `success:false` + [error]; callers
 * must check [success]. Only [syncedCount]/[sessionIds]/[hapiSessionIds]
 * concern the import flows (the desktop-launch fields belong to sibling
 * endpoints that share the schema).
 */
@Serializable
data class CodexDesktopScriptResponse(
    val success: Boolean = true,
    val message: String? = null,
    val pid: Long? = null,
    val command: String? = null,
    val script: String? = null,
    val cwd: String? = null,
    val output: String? = null,
    val error: String? = null,
    val codexDesktopRunning: Boolean? = null,
    val codexClientAvailable: Boolean? = null,
    /** Number of sessions the hub actually imported. */
    val syncedCount: Int? = null,
    val sessionIds: List<String>? = null,
    /** Created Hapi session ids, parallel to [sessionIds] when present. */
    val hapiSessionIds: List<String>? = null,
)
