import HapiClient
import HapiProtocol
import HapiUI
import SwiftUI

/// Questions are conversations, not permission approvals. Pending questions
/// own one inline step; settled records open the existing read-only inspector.
struct QuestionToolCard: View {
    let block: ToolCallBlock
    @Environment(\.chatInteractions) private var interactions
    @Environment(\.openChatTool) private var openTool
    @Environment(\.hapiTheme) private var theme
    @Environment(\.hapiTypography) private var typography

    var body: some View {
        let details = questionToolDetails(block.tool)
        let override = block.tool.permission.flatMap { interactions?.permissionOverrides[$0.id] }
        let state = QuestionCardState(tool: block.tool, details: details, override: override)
        Group {
            if (state == .answering || state == .submitting), let permission = block.tool.permission {
                QuestionAnswerFormView(
                    tool: block.tool, requestId: permission.id,
                    enabled: interactions != nil, submitting: state == .submitting,
                    openDetails: { openTool?(block) },
                    submit: { interactions?.resolvePermission(requestId: permission.id, action: $0) }
                )
            } else {
                summary(details: details, state: state)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func summary(details: QuestionToolDetails, state: QuestionCardState) -> some View {
        Button { openTool?(block) } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: state.icon)
                        .foregroundStyle(state == .failed ? theme.danger :
                                            state == .answered ? theme.success : theme.textSecondary)
                        .accessibilityHidden(true)
                    Text(verbatim: state.title)
                        .font(typography.toolTitleFont)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(typography.captionFont)
                        .foregroundStyle(theme.textSecondary)
                        .accessibilityHidden(true)
                }
                ForEach(Array(details.questions.enumerated()), id: \.offset) { _, question in
                    VStack(alignment: .leading, spacing: 3) {
                        let title = question.header ?? question.question
                        if !title.isEmpty {
                            Text(verbatim: title)
                                .font(typography.captionFont)
                                .foregroundStyle(theme.textSecondary)
                                .lineLimit(1)
                        }
                        if let answer = questionAnswerSummary(question) {
                            Text(verbatim: answer)
                                .font(typography.bodyFont)
                                .lineLimit(details.questions.count == 1 ? 2 : 1)
                        }
                    }
                }
            }
            .foregroundStyle(theme.textPrimary)
            .multilineTextAlignment(.leading)
            .padding(16)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("View full questions and answers")
        .accessibilityIdentifier("tool-summary-\(block.id)")
    }

}

struct QuestionAnswerFormView: View {
    let requestId: String
    let enabled: Bool
    let submitting: Bool
    let openDetails: (() -> Void)?
    let submit: (PermissionAction) -> Void
    private let form: QuestionAnswerForm

    @ChatStoredState private var draft: QuestionAnswerDraft
    @FocusState private var textFocused: Bool
    @AccessibilityFocusState private var focusedQuestion: Int?
    @Environment(\.hapiTheme) private var theme
    @Environment(\.hapiTypography) private var typography

    init(tool: ChatToolCall, requestId: String, enabled: Bool, submitting: Bool,
         openDetails: (() -> Void)?, submit: @escaping (PermissionAction) -> Void) {
        self.requestId = requestId
        self.enabled = enabled
        self.submitting = submitting
        self.openDetails = openDetails
        self.submit = submit
        form = QuestionAnswerForm(tool: tool)
        _draft = ChatStoredState(wrappedValue: QuestionAnswerDraft(), id: requestId, field: QuestionAnswerDraft.storageField)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            let index = draft.currentPage(in: form)
            header(index: index)
            if form.fields.indices.contains(index) {
                question(index: index)
                    .id(index)
                navigation(index: index)
            } else {
                Text("This question could not be displayed. Open details to inspect the request.")
                    .font(typography.bodyFont)
                    .foregroundStyle(theme.textSecondary)
            }
        }
        .padding(16)
        .onChange(of: draft.page) { _, _ in
            textFocused = false
            focusedQuestion = draft.currentPage(in: form)
        }
        .onChange(of: submitting) { _, value in
            if value { textFocused = false }
        }
    }

    private func header(index: Int) -> some View {
        let title = form.fields.indices.contains(index) ? form.fields[index].header : nil
        let layout = typography.usesStackedToolLayout
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 0))
            : AnyLayout(HStackLayout(spacing: 8))
        return layout {
            Label {
                Text(verbatim: title ?? String(localized: "Your answer"))
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "questionmark.bubble")
                    .foregroundStyle(theme.accent)
                    .accessibilityHidden(true)
            }
            .font(typography.toolTitleFont)
            .foregroundStyle(theme.textSecondary)
            if !typography.usesStackedToolLayout { Spacer(minLength: 0) }
            HStack(spacing: 12) {
                if form.fields.count > 1 {
                    Text(verbatim: "\(index + 1)/\(form.fields.count)")
                        .monospacedDigit()
                        .foregroundStyle(theme.textSecondary)
                        .accessibilityLabel(String(format: String(localized: "Question %lld of %lld"),
                                                   Int64(index + 1), Int64(form.fields.count)))
                        .accessibilityIdentifier("question-progress")
                }
                if let openDetails {
                    Button("Details", action: openDetails)
                        .frame(minWidth: 44, minHeight: 44)
                        .accessibilityIdentifier("question-details-\(requestId)")
                }
            }
            .font(typography.captionFont)
        }
    }

    private func question(index: Int) -> some View {
        let field = form.fields[index]
        return VStack(alignment: .leading, spacing: 10) {
            QuestionMarkdown(text: field.question.isEmpty ? String(localized: "Type your answer…") : field.question)
                .foregroundStyle(theme.textPrimary)
                .accessibilityAddTraits(.isHeader)
                .accessibilityFocused($focusedQuestion, equals: index)
                .accessibilityIdentifier("question-prompt-\(index)")

            if field.multiple || !field.required {
                Text(verbatim: [field.multiple ? String(localized: "Select all that apply") : nil,
                                !field.required ? String(localized: "Optional") : nil].compactMap { $0 }.joined(separator: " · "))
                    .font(typography.captionFont)
                    .foregroundStyle(theme.textSecondary)
            }

            VStack(spacing: 4) {
                ForEach(field.options.indices, id: \.self) { optionIndex in
                    QuestionSelectionRow(
                        option: field.options[optionIndex],
                        selected: draft.selections[index]?.contains(optionIndex) == true,
                        multiple: field.multiple
                    ) {
                        guard enabled, !submitting else { return }
                        textFocused = false
                        draft.select(optionIndex, at: index, in: form)
                    }
                    .disabled(!enabled || submitting)
                    .accessibilityIdentifier("question-\(index)-choice-\(optionIndex)")
                }
            }
            textInput(index: index)
        }
    }

    private func textTitle(index: Int) -> String {
        let field = form.fields[index]
        return field.options.isEmpty ? String(localized: "Your answer") :
            field.allowsCustomAnswer ? String(localized: "Other answer") : String(localized: "Add a note…")
    }

    @ViewBuilder
    private func textInput(index: Int) -> some View {
        if draft.showsText(at: index, in: form) {
            TextField(form.fields[index].placeholder ?? textTitle(index: index), text: Binding(
                get: { draft.text(at: index, in: form) },
                set: { draft.setText($0, at: index, in: form) }
            ), axis: .vertical)
            .font(typography.bodyFont)
            .lineLimit(2...6)
            .padding(12)
            .background(theme.background, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(theme.divider, lineWidth: 1))
            .focused($textFocused)
            .disabled(!enabled || submitting)
            .accessibilityLabel(textTitle(index: index))
            .accessibilityIdentifier("question-\(index)-text")
        }
    }

    private func navigation(index: Int) -> some View {
        // Keep the note affordance and primary action on one quiet row when
        // they fit. Narrow widths / large text use two rows, never truncation.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                secondaryActions(index: index).fixedSize(horizontal: true, vertical: false)
                Spacer(minLength: 0)
                primaryAction(index: index).fixedSize(horizontal: true, vertical: false)
            }
            VStack(alignment: .leading, spacing: 8) {
                secondaryActions(index: index)
                primaryAction(index: index, fullWidth: true)
            }
        }
    }

    private func secondaryActions(index: Int) -> some View {
        HStack(spacing: 8) {
            if index > 0 {
                Button { draft.previous(in: form) } label: {
                    Image(systemName: "chevron.left")
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Previous question")
                .accessibilityIdentifier("question-previous")
            }
            if !form.fields[index].options.isEmpty {
                Button {
                    draft.toggleText(at: index, in: form)
                    textFocused = draft.showsText(at: index, in: form)
                } label: {
                    Label {
                        Text(verbatim: textTitle(index: index))
                            .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: draft.showsText(at: index, in: form) ? "chevron.up" : "plus")
                    }
                    .font(typography.captionFont)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .accessibilityIdentifier("question-\(index)-expand-text")
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(theme.accent)
        .disabled(!enabled || submitting)
    }

    private func primaryAction(index: Int, fullWidth: Bool = false) -> some View {
        let last = index == form.fields.count - 1
        return Button {
            guard enabled, !submitting else { return }
            if last {
                if let action = draft.submission(in: form) { submit(action) }
            } else {
                draft.next(in: form)
            }
        } label: {
            HStack(spacing: 8) {
                if submitting { ProgressView().tint(.white).controlSize(.small) }
                Text(submitting ? String(localized: "Submitting answer…") :
                        last ? String(localized: "Submit answer") : String(localized: "Next question"))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(typography.toolTitleFont)
            .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: 32)
            .padding(.horizontal, 8)
        }
        .buttonStyle(.borderedProminent)
        .tint(theme.accent)
        .disabled(!enabled || submitting || (last ? draft.submission(in: form) == nil : !draft.isAnswered(at: index, in: form)))
        .accessibilityIdentifier(last ? "question-submit" : "question-next")
    }
}

private struct QuestionSelectionRow: View {
    let option: AskOption
    let selected: Bool
    let multiple: Bool
    let action: () -> Void
    @Environment(\.hapiTheme) private var theme
    @Environment(\.hapiTypography) private var typography

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: multiple ? (selected ? "checkmark.square.fill" : "square") :
                        (selected ? "largecircle.fill.circle" : "circle"))
                    .font(typography.bodyFont)
                    .foregroundStyle(selected ? theme.accent : theme.textHint)
                    .padding(.top, 2)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    QuestionOptionLabel(label: option.label)
                    if let description = option.description {
                        // Inline markdown keeps the caption metrics instead of
                        // promoting supporting text to full-size body paragraphs.
                        Text(.init(description))
                            .font(typography.captionFont)
                            .foregroundStyle(theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                // The button owns taps, not selectable Markdown/link children.
                // Keep the outer label hit-testable so its full row still works.
                .allowsHitTesting(false)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(selected ? theme.accent.opacity(0.10) : .clear,
                        in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(selected ? theme.accent : theme.divider, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .multilineTextAlignment(.leading)
        .accessibilityElement(children: .combine)
        .accessibilityValue(selected ? String(localized: "Selected") : String(localized: "Not selected"))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct QuestionOptionLabel: View {
    let label: String
    @Environment(\.hapiTheme) private var theme
    @Environment(\.hapiTypography) private var typography

    var body: some View {
        let title = QuestionOptionTitle(label)
        if title.recommended {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    QuestionMarkdown(text: title.text)
                    badge
                }
                .fixedSize(horizontal: true, vertical: false)
                VStack(alignment: .leading, spacing: 4) {
                    QuestionMarkdown(text: title.text)
                    badge
                }
            }
            .foregroundStyle(theme.textPrimary)
        } else {
            QuestionMarkdown(text: title.text).foregroundStyle(theme.textPrimary)
        }
    }

    private var badge: some View {
        Text("Recommended")
            .font(typography.captionFont)
            .foregroundStyle(theme.accent)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(theme.accent.opacity(0.08), in: Capsule())
    }
}
