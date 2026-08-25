package app.hapi.protocol.wire

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Full-payload decoding for [Session], [SessionSummary] and [MessagesResponse]
 * — the "full session" branch of `session-updated` and the REST list/detail/
 * messages responses. Exercises the [HapiJson] leniency rules the models rely
 * on (unknown keys ignored, `nullish` coercion, absent nullables).
 */
class SessionDecodingTest {

    @Test
    fun `decodes a realistic full session with lenient metadata`() {
        val session = HapiJson.decodeFromString(
            Session.serializer(),
            """
            {
              "id": "sess-1",
              "namespace": "default",
              "seq": 12,
              "createdAt": 1755000000000,
              "updatedAt": 1755000005000,
              "active": true,
              "activeAt": null,
              "metadata": {
                "path": "/data/github/hapi",
                "host": "devbox",
                "name": "protocol port",
                "flavor": "claude",
                "startingMode": "remote",
                "summary": {"text": "Porting wire models", "updatedAt": 1755000004000},
                "worktree": {"basePath": "/data/github/hapi", "branch": "native-apps", "name": "na"},
                "capabilities": {"terminal": true, "conversationHistory": {"forkCurrent": true}},
                "slashCommands": ["compact", "clear"],
                "claudeSessionId": "unmodeled-field-must-be-ignored",
                "homeDir": "/home/dev",
                "hostPid": 4242
              },
              "metadataVersion": 3,
              "agentState": {
                "controlledByUser": null,
                "requests": {
                  "req-1": {"tool": "Bash", "arguments": {"command": "ls"}, "createdAt": 1755000004500}
                },
                "completedRequests": {
                  "req-0": {"tool": "Edit", "arguments": {}, "status": "approved",
                            "decision": "approved_for_session", "allowTools": ["Edit"],
                            "completedAt": 1755000003000}
                }
              },
              "agentStateVersion": 7,
              "thinking": true,
              "thinkingAt": 1755000004900,
              "activeTurnStartedAt": null,
              "todos": [{"content": "wire models", "status": "completed"},
                        {"content": "patch port", "status": "in_progress", "priority": "high", "id": "t2"}],
              "todosUpdatedAt": 1755000002000,
              "teamState": {"teamName": "crew", "members": []},
              "teamStateUpdatedAt": 5,
              "model": "claude-opus-4-1",
              "permissionMode": "acceptEdits",
              "pinned": true,
              "unknownFutureField": {"nested": true}
            }
            """
        )
        assertEquals("sess-1", session.id)
        assertEquals(12L, session.seq)
        // zod: activeAt nullish → ?? 0 (coerceInputValues handles the null).
        assertEquals(0L, session.activeAt)
        assertEquals(true, session.pinned)
        assertNull(session.globalPinned)

        val metadata = assertNotNull(session.metadata)
        assertEquals("/data/github/hapi", metadata.path)
        assertEquals("claude", metadata.flavor)
        assertEquals("remote", metadata.startingMode)
        assertEquals("Porting wire models", metadata.summary?.text)
        assertEquals("native-apps", metadata.worktree?.branch)
        assertEquals(true, metadata.capabilities?.terminal)
        assertEquals(true, metadata.capabilities?.conversationHistory?.forkCurrent)
        assertEquals(listOf("compact", "clear"), metadata.slashCommands)

        val agentState = assertNotNull(session.agentState)
        assertNull(agentState.controlledByUser)
        assertEquals("Bash", agentState.requests?.get("req-1")?.tool)
        val completed = assertNotNull(agentState.completedRequests?.get("req-0"))
        assertEquals("approved", completed.status)
        assertEquals("approved_for_session", completed.decision)
        assertEquals(listOf("Edit"), completed.allowTools)
        assertNull(completed.answers)

        assertEquals(2, session.todos?.size)
        assertEquals("medium", session.todos?.get(0)?.priority) // zod default
        assertEquals("", session.todos?.get(0)?.id)             // zod default
        assertEquals("high", session.todos?.get(1)?.priority)
        assertEquals("crew", session.teamState.objOrNull?.get("teamName").stringOrNull)
        assertEquals(1_755_000_002_000L, session.todosUpdatedAt)
        assertNull(session.activeTurnStartedAt)
        assertNull(session.serviceTier)  // zod .default(null)
        assertNull(session.effort)
        assertEquals("acceptEdits", session.permissionMode)
    }

    @Test
    fun `session decode fails without required fields - full-vs-patch discrimination`() {
        // A SessionPatch payload must NOT decode as a full Session (mirror of
        // SessionSchema.safeParse failing in the web reference).
        val patchLike = """{"active":true,"activeAt":123}"""
        val result = runCatching {
            HapiJson.decodeFromString(Session.serializer(), patchLike)
        }
        assertTrue(result.isFailure)
    }

    @Test
    fun `decodes a sessions list response`() {
        val response = HapiJson.decodeFromString(
            SessionsResponse.serializer(),
            """
            {"sessions": [{
                "id": "sess-1",
                "active": true,
                "thinking": false,
                "activeAt": 1755000000000,
                "updatedAt": 1755000005000,
                "pinned": false,
                "globalPinned": false,
                "metadata": {
                  "name": "protocol port",
                  "path": "/data/github/hapi",
                  "machineId": "mach-1",
                  "summary": {"text": "Porting wire models"},
                  "flavor": "claude",
                  "agentSessionId": "abc-123",
                  "lifecycleState": "running"
                },
                "metadataVersion": 3,
                "agentStateVersion": 7,
                "todosUpdatedAt": 1755000002000,
                "todoProgress": {"completed": 1, "total": 2},
                "pendingRequestsCount": 6,
                "pendingRequestKinds": ["permission", "input"],
                "pendingRequests": [{"id": "req-1", "kind": "permission", "tool": "Bash", "since": 1755000004500}],
                "backgroundTaskCount": 0,
                "futureScheduledMessageCount": 1,
                "nextScheduledAt": 1755000009000,
                "model": "claude-opus-4-1",
                "modelReasoningEffort": null,
                "effort": null
            }]}
            """
        )
        val summary = response.sessions.single()
        assertEquals("sess-1", summary.id)
        assertEquals(6, summary.pendingRequestsCount)
        assertEquals(listOf("permission", "input"), summary.pendingRequestKinds)
        assertEquals(
            PendingRequest(id = "req-1", kind = "permission", tool = "Bash", since = 1_755_000_004_500L),
            summary.pendingRequests.single()
        )
        assertEquals(TodoProgress(completed = 1, total = 2), summary.todoProgress)
        assertEquals("Porting wire models", summary.metadata?.summary?.text)
        assertEquals("abc-123", summary.metadata?.agentSessionId)
        assertEquals(1_755_000_009_000L, summary.nextScheduledAt)
        assertNull(summary.modelReasoningEffort)
    }

    @Test
    fun `decodes a messages page envelope`() {
        val response = HapiJson.decodeFromString(
            MessagesResponse.serializer(),
            """
            {
              "messages": [
                {"id": "m-1", "seq": 1, "localId": null, "createdAt": 1000, "invokedAt": 1200,
                 "content": {"role": "user", "content": {"type": "text", "text": "hello"}}},
                {"id": "local-9", "seq": null, "localId": "local-9", "createdAt": 2000, "invokedAt": null,
                 "content": {"role": "user", "content": {"type": "text", "text": "queued"}}}
              ],
              "page": {
                "direction": "latest",
                "limit": 200,
                "epoch": 3,
                "reset": false,
                "nextBeforeSeq": 1,
                "nextBeforeAt": 1200,
                "nextAfterSeq": null,
                "nextAfterAt": null,
                "snapshotHeadSeq": 2,
                "snapshotHeadAt": 2000,
                "hasMore": true
              }
            }
            """
        )
        assertEquals(2, response.messages.size)
        assertEquals(1_200L, response.messages[0].positionAt)
        // Queued row: explicit null invokedAt, position falls back to createdAt.
        assertEquals(OptionalField.Present<Long?>(null), response.messages[1].invokedAt)
        assertEquals(2_000L, response.messages[1].positionAt)
        assertNull(response.messages[1].seq)

        assertEquals("latest", response.page.direction)
        assertEquals(3L, response.page.epoch)
        assertEquals(1L, response.page.nextBeforeSeq)
        assertNull(response.page.nextAfterSeq)
        assertTrue(response.page.hasMore)
    }
}
