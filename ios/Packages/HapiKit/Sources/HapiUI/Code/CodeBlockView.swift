import SwiftUI

/// Fenced code block: rounded container with a header (language chip + copy
/// button) and horizontally scrollable monospaced body. Highlighting runs off
/// the main thread through the injected `SyntaxHighlighting` engine and is
/// applied when ready; until then (or when the engine declines) the code
/// renders as plain text.
///
/// Unsupported fence languages the web renders specially (mermaid, math)
/// deliberately fall back to this view per the v1 plan.
public struct CodeBlockView: View {
    public let language: String?
    public let code: String

    @Environment(\.hapiTheme) private var theme
    @Environment(\.hapiSyntaxHighlighter) private var highlighter
    @Environment(\.hapiPasteboard) private var pasteboard

    @State private var highlighted: AttributedString?
    @State private var showCopied = false

    public init(language: String?, code: String) {
        self.language = language
        self.code = code
    }

    private var displayLanguage: String {
        guard let language, !language.isEmpty else { return "text" }
        return language.lowercased()
    }

    /// Recompute highlighting when content or palette changes.
    private var highlightID: String {
        "\(displayLanguage)|\(theme.isDark ? "d" : "l")|\(code.count)|\(code.hashValue)"
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            ScrollView(.horizontal, showsIndicators: false) {
                Text(highlighted ?? AttributedString(code))
                    .font(theme.codeFont)
                    .foregroundStyle(theme.textPrimary)
                    .textSelection(.enabled)
                    .padding(12)
            }
        }
        .background(theme.codeBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .task(id: highlightID) {
            highlighted = await highlighter.highlightAsync(
                code,
                language: language,
                dark: theme.isDark
            )
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text(displayLanguage)
                .font(.system(size: theme.captionSize, design: .monospaced))
                .foregroundStyle(theme.textSecondary)
                .lineLimit(1)
            Spacer(minLength: 12)
            Button {
                // Explicit MainActor hop: keeps the @MainActor pasteboard
                // call valid regardless of the SDK's Button-action isolation.
                let pasteboard = pasteboard
                let code = code
                Task { @MainActor in
                    pasteboard.copy(code)
                    showCopied = true
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    showCopied = false
                }
            } label: {
                Image(systemName: showCopied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: theme.captionSize))
                    .foregroundStyle(showCopied ? theme.success : theme.textSecondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(showCopied ? "Copied" : "Copy code"))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(theme.codeHeaderBackground)
    }
}
