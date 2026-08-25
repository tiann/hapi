import HapiClient
import HapiProtocol
import HapiUI
import SwiftUI

// MARK: - User bubble

/// Operator prompt: right-aligned bubble. Whitespace is preserved and the
/// text is NOT rendered as markdown — matching the web user bubble and the
/// Android port. Image attachments with a `previewUrl` render as thumbnails
/// (decoded off-main; also covers web-sent attachments), everything else as
/// filename chips (`AttachmentPreviewView`, A-M3f); a failed optimistic row
/// gets a "Not delivered" hint that retries the send when the interaction
/// engine is present (A-M3a).
struct UserTextBlockView: View {
    let block: UserTextBlock

    @Environment(\.chatInteractions) private var interactions

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 2) {
                VStack(alignment: .leading, spacing: 8) {
                    if !block.text.isEmpty {
                        Text(block.text)
                            .font(.subheadline)
                            .textSelection(.enabled)
                    }
                    if let attachments = block.attachments, !attachments.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(attachments, id: \.id) { attachment in
                                AttachmentPreviewView(attachment: attachment)
                            }
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(.tint.opacity(0.16))
                .clipShape(
                    .rect(
                        topLeadingRadius: 16,
                        bottomLeadingRadius: 16,
                        bottomTrailingRadius: 4,
                        topTrailingRadius: 16
                    )
                )
                if block.status == "failed" {
                    if let interactions, let retryLocalId = block.localId {
                        Button {
                            interactions.retryFailedMessage(localId: retryLocalId)
                        } label: {
                            Text("Not delivered — tap to retry")
                                .font(.caption2)
                                .foregroundStyle(.red)
                                .padding(.trailing, 4)
                        }
                        .buttonStyle(.plain)
                    } else {
                        Text("Not delivered")
                            .font(.caption2)
                            .foregroundStyle(.red)
                            .padding(.trailing, 4)
                    }
                }
            }
        }
    }
}

// MARK: - Agent prose

/// Assistant prose: full-width markdown through the shared M2e renderer.
struct AgentTextBlockView: View {
    let block: AgentTextBlock

    var body: some View {
        MarkdownView(markdown: block.text)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Extended thinking: collapsed to a subdued one-liner, expanding in place to
/// the full reasoning markdown (still subdued — it is meta-content).
struct AgentReasoningBlockView: View {
    let block: AgentReasoningBlock
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) {
                    expanded.toggle()
                }
            } label: {
                Label(
                    expanded ? String(localized: "Reasoning") : String(localized: "Reasoning…"),
                    systemImage: expanded ? "chevron.down" : "chevron.right"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            if expanded {
                MarkdownView(markdown: block.text)
                    .opacity(0.75)
                    .padding(.leading, 8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Event rows

/// Compact centered status row for the `'event'` family (limits, compaction,
/// switches, errors, turn duration, …); wording via `eventPresentation`.
struct AgentEventBlockView: View {
    let block: AgentEventBlock

    var body: some View {
        let presentation = eventPresentation(block.event)
        Text([presentation.icon, presentation.text].compactMap { $0 }.joined(separator: " "))
            .font(.caption)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .lineLimit(3)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24)
            .padding(.vertical, 2)
    }
}

// MARK: - CLI output

/// `<local-command-stdout>` / slash-command echo: terminal-styled monospace
/// panel (no header chrome — this is transcript, not a code sample).
struct CliOutputBlockView: View {
    let block: CliOutputBlock

    var body: some View {
        TerminalTextView(text: block.text)
    }
}

/// Shared terminal-look panel (cli output + tool stdout).
struct TerminalTextView: View {
    let text: String
    var isError = false

    @Environment(\.hapiTheme) private var theme

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(text)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(isError ? AnyShapeStyle(theme.danger) : AnyShapeStyle(theme.textPrimary))
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.codeBackground)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}
