import HapiClient
import HapiProtocol
import SwiftUI

/// ChatView keys this view by eventId, including in-flight, accepted and
/// failure state. A late response cannot dismiss or disable a newer alert.
struct CursorModelErrorBanner: View {
    let error: SessionModelError
    let active: Bool
    let abortRevision: Int
    let perform: (ModelErrorAction) async throws -> Void

    @State private var busy = false
    @State private var queuedAtAbortRevision: Int?
    @State private var dismissed = false
    @State private var failure: String?

    var body: some View {
        if !dismissed {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    let kind = error.kind.replacingOccurrences(of: "_", with: " ")
                    if error.retriedAndFailed == true {
                        Text("Bridge retry failed (\(kind))")
                    } else if error.recovered {
                        Text("Model recovered (\(kind))")
                    } else {
                        Text("Model error (\(kind))")
                    }
                    Spacer(minLength: 4)
                    Button("Dismiss") { submit(.acknowledge) }
                        .disabled(busy)
                }
                .fontWeight(.semibold)

                if !error.recovered {
                    if error.priorAssistantClaimsDone {
                        Text("The agent reported completion before this error.")
                    }
                    if !error.rawSnippet.isEmpty {
                        Text(verbatim: error.rawSnippet)
                            .lineLimit(2)
                    }
                }
                if error.canBridge(sessionActive: active) {
                    if queuedAtAbortRevision == abortRevision {
                        Text("Bridge retry queued")
                    } else {
                        Button("Bridge & retry") { submit(.bridge) }
                            .disabled(busy)
                    }
                }
                if let failure { Text(verbatim: failure) }
            }
            .font(.footnote)
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.bar)
            .onChange(of: active) { _, active in
                if !active { queuedAtAbortRevision = nil }
            }
        }
    }

    private func submit(_ action: ModelErrorAction) {
        guard !busy else { return }
        busy = true
        failure = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                try await perform(action)
                switch action {
                case .bridge: queuedAtAbortRevision = abortRevision
                case .acknowledge: dismissed = true
                }
            } catch is CancellationError {
                return
            } catch {
                failure = hubErrorMessage(error)
                    ?? (error as? APIError)?.code?.replacingOccurrences(of: "_", with: " ")
                    ?? error.localizedDescription
            }
        }
    }
}
