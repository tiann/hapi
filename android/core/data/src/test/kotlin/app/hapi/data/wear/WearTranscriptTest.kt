package app.hapi.data.wear

import app.hapi.protocol.wire.DecryptedMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.serialization.json.Json

private val json = Json { ignoreUnknownKeys = true }

private fun message(content: String, createdAt: Long = 1_000L) = DecryptedMessage(
    id = "m1",
    content = json.parseToJsonElement(content),
    createdAt = createdAt,
)

class WearTranscriptTest {

    @Test
    fun `direct user text`() {
        val line = WearTranscript.extractLine(
            message("""{"role":"user","content":{"text":"hello there"}}""")
        )
        assertEquals(WearTranscriptLine("user", "hello there", 1_000L), line)
    }

    @Test
    fun `claude content blocks join with blank line, thinking blocks dropped`() {
        val line = WearTranscript.extractLine(
            message(
                """{"role":"assistant","content":{"data":{"type":"output","message":{"role":"assistant",
                    "content":[{"type":"text","text":"first"},{"type":"thinking","text":"ignored"},
                    {"type":"text","text":"second"}]}}}}"""
            )
        )
        assertEquals("assistant", line?.role)
        assertEquals("first\n\nsecond", line?.text)
    }

    @Test
    fun `codex plain string message`() {
        val line = WearTranscript.extractLine(
            message("""{"role":"assistant","content":{"data":{"type":"message","message":"plain codex text"}}}""")
        )
        assertEquals("plain codex text", line?.text)
    }

    @Test
    fun `tool call events are dropped`() {
        val line = WearTranscript.extractLine(
            message("""{"role":"assistant","content":{"data":{"type":"tool-call","message":{"content":[]}}}}""")
        )
        assertNull(line)
    }

    @Test
    fun `token count events are dropped`() {
        val line = WearTranscript.extractLine(
            message("""{"role":"assistant","content":{"data":{"type":"token_count"}}}""")
        )
        assertNull(line)
    }

    @Test
    fun `blank text yields no line`() {
        val line = WearTranscript.extractLine(
            message("""{"role":"user","content":{"text":"   "}}""")
        )
        assertNull(line)
    }

    @Test
    fun `trailing AGENT_NOTIFY_SUMMARY contract line is stripped`() {
        val stripped = WearTranscript.stripAgentNotifySummary(
            "Fixed the bug.\n\nAGENT_NOTIFY_SUMMARY {\"status\":\"done\"}"
        )
        assertEquals("Fixed the bug.", stripped)
    }

    @Test
    fun `mid-message mention of the marker is left untouched`() {
        val text = "I saw AGENT_NOTIFY_SUMMARY in the logs and investigated."
        assertEquals(text, WearTranscript.stripAgentNotifySummary(text))
    }

    @Test
    fun `malformed notify summary tail is left untouched`() {
        val text = "Done.\nAGENT_NOTIFY_SUMMARY not-json"
        assertEquals(text, WearTranscript.stripAgentNotifySummary(text))
    }
}
