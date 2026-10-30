package app.hapi.protocol.wire

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.builtins.ListSerializer

/**
 * Decoding of the session's team-state element (`TeamStateSchema`,
 * `shared/src/schemas.ts`) — pins the hub payload shape: mandatory teamName,
 * optional collections, closed enums as raw strings, fractional timestamps,
 * unknown keys ignored at every level.
 */
class TeamDecodingTest {

    @Test
    fun `decodes a fully populated team state`() {
        val state = HapiJson.decodeFromString(
            TeamState.serializer(),
            """
            {
              "teamName": "release-crew",
              "description": "Ship the native release",
              "members": [
                {"name": "lead", "agentType": null, "status": "idle"},
                {"name": "scout", "agentType": "general-purpose", "status": "active"},
                {"name": "builder"}
              ],
              "tasks": [
                {"id": "t-1", "title": "Audit diffs", "description": "Read every hunk",
                 "status": "in_progress", "owner": "scout"},
                {"id": "t-2", "title": "Tag build", "status": "completed"}
              ],
              "messages": [
                {"from": "lead", "to": "all", "summary": "Start audit",
                 "type": "broadcast", "timestamp": 1755000001000},
                {"from": "scout", "to": "lead", "summary": "Found a leak",
                 "type": "message", "timestamp": 1755000002500}
              ],
              "updatedAt": 1755000003000
            }
            """
        )

        assertEquals("release-crew", state.teamName)
        assertEquals("Ship the native release", state.description)

        val members = assertNotNull(state.members)
        assertEquals(3, members.size)
        assertEquals("lead", members[0].name)
        assertNull(members[0].agentType)
        assertEquals("idle", members[0].status)
        assertEquals("general-purpose", members[1].agentType)
        assertEquals("active", members[1].status)
        // Absent optional fields decode to null, not defaults that invent data.
        assertEquals("builder", members[2].name)
        assertNull(members[2].agentType)
        assertNull(members[2].status)

        val tasks = assertNotNull(state.tasks)
        assertEquals(2, tasks.size)
        assertEquals("Audit diffs", tasks[0].title)
        assertEquals("in_progress", tasks[0].status)
        assertEquals("scout", tasks[0].owner)
        assertNull(tasks[1].owner)

        val messages = assertNotNull(state.messages)
        assertEquals(2, messages.size)
        assertEquals("broadcast", messages[0].type)
        assertEquals(1755000001000L, messages[0].timestamp)
        assertEquals("message", messages[1].type)

        assertEquals(1755000003000L, state.updatedAt)
    }

    @Test
    fun `teamName is the only mandatory field`() {
        val state = HapiJson.decodeFromString(
            TeamState.serializer(),
            """{"teamName": "solo"}"""
        )
        assertEquals("solo", state.teamName)
        assertNull(state.description)
        assertNull(state.members)
        assertNull(state.tasks)
        assertNull(state.messages)
        assertNull(state.updatedAt)
    }

    @Test
    fun `unknown keys and future enum values stay decodable`() {
        val state = HapiJson.decodeFromString(
            TeamState.serializer(),
            """
            {
              "teamName": "crew",
              "futureField": {"anything": true},
              "members": [{"name": "a", "status": "paused", "future": 1}],
              "tasks": [{"id": "1", "title": "t", "status": "under_review"}],
              "messages": [{"from": "a", "to": "b", "summary": "s",
                             "type": "future_kind", "timestamp": 5}]
            }
            """
        )
        // Unknown enum values pass through as raw strings; the roster renders
        // them through the neutral branch instead of failing the session.
        assertEquals("paused", state.members!!.single().status)
        assertEquals("under_review", state.tasks!!.single().status)
        assertEquals("future_kind", state.messages!!.single().type)
    }

    @Test
    fun `fractional timestamps truncate to whole milliseconds`() {
        val state = HapiJson.decodeFromString(
            TeamState.serializer(),
            """
            {
              "teamName": "crew",
              "messages": [{"from": "a", "to": "b", "summary": "s",
                             "type": "message", "timestamp": 1755000002500.1177}],
              "updatedAt": 1755000003000.9
            }
            """
        )
        assertEquals(1755000002500L, state.messages!!.single().timestamp)
        assertEquals(1755000003000L, state.updatedAt)
    }

    @Test
    fun `explicit nulls coerce to defaults`() {
        val state = HapiJson.decodeFromString(
            TeamState.serializer(),
            """
            {
              "teamName": null,
              "members": null,
              "messages": [{"from": null, "to": "b", "summary": null,
                             "type": null, "timestamp": null}]
            }
            """
        )
        // coerceInputValues: JSON null on a defaulted property falls back to
        // the default rather than failing the whole roster.
        assertEquals("", state.teamName)
        assertNull(state.members)
        val message = state.messages!!.single()
        assertEquals("", message.from)
        assertEquals("b", message.to)
        assertEquals("", message.summary)
        assertEquals(TeamMessageType.MESSAGE, message.type)
        assertNull(message.timestamp)
    }

    @Test
    fun `decodeTeamState accepts objects and rejects everything else`() {
        val teamObject = Json.parseToJsonElement(
            """{"teamName": "crew", "members": [{"name": "a", "status": "active"}]}"""
        )
        val state = assertNotNull(decodeTeamState(teamObject))
        assertEquals("crew", state.teamName)
        assertEquals("active", state.members!!.single().status)

        assertNull(decodeTeamState(null))
        assertNull(decodeTeamState(kotlinx.serialization.json.JsonNull))
        assertNull(decodeTeamState(JsonPrimitive("crew")))
        assertNull(decodeTeamState(Json.parseToJsonElement("[1, 2]")))
    }

    @Test
    fun `decodeTeamState degrades to null on structurally wrong members`() {
        // A member that is not an object cannot be decoded; the roster hides
        // instead of throwing out of the session pipeline.
        val broken = Json.parseToJsonElement(
            """{"teamName": "crew", "members": [{"name": "a"}, 17]}"""
        )
        assertNull(decodeTeamState(broken))
    }

    @Test
    fun `member and message lists round-trip through their serializers`() {
        // Encoding sanity for the raw-string enums and lenient timestamps.
        val member = TeamMember(name = "a", agentType = "probe", status = TeamMemberStatus.SHUTDOWN)
        val task = TeamTask(id = "1", title = "t", status = TeamTaskStatus.BLOCKED, owner = "a")
        val message = TeamMessage(
            from = "a", to = "lead", summary = "done",
            type = TeamMessageType.SHUTDOWN_RESPONSE, timestamp = 42,
        )
        val encoded = HapiJson.encodeToString(
            ListSerializer(TeamState.serializer()),
            listOf(TeamState(teamName = "crew", members = listOf(member), tasks = listOf(task), messages = listOf(message))),
        )
        val decoded = HapiJson.decodeFromString(ListSerializer(TeamState.serializer()), encoded).single()
        assertEquals(member, decoded.members!!.single())
        assertEquals(task, decoded.tasks!!.single())
        assertEquals(message, decoded.messages!!.single())
        assertTrue(encoded.contains("\"status\":\"shutdown\""))
    }
}
