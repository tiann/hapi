package app.hapi.protocol.wire

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `SyncEvents.parse` coverage for the 13-type union
 * (`docs/api/client-contract/sse.md`) plus the never-throw degradation rules.
 */
class SyncEventDecodingTest {

    @Test
    fun `decodes connection-changed handshake with resume verdict`() {
        val event = SyncEvents.parse(
            """{"type":"connection-changed","data":{"status":"connected","subscriptionId":"sub-1","resume":"ok"}}"""
        )
        val handshake = assertIs<SyncEvent.ConnectionChanged>(event)
        assertEquals("connected", handshake.data?.status)
        assertEquals("sub-1", handshake.data?.subscriptionId)
        assertEquals("ok", handshake.data?.resume)
        assertNull(handshake.namespace)
    }

    @Test
    fun `decodes heartbeat with and without data`() {
        val with = assertIs<SyncEvent.Heartbeat>(
            SyncEvents.parse("""{"type":"heartbeat","namespace":"default","data":{"timestamp":1755000000000}}""")
        )
        assertEquals(1_755_000_000_000L, with.data?.timestamp)
        assertEquals("default", with.namespace)

        val bare = assertIs<SyncEvent.Heartbeat>(SyncEvents.parse("""{"type":"heartbeat"}"""))
        assertNull(bare.data)
    }

    @Test
    fun `decodes session-updated keeping data raw for two-phase resolution`() {
        val event = assertIs<SyncEvent.SessionUpdated>(
            SyncEvents.parse(
                """{"type":"session-updated","namespace":"default","sessionId":"s-1","data":{"activeAt":123,"active":true}}"""
            )
        )
        assertEquals("s-1", event.sessionId)
        val patch = assertNotNull(SessionPatches.parse(event.data))
        assertEquals(123L, patch.activeAt)
        assertEquals(true, patch.active)
    }

    @Test
    fun `decodes message-received including the tri-state invokedAt`() {
        val queued = assertIs<SyncEvent.MessageReceived>(
            SyncEvents.parse(
                """
                {"type":"message-received","sessionId":"s-1","message":
                  {"id":"m-1","seq":7,"localId":"local-1","createdAt":1000,"invokedAt":null,
                   "content":{"role":"user","content":{"type":"text","text":"hi"}}}}
                """
            )
        )
        assertEquals("s-1", queued.sessionId)
        assertEquals(7L, queued.message.seq)
        assertEquals(OptionalField.Present<Long?>(null), queued.message.invokedAt)
        assertEquals("user", queued.message.content.jsonObject.getValue("role").stringOrNull)
    }

    @Test
    fun `decodes messages-consumed and message-cancelled reconciliation events`() {
        val consumed = assertIs<SyncEvent.MessagesConsumed>(
            SyncEvents.parse(
                """{"type":"messages-consumed","sessionId":"s-1","localIds":["a","b"],"invokedAt":2000}"""
            )
        )
        assertEquals(listOf("a", "b"), consumed.localIds)
        assertEquals(2_000L, consumed.invokedAt)

        val cancelled = assertIs<SyncEvent.MessageCancelled>(
            SyncEvents.parse("""{"type":"message-cancelled","sessionId":"s-1","messageId":"m-9"}""")
        )
        assertEquals("m-9", cancelled.messageId)
        assertNull(cancelled.localId)
    }

    @Test
    fun `decodes the remaining session and machine lifecycle events`() {
        assertEquals(
            SyncEvent.SessionAdded(namespace = "default", sessionId = "s-2"),
            SyncEvents.parse("""{"type":"session-added","namespace":"default","sessionId":"s-2"}""")
        )
        assertEquals(
            SyncEvent.SessionRemoved(sessionId = "s-2"),
            SyncEvents.parse("""{"type":"session-removed","sessionId":"s-2"}""")
        )
        assertEquals(
            SyncEvent.MessagesInvalidated(sessionId = "s-2"),
            SyncEvents.parse("""{"type":"messages-invalidated","sessionId":"s-2"}""")
        )
        assertEquals(
            SyncEvent.ScheduledMatured(sessionId = "s-2"),
            SyncEvents.parse("""{"type":"scheduled-matured","sessionId":"s-2"}""")
        )
        assertEquals(
            SyncEvent.SessionEnded(sessionId = "s-2", reason = "completed"),
            SyncEvents.parse("""{"type":"session-ended","sessionId":"s-2","reason":"completed"}""")
        )

        val removal = assertIs<SyncEvent.MachineUpdated>(
            SyncEvents.parse("""{"type":"machine-updated","machineId":"mach-1","data":null}""")
        )
        assertEquals("mach-1", removal.machineId)
        // Explicit JSON null (= machine removed) must stay distinguishable
        // from an absent data key (= refetch machines).
        assertEquals(OptionalField.Present<JsonElement>(JsonNull), removal.data)

        val refetch = assertIs<SyncEvent.MachineUpdated>(
            SyncEvents.parse("""{"type":"machine-updated","machineId":"mach-1"}""")
        )
        assertEquals(OptionalField.Absent, refetch.data)

        val patch = assertIs<SyncEvent.MachineUpdated>(
            SyncEvents.parse("""{"type":"machine-updated","machineId":"mach-1","data":{"active":false,"updatedAt":5}}""")
        )
        assertEquals(
            MachinePatch(active = false, updatedAt = 5),
            MachinePatches.parse(patch.data.valueOrNull())
        )
    }

    @Test
    fun `decodes toast payload`() {
        val toast = assertIs<SyncEvent.Toast>(
            SyncEvents.parse(
                """{"type":"toast","data":{"title":"Ready","body":"Agent is done","sessionId":"s-1","url":"/sessions/s-1"}}"""
            )
        )
        assertEquals("Ready", toast.data.title)
        assertEquals("/sessions/s-1", toast.data.url)
    }

    @Test
    fun `unknown event types degrade to Unknown - never throw`() {
        val unknown = assertIs<SyncEvent.Unknown>(
            SyncEvents.parse("""{"type":"quantum-entangled","namespace":"default","payload":1}""")
        )
        assertEquals("quantum-entangled", unknown.type)
        assertEquals("default", unknown.namespace)
    }

    @Test
    fun `malformed known-type payloads degrade to Unknown`() {
        // message-received without its required message: the web reference
        // drops frames failing safeParse; we surface Unknown instead.
        val malformed = SyncEvents.parse("""{"type":"message-received","sessionId":"s-1"}""")
        assertIs<SyncEvent.Unknown>(malformed)
        assertEquals("message-received", (malformed as SyncEvent.Unknown).type)
    }

    @Test
    fun `non-object and invalid frames degrade to Unknown`() {
        assertIs<SyncEvent.Unknown>(SyncEvents.parse("[]"))
        assertIs<SyncEvent.Unknown>(SyncEvents.parse("not json at all"))
        assertIs<SyncEvent.Unknown>(SyncEvents.parse("""{"data":{}}"""))
        assertTrue((SyncEvents.parse("""{"type":42}""") as SyncEvent.Unknown).type == null)
    }

    @Test
    fun `machine wire model decodes a realistic payload`() {
        val machine = HapiJson.decodeFromString(
            Machine.serializer(),
            """
            {"id":"mach-1","namespace":"default","seq":3,"createdAt":1,"updatedAt":2,
             "active":true,"activeAt":3,"metadataVersion":4,"runnerStateVersion":5,
             "metadata":{"host":"devbox","platform":"linux","happyCliVersion":"0.28.0","workspaceRoots":["/data"]},
             "runnerState":{"status":"running","pid":4242,"httpPort":8080,"capabilities":{"agentConfigs":[]}},
             "health":{"collectedAt":9,"cpuCount":16,"cpuPercent":12.5}}
            """
        )
        assertEquals("devbox", machine.metadata?.host)
        assertEquals("running", machine.runnerState?.status)
        assertEquals(4242, machine.runnerState?.pid)
        assertEquals(12.5, machine.health?.cpuPercent)
        assertNull(machine.runnerState?.lastSpawnError)
    }
}
