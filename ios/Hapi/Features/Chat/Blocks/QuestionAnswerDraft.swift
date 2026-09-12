import Foundation
import HapiClient
import HapiProtocol

/// Presentation adapter only. The existing parsers and dialect-specific wire
/// values stay authoritative; display labels must never become answer values.
struct QuestionAnswerForm: Equatable {
    enum Field: Equatable {
        case ask(AskQuestion, key: String, stableOptionIDs: Bool)
        case request(RequestUserInputQuestion)

        var key: String {
            switch self {
            case .ask(_, let key, _): key
            case .request(let question): question.id
            }
        }

        var header: String? {
            switch self {
            case .ask(let question, _, _): question.header
            case .request(let question): question.header
            }
        }

        var question: String {
            switch self {
            case .ask(let question, _, _): question.question
            case .request(let question): question.question
            }
        }

        var options: [AskOption] {
            switch self {
            case .ask(let question, _, _): question.options
            case .request(let question): question.options
            }
        }

        var multiple: Bool {
            switch self {
            case .ask(let question, _, _): question.multiSelect
            case .request(let question): question.multiple
            }
        }

        var required: Bool {
            switch self {
            case .ask: true
            case .request(let question): question.required
            }
        }

        var allowsCustomAnswer: Bool {
            if case .ask = self { return true }
            return false
        }

        var prefill: String {
            if case .request(let question) = self { return question.prefill ?? "" }
            return ""
        }

        var placeholder: String? {
            if case .request(let question) = self { return question.placeholder }
            return nil
        }

        func values(selected: Set<Int>, text: String) -> [String] {
            let picked = options.indices.filter(selected.contains).map { index in
                let option = options[index]
                if case .ask(_, _, true) = self { return option.id ?? option.label }
                return option.label
            }
            if case .request = self {
                return requestUserInputAnswerValues(selected: picked, note: text)
            }
            let custom = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return picked + (custom.isEmpty ? [] : [custom])
        }

        func isAnswered(selected: Set<Int>, text: String) -> Bool {
            if case .request(let question) = self {
                return isRequestUserInputAnswered(
                    question, selected: options.indices.filter(selected.contains).map { options[$0].label }, note: text
                )
            }
            return !values(selected: selected, text: text).isEmpty
        }
    }

    let fields: [Field]
    let nestedAnswers: Bool

    init(tool: ChatToolCall) {
        let name = toolPresentationName(tool.name)
        nestedAnswers = isRequestUserInputToolName(name)
        if nestedAnswers {
            // One answer slot per stable ID; malformed duplicates must not
            // create two steps that silently overwrite one another on submit.
            var seen: Set<String> = []
            fields = parseRequestUserInputQuestions(tool.input)
                .filter { seen.insert($0.id).inserted }.map(Field.request)
        } else {
            let cursor = isCursorAskQuestionToolName(name)
            let parsed = parseAskUserQuestions(tool.input, cursorDialect: cursor)
            let questions = parsed.isEmpty
                ? [AskQuestion(id: nil, header: nil, question: "", options: [], multiSelect: false)] : parsed
            var seen: Set<String> = []
            fields = questions.enumerated().compactMap { index, question in
                let key = question.answerKey(index: index, useStableIds: cursor)
                guard seen.insert(key).inserted else { return nil }
                return .ask(question, key: key, stableOptionIDs: cursor)
            }
        }
    }
}

/// One request-owned value, retained outside recycled transcript cells. Only
/// explicit user actions navigate; re-rendering or restoring a draft cannot.
struct QuestionAnswerDraft: Equatable {
    static let storageField = "question.answerDraft"
    private(set) var page = 0
    private(set) var selections: [Int: Set<Int>] = [:]
    private(set) var texts: [Int: String] = [:]
    private(set) var expanded: [Int: Bool] = [:]

    func currentPage(in form: QuestionAnswerForm) -> Int {
        min(page, max(0, form.fields.count - 1))
    }

    func text(at index: Int, in form: QuestionAnswerForm) -> String {
        texts[index] ?? form.fields[index].prefill
    }

    func showsText(at index: Int, in form: QuestionAnswerForm) -> Bool {
        form.fields[index].options.isEmpty || (expanded[index] ?? !text(at: index, in: form).isEmpty)
    }

    func isAnswered(at index: Int, in form: QuestionAnswerForm) -> Bool {
        form.fields[index].isAnswered(selected: selections[index] ?? [], text: text(at: index, in: form))
    }

    mutating func toggleText(at index: Int, in form: QuestionAnswerForm) {
        expanded[index] = !showsText(at: index, in: form)
    }

    mutating func setText(_ text: String, at index: Int, in form: QuestionAnswerForm) {
        guard form.fields.indices.contains(index) else { return }
        texts[index] = text
        let field = form.fields[index]
        if field.allowsCustomAnswer && !field.multiple && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            selections[index] = []
        }
    }

    mutating func select(_ option: Int, at index: Int, in form: QuestionAnswerForm) {
        guard index == currentPage(in: form), form.fields.indices.contains(index),
              form.fields[index].options.indices.contains(option) else { return }
        let field = form.fields[index]
        if field.multiple {
            var selected = selections[index] ?? []
            if selected.contains(option) { selected.remove(option) }
            else { selected.insert(option) }
            selections[index] = selected
        } else {
            selections[index] = [option]
            if field.allowsCustomAnswer { texts[index] = "" }
            next(in: form)
        }
    }

    mutating func previous(in form: QuestionAnswerForm) {
        page = max(0, currentPage(in: form) - 1)
    }

    mutating func next(in form: QuestionAnswerForm) {
        let index = currentPage(in: form)
        guard form.fields.indices.contains(index), isAnswered(at: index, in: form) else { return }
        page = min(index + 1, form.fields.count - 1)
    }

    func submission(in form: QuestionAnswerForm) -> PermissionAction? {
        guard !form.fields.isEmpty, form.fields.indices.allSatisfy({ isAnswered(at: $0, in: form) }) else { return nil }
        var answers: [String: [String]] = [:]
        for (index, field) in form.fields.enumerated() {
            answers[field.key] = field.values(selected: selections[index] ?? [], text: text(at: index, in: form))
        }
        return form.nestedAnswers ? .nestedAnswers(answers) : .flatAnswers(answers)
    }
}

struct QuestionOptionTitle: Equatable {
    let text: String
    let recommended: Bool

    init(_ original: String) {
        let suffix = " (Recommended)"
        let stripped = original.hasSuffix(suffix)
            ? String(original.dropLast(suffix.count)).trimmingCharacters(in: .whitespacesAndNewlines) : ""
        recommended = !stripped.isEmpty
        text = recommended ? stripped : original
    }
}

enum QuestionCardState: Equatable {
    case answering, submitting, answered, handled, canceled, failed, waiting

    var title: String {
        switch self {
        case .answered: String(localized: "Answered")
        case .handled: String(localized: "Question handled")
        case .canceled: String(localized: "Question canceled")
        case .failed: String(localized: "Question failed")
        case .waiting, .answering: String(localized: "Awaiting response")
        case .submitting: String(localized: "Submitting answer…")
        }
    }

    var icon: String {
        switch self {
        case .answered: "checkmark.circle.fill"
        case .handled: "checkmark.circle"
        case .canceled: "xmark.circle"
        case .failed: "exclamationmark.circle"
        default: "questionmark.circle"
        }
    }

    init(tool: ChatToolCall, details: QuestionToolDetails, override: PermissionRowOverride?) {
        if tool.state == .error { self = .failed }
        else if tool.permission?.status == .denied || tool.permission?.status == .canceled { self = .canceled }
        else if details.hasAnswers { self = .answered }
        else if override == .alreadyHandled { self = .handled }
        else if tool.permission?.status == .pending { self = override == .resolving ? .submitting : .answering }
        else if tool.permission != nil || tool.state == .completed { self = .handled }
        else { self = .waiting }
    }
}

func questionAnswerSummary(_ question: QuestionDetail) -> String? {
    let choices = question.options.filter(\.selected).map { QuestionOptionTitle($0.label).text }
    let values = choices + question.otherAnswers + (question.note.map { [$0.isEmpty ? String(localized: "(empty)") : $0] } ?? [])
    guard !values.isEmpty else { return nil }
    return chatTruncate(values.joined(separator: " · ").split(whereSeparator: \.isWhitespace).joined(separator: " "), 240)
}
