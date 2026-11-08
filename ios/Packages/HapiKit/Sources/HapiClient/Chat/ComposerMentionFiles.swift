import Foundation
import HapiProtocol
import Observation

/// Best-effort file suggestions supplement the synchronous session shortlist.
/// Cancellation plus a generation gate prevents an old query publishing after
/// a newer one, including transports that do not honor cancellation.
@MainActor @Observable
public final class ComposerMentionFiles {
    public struct Request: Equatable, Sendable {
        public let query: String
        public let flavor: String

        public init(query: String, flavor: String) {
            self.query = query
            self.flavor = flavor
        }
    }

    private var request: Request?
    private var results: [ComposerMentionSuggestion] = []
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private let debounce: Duration
    @ObservationIgnored private let search: @Sendable (String) async throws -> FileSearchResponse

    public init(debounce: Duration = .milliseconds(150), search: @escaping @Sendable (String) async throws -> FileSearchResponse) {
        self.debounce = debounce
        self.search = search
    }

    public func suggestions(for request: Request) -> [ComposerMentionSuggestion] {
        self.request == request ? results : []
    }

    public func load(_ request: Request?) async {
        generation += 1
        let generation = generation
        self.request = request
        results = []
        guard let request, request.flavor == "codex" || request.flavor == "copilot" else { return }
        do {
            try await Task.sleep(for: debounce)
            try Task.checkCancellation()
            let response = try await search(request.query)
            guard !Task.isCancelled, self.generation == generation, response.success else { return }
            results = ComposerMentionSuggestions.files(response.files ?? [], flavor: request.flavor)
        } catch {
            // Local session suggestions remain available when the CLI is offline.
        }
    }
}
