package app.hapi.protocol.wire

import java.io.File
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Wire-decoding conformance against the golden fixtures in
 * `shared/fixtures/` (path injected by the Gradle test task as
 * `hapi.fixtures.dir`). Every `.json` file under `chat/` must have its
 * `input.messages` array decode into `List<DecryptedMessage>` — newly added
 * fixtures are picked up automatically and must never break wire decoding.
 */
class FixtureDecodingTest {

    private val fixturesDir: File by lazy {
        val path = System.getProperty("hapi.fixtures.dir")
        assertNotNull(path, "hapi.fixtures.dir system property not set (see core/protocol/build.gradle.kts)")
        val dir = File(path)
        assertTrue(dir.isDirectory, "fixtures dir does not exist: $dir")
        dir
    }

    private fun chatFixtures(): List<File> {
        val files = File(fixturesDir, "chat")
            .listFiles { file -> file.isFile && file.name.endsWith(".json") }
            ?.sortedBy { it.name }
            .orEmpty()
        assertTrue(files.isNotEmpty(), "no chat fixtures found under $fixturesDir/chat — refusing to pass on zero files")
        return files
    }

    private fun readFixture(name: String) =
        HapiJson.parseToJsonElement(File(fixturesDir, "chat/$name").readText()).jsonObject

    @Test
    fun `fixture VERSION is supported`() {
        // Fail loudly when the on-disk fixtureVersion is newer than this port
        // supports (shared/fixtures/README.md policy) — never silently skip.
        val version = File(fixturesDir, "VERSION").readText().trim().toInt()
        assertTrue(
            version <= SUPPORTED_PROTOCOL_VERSION,
            "fixtures are version $version but this client supports <= $SUPPORTED_PROTOCOL_VERSION — update the port"
        )
    }

    @Test
    fun `every chat fixture's input messages decode as DecryptedMessage`() {
        for (file in chatFixtures()) {
            val root = HapiJson.parseToJsonElement(file.readText()).jsonObject
            assertEquals(1, root.getValue("fixtureVersion").intOrNull, "fixtureVersion in ${file.name}")
            val rawMessages = root.getValue("input").jsonObject.getValue("messages").jsonArray
            assertTrue(rawMessages.isNotEmpty(), "empty input.messages in ${file.name}")

            val decoded = HapiJson.decodeFromJsonElement(
                ListSerializer(DecryptedMessage.serializer()),
                rawMessages
            )
            assertEquals(rawMessages.size, decoded.size, "message count in ${file.name}")
            decoded.forEach { message ->
                assertTrue(message.id.isNotEmpty(), "blank message id in ${file.name}")
                assertTrue(message.content !is JsonNull, "missing content in ${file.name}")
            }
        }
    }

    @Test
    fun `user-text-with-attachments decodes fields and attachments`() {
        val fixture = readFixture("user-text-with-attachments.json")
        val messages = HapiJson.decodeFromJsonElement(
            ListSerializer(DecryptedMessage.serializer()),
            fixture.getValue("input").jsonObject.getValue("messages")
        )
        val message = messages.single()
        assertEquals("msg-user-101", message.id)
        assertEquals(1L, message.seq)
        assertEquals("local-7d2b9e4f-03c6-4a18-b7e5-3d0f8c4a6b21", message.localId)
        assertEquals(1_755_000_000_000L, message.createdAt)
        assertEquals(OptionalField.Present<Long?>(1_755_000_000_510L), message.invokedAt)
        assertEquals(1_755_000_000_510L, message.positionAt)

        val envelope = message.content.jsonObject
        assertEquals("user", envelope.getValue("role").stringOrNull)
        val attachments = HapiJson.decodeFromJsonElement(
            ListSerializer(AttachmentMetadata.serializer()),
            envelope.getValue("content").jsonObject.getValue("attachments")
        )
        assertEquals(2, attachments.size)
        assertEquals(
            AttachmentMetadata(
                id = "att-01HZXK3Q",
                filename = "crash.log",
                mimeType = "text/plain",
                size = 18_432,
                path = "/uploads/att-01HZXK3Q/crash.log",
                previewUrl = "/api/uploads/att-01HZXK3Q/preview",
            ),
            attachments[0]
        )
        assertNull(attachments[1].previewUrl)
    }

    @Test
    fun `claude-assistant-text decodes agent message with absent invokedAt`() {
        val fixture = readFixture("claude-assistant-text.json")
        val messages = HapiJson.decodeFromJsonElement(
            ListSerializer(DecryptedMessage.serializer()),
            fixture.getValue("input").jsonObject.getValue("messages")
        )
        assertEquals(2, messages.size)

        val agent = messages[1]
        assertEquals("msg-agent-002", agent.id)
        assertEquals(2L, agent.seq)
        assertNull(agent.localId)
        // No invokedAt key on the wire: tri-state must read Absent (pre-V8
        // "already invoked"), NOT Present(null) ("queued").
        assertEquals(OptionalField.Absent, agent.invokedAt)
        assertEquals(agent.createdAt, agent.positionAt)
        assertEquals("agent", agent.content.jsonObject.getValue("role").stringOrNull)
        assertEquals(
            "output",
            agent.content.jsonObject.getValue("content").jsonObject.getValue("type").stringOrNull
        )
    }

    @Test
    fun `permission-synthesized-pending agentState decodes into AgentState`() {
        val fixture = readFixture("permission-synthesized-pending.json")
        val agentState = HapiJson.decodeFromJsonElement(
            AgentState.serializer(),
            fixture.getValue("input").jsonObject.getValue("agentState")
        )
        assertEquals(emptyMap(), agentState.completedRequests)
        val request = assertNotNull(agentState.requests).getValue("req-01J5XKQ8TZ3M")
        assertEquals("Bash", request.tool)
        assertEquals(1_755_000_006_000L, request.createdAt)
        assertEquals(
            "bun add zod",
            request.arguments.objOrNull?.get("command").stringOrNull
        )
    }

    @Test
    fun `decrypted message round-trips through encode preserving invokedAt tri-state`() {
        val queued = DecryptedMessage(
            id = "local-1",
            seq = null,
            localId = "local-1",
            content = HapiJson.parseToJsonElement("""{"role":"user","content":{"type":"text","text":"hi"}}"""),
            createdAt = 42L,
            invokedAt = OptionalField.Present(null),
        )
        val queuedJson = HapiJson.encodeToString(DecryptedMessage.serializer(), queued)
        assertTrue("\"invokedAt\":null" in queuedJson, "explicit null must survive encoding: $queuedJson")
        assertEquals(queued, HapiJson.decodeFromString(DecryptedMessage.serializer(), queuedJson))

        val legacyInvoked = queued.copy(invokedAt = OptionalField.Absent)
        val legacyJson = HapiJson.encodeToString(DecryptedMessage.serializer(), legacyInvoked)
        assertTrue("invokedAt" !in legacyJson, "absent field must stay absent: $legacyJson")
        assertEquals(legacyInvoked, HapiJson.decodeFromString(DecryptedMessage.serializer(), legacyJson))
    }
}
