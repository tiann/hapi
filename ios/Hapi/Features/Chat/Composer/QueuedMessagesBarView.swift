import HapiClient
import SwiftUI

/// Floating bar above the composer for queued (uninvoked) sends — the
/// SwiftUI twin of `QueuedMessagesBar.tsx` via the Android port. Per row:
/// Steer (while a turn is active), Edit (cancel + prefill composer) and
/// Cancel. Rows without a server echo yet (`id == localId`) keep their
/// actions disabled until the SSE echo lands.
struct QueuedMessagesBarView: View {
    let interactor: ChatInteractor

    var body: some View {
        let rows = interactor.queuedRows
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(rows.count == 1
                    ? String(localized: "1 queued message")
                    : String(format: String(localized: "%lld queued messages"), Int64(rows.count)))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
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

private struct QueuedRowView: View {
    let row: QueuedMessageRow
    let interactor: ChatInteractor

    var body: some View {
        HStack(alignment: .center, spacing: 4) {
            VStack(alignment: .leading, spacing: 1) {
                Text(row.text.isEmpty ? row.attachmentNames.joined(separator: ", ") : row.text)
                    .font(.footnote)
                    .lineLimit(2)
                if row.indeterminate {
                    Text("Delivery outcome unknown")
                        .font(.caption2)
                        .foregroundStyle(.red)
                }
                if let scheduledAt = row.scheduledAt {
                    Text("Scheduled · \(Self.timeLabel(scheduledAt))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if row.indeterminate {
                Button("Retry") {
                    interactor.retryIndeterminateMessage(row.id)
                }
                .font(.footnote.weight(.medium))
                .disabled(!row.canAct)
            } else if row.canSteer {
                Button("Steer") {
                    interactor.steerQueuedMessage(row.id)
                }
                .font(.footnote.weight(.medium))
            }
            Button("Edit") {
                interactor.editQueuedMessage(row.id)
            }
            .font(.footnote.weight(.medium))
            .disabled(!row.canAct)
            Button("Cancel") {
                interactor.cancelQueuedMessage(row.id)
            }
            .font(.footnote.weight(.medium))
            .tint(.red)
            .disabled(!row.canAct)
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private static func timeLabel(_ epochMs: Int) -> String {
        Date(timeIntervalSince1970: TimeInterval(epochMs) / 1000)
            .formatted(date: .omitted, time: .shortened)
    }
}
