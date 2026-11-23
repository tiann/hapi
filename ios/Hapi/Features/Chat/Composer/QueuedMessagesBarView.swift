import HapiClient
import HapiUI
import SwiftUI

/// Queued (uninvoked) sends, stacked as a compact card on top of the
/// composer — the agent-tool convention (Codex, Claude Code, Cursor) rather
/// than chat-app "unsent" bubbles, so a queued message never reads as a
/// failed delivery. Same data and actions as the web `QueuedMessagesBar`:
/// icon actions per row (Steer while a turn is active, Retry for an
/// unknown outcome, Cancel); tapping the row edits it (cancel +
/// prefill composer) and the context menu carries everything. Rows without
/// a server echo yet (`id == localId`) keep their actions disabled until the
/// SSE echo lands.
struct QueuedMessagesBarView: View {
    let interactor: ChatInteractor
    /// Measured height of the rows; nil until the first layout pass (one
    /// row is the likely case, so that is the first guess).
    @State private var contentHeight: CGFloat?

    var body: some View {
        let rows = interactor.queuedRows
        VStack(spacing: 0) {
            if !rows.isEmpty {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                            if index > 0 { Divider().padding(.leading, 14) }
                            QueuedRowView(row: row, interactor: interactor)
                                .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }
                    }
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: {
                        contentHeight = $0
                    }
                }
                // A ScrollView is greedy: size it to its rows, capped at about
                // three; further ones scroll inside the card.
                .frame(height: min(contentHeight ?? 44, 140))
                .scrollBounceBehavior(.basedOnSize)
                .modifier(QueuedCardSurface())
                .accessibilityElement(children: .contain)
                .accessibilityLabel(rows.count == 1
                    ? String(localized: "1 queued message")
                    : String(format: String(localized: "%lld queued messages"), Int64(rows.count)))
                // Inset from the composer edges so the card reads as stacked
                // on it rather than as a second input.
                .padding(.horizontal, 8)
                .hapiReadingColumn()
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .animation(.snappy, value: rows.map(\.id))
    }
}

struct QueuedRowView: View {
    let row: QueuedMessageRow
    let interactor: ChatInteractor
    @Environment(\.hapiTheme) private var theme
    @Environment(\.hapiTypography) private var typography

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 4) {
                // A fixed ideal width: long status lines wrap in place instead
                // of pushing the actions onto their own line.
                preview.frame(minWidth: 120, idealWidth: 120, maxWidth: .infinity, alignment: .leading)
                actions
            }
            VStack(alignment: .trailing, spacing: 0) {
                preview.frame(maxWidth: .infinity, alignment: .leading)
                actions
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 4)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .onTapGesture {
            if row.canAct { interactor.editQueuedMessage(row.id) }
        }
        .contextMenu { menuActions }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: Text("Edit")) {
            if row.canAct { interactor.editQueuedMessage(row.id) }
        }
    }

    private var preview: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "arrow.turn.down.right")
                .font(typography.captionFont)
                .foregroundStyle(theme.textSecondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(row.text.isEmpty ? row.attachmentNames.joined(separator: ", ") : row.text)
                    .font(typography.toolSubtitleFont)
                    .foregroundStyle(theme.textPrimary)
                    .lineLimit(1)
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
        .padding(.vertical, 6)
    }

    private var actions: some View {
        HStack(spacing: 0) {
            if row.indeterminate {
                iconAction("arrow.clockwise", label: "Retry", id: "retry", tint: theme.danger) {
                    interactor.retryIndeterminateMessage(row.id)
                }
            } else if row.canSteer {
                iconAction("bolt", label: "Steer", id: "steer", tint: theme.link) {
                    interactor.steerQueuedMessage(row.id)
                }
            }
            iconAction("xmark", label: "Cancel", id: "cancel", tint: theme.textSecondary) {
                interactor.cancelQueuedMessage(row.id)
            }
        }
        .fixedSize()
    }

    /// Bare symbol in a 44 pt hit target; the label is for VoiceOver.
    private func iconAction(
        _ systemImage: String, label: LocalizedStringKey, id: String, tint: Color,
        perform: @escaping () -> Void
    ) -> some View {
        Button(action: perform) {
            Image(systemName: systemImage)
                .font(typography.bodyFont.weight(.semibold))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(tint.opacity(row.canAct ? 1 : 0.4))
        .disabled(!row.canAct)
        .accessibilityLabel(label)
        .accessibilityIdentifier("queued-\(id)-\(row.id)")
    }

    @ViewBuilder
    private var menuActions: some View {
        if row.indeterminate {
            Button("Retry", systemImage: "arrow.clockwise") {
                interactor.retryIndeterminateMessage(row.id)
            }
            .disabled(!row.canAct)
        } else if row.canSteer {
            Button("Steer", systemImage: "bolt") {
                interactor.steerQueuedMessage(row.id)
            }
        }
        Button("Edit", systemImage: "pencil") {
            interactor.editQueuedMessage(row.id)
        }
        .disabled(!row.canAct)
        Button("Cancel", systemImage: "xmark", role: .destructive) {
            interactor.cancelQueuedMessage(row.id)
        }
        .disabled(!row.canAct)
    }

    private static func timeLabel(_ epochMs: Int) -> String {
        Date(timeIntervalSince1970: TimeInterval(epochMs) / 1000)
            .formatted(date: .omitted, time: .shortened)
    }
}

/// Matches the composer card (`ComposerCardSurface`): Liquid Glass on
/// iOS 26, otherwise the elevated surface with a hairline edge.
private struct QueuedCardSurface: ViewModifier {
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
        let fill = Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(white: 0.12, alpha: 1) : .white
        })
        if #available(iOS 26.0, *) {
            content
                .background(shape.fill(fill.opacity(0.7)))
                .clipShape(shape)
                .glassEffect(.regular, in: shape)
        } else {
            content
                .background(shape.fill(fill))
                .clipShape(shape)
                .overlay(shape.strokeBorder(Color(uiColor: .separator), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
        }
    }
}
