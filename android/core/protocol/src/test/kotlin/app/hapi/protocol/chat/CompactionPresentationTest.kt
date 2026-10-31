package app.hapi.protocol.chat

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test

class CompactionPresentationTest {
    private fun event(vararg facts: Pair<String, Double>, summary: String = "") = AgentEvent.of(
        JsonObject(mapOf("type" to JsonPrimitive("compact-summary"), "summary" to JsonPrimitive(summary)) +
            facts.associate { it.first to JsonPrimitive(it.second) }),
    )

    @Test fun `available counts retain exact estimated zero and missing semantics`() {
        val cases = listOf(
            listOf("tokensBefore" to 100.0, "tokensAfter" to 40.0) to "100 → 40 tokens",
            listOf("tokensBefore" to 100.0, "estimatedTokensAfter" to 40.0) to "100 → ~40 tokens (estimated after)",
            listOf("tokensBefore" to 0.0) to "0 tokens before",
            listOf("tokensAfter" to 0.0) to "0 tokens after",
            listOf("estimatedTokensAfter" to 0.0) to "~0 tokens after (estimated)",
            listOf("tokensAfter" to 2.0, "estimatedTokensAfter" to 99.0) to "2 tokens after",
            listOf("tokensAfter" to -1.0, "estimatedTokensAfter" to 3.0) to "~3 tokens after (estimated)",
            listOf("tokensBefore" to -1.0, "tokensAfter" to Double.POSITIVE_INFINITY, "estimatedTokensAfter" to 1.5) to null,
            listOf("tokensAfter" to 9_007_199_254_740_992.0) to null,
            emptyList<Pair<String, Double>>() to null,
        )
        for ((facts, expected) in cases) assertEquals(facts.toString(), expected, getCompactionPresentation(event(*facts.toTypedArray()))?.tokenDelta)
    }

    @Test fun `summary eligibility preserves content without treating whitespace as details`() {
        val markdown = "\n# Checkpoint\n\nSaved **answer**.\n"
        assertEquals(markdown, getCompactionPresentation(event(summary = markdown))?.summary)
        assertTrue(getCompactionPresentation(event(summary = markdown))!!.hasSummary)
        assertFalse(getCompactionPresentation(event(summary = " \n\t"))!!.hasSummary)
        assertNull(getCompactionPresentation(AgentEvent.of(JsonObject(mapOf("type" to JsonPrimitive("message"))))))
    }
}
