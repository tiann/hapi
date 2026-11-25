import Foundation
import HapiClient
import HapiProtocol
import Testing

struct RequestUserInputTests {
    private func question(_ fields: String) throws -> RequestUserInputQuestion {
        let input = try JSONDecoder().decode(JSONValue.self, from: Data("{\"questions\":[{\"id\":\"choice\",\(fields)}]}".utf8))
        return try #require(parseRequestUserInputQuestions(input).first)
    }

    @Test func otherRequiresExplicitBooleanAndNonemptyOptions() throws {
        for flag in ["true", "false", "null", "\"true\""] {
            let question = try question("\"isOther\":\(flag),\"options\":[{\"label\":\"A\"}]")
            #expect(question.isOther == (flag == "true"))
            #expect(question.options.map(\.label) == ["A"])
            #expect(question.answerOptions.map(\.label) == (flag == "true" ? ["A", "None of the above"] : ["A"]))
            #expect(!question.isOtherOption(at: 0))
            #expect(question.isOtherOption(at: 1) == (flag == "true"))
        }
        let missing = try question(#""options":[{"label":"A"}]"#)
        #expect(!missing.isOther)
        #expect(missing.answerOptions == missing.options)
        let text = try question(#""isOther":true,"options":[]"#)
        #expect(text.answerOptions.isEmpty)
        #expect(!text.isOtherOption(at: 0))
        #expect(!isRequestUserInputAnswered(text, selected: [], note: ""))
    }

    @Test func optionalNoteKeepsCanonicalOtherValue() throws {
        let question = try question(#""isOther":true,"options":[{"label":"A"}]"#)
        #expect(isRequestUserInputAnswered(question, selected: [requestUserInputOtherAnswer], note: ""))
        #expect(!isRequestUserInputAnswered(question, selected: [], note: "custom answer"))
        for note in ["", " \n ", "  自定义\n说明  "] {
            let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
            #expect(requestUserInputAnswerValues(selected: [requestUserInputOtherAnswer], note: note)
                    == ["None of the above"] + (trimmed.isEmpty ? [] : ["user_note: \(trimmed)"]))
        }
    }
}
