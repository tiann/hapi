import Foundation
import HapiClient
import HapiProtocol

/// Read-only projection, separate from drafts and permission submission. The
/// recorded input/result/answers remain untouched and available under Source.
struct QuestionToolDetails: Equatable, Sendable {
    let questions: [QuestionDetail]
    let showResult: Bool
    var hasAnswers: Bool { questions.contains { $0.hasAnswers } }
}

struct QuestionDetail: Equatable, Sendable {
    let header: String?
    let question: String
    let multiple: Bool
    let options: [QuestionOptionDetail]
    let otherAnswers: [String]
    let note: String?
    var hasAnswers: Bool { options.contains { $0.selected } || !otherAnswers.isEmpty || note != nil }
}

struct QuestionOptionDetail: Equatable, Sendable {
    let label: String
    let description: String?
    let selected: Bool
}

func isQuestionDetailsTool(_ name: String) -> Bool {
    let name = toolPresentationName(name)
    return isAskUserQuestionToolName(name) || isRequestUserInputToolName(name)
}

func questionToolDetails(_ tool: ChatToolCall) -> QuestionToolDetails {
    let name = toolPresentationName(tool.name)
    let answers = questionAnswerMap(tool.permission?.answers)
    let questions: [QuestionDetail]
    if isAskUserQuestionToolName(name) {
        let cursor = isCursorAskQuestionToolName(name)
        let parsed = parseAskUserQuestions(tool.input, cursorDialect: cursor)
        if parsed.isEmpty {
            // The existing malformed-input answer form submits free text as "0".
            let values = (answers["0"] ?? []).map(trimQuestionAnswer).filter { !$0.isEmpty }
            questions = values.isEmpty ? [] : [QuestionDetail(
                header: nil, question: "", multiple: false, options: [], otherAnswers: values, note: nil
            )]
        } else {
            questions = parsed.enumerated().map { index, question in
                let values = (answers[question.answerKey(index: index, useStableIds: cursor)] ?? [])
                    .map(trimQuestionAnswer).filter { !$0.isEmpty }
                let optionValues = question.options.map { cursor ? ($0.id ?? $0.label) : $0.label }
                return QuestionDetail(
                    header: question.header, question: question.question, multiple: question.multiSelect,
                    options: question.options.enumerated().map { index, option in
                        QuestionOptionDetail(label: option.label, description: option.description,
                                             selected: values.contains(optionValues[index]))
                    },
                    otherAnswers: values.filter { !optionValues.contains($0) }, note: nil
                )
            }
        }
    } else if isRequestUserInputToolName(name) {
        let parsed = parseRequestUserInputQuestions(tool.input)
        let live = requestQuestionDetails(parsed, answers: answers)
        // Prefer usable live answers as a whole; do not merge with stale history.
        if live.contains(where: { $0.hasAnswers }) {
            questions = live
        } else {
            var result = tool.result
            if case .string(let text) = result {
                result = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
            }
            questions = requestQuestionDetails(parsed, answers: questionAnswerMap(result))
        }
    } else {
        questions = []
    }
    return QuestionToolDetails(questions: questions,
                               showResult: tool.state == .error || !questions.contains { $0.hasAnswers })
}

private func trimQuestionAnswer(_ value: String) -> String {
    value.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Only the documented flat/nested maps and one outer `answers` wrapper.
/// Try a direct map first: a question may itself be named "answers".
private func questionAnswerMap(_ value: JSONValue?) -> [String: [String]] {
    guard let object = value?.chatObject else { return [:] }
    func parse(_ object: [String: JSONValue]) -> [String: [String]] {
        object.compactMapValues { value in
            (value.chatArray ?? value.chatObject?["answers"]?.chatArray)?.compactMap(\.chatString)
        }
    }
    let direct = parse(object)
    if !direct.isEmpty { return direct }
    return object["answers"]?.chatObject.map(parse) ?? [:]
}

private func requestQuestionDetails(
    _ questions: [RequestUserInputQuestion], answers: [String: [String]]
) -> [QuestionDetail] {
    questions.map { question in
        var selected: Set<String> = []
        var other: [String] = []
        var note: String?
        for value in answers[question.id] ?? [] {
            let trimmed = trimQuestionAnswer(value)
            // An actual option named "user_note: ..." is not metadata.
            if let option = question.options.first(where: { $0.label == trimmed }) {
                selected.insert(option.label)
            } else if value.hasPrefix("user_note: ") {
                let text = String(value.dropFirst("user_note: ".count))
                if question.inputType == "editor" {
                    note = text // An intentionally empty document is still an answer.
                } else {
                    let text = trimQuestionAnswer(text)
                    if !text.isEmpty { note = text }
                }
            } else if !trimmed.isEmpty {
                // Codex history may contain plain free text without a note prefix.
                other.append(trimmed)
            }
        }
        return QuestionDetail(
            header: nil, question: question.question, multiple: question.multiple,
            options: question.options.map {
                QuestionOptionDetail(label: $0.label, description: $0.description, selected: selected.contains($0.label))
            },
            otherAnswers: other, note: note
        )
    }
}
