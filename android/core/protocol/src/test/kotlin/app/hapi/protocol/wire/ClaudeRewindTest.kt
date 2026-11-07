package app.hapi.protocol.wire

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlinx.serialization.decodeFromString

class ClaudeRewindTest {
    @Test fun `metadata preserves rewind and locks only nonterminal phases`() {
        for (phase in listOf("requested", "pending", "applied", "unknown", "committed", "rejected")) {
            val metadata = HapiJson.decodeFromString<SessionMetadata>(
                """{"path":"/tmp","host":"host","claudeRewind":{"operationId":"op-1","phase":"$phase","requestedLocalId":"l1","cutoffSeq":42,"extra":"ignored"}}""",
            )
            assertEquals("op-1", metadata.claudeRewind?.operationId)
            assertEquals(42L, metadata.claudeRewind?.cutoffSeq)
            assertEquals(phase !in listOf("committed", "rejected"), metadata.claudeRewind?.isPending)
        }
        assertFalse(HapiJson.decodeFromString<SessionMetadata>("""{"path":"/tmp","host":"host"}""").claudeRewind?.isPending == true)
    }
}
