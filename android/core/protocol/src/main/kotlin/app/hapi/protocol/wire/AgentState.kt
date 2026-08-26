package app.hapi.protocol.wire

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

/**
 * Session agent state (`AgentStateSchema`, `shared/src/schemas.ts`). Pending
 * permission / input requests live here — they are NOT chat messages
 * (`docs/api/client-contract/rest.md`, plan "核心协议事实").
 *
 * Closed zod enums (`startingMode`, request `status`/`decision`) are kept as
 * raw strings on the wire so a hub that grows a new value can never make an
 * entire `Session` undecodable; interpret them via `app.hapi.protocol.catalog`.
 */
@Serializable
data class AgentState(
    val controlledByUser: Boolean? = null,
    /** `'local' | 'remote' | 'pty'` — mode the session was started in. */
    val startingMode: String? = null,
    /** Pending requests keyed by request id (the `:rid` in the approve/deny routes). */
    val requests: Map<String, AgentStateRequest>? = null,
    /** Resolved requests keyed by request id. */
    val completedRequests: Map<String, AgentStateCompletedRequest>? = null,
)

/** A pending tool-permission / user-input request (`AgentStateRequestSchema`). */
@Serializable
data class AgentStateRequest(
    val tool: String,
    /** Tool arguments, shape depends on [tool] (zod `unknown`). */
    val arguments: JsonElement = JsonNull,
    val createdAt: Long? = null,
)

/** A resolved request (`AgentStateCompletedRequestSchema`). */
@Serializable
data class AgentStateCompletedRequest(
    val tool: String,
    val arguments: JsonElement = JsonNull,
    val createdAt: Long? = null,
    val completedAt: Long? = null,
    /** `'canceled' | 'denied' | 'approved'`. */
    val status: String,
    val reason: String? = null,
    val mode: String? = null,
    /** `'approved' | 'approved_for_session' | 'denied' | 'abort'`. */
    val decision: String? = null,
    val allowTools: List<String>? = null,
    /**
     * Answers to AskUserQuestion / request_user_input. Two wire formats:
     * flat `{question: string[]}` and nested `{question: {answers: string[]}}` —
     * kept raw until the permission-UX milestone needs them.
     */
    val answers: JsonElement? = null,
)
