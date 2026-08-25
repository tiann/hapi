import Foundation
import HapiProtocol

// Question/option models + input parsers for the two interactive request
// tools, ported from `web/src/components/ToolCard/askUserQuestion.ts`,
// `cursorAskQuestion.ts` and `requestUserInput.ts` via the Android port's
// `PermissionInputs.kt`. Pure functions over `JSONValue` — unit-tested
// alongside the interactor.

public struct AskOption: Equatable, Sendable {
    /// Stable option id (Cursor ACP); falls back to the label on submit.
    public let id: String?
    public let label: String
    public let description: String?

    public init(id: String?, label: String, description: String?) {
        self.id = id
        self.label = label
        self.description = description
    }
}

public struct AskQuestion: Equatable, Sendable {
    /// Stable question id (Cursor ACP); falls back to the index on submit.
    public let id: String?
    public let header: String?
    public let question: String
    public let options: [AskOption]
    public let multiSelect: Bool

    public init(id: String?, header: String?, question: String, options: [AskOption], multiSelect: Bool) {
        self.id = id
        self.header = header
        self.question = question
        self.options = options
        self.multiSelect = multiSelect
    }

    /// The flat-answers key: stable id when present, else the index (web parity).
    public func answerKey(index: Int, useStableIds: Bool) -> String {
        if useStableIds, let id, !id.isEmpty {
            return id
        }
        return String(index)
    }
}

public func isCursorAskQuestionToolName(_ toolName: String) -> Bool {
    toolName == "CursorAskQuestion"
}

private func trimmedString(_ value: JSONValue?) -> String? {
    value?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// `parseAskUserQuestionInput` / `parseCursorAskQuestionInput` merged: the
/// Cursor dialect adds `prompt`/`title`/`allowMultiple` synonyms and stable
/// ids; both collapse to the same `AskQuestion` list.
public func parseAskUserQuestions(_ input: JSONValue?, cursorDialect: Bool) -> [AskQuestion] {
    guard let root = input?.objectValue,
          let rawQuestions = root["questions"]?.arrayValue else {
        return []
    }
    let requestTitle = cursorDialect ? (trimmedString(root["title"]) ?? "") : ""

    var questions: [AskQuestion] = []
    for raw in rawQuestions {
        guard let object = raw.objectValue else { continue }

        let question: String
        let header: String
        let multiSelect: Bool
        let questionId: String?
        if cursorDialect {
            question = trimmedString(object["prompt"]) ?? trimmedString(object["question"]) ?? ""
            header = trimmedString(object["title"]) ?? trimmedString(object["header"]) ?? ""
            multiSelect = object["allowMultiple"]?.boolValue == true
                || object["multiSelect"]?.boolValue == true
            let rawId = trimmedString(object["id"]) ?? ""
            questionId = rawId.isEmpty ? String(questions.count) : rawId
        } else {
            question = trimmedString(object["question"]) ?? ""
            header = trimmedString(object["header"]) ?? ""
            multiSelect = object["multiSelect"]?.boolValue == true
            questionId = nil
        }

        var options: [AskOption] = []
        for rawOption in object["options"]?.arrayValue ?? [] {
            guard let optionObject = rawOption.objectValue else { continue }
            let label: String
            if cursorDialect {
                label = trimmedString(optionObject["label"]) ?? trimmedString(optionObject["id"]) ?? ""
            } else {
                label = trimmedString(optionObject["label"]) ?? ""
            }
            guard !label.isEmpty else { continue }
            let optionId: String?
            if cursorDialect {
                let rawId = trimmedString(optionObject["id"]) ?? ""
                optionId = rawId.isEmpty ? label : rawId
            } else {
                optionId = nil
            }
            let description = cursorDialect
                ? nil
                : trimmedString(optionObject["description"]).flatMap { $0.isEmpty ? nil : $0 }
            options.append(AskOption(id: optionId, label: label, description: description))
        }

        if question.isEmpty && options.isEmpty { continue }

        let effectiveHeader = header.isEmpty ? (requestTitle.isEmpty ? nil : requestTitle) : header
        questions.append(AskQuestion(
            id: questionId,
            header: effectiveHeader,
            question: question,
            options: options,
            multiSelect: multiSelect
        ))
    }
    return questions
}

public struct RequestUserInputQuestion: Equatable, Sendable {
    public let id: String
    public let question: String
    public let required: Bool
    public let multiple: Bool
    public let options: [AskOption]
    public let placeholder: String?
    public let prefill: String?

    public init(
        id: String,
        question: String,
        required: Bool,
        multiple: Bool,
        options: [AskOption],
        placeholder: String?,
        prefill: String?
    ) {
        self.id = id
        self.question = question
        self.required = required
        self.multiple = multiple
        self.options = options
        self.placeholder = placeholder
        self.prefill = prefill
    }
}

/// `parseRequestUserInputInput` (the URL-confirmation flow is web-only).
public func parseRequestUserInputQuestions(_ input: JSONValue?) -> [RequestUserInputQuestion] {
    guard let root = input?.objectValue,
          let rawQuestions = root["questions"]?.arrayValue else {
        return []
    }

    var questions: [RequestUserInputQuestion] = []
    for raw in rawQuestions {
        guard let object = raw.objectValue else { continue }
        let id = trimmedString(object["id"]) ?? ""
        guard !id.isEmpty else { continue }

        var options: [AskOption] = []
        for rawOption in object["options"]?.arrayValue ?? [] {
            guard let optionObject = rawOption.objectValue else { continue }
            let label = trimmedString(optionObject["label"]) ?? ""
            guard !label.isEmpty else { continue }
            options.append(AskOption(
                id: nil,
                label: label,
                description: trimmedString(optionObject["description"]).flatMap { $0.isEmpty ? nil : $0 }
            ))
        }

        questions.append(RequestUserInputQuestion(
            id: id,
            question: trimmedString(object["question"]) ?? "",
            required: object["required"]?.boolValue != false,
            multiple: object["multiple"]?.boolValue == true,
            options: options,
            placeholder: object["placeholder"]?.stringValue,
            prefill: object["prefill"]?.stringValue
        ))
    }
    return questions
}

/// `formatRequestUserInputAnswers` value building for ONE field: selected
/// option labels plus a trailing `user_note: <text>` entry when a note was
/// typed. The nested `{answers: [...]}` wrapper is applied by the interactor.
public func requestUserInputAnswerValues(selected: [String], note: String) -> [String] {
    var values = selected
    let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty {
        values.append("user_note: \(trimmed)")
    }
    return values
}

/// `isRequestUserInputQuestionAnswered`.
public func isRequestUserInputAnswered(
    _ question: RequestUserInputQuestion,
    selected: [String],
    note: String
) -> Bool {
    if !question.required { return true }
    if !question.options.isEmpty { return !selected.isEmpty }
    return !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}
