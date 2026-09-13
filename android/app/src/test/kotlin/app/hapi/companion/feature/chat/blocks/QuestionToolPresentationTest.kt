package app.hapi.companion.feature.chat.blocks

import app.hapi.protocol.chat.ChatToolCall
import app.hapi.protocol.chat.ToolPermission
import app.hapi.protocol.wire.HapiJson
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class QuestionToolPresentationTest {
    private val askInput = """{"questions":[{"header":"Storage","question":"Choose **storage**","multiSelect":true,"options":[{"label":"SQLite","description":"Local file"},{"label":"Postgres"}]},{"question":"Anything else?","options":[]}]}"""
    private val requestInput = """{"questions":[{"id":"target","question":"Deploy where?","multiple":true,"options":[{"label":"staging","description":"Safe"},{"label":"production"}]},{"id":"comment","question":"Comment","prefill":"Not an answer"}]}"""
    private fun json(source: String) = HapiJson.parseToJsonElement(source)
    private fun tool(name: String, input: String, answers: String? = null, result: JsonElement? = null, state: String = "completed") =
        ChatToolCall(id = "question", name = name, state = state, input = json(input), createdAt = 0, description = null,
            result = result, permission = ToolPermission(id = "reply", status = if (answers == null) "pending" else "approved",
                answers = answers?.let(::json), presence = emptySet()))

    @Test fun askFlatNestedAndAliasesShowChoicesAndCustomAnswersWithoutChangingWireData() {
        for (name in listOf("AskUserQuestion", "ask_user_question", "functions.AskUserQuestion")) {
            for (answers in listOf("""{"0":[" SQLite ","Postgres","Redis"],"1":["Keep it simple"]}""",
                """{"0":{"answers":[" SQLite ","Postgres","Redis"]},"1":{"answers":["Keep it simple"]}}""")) {
                val call = tool(name, askInput, answers)
                val details = questionToolDetails(call)
                assertTrue(isQuestionDetailsTool(name))
                assertTrue(details.hasAnswers)
                assertFalse(details.showResult)
                assertEquals("Storage", details.questions[0].header)
                assertTrue(details.questions[0].multiple)
                assertEquals(listOf(true, true), details.questions[0].options.map { it.selected })
                assertEquals("Local file", details.questions[0].options[0].description)
                assertEquals(listOf("Redis"), details.questions[0].otherAnswers)
                assertEquals(listOf("Keep it simple"), details.questions[1].otherAnswers)
                assertEquals(json(answers), call.permission?.answers)
            }
        }
    }

    @Test fun cursorUsesStableQuestionAndOptionIds() {
        val input = """{"title":"Preferences","questions":[{"id":"storage","prompt":"Choose storage","allowMultiple":false,"options":[{"id":"local","label":"SQLite"},{"id":"server","label":"Postgres"}]}]}"""
        val details = questionToolDetails(tool("CursorAskQuestion", input, """{"storage":["server"]}"""))
        assertEquals("Preferences", details.questions[0].header)
        assertEquals("Choose storage", details.questions[0].question)
        assertFalse(details.questions[0].multiple)
        assertEquals(listOf(false, true), details.questions[0].options.map { it.selected })
        assertEquals(emptyList(), details.questions[0].otherAnswers)
    }

    @Test fun requestHistoryObjectsStringsFlatAndNestedMaps() {
        for (source in listOf("""{"target":["staging"],"comment":["plain free text"]}""",
            """{"target":{"answers":["staging"]},"comment":{"answers":["plain free text"]}}""",
            """{"answers":{"target":{"answers":["staging"]},"comment":{"answers":["plain free text"]}}}""")) {
            for (result in listOf(json(source), JsonPrimitive(source))) {
                val details = questionToolDetails(tool("functions.request_user_input", requestInput, result = result))
                assertTrue(details.hasAnswers)
                assertFalse(details.showResult)
                assertEquals(listOf(true, false), details.questions[0].options.map { it.selected })
                assertEquals(listOf("plain free text"), details.questions[1].otherAnswers)
            }
        }
    }

    @Test fun liveAnswersWinAsAWholeWithoutMergingHistory() {
        val result = json("""{"answers":{"target":{"answers":["production"]},"comment":{"answers":["stale"]}}}""")
        val details = questionToolDetails(tool("request_user_input", requestInput,
            """{"target":{"answers":["staging","user_note:  after tests  "]}}""", result))
        assertEquals(listOf(true, false), details.questions[0].options.map { it.selected })
        assertEquals("after tests", details.questions[0].note)
        assertFalse(details.questions[1].hasAnswers)
        for (missing in listOf("{}", """{"unknown":["unmapped"]}""", """{"target":{"answers":[null,3]}}""")) {
            val fallback = questionToolDetails(tool("request_user_input", requestInput, missing, result))
            assertEquals(listOf(false, true), fallback.questions[0].options.map { it.selected })
        }
    }

    @Test fun notePrefixCanBeAnOptionAndEditorWhitespaceAndEmptyDocumentsSurvive() {
        val input = """{"questions":[{"id":"choice","question":"Choose","options":[{"label":"user_note: later"}]},{"id":"document","question":"Edit","inputType":"editor"}]}"""
        for (note in listOf("  code\n", "")) {
            val encodedNote = JsonPrimitive("user_note: $note")
            val answers = """{"choice":["user_note: later"],"document":{"answers":[$encodedNote]}}"""
            val details = questionToolDetails(tool("request_user_input", input, answers))
            assertTrue(details.questions[0].options[0].selected)
            assertNull(details.questions[0].note)
            assertEquals(note, details.questions[1].note)
            assertTrue(details.questions[1].hasAnswers)
        }
    }

    @Test fun questionNamedAnswersDoesNotGetConfusedWithOuterWrapper() {
        val input = """{"questions":[{"id":"answers","question":"Any comment?"}]}"""
        for (source in listOf("""{"answers":{"answers":["comment"]}}""", """{"answers":{"answers":{"answers":["comment"]}}}""")) {
            val details = questionToolDetails(tool("request_user_input", input, result = json(source)))
            assertEquals(listOf("comment"), details.questions[0].otherAnswers)
        }
    }

    @Test fun pendingDoesNotInventAnswersFromPrefillAndErrorsRemainVisible() {
        val pending = questionToolDetails(tool("request_user_input", requestInput, state = "running"))
        assertFalse(pending.hasAnswers)
        assertTrue(pending.showResult)
        assertTrue(pending.questions.none { it.hasAnswers })
        val failed = questionToolDetails(tool("AskUserQuestion", askInput,
            """{"0":["SQLite"]}""", JsonPrimitive("Failure"), state = "error"))
        assertTrue(failed.hasAnswers)
        assertTrue(failed.showResult)
    }

    @Test fun malformedInputAndAnswersRetainFallbackAndAsyncStaysOnLegacyPath() {
        for (input in listOf("null", "[]", """{"questions":[null,{},3]}""")) {
            val details = questionToolDetails(tool("AskUserQuestion", input))
            assertTrue(details.questions.isEmpty())
            assertTrue(details.showResult)
        }
        val freeform = questionToolDetails(tool("AskUserQuestion", "{}", """{"0":["A fallback answer"]}"""))
        assertEquals(listOf("A fallback answer"), freeform.questions[0].otherAnswers)
        for (source in listOf("not JSON", """{"answers":{"target":{"answers":"not an array"}}}""")) {
            val details = questionToolDetails(tool("request_user_input", requestInput, result = JsonPrimitive(source)))
            assertFalse(details.hasAnswers)
            assertTrue(details.showResult)
        }
        assertFalse(isQuestionDetailsTool("request_user_input_async"))
        assertFalse(isQuestionDetailsTool("mcp__server__request_user_input"))
        val duplicate = """{"questions":[{"id":"same","question":"First"},{"id":"same","question":"Second"}]}"""
        assertEquals(2, questionToolDetails(tool("request_user_input", duplicate)).questions.size)
    }
}
