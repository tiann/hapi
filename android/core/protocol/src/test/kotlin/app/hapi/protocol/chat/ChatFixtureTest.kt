package app.hapi.protocol.chat

import app.hapi.protocol.wire.AgentState
import app.hapi.protocol.wire.DecryptedMessage
import app.hapi.protocol.wire.HapiJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized
import java.io.File
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Golden chat-fixture conformance (every JSON file under `shared/fixtures/chat`): decode the
 * stored wire inputs, run the ported pipeline
 * (normalize → reduceChatBlocks → buildVisibleChatBlocks), project, and
 * compare against the stored expectation under canonical-JSON equality
 * (`shared/fixtures/README.md`, "Acceptance bar").
 */
@RunWith(Parameterized::class)
class ChatFixtureTest(private val fixtureName: String, private val file: File) {

    companion object {
        /** Highest chat-fixture document version this port implements. */
        const val SUPPORTED_FIXTURE_VERSION = 1

        val fixturesDir: File by lazy {
            val path = System.getProperty("hapi.fixtures.dir")
                ?: error("hapi.fixtures.dir system property not set (see core/protocol/build.gradle.kts)")
            File(path).also { require(it.isDirectory) { "fixtures dir does not exist: $it" } }
        }

        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun fixtures(): List<Array<Any>> {
            val files = File(fixturesDir, "chat")
                .listFiles { f -> f.isFile && f.name.endsWith(".json") }
                ?.sortedBy { it.name }
                .orEmpty()
            require(files.isNotEmpty()) {
                "no chat fixtures found under $fixturesDir/chat — refusing to pass on zero files"
            }
            return files.map { arrayOf<Any>(it.name.removeSuffix(".json"), it) }
        }
    }

    private fun runPipeline(input: JsonObject): JsonObject {
        val rawMessages = input.getValue("messages") as JsonArray
        val messages = rawMessages.map { HapiJson.decodeFromJsonElement<DecryptedMessage>(it) }
        val agentStateElement = input["agentState"] ?: JsonNull
        val agentState: AgentState? = if (agentStateElement is JsonNull) {
            null
        } else {
            HapiJson.decodeFromJsonElement<AgentState>(agentStateElement)
        }
        val options = input.getValue("options").jsonObject
        val hasMoreMessages = (options.getValue("hasMoreMessages") as JsonPrimitive).boolean

        val normalized = messages.mapNotNull(::normalizeDecryptedMessage)
        val reduced = reduceChatBlocks(normalized, agentState)
        val visibleBlocks = buildVisibleChatBlocks(reduced.blocks, ToolGroupingOptions(hasMoreMessages = hasMoreMessages))

        val actual = LinkedHashMap<String, JsonElement>()
        actual["blocks"] = JsonArray(reduced.blocks.map(::projectChatBlock))
        actual["hasReadyEvent"] = JsonPrimitive(reduced.hasReadyEvent)
        actual["latestUsage"] = projectLatestUsage(reduced.latestUsage)
        actual["visibleBlocks"] = JsonArray(visibleBlocks.map(::projectVisibleChatBlock))
        return JsonObject(actual)
    }

    private fun diffExcerpt(expected: JsonElement, actual: JsonElement): String {
        val expectedLines = toCanonicalJsonString(expected).lines()
        val actualLines = toCanonicalJsonString(actual).lines()
        val firstDiff = (0 until maxOf(expectedLines.size, actualLines.size)).firstOrNull { i ->
            expectedLines.getOrNull(i) != actualLines.getOrNull(i)
        } ?: 0
        val from = maxOf(0, firstDiff - 3)
        fun excerpt(lines: List<String>): String =
            lines.subList(from, minOf(lines.size, firstDiff + 8)).joinToString("\n")
        return buildString {
            appendLine("first divergence at canonical line ${firstDiff + 1}")
            appendLine("--- expected ---")
            appendLine(excerpt(expectedLines))
            appendLine("--- actual ---")
            appendLine(excerpt(actualLines))
        }
    }

    @Test
    fun matchesGoldenExpectation() {
        val document = HapiJson.parseToJsonElement(file.readText()).jsonObject

        val version = (document.getValue("fixtureVersion") as JsonPrimitive).content.toInt()
        assertTrue(
            version <= SUPPORTED_FIXTURE_VERSION,
            "$fixtureName carries fixtureVersion $version but this port supports <= $SUPPORTED_FIXTURE_VERSION",
        )

        val input = document.getValue("input").jsonObject
        val expected = document.getValue("expected").jsonObject
        assertNotNull(expected)

        val actual = runPipeline(input)

        val canonicalExpected = canonicalizeJson(expected)
        val canonicalActual = canonicalizeJson(actual)
        if (canonicalExpected != canonicalActual) {
            fail("$fixtureName: projection mismatch\n${diffExcerpt(canonicalExpected, canonicalActual)}")
        }
    }
}

/** Suite-level gates that are not per-fixture. */
class ChatFixtureSuiteTest {
    @Test
    fun `fixture VERSION on disk is supported`() {
        val version = File(ChatFixtureTest.fixturesDir, "VERSION").readText().trim().toInt()
        assertTrue(
            version <= ChatFixtureTest.SUPPORTED_FIXTURE_VERSION,
            "shared/fixtures VERSION is $version but this port supports <= ${ChatFixtureTest.SUPPORTED_FIXTURE_VERSION} — update the chat port",
        )
    }
}
