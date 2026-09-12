import XCTest
@testable import Hapi
import HapiProtocol

final class QuestionToolPresentationTests: XCTestCase {
    private let askInput = #"{"questions":[{"header":"Storage","question":"Choose **storage**","multiSelect":true,"options":[{"label":"SQLite","description":"Local file"},{"label":"Postgres"}]},{"question":"Anything else?","options":[]}]}"#
    private let requestInput = #"{"questions":[{"id":"target","question":"Deploy where?","multiple":true,"options":[{"label":"staging","description":"Safe"},{"label":"production"}]},{"id":"comment","question":"Comment","prefill":"Not an answer"}]}"#

    private func json(_ source: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(source.utf8))
    }

    private func tool(_ name: String, input: String, answers: String? = nil, result: JSONValue? = nil,
                      state: ToolCallState = .completed) throws -> ChatToolCall {
        ChatToolCall(id: "question", name: name, state: state, input: try json(input), createdAt: 0,
                     result: result, permission: ToolPermission(id: "reply", status: answers == nil ? .pending : .approved,
                                                               answers: try answers.map(json)))
    }

    func testAskFlatNestedAndAliasesShowChoicesAndCustomAnswersWithoutChangingWireData() throws {
        for name in ["AskUserQuestion", "ask_user_question", "functions.AskUserQuestion"] {
            for answers in [#"{"0":[" SQLite ","Postgres","Redis"],"1":["Keep it simple"]}"#,
                            #"{"0":{"answers":[" SQLite ","Postgres","Redis"]},"1":{"answers":["Keep it simple"]}}"#] {
                let call = try tool(name, input: askInput, answers: answers)
                let details = questionToolDetails(call)
                XCTAssertTrue(isQuestionDetailsTool(name))
                XCTAssertTrue(details.hasAnswers)
                XCTAssertFalse(details.showResult)
                XCTAssertEqual(details.questions[0].header, "Storage")
                XCTAssertTrue(details.questions[0].multiple)
                XCTAssertEqual(details.questions[0].options.map(\.selected), [true, true])
                XCTAssertEqual(details.questions[0].options[0].description, "Local file")
                XCTAssertEqual(details.questions[0].otherAnswers, ["Redis"])
                XCTAssertEqual(details.questions[1].otherAnswers, ["Keep it simple"])
                XCTAssertEqual(call.permission?.answers, try json(answers))
            }
        }
    }

    func testCursorUsesStableQuestionAndOptionIds() throws {
        let input = #"{"title":"Preferences","questions":[{"id":"storage","prompt":"Choose storage","allowMultiple":false,"options":[{"id":"local","label":"SQLite"},{"id":"server","label":"Postgres"}]}]}"#
        let details = questionToolDetails(try tool("CursorAskQuestion", input: input, answers: #"{"storage":["server"]}"#))
        XCTAssertEqual(details.questions[0].header, "Preferences")
        XCTAssertEqual(details.questions[0].question, "Choose storage")
        XCTAssertFalse(details.questions[0].multiple)
        XCTAssertEqual(details.questions[0].options.map(\.selected), [false, true])
        XCTAssertEqual(details.questions[0].otherAnswers, [])
    }

    func testRequestHistoryObjectsStringsFlatAndNestedMaps() throws {
        for source in [#"{"target":["staging"],"comment":["plain free text"]}"#,
                       #"{"target":{"answers":["staging"]},"comment":{"answers":["plain free text"]}}"#,
                       #"{"answers":{"target":{"answers":["staging"]},"comment":{"answers":["plain free text"]}}}"#] {
            for result in [try json(source), JSONValue.string(source)] {
                let details = questionToolDetails(try tool("functions.request_user_input", input: requestInput, result: result))
                XCTAssertTrue(details.hasAnswers)
                XCTAssertFalse(details.showResult)
                XCTAssertEqual(details.questions[0].options.map(\.selected), [true, false])
                XCTAssertEqual(details.questions[1].otherAnswers, ["plain free text"])
            }
        }
    }

    func testLiveAnswersWinAsAWholeWithoutMergingHistory() throws {
        let result = try json(#"{"answers":{"target":{"answers":["production"]},"comment":{"answers":["stale"]}}}"#)
        let call = try tool("request_user_input", input: requestInput,
                            answers: #"{"target":{"answers":["staging","user_note:  after tests  "]}}"#, result: result)
        let details = questionToolDetails(call)
        XCTAssertEqual(details.questions[0].options.map(\.selected), [true, false])
        XCTAssertEqual(details.questions[0].note, "after tests")
        XCTAssertFalse(details.questions[1].hasAnswers)
        for missing in ["{}", #"{"unknown":["unmapped"]}"#, #"{"target":{"answers":[null,3]}}"#] {
            let fallback = questionToolDetails(try tool("request_user_input", input: requestInput, answers: missing, result: result))
            XCTAssertEqual(fallback.questions[0].options.map(\.selected), [false, true])
        }
    }

    func testNotePrefixCanBeAnOptionAndEditorWhitespaceAndEmptyDocumentsSurvive() throws {
        let input = #"{"questions":[{"id":"choice","question":"Choose","options":[{"label":"user_note: later"}]},{"id":"document","question":"Edit","inputType":"editor"}]}"#
        for note in ["  code\n", ""] {
            let answers: JSONValue = .object([
                "choice": .array([.string("user_note: later")]),
                "document": .object(["answers": .array([.string("user_note: " + note)])]),
            ])
            var call = try tool("request_user_input", input: input)
            call.permission?.answers = answers
            let details = questionToolDetails(call)
            XCTAssertTrue(details.questions[0].options[0].selected)
            XCTAssertNil(details.questions[0].note)
            XCTAssertEqual(details.questions[1].note, note)
            XCTAssertTrue(details.questions[1].hasAnswers)
        }
    }

    func testQuestionNamedAnswersDoesNotGetConfusedWithOuterWrapper() throws {
        let input = #"{"questions":[{"id":"answers","question":"Any comment?"}]}"#
        for source in [#"{"answers":{"answers":["comment"]}}"#,
                       #"{"answers":{"answers":{"answers":["comment"]}}}"#] {
            let details = questionToolDetails(try tool("request_user_input", input: input, result: json(source)))
            XCTAssertEqual(details.questions[0].otherAnswers, ["comment"])
        }
    }

    func testPendingDoesNotInventAnswersFromPrefillAndErrorsRemainVisible() throws {
        let pending = questionToolDetails(try tool("request_user_input", input: requestInput, state: .running))
        XCTAssertFalse(pending.hasAnswers)
        XCTAssertTrue(pending.showResult)
        XCTAssertTrue(pending.questions.allSatisfy { !$0.hasAnswers })
        let failed = questionToolDetails(try tool("AskUserQuestion", input: askInput,
                                                  answers: #"{"0":["SQLite"]}"#, result: .string("Failure"), state: .error))
        XCTAssertTrue(failed.hasAnswers)
        XCTAssertTrue(failed.showResult)
    }

    func testMalformedInputAndAnswersRetainFallbackAndAsyncStaysOnLegacyPath() throws {
        for input in ["null", "[]", #"{"questions":[null,{},3]}"#] {
            let details = questionToolDetails(try tool("AskUserQuestion", input: input))
            XCTAssertTrue(details.questions.isEmpty)
            XCTAssertTrue(details.showResult)
        }
        let freeform = questionToolDetails(try tool("AskUserQuestion", input: "{}", answers: #"{"0":["A fallback answer"]}"#))
        XCTAssertEqual(freeform.questions[0].otherAnswers, ["A fallback answer"])
        for source in ["not JSON", #"{"answers":{"target":{"answers":"not an array"}}}"#] {
            let details = questionToolDetails(try tool("request_user_input", input: requestInput, result: .string(source)))
            XCTAssertFalse(details.hasAnswers)
            XCTAssertTrue(details.showResult)
        }
        XCTAssertFalse(isQuestionDetailsTool("request_user_input_async"))
        XCTAssertFalse(isQuestionDetailsTool("mcp__server__request_user_input"))
        let duplicate = #"{"questions":[{"id":"same","question":"First"},{"id":"same","question":"Second"}]}"#
        XCTAssertEqual(questionToolDetails(try tool("request_user_input", input: duplicate)).questions.count, 2)
    }
}
