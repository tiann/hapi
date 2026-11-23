import HapiClient
import SwiftUI

struct ComposerMentionList: View {
    let suggestions: [ComposerMentionSuggestion]
    let surface: Color
    let onSelect: (ComposerMentionSuggestion) -> Void
    @ScaledMetric(relativeTo: .body) private var rowHeight: CGFloat = 58

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(suggestions) { suggestion in
                    Button { onSelect(suggestion) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: suggestion.source == .file ? "doc" : "bubble.left.and.bubble.right")
                                .foregroundStyle(.secondary)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: suggestion.label)
                                    .font(.body)
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                HStack(spacing: 4) {
                                    if case .session(let active) = suggestion.source {
                                        Text("Session")
                                        Text(verbatim: "·")
                                        if active { Text("Active"); Text(verbatim: "·") }
                                    }
                                    Text(verbatim: suggestion.detail)
                                }
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            }
                            Spacer(minLength: 0)
                        }
                        .frame(maxWidth: .infinity, minHeight: rowHeight, alignment: .leading)
                        .padding(.horizontal, 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("composer.mention.\(suggestion.id)")
                }
            }
        }
        .frame(height: min(CGFloat(suggestions.count), 4) * rowHeight)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(surface))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: .black.opacity(0.06), radius: 6, y: 2)
        .accessibilityIdentifier("composer.mentions")
    }
}
