import HapiProtocol
import HapiUI
import SwiftUI
import UIKit

private struct OpenMessageKey: EnvironmentKey {
    static let defaultValue: ((UserTextBlock) -> Void)? = nil
}

extension EnvironmentValues {
    var openChatMessage: ((UserTextBlock) -> Void)? {
        get { self[OpenMessageKey.self] }
        set { self[OpenMessageKey.self] = newValue }
    }
}

private struct MessageSelection: Identifiable {
    let id: String
    let text: String
}

/// A screen owns the sheet, never a recycled bubble. Retain the original
/// text as a read-only snapshot even if the message window trims that row.
struct MessagePresentationHost: ViewModifier {
    let model: ChatModel
    let owner: String
    @State private var selection: MessageSelection?

    func body(content: Content) -> some View {
        content
            .environment(\.openChatMessage, { block in
                model.beginContentInspection()
                model.retainSurface("message:\(owner)")
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                selection = MessageSelection(id: block.id, text: block.text)
            })
            .sheet(item: $selection, onDismiss: {
                model.releaseSurface("message:\(owner)")
            }) { message in
                MessageDetailView(text: message.text).id(message.id)
            }
            .onChange(of: model.toolInspection.invalidation) {
                selection = nil
            }
    }
}

struct MessageDetailView: View {
    @State private var pager: MessageTextPager
    @Environment(\.dismiss) private var dismiss
    @Environment(\.hapiPasteboard) private var pasteboard
    @Environment(\.hapiTypography) private var typography

    init(text: String) {
        _pager = State(initialValue: MessageTextPager(source: text))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                // Plain text, like the user bubble. No markdown parsing,
                // highlighting or single infinitely tall Text layout.
                Text(verbatim: pager.page.text)
                    .font(typography.bodyFont)
                    .lineSpacing(typography.bodyLineSpacing)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .hapiReadingColumn()
                    .padding(.vertical, 16)
                    .accessibilityIdentifier("message-detail-text")
            }
            .id(pager.number)
            .navigationTitle("Full message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Copy full content", systemImage: "doc.on.doc") { pasteboard.copy(pager.source) }
                        .accessibilityIdentifier("message-copy-full")
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                HStack {
                    Button { pager.previous() } label: {
                        Label("Previous part", systemImage: "chevron.left")
                            .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
                    }
                    .disabled(!pager.hasPrevious)
                    .accessibilityIdentifier("message-previous")
                    Spacer()
                    Text(String(format: String(localized: "Part %lld"), Int64(pager.number)))
                        .font(.footnote.monospacedDigit())
                    Spacer()
                    Button { pager.next() } label: {
                        Label("Next part", systemImage: "chevron.right")
                            .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
                    }
                    .disabled(!pager.hasNext)
                    .accessibilityIdentifier("message-next")
                }
                .hapiReadingColumn()
                .background(.bar)
            }
        }
        .hapiTypography()
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
}
