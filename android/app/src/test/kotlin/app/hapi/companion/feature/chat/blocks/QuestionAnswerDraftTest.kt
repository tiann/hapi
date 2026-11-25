package app.hapi.companion.feature.chat.blocks

import app.hapi.companion.feature.chat.PermissionAction
import app.hapi.companion.feature.chat.PermissionRowOverride
import app.hapi.protocol.chat.ChatToolCall
import app.hapi.protocol.chat.ToolPermission
import app.hapi.protocol.wire.HapiJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class QuestionAnswerDraftTest {
    private fun tool(name: String, input: String, status: String = "pending") = ChatToolCall(
        id = "q", name = name, state = "running", createdAt = 0, description = null,
        input = HapiJson.parseToJsonElement(input),
        permission = ToolPermission(id = "reply", status = status, presence = emptySet()),
    )

    private val twoQuestions = tool(
        "AskUserQuestion",
        """{"questions":[{"header":"Target","question":"Where?","options":[{"label":"staging"},{"label":"prod"}]},""" +
            """{"question":"Which checks?","multiSelect":true,"options":[{"label":"lint"},{"label":"test"}]}]}""",
    )

    @Test fun singleChoiceAdvancesAndSubmissionWaitsForEveryQuestion() {
        val form = QuestionAnswerForm(twoQuestions)
        var draft = QuestionAnswerDraft()
        assertFalse(draft.isAnswered(0, form))
        assertEquals(draft, draft.next(form)) // Unanswered pages never advance.

        draft = draft.select(1, 0, form)
        assertEquals(1, draft.currentPage(form))
        assertNull(draft.submission(form))

        draft = draft.select(0, 1, form).select(1, 1, form)
        assertEquals(1, draft.currentPage(form)) // Multi-select stays on its page.
        assertEquals(
            PermissionAction.FlatAnswers(mapOf("0" to listOf("prod"), "1" to listOf("lint", "test"))),
            draft.submission(form),
        )
        assertEquals(0, draft.previous(form).currentPage(form))
    }

    @Test fun customAnswerReplacesSingleSelectionAndChoosingClearsIt() {
        val form = QuestionAnswerForm(twoQuestions)
        var draft = QuestionAnswerDraft().select(0, 0, form).previous(form).withText("  canary  ", 0, form)
        assertEquals(emptySet(), draft.selected(0))
        assertTrue(draft.isAnswered(0, form))
        assertEquals(listOf("canary"), form.fields[0].values(draft.selected(0), draft.text(0, form)))

        draft = draft.select(1, 0, form)
        assertEquals("", draft.text(0, form))
        assertEquals(setOf(1), draft.selected(0))
    }

    @Test fun selectingOffPageIsIgnored() {
        val form = QuestionAnswerForm(twoQuestions)
        val draft = QuestionAnswerDraft()
        assertEquals(draft, draft.select(0, 1, form))
    }

    @Test fun requestUserInputOtherIsExclusiveAndKeepsNotesAsUserNote() {
        val form = QuestionAnswerForm(
            tool(
                "request_user_input",
                """{"questions":[{"id":"target","question":"Choose","isOther":true,"multiple":true,"options":[{"label":"Alpha"},{"label":"Beta"}]}]}""",
            ),
        )
        var draft = QuestionAnswerDraft().select(0, 0, form).select(1, 0, form)
        assertEquals(setOf(0, 1), draft.selected(0))
        draft = draft.select(2, 0, form)
        assertEquals(setOf(2), draft.selected(0))
        assertTrue(draft.showsText(0, form))
        draft = draft.withText(" note ", 0, form).select(0, 0, form)
        assertEquals(setOf(0), draft.selected(0)) // Picking a real option drops "Other".
        draft = draft.select(2, 0, form)
        assertEquals(
            PermissionAction.NestedAnswers(mapOf("target" to listOf("None of the above", "user_note: note"))),
            draft.submission(form),
        )
    }

    @Test fun requestPrefillShowsTheNoteAndIsSubmitted() {
        val form = QuestionAnswerForm(
            tool(
                "request_user_input",
                """{"questions":[{"id":"target","question":"Where?","prefill":"production","options":[{"label":"staging"}]}]}""",
            ),
        )
        val draft = QuestionAnswerDraft()
        assertTrue(draft.showsText(0, form))
        assertFalse(draft.toggleText(0, form).showsText(0, form))
        assertEquals(
            PermissionAction.NestedAnswers(mapOf("target" to listOf("staging", "user_note: production"))),
            draft.select(0, 0, form).submission(form),
        )
    }

    @Test fun duplicateKeysCollapseAndMalformedAskFallsBackToFreeText() {
        val dup = QuestionAnswerForm(
            tool("request_user_input", """{"questions":[{"id":"a","question":"One"},{"id":"a","question":"Two"}]}"""),
        )
        assertEquals(1, dup.fields.size)

        val malformed = QuestionAnswerForm(tool("AskUserQuestion", """{"questions":"nope"}"""))
        assertEquals(1, malformed.fields.size)
        val draft = QuestionAnswerDraft()
        assertTrue(draft.showsText(0, malformed))
        assertEquals(
            PermissionAction.FlatAnswers(mapOf("0" to listOf("hello"))),
            draft.withText("hello", 0, malformed).submission(malformed),
        )
    }

    @Test fun cursorDialectSubmitsStableIds() {
        val form = QuestionAnswerForm(
            tool(
                "CursorAskQuestion",
                """{"questions":[{"id":"env","prompt":"Where?","options":[{"id":"stg","label":"Staging"}]}]}""",
            ),
        )
        assertEquals(
            PermissionAction.FlatAnswers(mapOf("env" to listOf("stg"))),
            QuestionAnswerDraft().select(0, 0, form).submission(form),
        )
    }

    @Test fun signInRequestsNeedTheConfirmationOption() {
        val url = "https://example.com/login?state=a|b"
        val form = QuestionAnswerForm(
            tool(
                "request_user_input",
                """{"url":"$url","questions":[{"id":"__mcp_url_confirmation","question":"Sign in","options":[{"label":"Continue","description":"$url"}]}]}""",
            ),
        )
        assertEquals(url, form.url)
        assertFalse(form.isUrlConfirmed(QuestionAnswerDraft()))
        assertTrue(form.isUrlConfirmed(QuestionAnswerDraft().select(0, 0, form)))
    }

    @Test fun saverRoundTripsTheDraft() {
        val form = QuestionAnswerForm(twoQuestions)
        val draft = QuestionAnswerDraft().select(1, 0, form).select(0, 1, form).toggleText(1, form).withText("x", 1, form)
        val saved = with(QuestionAnswerDraft.Saver) { androidx.compose.runtime.saveable.SaverScope { true }.save(draft) }!!
        assertEquals(draft, QuestionAnswerDraft.Saver.restore(saved))
    }

    @Test fun recommendedSuffixBecomesABadge() {
        assertEquals(QuestionOptionTitle("Staging", true), QuestionOptionTitle.of("Staging (Recommended)"))
        assertEquals(QuestionOptionTitle(" (Recommended)", false), QuestionOptionTitle.of(" (Recommended)"))
        assertEquals(QuestionOptionTitle("Prod", false), QuestionOptionTitle.of("Prod"))
    }

    @Test fun cardStateFollowsPermissionAndAnswers() {
        val pending = twoQuestions
        val details = questionToolDetails(pending)
        assertEquals(QuestionCardState.Answering, QuestionCardState.of(pending, details, null))
        assertEquals(QuestionCardState.Submitting, QuestionCardState.of(pending, details, PermissionRowOverride.Resolving))
        assertEquals(QuestionCardState.Handled, QuestionCardState.of(pending, details, PermissionRowOverride.AlreadyHandled))
        val denied = pending.copy(permission = pending.permission!!.copy(status = "denied"))
        assertEquals(QuestionCardState.Canceled, QuestionCardState.of(denied, questionToolDetails(denied), null))
        val answered = pending.copy(
            permission = pending.permission!!.copy(status = "approved", answers = HapiJson.parseToJsonElement("""{"0":["prod"]}""")),
        )
        assertEquals(QuestionCardState.Answered, QuestionCardState.of(answered, questionToolDetails(answered), null))
        assertEquals(QuestionCardState.Failed, QuestionCardState.of(pending.copy(state = "error"), details, null))
    }

    @Test fun answerSummaryJoinsChoicesAndCollapsesWhitespace() {
        val answered = twoQuestions.copy(
            permission = twoQuestions.permission!!.copy(
                status = "approved",
                answers = HapiJson.parseToJsonElement("""{"0":["prod"],"1":["lint","multi\nline  custom"]}"""),
            ),
        )
        val questions = questionToolDetails(answered).questions
        assertEquals("prod", questionAnswerSummary(questions[0], "Other", "(empty)"))
        assertEquals("lint · multi line custom", questionAnswerSummary(questions[1], "Other", "(empty)"))
    }
}
