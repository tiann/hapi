package app.hapi.protocol.wire

import kotlinx.serialization.Serializable

/**
 * One local Pi session as listed by `GET /api/pi/sessions`
 * (`PiLocalSessionSummary`, `web/src/types/api.ts`; produced by the hub's pi
 * scanner). Messages are stripped server-side — only the summary fields
 * below ever travel. Added for slice C (pi session import).
 */
@Serializable
data class PiLocalSessionSummary(
    val id: String,
    val title: String,
    val lastUserMessage: String? = null,
    val cwd: String? = null,
    /** Transcript file backing the session (`file`, always non-empty). */
    val file: String,
    /** Epoch ms. */
    val modifiedAt: Long,
    val model: String? = null,
    val thinkingLevel: String? = null,
    val leafEntryId: String? = null,
    val messageCount: Long = 0L,
    /** Present once this local session was already imported into Hapi. */
    val hapiSessionId: String? = null,
    /**
     * `'importing' | 'complete' | 'failed' | 'diverged'` — raw enum-string;
     * `diverged`/`failed` drive the Needs-attention badge. Unknown values
     * decode without error and match no badge.
     */
    val importState: String? = null,
)

/**
 * `GET /api/pi/sessions?cwd=&machineId=` — flattened union like the codex
 * twin, **but** the web Pi caller treats `success:false` as an error (unlike
 * codex, which silently renders the empty list): the policy lives in
 * `PiImportController`, decoding here stays flag-only. A hard RPC failure
 * answers 503, which surfaces as `ApiError` before this body is decoded.
 */
@Serializable
data class PiLocalSessionsResponse(
    val success: Boolean = true,
    val sessions: List<PiLocalSessionSummary> = emptyList(),
    /** Echoed back only when the request carried a `machineId`. */
    val machineId: String? = null,
    val error: String? = null,
)

/**
 * `POST /api/pi/import-sessions` body (`importPiSessions` payload). Null
 * fields are omitted (`explicitNulls=false`), matching the web client's
 * `?? undefined` / `|| null` sends.
 */
@Serializable
data class PiImportSessionsRequest(
    val sessionIds: List<String>,
    val cwd: String? = null,
    val machineId: String? = null,
)

/**
 * Per-item failure of `POST /api/pi/import-sessions` — [code] drives the
 * friendly mapping (`transcript_diverged` / `session_active`), [message] is
 * the pass-through fallback.
 */
@Serializable
data class PiImportError(
    val code: String? = null,
    val message: String? = null,
)

/**
 * One row of `POST /api/pi/import-sessions` results (`PiImportResult`):
 * which local session it covers, the Hapi session it created/updated
 * ([hapiSessionId] null = nothing imported), and the per-item [error].
 */
@Serializable
data class PiImportResult(
    val piSessionId: String,
    val hapiSessionId: String? = null,
    /** `'created' | 'updated' | 'unchanged'` — raw enum-string. */
    val action: String? = null,
    val appended: Long? = null,
    val error: PiImportError? = null,
)

/**
 * `POST /api/pi/import-sessions` reply (`PiImportSessionsResponse`) — the
 * envelope [success] flag exists but the web import callers score the batch
 * from [results] alone (`hapiSessionId && !error`), so decoding stays
 * flag-only here too.
 */
@Serializable
data class PiImportSessionsResponse(
    val success: Boolean = true,
    val results: List<PiImportResult> = emptyList(),
    val machineId: String? = null,
    val error: String? = null,
)
