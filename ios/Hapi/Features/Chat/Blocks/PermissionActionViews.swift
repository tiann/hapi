import HapiClient
import HapiProtocol
import HapiUI
import SwiftUI

/// Pending-permission footers (A-M3b): the approval buttons for ordinary tool
/// permissions plus the dedicated AskUserQuestion / request_user_input answer
/// forms. Flavor logic mirrors `PermissionFooter.tsx` via the Android port:
///
/// - codex family (incl. cursor and codex-dialect tool names): Allow
///   (`decision: approved`) / Abort (`decision: abort`) + overflow
///   Allow-for-session (`decision: approved_for_session`);
/// - everyone else: Allow (`{}`) / Deny (`{}`) + overflow Allow-for-session
///   (claude: `allowTools`) and, for claude edit tools, Allow-all-edits
///   (`mode: acceptEdits`).
struct PendingPermissionFooter: View {
    let tool: ChatToolCall
    let requestId: String
    let interactions: ChatInteractor

    var body: some View {
        if isAskUserQuestionToolName(tool.name) {
            AskUserQuestionFooter(tool: tool, requestId: requestId, interactions: interactions)
        } else if isRequestUserInputToolName(tool.name) {
            RequestUserInputFooter(tool: tool, requestId: requestId, interactions: interactions)
        } else {
            PermissionActionsRow(tool: tool, requestId: requestId, interactions: interactions)
        }
    }
}

// MARK: - Ordinary tool approvals

private struct PermissionActionsRow: View {
    let tool: ChatToolCall
    let requestId: String
    let interactions: ChatInteractor

    var body: some View {
        let override = interactions.permissionOverrides[requestId]
        if override == .alreadyHandled {
            AlreadyHandledLine()
        } else {
            let resolving = override == .resolving
            let codex = isCodexPermissionUX(flavor: interactions.flavor, toolName: tool.name)
            let canAllowForSession = !codex && !PermissionGates.hideAllowForSession.contains(tool.name)
            let canAllowAllEdits = interactions.flavor == "claude"
                && PermissionGates.editTools.contains(tool.name)

            HStack(spacing: 8) {
                Button {
                    interactions.resolvePermission(requestId: requestId, action: .allow)
                } label: {
                    Text("Allow")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(.green)

                Button {
                    interactions.resolvePermission(requestId: requestId, action: codex ? .abort : .deny)
                } label: {
                    Text(codex ? String(localized: "Abort") : String(localized: "Deny"))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(.red)

                if resolving {
                    ProgressView()
                        .controlSize(.small)
                } else if codex || canAllowForSession || canAllowAllEdits {
                    Menu {
                        if codex || canAllowForSession {
                            Button("Allow for this session") {
                                interactions.resolvePermission(requestId: requestId, action: .allowForSession)
                            }
                        }
                        if canAllowAllEdits {
                            Button("Allow all edits") {
                                interactions.resolvePermission(requestId: requestId, action: .allowAllEdits)
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .frame(width: 28, height: 28)
                            .contentShape(Rectangle())
                    }
                }
            }
            .disabled(resolving)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
    }
}

private struct AlreadyHandledLine: View {
    var body: some View {
        Text("Already handled elsewhere")
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
    }
}

// MARK: - AskUserQuestion

/// AskUserQuestion answer form: every question as a card section — options as
/// tappable rows (radio/checkbox per `multiSelect`), an "Other" free-text
/// field, one Submit. Answers post flat `{key: [labels…]}` where the key is
/// the index (or the Cursor stable id) — `AskUserQuestionFooter.tsx` parity.
private struct AskUserQuestionFooter: View {
    let tool: ChatToolCall
    let requestId: String
    let interactions: ChatInteractor

    private let cursorDialect: Bool
    private let questions: [AskQuestion]

    /// Selection state per question index.
    @State private var selected: [Int: Set<Int>] = [:]
    @State private var otherText: [Int: String] = [:]
    @State private var validationError: String?

    init(tool: ChatToolCall, requestId: String, interactions: ChatInteractor) {
        self.tool = tool
        self.requestId = requestId
        self.interactions = interactions
        self.cursorDialect = isCursorAskQuestionToolName(tool.name)
        self.questions = parseAskUserQuestions(tool.input, cursorDialect: cursorDialect)
    }

    var body: some View {
        let override = interactions.permissionOverrides[requestId]
        if override == .alreadyHandled {
            AlreadyHandledLine()
        } else {
            let resolving = override == .resolving
            VStack(alignment: .leading, spacing: 10) {
                if questions.isEmpty {
                    // Fallback: free-text answer keyed "0" (web parity).
                    TextField(
                        "Type your answer…",
                        text: bindingForOther(0),
                        axis: .vertical
                    )
                    .lineLimit(2...4)
                    .textFieldStyle(.roundedBorder)
                    .disabled(resolving)
                } else {
                    ForEach(questions.indices, id: \.self) { index in
                        questionSection(index: index, enabled: !resolving)
                    }
                }

                if let validationError {
                    Text(validationError)
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                HStack {
                    Spacer()
                    if resolving {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Button("Submit") {
                            submit()
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
    }

    private func bindingForOther(_ index: Int) -> Binding<String> {
        Binding(
            get: { otherText[index] ?? "" },
            set: { text in
                otherText[index] = text
                if let question = questions.indices.contains(index) ? questions[index] : nil,
                   !question.multiSelect,
                   !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    // Typing a custom answer replaces a single-select choice.
                    selected[index] = []
                }
                validationError = nil
            }
        )
    }

    @ViewBuilder
    private func questionSection(index: Int, enabled: Bool) -> some View {
        let question = questions[index]
        VStack(alignment: .leading, spacing: 6) {
            if let header = question.header {
                Text(header)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            if !question.question.isEmpty {
                Text(question.question)
                    .font(.subheadline)
            }
            ForEach(question.options.indices, id: \.self) { optionIndex in
                let option = question.options[optionIndex]
                PermissionOptionRow(
                    label: option.label,
                    description: option.description,
                    checked: selected[index]?.contains(optionIndex) == true,
                    multiple: question.multiSelect,
                    enabled: enabled
                ) {
                    toggleOption(question: question, index: index, optionIndex: optionIndex)
                }
            }
            TextField("Other…", text: bindingForOther(index))
                .textFieldStyle(.roundedBorder)
                .disabled(!enabled)
        }
    }

    private func toggleOption(question: AskQuestion, index: Int, optionIndex: Int) {
        let current = selected[index] ?? []
        if question.multiSelect {
            selected[index] = current.contains(optionIndex)
                ? current.subtracting([optionIndex])
                : current.union([optionIndex])
        } else {
            selected[index] = [optionIndex]
        }
        validationError = nil
    }

    private func submit() {
        var answers: [String: [String]] = [:]
        if questions.isEmpty {
            let text = (otherText[0] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else {
                validationError = String(localized: "Type an answer first")
                return
            }
            answers["0"] = [text]
        } else {
            for (index, question) in questions.enumerated() {
                var values: [String] = []
                for optionIndex in (selected[index] ?? []).sorted()
                where question.options.indices.contains(optionIndex) {
                    let option = question.options[optionIndex]
                    if cursorDialect {
                        let id = option.id?.trimmingCharacters(in: .whitespaces) ?? ""
                        values.append(id.isEmpty ? option.label : id)
                    } else {
                        values.append(option.label)
                    }
                }
                let free = (otherText[index] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !free.isEmpty {
                    values.append(free)
                }
                guard !values.isEmpty else {
                    validationError = String(localized: "Answer every question first")
                    return
                }
                answers[question.answerKey(index: index, useStableIds: cursorDialect)] = values
            }
        }
        interactions.resolvePermission(requestId: requestId, action: .flatAnswers(answers))
    }
}

// MARK: - request_user_input

/// request_user_input answer form: per-field option rows plus a free-text
/// note; answers post nested `{fieldId: {answers: [labels…, "user_note: …"]}}`
/// (`RequestUserInputFooter.tsx` parity; the web-only URL confirmation flow
/// is not ported).
private struct RequestUserInputFooter: View {
    let tool: ChatToolCall
    let requestId: String
    let interactions: ChatInteractor

    private let questions: [RequestUserInputQuestion]

    @State private var selected: [String: Set<String>] = [:]
    @State private var notes: [String: String]
    @State private var validationError: String?

    init(tool: ChatToolCall, requestId: String, interactions: ChatInteractor) {
        self.tool = tool
        self.requestId = requestId
        self.interactions = interactions
        let parsed = parseRequestUserInputQuestions(tool.input)
        self.questions = parsed
        // Duplicate field ids are malformed input; keep the first rather
        // than trapping.
        _notes = State(initialValue: Dictionary(
            parsed.map { ($0.id, $0.prefill ?? "") },
            uniquingKeysWith: { first, _ in first }
        ))
    }

    var body: some View {
        let override = interactions.permissionOverrides[requestId]
        if override == .alreadyHandled {
            AlreadyHandledLine()
        } else {
            let resolving = override == .resolving
            VStack(alignment: .leading, spacing: 10) {
                ForEach(questions, id: \.id) { question in
                    questionSection(question, enabled: !resolving)
                }

                if let validationError {
                    Text(validationError)
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                HStack {
                    Spacer()
                    if resolving {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Button("Submit") {
                            submit()
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
    }

    @ViewBuilder
    private func questionSection(_ question: RequestUserInputQuestion, enabled: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if !question.question.isEmpty {
                Text(question.required
                    ? question.question
                    : String(format: String(localized: "%@ (optional)"), question.question))
                    .font(.subheadline)
            }
            ForEach(question.options.indices, id: \.self) { optionIndex in
                let option = question.options[optionIndex]
                PermissionOptionRow(
                    label: option.label,
                    description: option.description,
                    checked: selected[question.id]?.contains(option.label) == true,
                    multiple: question.multiple,
                    enabled: enabled
                ) {
                    toggleOption(question: question, label: option.label)
                }
            }
            TextField(
                question.placeholder ?? String(localized: "Add a note…"),
                text: Binding(
                    get: { notes[question.id] ?? "" },
                    set: { text in
                        notes[question.id] = text
                        validationError = nil
                    }
                )
            )
            .textFieldStyle(.roundedBorder)
            .disabled(!enabled)
        }
    }

    private func toggleOption(question: RequestUserInputQuestion, label: String) {
        let current = selected[question.id] ?? []
        if question.multiple {
            selected[question.id] = current.contains(label)
                ? current.subtracting([label])
                : current.union([label])
        } else {
            selected[question.id] = [label]
        }
        validationError = nil
    }

    private func submit() {
        for question in questions {
            let questionSelected = Array(selected[question.id] ?? [])
            let note = notes[question.id] ?? ""
            guard isRequestUserInputAnswered(question, selected: questionSelected, note: note) else {
                validationError = String(localized: "Answer every required question first")
                return
            }
        }
        var answers: [String: [String]] = [:]
        for question in questions {
            // Preserve the question's own option order for multi-selects.
            let picked = selected[question.id] ?? []
            let ordered = question.options.map(\.label).filter(picked.contains)
            answers[question.id] = requestUserInputAnswerValues(
                selected: ordered,
                note: notes[question.id] ?? ""
            )
        }
        interactions.resolvePermission(requestId: requestId, action: .nestedAnswers(answers))
    }
}

// MARK: - Shared option row

private struct PermissionOptionRow: View {
    let label: String
    let description: String?
    let checked: Bool
    let multiple: Bool
    let enabled: Bool
    let onTap: () -> Void

    @Environment(\.hapiTheme) private var theme

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: indicatorSymbol)
                    .font(.subheadline)
                    .foregroundStyle(checked ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    Text(label)
                        .font(.subheadline)
                        .foregroundStyle(theme.textPrimary)
                        .multilineTextAlignment(.leading)
                    if let description {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                checked ? AnyShapeStyle(.tint.opacity(0.14)) : AnyShapeStyle(theme.surface),
                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    private var indicatorSymbol: String {
        if multiple {
            return checked ? "checkmark.square.fill" : "square"
        }
        return checked ? "largecircle.fill.circle" : "circle"
    }
}
