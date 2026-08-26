package app.hapi.protocol.wire

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Full session row (`SessionSchema`, `shared/src/schemas.ts` — verified
 * field-by-field). Sent by `GET /api/sessions/:id` and as the "full session"
 * variant of the `session-updated` SSE event.
 *
 * All timestamps are epoch milliseconds ([Long]). `metadataVersion` /
 * `agentStateVersion` are hub-side write counters; `todosUpdatedAt` /
 * `teamStateUpdatedAt` are epoch-ms watermarks — all four gate versioned
 * patches (see `app.hapi.protocol.patch.SessionPatching`).
 *
 * zod-exactness notes:
 * - `activeAt` is `nullish` with a `?? 0` transform in zod → default 0 here
 *   ([HapiJson] coerces an explicit `null` to the default).
 * - `model`/`modelReasoningEffort`/`effort`/`serviceTier` default to `null`
 *   in zod → nullable with `null` default.
 * - `permissionMode`/`collaborationMode`/`copilotAgentMode` are strict zod
 *   enums; kept as raw strings for forward compatibility (a new hub-side mode
 *   must not make the session undecodable) — interpret via
 *   `app.hapi.protocol.catalog`. Legacy `copilotAgentMode: 'fleet'` is
 *   likewise normalized there, not at decode time.
 * - `teamState` stays a raw [JsonElement]: nothing in v1 renders its inner
 *   structure, only replaces it wholesale via versioned patches.
 */
@Serializable
data class Session(
    val id: String,
    val namespace: String,
    val seq: Long,
    val createdAt: Long,
    val updatedAt: Long,
    val pinned: Boolean? = null,
    val globalPinned: Boolean? = null,
    val active: Boolean,
    val activeAt: Long = 0,
    val metadata: SessionMetadata? = null,
    val metadataVersion: Long,
    val agentState: AgentState? = null,
    val agentStateVersion: Long,
    val thinking: Boolean,
    val thinkingAt: Long,
    val activeTurnStartedAt: Long? = null,
    val backgroundTaskCount: Int? = null,
    val todos: List<TodoItem>? = null,
    val teamState: JsonElement? = null,
    val todosUpdatedAt: Long? = null,
    val teamStateUpdatedAt: Long? = null,
    val model: String? = null,
    val modelReasoningEffort: String? = null,
    val effort: String? = null,
    val serviceTier: String? = null,
    val permissionMode: String? = null,
    val collaborationMode: String? = null,
    val copilotAgentMode: String? = null,
)

/**
 * One TodoWrite item (`TodoItemSchema`). zod defaults `priority` to
 * `'medium'` and `id` to `''`; replicated as Kotlin defaults.
 */
@Serializable
data class TodoItem(
    val content: String,
    /** `'pending' | 'in_progress' | 'completed'`. */
    val status: String,
    val priority: String = "medium",
    val id: String = "",
    val activeForm: String? = null,
)
