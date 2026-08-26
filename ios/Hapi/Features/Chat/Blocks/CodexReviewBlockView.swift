import HapiProtocol
import HapiUI
import SwiftUI

/// Codex `/review` verdict card (web `CodexReviewCard`): header with the
/// overall-correctness badge (+ confidence), the explanation as markdown,
/// and the findings list collapsed behind a count row.
struct CodexReviewBlockView: View {
    let block: CodexReviewBlock

    @State private var findingsOpen = false
    @Environment(\.hapiTheme) private var theme

    var body: some View {
        let review = block.review
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Text("Code review")
                    .font(.subheadline.weight(.semibold))
                Spacer(minLength: 8)
                if let verdict = review.overallCorrectness {
                    VerdictBadge(verdict: verdict)
                }
                if let confidence = formatPercent(review.overallConfidenceScore) {
                    Text(confidence)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            if let explanation = review.overallExplanation,
               !explanation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Divider()
                MarkdownView(markdown: explanation)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
            }

            if !review.findings.isEmpty {
                Divider()
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        findingsOpen.toggle()
                    }
                } label: {
                    Label(
                        review.findings.count == 1
                            ? String(localized: "1 finding")
                            : String(format: String(localized: "%lld findings"), Int64(review.findings.count)),
                        systemImage: findingsOpen ? "chevron.down" : "chevron.right"
                    )
                    .font(.footnote)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if findingsOpen {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(review.findings.enumerated()), id: \.offset) { _, finding in
                            FindingRow(finding: finding)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct VerdictBadge: View {
    let verdict: String

    var body: some View {
        let lowered = verdict.lowercased()
        let tint: Color = lowered.contains("incorrect")
            ? .red
            : (lowered.contains("correct") ? .green : .secondary)
        Text(verdict)
            .font(.caption2)
            .foregroundStyle(tint)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tint.opacity(0.15), in: RoundedRectangle(cornerRadius: 6))
    }
}

private struct FindingRow: View {
    let finding: CodexReviewFinding

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if let priority = finding.priority {
                    let value = Int(priority.rounded())
                    Text("P\(value)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(value <= 1 ? Color.red : Color.secondary)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(
                            (value <= 1 ? Color.red : Color.secondary).opacity(0.14),
                            in: RoundedRectangle(cornerRadius: 4)
                        )
                }
                Text(finding.title)
                    .font(.subheadline.weight(.semibold))
            }
            Text(finding.body)
                .font(.footnote)
            if let location = formatLocation(finding) {
                Text(location)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
    }
}

private func formatPercent(_ value: Double?) -> String? {
    guard let value, value.isFinite else { return nil }
    return "\(Int((value * 100).rounded()))%"
}

private func formatLocation(_ finding: CodexReviewFinding) -> String? {
    guard let filePath = finding.filePath else { return nil }
    guard let start = finding.lineStart.map({ Int($0.rounded()) }) else { return filePath }
    if let end = finding.lineEnd.map({ Int($0.rounded()) }), end != start {
        return "\(filePath):\(start)-\(end)"
    }
    return "\(filePath):\(start)"
}
