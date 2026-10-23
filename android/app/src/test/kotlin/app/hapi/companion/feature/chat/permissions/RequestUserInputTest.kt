package app.hapi.companion.feature.chat.permissions

import app.hapi.protocol.wire.HapiJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RequestUserInputTest {
    private fun question(fields: String): RequestUserInputQuestion {
        val extra = if (fields.isBlank()) "" else ",$fields"
        return parseRequestUserInputQuestions(
            HapiJson.parseToJsonElement("""{"questions":[{"id":"choice"$extra}]}"""),
        ).single()
    }

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
                requestUserInputAnswerValues(question, other.toList(), note))
        }
    }

    // ------------------------------------------- editor inputType semantics --

    @Test fun inputTypeSurvivesOnlyForLiteralEditor() {
        for (value in listOf("\"editor\"", "\"text\"", "\"single\"", "null", "3")) {
            val parsed = parseRequestUserInputQuestions(
                HapiJson.parseToJsonElement("""{"questions":[{"id":"q","inputType":$value}]}"""),
            )
            assertEquals(if (value == "\"editor\"") "editor" else null, parsed.single().inputType, value)
        }
    }

    @Test fun editorQuestionIsAnsweredEvenWithEmptyNote() {
        val editor = question(""""inputType":"editor"""")
        assertTrue(isRequestUserInputAnswered(editor, emptyList(), ""))
        assertTrue(isRequestUserInputAnswered(editor, emptyList(), "   \n "))

        val plain = question("")
        assertFalse(isRequestUserInputAnswered(plain, emptyList(), ""))
        assertFalse(isRequestUserInputAnswered(plain, emptyList(), "  \n "))
        assertTrue(isRequestUserInputAnswered(plain, emptyList(), " text "))

        // Option questions keep needing a selection regardless of inputType.
        val editorWithOptions = question(""""inputType":"editor","options":[{"label":"A"}]""")
        assertFalse(isRequestUserInputAnswered(editorWithOptions, emptyList(), "note"))
        assertTrue(isRequestUserInputAnswered(editorWithOptions, listOf("A"), ""))
    }

    @Test fun editorNoteIsUntrimmedAndAlwaysPushed() {
        val editor = question(""""inputType":"editor"""")
        // Even an empty note pushes the literal "user_note: " (web 191-195).
        assertEquals(listOf("user_note: "), requestUserInputAnswerValues(editor, emptyList(), ""))
        assertEquals(listOf("user_note:  keep\n spacing "), requestUserInputAnswerValues(editor, emptyList(), " keep\n spacing "))

        val plain = question("")
        assertEquals(emptyList(), requestUserInputAnswerValues(plain, emptyList(), "  \n "))
        assertEquals(listOf("user_note: trimmed"), requestUserInputAnswerValues(plain, emptyList(), "  trimmed\t"))
        assertEquals(listOf("A", "user_note: n"), requestUserInputAnswerValues(plain, listOf("A"), " n "))
    }

    // ----------------------------------------------- URL parsing & confirm --

    private fun parseUrl(urlJson: String): String? = parseRequestUserInput(
        HapiJson.parseToJsonElement("""{"url":$urlJson,"questions":[]}"""),
    ).url

    @Test fun urlSurvivesOnlyAsValidHttpOrHttps() {
        assertEquals("https://accounts.example.com/callback", parseUrl("\"https://accounts.example.com/callback\""))
        assertEquals("http://localhost:3000/signin", parseUrl("\"http://localhost:3000/signin\""))
        assertNull(parseUrl("\"javascript:alert(1)\""))
        assertNull(parseUrl("\"file:///etc/passwd\""))
        assertNull(parseUrl("\"ftp://example.com\""))
        assertNull(parseUrl("\"not a url\""))
        assertNull(parseUrl("\"https://exa mple.com\""))
        assertNull(parseUrl("null"), "non-string url is dropped")
        assertEquals(null, parseRequestUserInput(HapiJson.parseToJsonElement("""{"questions":[]}""")).url)
        assertEquals(null, parseRequestUserInput(null).url)
    }

    private fun confirmFixture(url: String, optionDescription: String?): RequestUserInputParsed {
        val option = buildString {
            append("""{"label":"Open sign-in page and continue"""")
            if (optionDescription != null) append(""","description":"$optionDescription"""")
            append("}")
        }
        return parseRequestUserInput(
            HapiJson.parseToJsonElement(
                """{"url":"$url","questions":[""" +
                    """{"id":"__mcp_url_confirmation","question":"Sign in","options":[$option]}]}""",
            ),
        )
    }

    private val selectedConfirmOption = listOf("Open sign-in page and continue")

    @Test fun urlConfirmationRequiresSelectedOptionWithMatchingDescription() {
        val url = "https://accounts.example.com/callback"
        val confirmed = confirmFixture(url, url)
        assertTrue(
            isRequestUserInputUrlConfirmed(confirmed, mapOf("__mcp_url_confirmation" to selectedConfirmOption)),
        )
        // Option present but not selected.
        assertFalse(
            isRequestUserInputUrlConfirmed(confirmed, mapOf("__mcp_url_confirmation" to emptyList())),
        )
        // Selected but description does not equal the url.
        val mismatched = confirmFixture(url, "https://other.example.com")
        assertFalse(
            isRequestUserInputUrlConfirmed(mismatched, mapOf("__mcp_url_confirmation" to selectedConfirmOption)),
        )
        // Description missing entirely.
        val undescribed = confirmFixture(url, null)
        assertFalse(
            isRequestUserInputUrlConfirmed(undescribed, mapOf("__mcp_url_confirmation" to selectedConfirmOption)),
        )
    }

    @Test fun urlConfirmationFallsThroughWithoutUrlOrConfirmationQuestion() {
        // No url at all → never confirmed (and the submit guard skips opening).
        val noUrl = parseRequestUserInput(HapiJson.parseToJsonElement("""{"questions":[]}"""))
        assertFalse(isRequestUserInputUrlConfirmed(noUrl, emptyMap()))

        // Url present but no __mcp_url_confirmation question → not confirmed.
        val noQuestion = parseRequestUserInput(
            HapiJson.parseToJsonElement("""{"url":"https://x.example.com","questions":[{"id":"other","options":[]}]}"""),
        )
        assertFalse(isRequestUserInputUrlConfirmed(noQuestion, mapOf("__mcp_url_confirmation" to selectedConfirmOption)))

        // A selected option on an unrelated question never confirms.
        val unrelated = confirmFixture("https://x.example.com", "https://x.example.com")
        assertFalse(isRequestUserInputUrlConfirmed(unrelated, mapOf("other" to selectedConfirmOption)))
    }
}
