package app.hapi.protocol.chat

import app.hapi.protocol.wire.TeamMember
import app.hapi.protocol.wire.TeamMemberStatus
import app.hapi.protocol.wire.TeamMessage
import app.hapi.protocol.wire.TeamState
import app.hapi.protocol.wire.TeamTask
import app.hapi.protocol.wire.TeamTaskStatus

/**
 * Rendering decisions for the team roster panel, derived purely from a
 * decoded [TeamState]. The hub owns the merge semantics (member/task updates
 * keyed by name/id, message ring buffer); this projection only normalizes
 * absent collections to empty, windows the message list to the most recent
 * few, and precomputes the counts the collapsed header shows. Members and
 * tasks keep their stored order — the roster is a mirror of hub state, never
 * re-sorted client-side.
 */

/** Status dot tone for a member row. */
enum class TeamMemberDot {
    /** Currently working (`active`). */
    ACTIVE,

    /** Asked to stop / stopped (`shutdown`). */
    SHUTDOWN,

    /** `idle`, absent or a status this build does not know. */
    NEUTRAL,
}

/** Glyph + tone decision for a task row. */
enum class TeamTaskMark {
    COMPLETED,
    IN_PROGRESS,
    BLOCKED,

    /** `pending`, absent or a status this build does not know. */
    PENDING,
}

/** Status dot for a member: only exact known spellings get a tinted dot. */
fun TeamMember.rosterDot(): TeamMemberDot = when (status) {
    TeamMemberStatus.ACTIVE -> TeamMemberDot.ACTIVE
    TeamMemberStatus.SHUTDOWN -> TeamMemberDot.SHUTDOWN
    else -> TeamMemberDot.NEUTRAL
}

/** Row mark for a task: only exact known spellings leave the neutral branch. */
fun TeamTask.rosterMark(): TeamTaskMark = when (status) {
    TeamTaskStatus.COMPLETED -> TeamTaskMark.COMPLETED
    TeamTaskStatus.IN_PROGRESS -> TeamTaskMark.IN_PROGRESS
    TeamTaskStatus.BLOCKED -> TeamTaskMark.BLOCKED
    else -> TeamTaskMark.PENDING
}

/**
 * View-ready projection of a [TeamState].
 *
 * @param recentMessages the tail of the stored message list (most recent
 *   last, stored order preserved), capped at [TeamRosterModel.RECENT_MESSAGE_LIMIT].
 */
data class TeamRosterModel(
    val teamName: String = "",
    val description: String? = null,
    val members: List<TeamMember> = emptyList(),
    val tasks: List<TeamTask> = emptyList(),
    val recentMessages: List<TeamMessage> = emptyList(),
) {
    /** How many of the tracked tasks are completed. */
    val completedTaskCount: Int get() = tasks.count { it.rosterMark() == TeamTaskMark.COMPLETED }

    /** Members whose status is exactly `active`. */
    val activeMemberCount: Int get() = members.count { it.rosterDot() == TeamMemberDot.ACTIVE }

    /** The task counter only appears once the team tracks any task. */
    val showsTaskProgress: Boolean get() = tasks.isNotEmpty()

    /** The "(N active)" segment only appears when at least one member is active. */
    val showsActiveMembers: Boolean get() = activeMemberCount > 0

    /** True only for exactly one member — drives the singular noun form. */
    val usesSingularMemberNoun: Boolean get() = members.size == 1

    companion object {
        const val RECENT_MESSAGE_LIMIT = 5
    }
}

/**
 * Projects a decoded team state into a roster model: absent collections
 * become empty, the message list is windowed to its tail, everything else
 * passes through in stored order.
 */
fun TeamState.toTeamRosterModel(): TeamRosterModel = TeamRosterModel(
    teamName = teamName,
    description = description,
    members = members.orEmpty(),
    tasks = tasks.orEmpty(),
    recentMessages = messages.orEmpty().takeLast(TeamRosterModel.RECENT_MESSAGE_LIMIT),
)
