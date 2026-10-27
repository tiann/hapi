package app.hapi.protocol.wire

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Subagent team roster attached to a session (`TeamStateSchema` and friends,
 * `shared/src/schemas.ts`). The hub maintains this state from team-related
 * tool calls (team create/delete, member-spawning tasks, task updates,
 * member-to-member messages) and stores it verbatim on the session record;
 * clients replace it wholesale via the versioned `teamState` patch and never
 * synthesize it locally.
 *
 * zod-exactness notes:
 * - `teamName` is the only mandatory field of the state object; every other
 *   field is optional and defaults here (absent array = "not tracked", the
 *   roster renders it as empty).
 * - Closed zod enums (`TeamMember.status`, `TeamTask.status`,
 *   `TeamMessage.type`) are kept as raw strings: a hub that grows a new value
 *   must not make the roster undecodable; unknown values fall back to the
 *   neutral branch at render time.
 * - Numeric timestamps are `z.number()` on the wire and may arrive
 *   fractional; decoded through [LenientEpochMs].
 */
@Serializable
data class TeamState(
    val teamName: String = "",
    val description: String? = null,
    val members: List<TeamMember>? = null,
    val tasks: List<TeamTask>? = null,
    val messages: List<TeamMessage>? = null,
    /** Hub write clock; not rendered. May arrive fractional (see [LenientEpochMs]). */
    @Serializable(with = LenientEpochMs::class)
    val updatedAt: Long? = null,
)

/** One named agent in the team (`TeamMemberSchema`). */
@Serializable
data class TeamMember(
    val name: String = "",
    /** Spawned agent flavor, e.g. `"general-purpose"`. */
    val agentType: String? = null,
    /** One of [TeamMemberStatus]; null while the hub has not reported one. */
    val status: String? = null,
)

/** One tracked work item (`TeamTaskSchema`). */
@Serializable
data class TeamTask(
    val id: String = "",
    val title: String = "",
    val description: String? = null,
    /** One of [TeamTaskStatus]; null renders like pending. */
    val status: String? = null,
    /** Member name responsible for this task. */
    val owner: String? = null,
)

/** One agent-to-agent message (`TeamMessageSchema`). */
@Serializable
data class TeamMessage(
    val from: String = "",
    /** Recipient name, or `"all"` for broadcasts. */
    val to: String = "",
    val summary: String = "",
    /** One of [TeamMessageType]. */
    val type: String = TeamMessageType.MESSAGE,
    /** Hub receive clock, epoch ms; may arrive fractional (see [LenientEpochMs]). */
    @Serializable(with = LenientEpochMs::class)
    val timestamp: Long? = null,
)

/** `TeamMember.status` values (zod enum). */
object TeamMemberStatus {
    const val ACTIVE = "active"
    const val IDLE = "idle"
    const val SHUTDOWN = "shutdown"
}

/** `TeamTask.status` values (zod enum). */
object TeamTaskStatus {
    const val PENDING = "pending"
    const val IN_PROGRESS = "in_progress"
    const val COMPLETED = "completed"
    const val BLOCKED = "blocked"
}

/** `TeamMessage.type` values (zod enum). */
object TeamMessageType {
    const val MESSAGE = "message"
    const val BROADCAST = "broadcast"
    const val SHUTDOWN_REQUEST = "shutdown_request"
    const val SHUTDOWN_RESPONSE = "shutdown_response"
}

/**
 * Decodes the raw `teamState` element of a session record into a typed
 * roster. The element is only shallowly validated on the patch path, and a
 * full-session payload carries it unvalidated, so decoding must stay
 * defensive: anything that is not a decodable team object (null after a team
 * disband, arrays, strings, malformed members) yields `null` and the roster
 * stays hidden — a broken panel must never break the chat screen.
 */
fun decodeTeamState(element: JsonElement?): TeamState? {
    if (element !is JsonObject) return null
    return runCatching {
        HapiJson.decodeFromJsonElement(TeamState.serializer(), element)
    }.getOrNull()
}
