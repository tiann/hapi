import HapiUI
import SwiftUI

/// Static answer cards, never the actionable permission form. Indices identify
/// rows so malformed duplicate question IDs cannot crash SwiftUI reconciliation.
struct QuestionDetailsView: View {
    let questions: [QuestionDetail]
    @Environment(\.hapiTheme) private var theme
    @Environment(\.hapiTypography) private var typography

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
                VStack(alignment: .leading, spacing: 8) {
                    if let header = question.header {
                        Text(verbatim: header).font(typography.captionFont).foregroundStyle(theme.textSecondary)
                    }
                    if !question.question.isEmpty {
                        QuestionMarkdown(text: question.question)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(theme.quoteBackground, in: RoundedRectangle(cornerRadius: 8))
                    }
                    ForEach(Array(question.options.enumerated()), id: \.offset) { optionIndex, option in
                        QuestionAnswerCard(
                            text: option.label, description: option.description, markdown: true,
                            selected: option.selected, multiple: question.multiple, showControl: question.hasAnswers
                        )
                        .accessibilityIdentifier("question-\(index)-option-\(optionIndex)")
                    }
                    ForEach(Array(question.otherAnswers.enumerated()), id: \.offset) { _, answer in
                        QuestionAnswerCard(
                            text: answer, caption: question.options.isEmpty ? nil : String(localized: "Custom answer"),
                            selected: true, multiple: question.multiple
                        )
                    }
                    if let note = question.note {
                        QuestionAnswerCard(
                            text: note, caption: question.options.isEmpty ? nil : String(localized: "Note"),
                            selected: true, multiple: false
                        )
                    }
                }
            }
        }
    }
}

private struct QuestionAnswerCard: View {
    let text: String
    var description: String?
    var caption: String?
    var markdown = false
    let selected: Bool
    let multiple: Bool
    var showControl = true
    @Environment(\.hapiTheme) private var theme
    @Environment(\.hapiTypography) private var typography

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if showControl {
                Image(systemName: multiple
                      ? (selected ? "checkmark.square.fill" : "square")
                      : (selected ? "largecircle.fill.circle" : "circle"))
                    .foregroundStyle(selected ? theme.success : theme.textHint)
                    .font(typography.bodyFont)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 4) {
                if let caption {
                    Text(verbatim: caption).font(typography.captionFont).foregroundStyle(theme.textSecondary)
                }
                if markdown {
                    QuestionMarkdown(text: text)
                } else if text.count > toolTextPageSize {
                    ToolTextContent(language: nil, code: text)
                } else {
                    Text(verbatim: text.isEmpty ? String(localized: "(empty)") : text)
                        .font(typography.bodyFont).textSelection(.enabled)
                }
                if let description, !description.isEmpty {
                    QuestionMarkdown(text: description).foregroundStyle(theme.textSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(10)
        .background(selected ? theme.success.opacity(0.10) : theme.surface,
                    in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(selected ? theme.success : theme.divider, lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityValue(showControl ? (selected ? String(localized: "Selected") : String(localized: "Not selected")) : "")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct QuestionMarkdown: View {
    let text: String
    var body: some View {
        if text.count > toolTextPageSize {
            ToolTextContent(language: "markdown", code: text)
        } else {
            CachedMarkdownView(markdown: text)
        }
    }
}
