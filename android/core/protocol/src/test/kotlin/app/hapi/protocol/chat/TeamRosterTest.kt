package app.hapi.protocol.chat

import app.hapi.protocol.wire.TeamMember
import app.hapi.protocol.wire.TeamMessage
import app.hapi.protocol.wire.TeamState
import app.hapi.protocol.wire.TeamTask
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Test

/**
 * Rendering decisions of the team roster panel: member status dots, task
 * marks, stored-order pass-through, the five-message window and the header
 * count/segment decisions.
 */
class TeamRosterTest {

    private fun member(name: String, status: String? = null, agentType: String? = null) =
        TeamMember(name = name, agentType = agentType, status = status)

    private fun task(id: String, title: String, status: String? = null, owner: String? = null) =
        TeamTask(id = id, title = title, status = status, owner = owner)

    private fun message(from: String, to: String = "lead") =
        TeamMessage(from = from, to = to, summary = "note from $from", type = "message", timestamp = 0)

    @Test
    fun `member status maps to exactly three dot tones`() {
        assertEquals(TeamMemberDot.ACTIVE, member("a", status = "active").rosterDot())
        assertEquals(TeamMemberDot.SHUTDOWN, member("a", status = "shutdown").rosterDot())
        // idle, absent and unrecognized statuses all share the neutral dot.
        assertEquals(TeamMemberDot.NEUTRAL, member("a", status = "idle").rosterDot())
        assertEquals(TeamMemberDot.NEUTRAL, member("a").rosterDot())
        assertEquals(TeamMemberDot.NEUTRAL, member("a", status = "paused").rosterDot())
    }

    @Test
    fun `task status maps to exactly four marks`() {
        assertEquals(TeamTaskMark.COMPLETED, task("1", "t", status = "completed").rosterMark())
        assertEquals(TeamTaskMark.IN_PROGRESS, task("1", "t", status = "in_progress").rosterMark())
        assertEquals(TeamTaskMark.BLOCKED, task("1", "t", status = "blocked").rosterMark())
        assertEquals(TeamTaskMark.PENDING, task("1", "t", status = "pending").rosterMark())
        // Absent and unrecognized statuses render like pending.
        assertEquals(TeamTaskMark.PENDING, task("1", "t").rosterMark())
        assertEquals(TeamTaskMark.PENDING, task("1", "t", status = "under_review").rosterMark())
    }

    @Test
    fun `absent collections project to empty and order is preserved`() {
        val roster = TeamState(teamName = "solo").toTeamRosterModel()
        assertEquals("solo", roster.teamName)
        assertEmptyCollections(roster)
        assertFalse(roster.showsTaskProgress)

        val ordered = TeamState(
            teamName = "crew",
            members = listOf(member("zeta"), member("alpha"), member("mid")),
            tasks = listOf(task("t3", "third"), task("t1", "first"), task("t2", "second")),
        ).toTeamRosterModel()
        // The roster mirrors hub state — members and tasks are never re-sorted.
        assertEquals(listOf("zeta", "alpha", "mid"), ordered.members.map { it.name })
        assertEquals(listOf("third", "first", "second"), ordered.tasks.map { it.title })
    }

    private fun assertEmptyCollections(roster: TeamRosterModel) {
        assertTrue(roster.members.isEmpty())
        assertTrue(roster.tasks.isEmpty())
        assertTrue(roster.recentMessages.isEmpty())
    }

    @Test
    fun `recent messages keep the last five in stored order`() {
        val all = (1..7).map { message("agent-$it") }
        val roster = TeamState(teamName = "crew", messages = all).toTeamRosterModel()
        // Oldest two drop off; the survivors stay chronological, newest last.
        assertEquals(
            listOf("agent-3", "agent-4", "agent-5", "agent-6", "agent-7"),
            roster.recentMessages.map { it.from },
        )

        val few = TeamState(teamName = "crew", messages = all.take(2)).toTeamRosterModel()
        assertEquals(listOf("agent-1", "agent-2"), few.recentMessages.map { it.from })
    }

    @Test
    fun `header counts only recognize exact status spellings`() {
        val roster = TeamState(
            teamName = "crew",
            members = listOf(
                member("a", status = "active"),
                member("b", status = "active"),
                member("c", status = "idle"),
                member("d"),
                member("e", status = "paused"),
            ),
            tasks = listOf(
                task("1", "done", status = "completed"),
                task("2", "wip", status = "in_progress"),
                task("3", "blocked", status = "blocked"),
                task("4", "open"),
                task("5", "unknown", status = "under_review"),
            ),
        ).toTeamRosterModel()

        assertEquals(2, roster.activeMemberCount)
        assertEquals(1, roster.completedTaskCount)
        assertTrue(roster.showsActiveMembers)
        assertTrue(roster.showsTaskProgress)
        // Five members is not exactly one — plural noun form.
        assertFalse(roster.usesSingularMemberNoun)
    }

    @Test
    fun `single member uses the singular noun form`() {
        val one = TeamState(
            teamName = "pair",
            members = listOf(member("solo", status = "idle")),
        ).toTeamRosterModel()
        assertTrue(one.usesSingularMemberNoun)
        // Idle-only team hides the "(N active)" segment.
        assertFalse(one.showsActiveMembers)

        val none = TeamState(teamName = "empty").toTeamRosterModel()
        // Zero members is plural ("0 members"), matching the header rule of
        // "not exactly one".
        assertFalse(none.usesSingularMemberNoun)
        assertFalse(none.showsActiveMembers)
        assertFalse(none.showsTaskProgress)
    }
}
