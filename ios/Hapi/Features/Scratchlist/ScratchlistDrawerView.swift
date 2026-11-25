import HapiClient
import HapiProtocol
import HapiUI
import SwiftUI
import UIKit

private struct ScratchlistAccessibilityProbe: UIViewRepresentable {
    let identifier: String

    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.accessibilityIdentifier = identifier
        view.isAccessibilityElement = false
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        view.accessibilityIdentifier = identifier
    }
}

/// One recent draft while browsing; just a header while typing.
struct ScratchlistDrawerView: View {
    @State private var model: ScratchlistScreenModel
    let interactor: ChatInteractor
    let keyboardFocused: Bool
    let onOpen: (ScratchlistEntry?, Bool) -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(store: any SessionScratchlistStoring, sessionId: String, interactor: ChatInteractor,
         keyboardFocused: Bool, onOpen: @escaping (ScratchlistEntry?, Bool) -> Void) {
        _model = State(initialValue: ScratchlistScreenModel(sessionId: sessionId, store: store))
        self.interactor = interactor
        self.keyboardFocused = keyboardFocused
        self.onOpen = onOpen
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if model.state.loadFailed || model.state.refreshFailed {
                ScratchlistErrorBanner(message: String(localized: model.state.loadFailed
                    ? "Couldn't load the scratchlist" : "Couldn't refresh — showing saved drafts")) { model.retry() }
            }
            if !keyboardFocused, !dynamicTypeSize.isAccessibilitySize, let entry = model.state.entries.first {
                ScratchlistEntryRow(entry: entry, interactor: interactor,
                    onOpen: { onOpen(entry, false) }, onEdit: { onOpen(entry, true) },
                    onDelete: { model.deleteEntry(entry.entryId) }, compact: true)
                    .padding(.bottom, 8)
                    .accessibilityIdentifier("scratchlist.recent")
                    // Keep a concrete UIKit node for presentation tests. The
                    // probe follows the same condition as the visible preview.
                    .background {
                        ScratchlistAccessibilityProbe(identifier: "scratchlist.recent")
                            .frame(width: 1, height: 1)
                            .allowsHitTesting(false)
                    }
            }
            Divider()
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .accessibilityIdentifier("scratchlist.drawer")
        .onAppear { model.start() }
        .onDisappear { model.stop() }
    }

    private var header: some View {
        HStack(spacing: 0) {
            Button { onOpen(nil, false) } label: {
                HStack(spacing: 6) {
                    Text("Scratchlist").font(.subheadline.weight(.semibold))
                    if model.isLoading {
                        ProgressView().controlSize(.small)
                    } else if model.state.loaded {
                        Text(verbatim: "· \(model.state.entries.count)")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("View all")
            .accessibilityIdentifier("scratchlist.open")
            Button { interactor.setComposerDestination(.chat) } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .medium)).foregroundStyle(.secondary)
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back to chat")
            .accessibilityIdentifier("scratchlist.close")
            .disabled(interactor.scratchlistBusy || interactor.isSending)
        }
    }
}
