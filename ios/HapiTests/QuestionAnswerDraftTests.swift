import HapiClient
import HapiProtocol
import XCTest
@testable import Hapi

final class QuestionAnswerDraftTests: XCTestCase {
    private func tool(_ input: String, name: String = "functions.request_user_input") throws -> ChatToolCall {
        ChatToolCall(id: "question", name: name, state: .running,
                     input: try JSONDecoder().decode(JSONValue.self, from: Data(input.utf8)), createdAt: 0,
                     permission: ToolPermission(id: "request", status: .pending))
    }

    private let choices = #"{"questions":[{"id":"first","header":"First","question":"Choose **one**","options":[{"label":"A (Recommended)"},{"label":"B"}]},{"id":"last","header":"Last","question":"Choose again","options":[{"label":"C"},{"label":"D"}]}]}"#

    func testSingleSelectAdvancesOnlyOnExplicitSelectionAndLastRequiresSubmission() throws {
        let call = try tool(choices)
        let form = QuestionAnswerForm(tool: call)
        var draft = QuestionAnswerDraft()
        XCTAssertEqual(form.fields.map(\.header), ["First", "Last"])
        XCTAssertTrue(draft.selections.isEmpty, "Recommended options are not preselected")
        draft.next(in: form)
        XCTAssertEqual(draft.page, 0)
        XCTAssertNil(draft.submission(in: form))
        draft.select(0, at: 0, in: form)
        XCTAssertEqual(draft.page, 1)
        XCTAssertNil(draft.submission(in: form))
        // A stale action from the previous hosted step cannot answer the new one.
        draft.select(1, at: 0, in: form)
        XCTAssertEqual(draft.selections[0], [0])
        XCTAssertNil(draft.selections[1])
        draft.select(1, at: 1, in: form)
        XCTAssertEqual(draft.page, 1)
        XCTAssertEqual(draft.submission(in: form), .nestedAnswers([
            "first": ["A (Recommended)"], "last": ["D"],
        ]))
        draft.previous(in: form)
        XCTAssertEqual(draft.page, 0)
        XCTAssertEqual(draft.selections[0], [0])
        // Rebuilding from an identical SSE snapshot must never auto-navigate.
        let refreshed = QuestionAnswerForm(tool: call)
        XCTAssertEqual(draft.currentPage(in: refreshed), 0)
        draft.setText("  keep this note  ", at: 0, in: form)
        XCTAssertEqual(draft.page, 0)
        draft.next(in: form)
        XCTAssertEqual(draft.submission(in: form), .nestedAnswers([
            "first": ["A (Recommended)", "user_note: keep this note"], "last": ["D"],
        ]))
    }

    func testSingleQuestionDoesNotMoveOrSubmitWhenSelected() throws {
        let form = try QuestionAnswerForm(tool: tool(#"{"questions":[{"id":"one","options":[{"label":"A"}]}]}"#))
        var draft = QuestionAnswerDraft()
        draft.select(0, at: 0, in: form)
        XCTAssertEqual(draft.page, 0)
        // This only builds an action; the view must explicitly invoke Submit.
        XCTAssertEqual(draft.submission(in: form), .nestedAnswers(["one": ["A"]]))
    }

    func testMultipleAndTextQuestionsAdvanceManuallyAndPreserveWireOrder() throws {
        let form = try QuestionAnswerForm(tool: tool(#"{"questions":[{"id":"many","multiple":true,"options":[{"label":"A"},{"label":"B"}]},{"id":"text","question":"Explain"},{"id":"optional","required":false,"options":[{"label":"C"}]}]}"#))
        var draft = QuestionAnswerDraft()
        draft.select(1, at: 0, in: form)
        draft.select(0, at: 0, in: form)
        XCTAssertEqual(draft.page, 0)
        draft.next(in: form)
        XCTAssertEqual(draft.page, 1)
        XCTAssertTrue(draft.showsText(at: 1, in: form))
        draft.setText(" \n ", at: 1, in: form)
        draft.next(in: form)
        XCTAssertEqual(draft.page, 1)
        draft.setText("  Reason\nwith two lines  ", at: 1, in: form)
        XCTAssertEqual(draft.page, 1)
        draft.next(in: form)
        XCTAssertEqual(draft.submission(in: form), .nestedAnswers([
            "many": ["A", "B"], "text": ["user_note: Reason\nwith two lines"], "optional": [],
        ]))
    }

    func testCustomSingleAnswerAndOptionsAreExclusiveInBothDirections() throws {
        let form = try QuestionAnswerForm(tool: tool(#"{"questions":[{"question":"Choose","options":[{"label":"A (Recommended)"}]}]}"#, name: "AskUserQuestion"))
        var draft = QuestionAnswerDraft()
        draft.select(0, at: 0, in: form)
        draft.setText("Custom", at: 0, in: form)
        XCTAssertEqual(draft.submission(in: form), .flatAnswers(["0": ["Custom"]]))
        draft.select(0, at: 0, in: form)
        XCTAssertEqual(draft.text(at: 0, in: form), "")
        XCTAssertEqual(draft.submission(in: form), .flatAnswers(["0": ["A (Recommended)"]]))
    }

    func testCursorIDsAndAskMultiselectCustomValuesRemainUnchanged() throws {
        let form = try QuestionAnswerForm(tool: tool(#"{"questions":[{"id":"target","prompt":"Choose","allowMultiple":true,"options":[{"id":"stable-a","label":"A (Recommended)"},{"id":"stable-b","label":"B"}]}]}"#, name: "CursorAskQuestion"))
        var draft = QuestionAnswerDraft()
        draft.select(1, at: 0, in: form)
        draft.select(0, at: 0, in: form)
        draft.setText("Custom", at: 0, in: form)
        XCTAssertEqual(draft.submission(in: form), .flatAnswers(["target": ["stable-a", "stable-b", "Custom"]]))
        draft.select(0, at: 0, in: form)
        XCTAssertEqual(draft.submission(in: form), .flatAnswers(["target": ["stable-b", "Custom"]]))
    }

    func testTextExpansionPrefillAndRestorationDoNotEraseDrafts() throws {
        let form = try QuestionAnswerForm(tool: tool(choices))
        var draft = QuestionAnswerDraft()
        XCTAssertFalse(draft.showsText(at: 0, in: form))
        draft.toggleText(at: 0, in: form)
        draft.setText("Draft", at: 0, in: form)
        draft.toggleText(at: 0, in: form)
        XCTAssertFalse(draft.showsText(at: 0, in: form))
        XCTAssertEqual(draft.text(at: 0, in: form), "Draft")
        XCTAssertNil(draft.submission(in: form), "A Codex note does not replace a required selection")
        let prefilled = try QuestionAnswerForm(tool: tool(#"{"questions":[{"id":"one","prefill":"Existing text","options":[{"label":"A"}]}]}"#))
        XCTAssertTrue(QuestionAnswerDraft().showsText(at: 0, in: prefilled))
        XCTAssertEqual(QuestionAnswerDraft().text(at: 0, in: prefilled), "Existing text")
    }

    func testMalformedInputNeverPostsAnEmptyRequestAndAskKeepsFreeTextFallback() throws {
        let request = try QuestionAnswerForm(tool: tool("{}"))
        var draft = QuestionAnswerDraft()
        XCTAssertTrue(request.fields.isEmpty)
        XCTAssertNil(draft.submission(in: request))
        draft.next(in: request)
        let ask = try QuestionAnswerForm(tool: tool("{}", name: "AskUserQuestion"))
        draft.setText("Fallback", at: 0, in: ask)
        XCTAssertEqual(draft.submission(in: ask), .flatAnswers(["0": ["Fallback"]]))
        let duplicates = try QuestionAnswerForm(tool: tool(#"{"questions":[{"id":"same","question":"First"},{"id":"same","question":"Second"}]}"#))
        XCTAssertEqual(duplicates.fields.map(\.question), ["First"])
    }

    func testRecommendedSuffixIsDisplayOnlyAndMustBeATrailingNonemptyLabel() {
        XCTAssertEqual(QuestionOptionTitle("A (Recommended)").text, "A")
        XCTAssertTrue(QuestionOptionTitle("A (Recommended)").recommended)
        for text in ["(Recommended)", " (Recommended)", "A (Recommended) elsewhere", "Normal"] {
            XCTAssertEqual(QuestionOptionTitle(text).text, text)
            XCTAssertFalse(QuestionOptionTitle(text).recommended)
        }
    }

    func testCardStateUsesAuthoritativeAnswersAndRetainsFailures() throws {
        var call = try tool(choices)
        func state(_ override: PermissionRowOverride? = nil) -> QuestionCardState {
            QuestionCardState(tool: call, details: questionToolDetails(call), override: override)
        }
        XCTAssertEqual(state(), .answering)
        XCTAssertEqual(state(.resolving), .submitting)
        XCTAssertEqual(state(.alreadyHandled), .handled)
        call.permission?.status = .resolved
        XCTAssertEqual(state(), .handled, "Settled requests must not invent answers")
        call.result = .object(["answers": .object(["first": .object(["answers": .array([.string("A (Recommended)")])])])])
        XCTAssertEqual(state(), .answered)
        XCTAssertEqual(questionAnswerSummary(questionToolDetails(call).questions[0]), "A")
        call.state = .error
        XCTAssertEqual(state(), .failed)
        XCTAssertEqual(questionAnswerSummary(questionToolDetails(call).questions[0]), "A")
    }
}
