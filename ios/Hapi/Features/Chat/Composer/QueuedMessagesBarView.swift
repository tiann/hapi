import HapiClient
import HapiUI
import SwiftUI

/// Floating bar above the composer for queued (uninvoked) sends — the
/// SwiftUI twin of `QueuedMessagesBar.tsx` via the Android port. Per row:
/// Steer (while a turn is active), Edit (cancel + prefill composer) and
/// Cancel. Rows without a server echo yet (`id == localId`) keep their
/// actions disabled until the SSE echo lands.
struct QueuedMessagesBarView: View {
    let interactor: ChatInteractor
    @Environment(\.hapiTheme) private var theme
    @Environment(\.hapiTypography) private var typography

    var body: some View {
        let rows = interactor.queuedRows
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(rows.count == 1
                    ? String(localized: "1 queued message")
                    : String(format: String(localized: "%lld queued messages"), Int64(rows.count)))
                    .font(typography.captionFont)
                    .foregroundStyle(theme.textSecondary)
                    .padding(.horizontal, 10)
                ScrollView {
                    VStack(spacing: 4) {
                        ForEach(rows) { row in
                            QueuedRowView(row: row, interactor: interactor)
                        }
                    }
                    .padding(.horizontal, 10)
                }
                .frame(maxHeight: 160)
                .scrollBounceBehavior(.basedOnSize)
            }
            .padding(.vertical, 4)
            .background(.bar)
        }
    }
}

struct QueuedRowView: View {
    let row: QueuedMessageRow
    let interactor: ChatInteractor
    @Environment(\.hapiTheme) private var theme
    @Environment(\.hapiTypography) private var typography

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                preview.frame(minWidth: 120, alignment: .leading)
                Spacer(minLength: 0)
                HStack(spacing: 4) { actions(horizontal: true) }
                    .fixedSize(horizontal: true, vertical: true)
            }
            VStack(alignment: .leading, spacing: 4) {
                preview.frame(maxWidth: .infinity, alignment: .leading)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 4) { actions(horizontal: true) }
                    VStack(spacing: 4) { actions(horizontal: false) }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(theme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var preview: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(row.text.isEmpty ? row.attachmentNames.joined(separator: ", ") : row.text)
                .font(typography.toolSubtitleFont)
                .foregroundStyle(theme.textPrimary)
                .lineLimit(2)
            if row.indeterminate {
                Text("Delivery outcome unknown")
                    .font(typography.captionFont)
                    .foregroundStyle(theme.danger)
            }
            if let scheduledAt = row.scheduledAt {
                Text("Scheduled · \(Self.timeLabel(scheduledAt))")
                    .font(typography.captionFont)
                    .foregroundStyle(theme.textSecondary)
            }
        }
    }

    @ViewBuilder
    private func actions(horizontal: Bool) -> some View {
        if row.indeterminate {
            action("Retry", id: "retry", horizontal: horizontal) {
                interactor.retryIndeterminateMessage(row.id)
            }
        } else if row.canSteer {
            action("Steer", id: "steer", horizontal: horizontal) {
                interactor.steerQueuedMessage(row.id)
            }
        }
        action("Edit", id: "edit", horizontal: horizontal) {
            interactor.editQueuedMessage(row.id)
        }
        action("Cancel", id: "cancel", horizontal: horizontal, destructive: true) {
            interactor.cancelQueuedMessage(row.id)
        }
    }

    private func action(
        _ title: LocalizedStringKey, id: String, horizontal: Bool,
        destructive: Bool = false, perform: @escaping () -> Void
    ) -> some View {
        Button(action: perform) {
            Text(title)
                .font(typography.toolTitleFont)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: horizontal, vertical: true)
                .padding(.horizontal, 8)
                .frame(minWidth: 44, maxWidth: horizontal ? nil : .infinity, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(destructive ? theme.danger : theme.link)
        .disabled(!row.canAct)
        .opacity(row.canAct ? 1 : 0.5)
        .accessibilityIdentifier("queued-\(id)-\(row.id)")
    }

    private static func timeLabel(_ epochMs: Int) -> String {
        Date(timeIntervalSince1970: TimeInterval(epochMs) / 1000)
            .formatted(date: .omitted, time: .shortened)
    }
}
