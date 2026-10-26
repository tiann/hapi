package app.hapi.companion.feature.chat.permissions

import app.hapi.protocol.wire.HapiJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class RequestUserInputTest {
    private fun question(fields: String): RequestUserInputQuestion = parseRequestUserInputQuestions(
        HapiJson.parseToJsonElement("""{"questions":[{"id":"choice",$fields}]}"""),
    ).single()

    @Test fun otherRequiresExplicitBooleanAndNonemptyOptions() {
        for (flag in listOf("true", "false", "null", "\"true\"")) {
            val question = question(""""isOther":$flag,"options":[{"label":"A"}]""")
            assertEquals(flag == "true", question.isOther)
            assertEquals(listOf("A"), question.options.map { it.label })
            assertEquals(if (flag == "true") listOf("A", "None of the above") else listOf("A"), question.answerOptions.map { it.label })
            assertFalse(question.isOtherOption(0))
            assertEquals(flag == "true", question.isOtherOption(1))
        }
        val missing = question(""""options":[{"label":"A"}]""")
        assertFalse(missing.isOther)
        assertEquals(missing.options, missing.answerOptions)
        val text = question(""""isOther":true,"options":[]""")
        assertTrue(text.answerOptions.isEmpty())
        assertFalse(text.isOtherOption(0))
        assertFalse(isRequestUserInputAnswered(text, emptyList(), ""))
    }

    @Test fun otherIsExclusiveAndNotesAreOptional() {
        val question = question(""""isOther":true,"multiple":true,"options":[{"label":"A"},{"label":"B"}]""")
        val other = selectRequestUserInputOption(question, setOf("A", "B"), 2)
        assertEquals(setOf("None of the above"), other)
        assertTrue(isRequestUserInputAnswered(question, other.toList(), ""))
        assertFalse(isRequestUserInputAnswered(question, emptyList(), "custom answer"))
        var selected = selectRequestUserInputOption(question, other, 0)
        assertEquals(setOf("A"), selected)
        selected = selectRequestUserInputOption(question, selected, 1)
        assertEquals(setOf("A", "B"), selected)
        assertEquals(setOf("B"), selectRequestUserInputOption(question, selected, 0))
        for (note in listOf("", " \n ", "  自定义\n说明  ")) {
            assertEquals(listOf("None of the above") + (if (note.isBlank()) emptyList() else listOf("user_note: ${note.trim()}")),
                requestUserInputAnswerValues(other.toList(), note))
        }
    }
}
