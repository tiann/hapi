import HapiClient
import HapiProtocol
import SwiftUI
import UIKit

// MARK: - List identity

extension VisibleChatBlock {
    /// Stable list key: block ids are reducer-stable and tool-group ids are
    /// pinned across recomputes via `previousGroups`, so scroll anchoring
    /// and expansion state survive pipeline re-runs.
    var stableId: String {
        switch self {
        case .block(let block): return block.id
        case .toolGroup(let group): return group.id
        }
    }

    /// Recycling bucket (the Android `contentKind` / web block `kind`).
    var contentKind: String {
        switch self {
        case .block(let block): return block.kind
        case .toolGroup: return "tool-group"
        }
    }
}

// MARK: - Media plumbing

/// Per-chat generated-image loading: `GET /generated-images/:imageId` bytes
/// through the authed APIClient (URLCache underneath serves immutable-ETag
/// repeats), plus a small in-memory decode cache so scroll-back does not
/// re-decode. Injected down the block tree via `\.chatMedia`.
@MainActor
final class GeneratedImageLoader {
    private let api: APIClient
    private let sessionId: String
    private let cache = NSCache<NSString, UIImage>()
    private var inFlight: [String: Task<UIImage?, Never>] = [:]

    init(api: APIClient, sessionId: String) {
        self.api = api
        self.sessionId = sessionId
        cache.countLimit = 40
    }

    func image(for imageId: String) async -> UIImage? {
        if let cached = cache.object(forKey: imageId as NSString) {
            return cached
        }
        if let running = inFlight[imageId] {
            return await running.value
        }
        let api = api
        let sessionId = sessionId
        let task = Task<UIImage?, Never> {
            guard let payload = try? await api.generatedImage(sessionId: sessionId, imageId: imageId) else {
                return nil
            }
            return UIImage(data: payload.data)
        }
        inFlight[imageId] = task
        let image = await task.value
        inFlight[imageId] = nil
        if let image {
            cache.setObject(image, forKey: imageId as NSString)
        }
        return image
    }
}

private struct ChatMediaKey: EnvironmentKey {
    static let defaultValue: GeneratedImageLoader? = nil
}

extension EnvironmentValues {
    /// The open chat's image loader; nil (previews/tests) degrades generated
    /// images to a filename placeholder.
    var chatMedia: GeneratedImageLoader? {
        get { self[ChatMediaKey.self] }
        set { self[ChatMediaKey.self] = newValue }
    }
}

private struct ChatInteractionsKey: EnvironmentKey {
    static let defaultValue: ChatInteractor? = nil
}

extension EnvironmentValues {
    /// The open chat's interaction engine (A-M3ab), injected down the block
    /// tree so deeply nested tool cards — groups, sidechains — reach the
    /// permission actions and failed-send retry without prop threading. Nil
    /// (previews/tests, read-only embeddings) keeps blocks in their M2
    /// read-only rendering.
    var chatInteractions: ChatInteractor? {
        get { self[ChatInteractionsKey.self] }
        set { self[ChatInteractionsKey.self] = newValue }
    }
}

// MARK: - Dispatcher

/// One thread entry: routes a reduced `VisibleChatBlock` to its card — the
/// SwiftUI analogue of the web block-kind → component mapping and the
/// Android `ChatBlockCard`. Also used recursively for tool-call children
/// (sidechain transcripts).
struct ChatBlockCard: View {
    let block: VisibleChatBlock
    let basePath: String?

    var body: some View {
        switch block {
        case .toolGroup(let group):
            ToolGroupBlockView(block: group, basePath: basePath)
        case .block(let chatBlock):
            ChatSubBlockView(block: chatBlock, basePath: basePath)
        }
    }
}

/// Dispatcher for the plain `ChatBlock` union (shared by the thread and by
/// tool-card children).
struct ChatSubBlockView: View {
    let block: ChatBlock
    let basePath: String?

    var body: some View {
        switch block {
        case .userText(let value):
            UserTextBlockView(block: value)
        case .agentText(let value):
            AgentTextBlockView(block: value)
        case .agentReasoning(let value):
            AgentReasoningBlockView(block: value)
        case .agentEvent(let value):
            AgentEventBlockView(block: value)
        case .cliOutput(let value):
            CliOutputBlockView(block: value)
        case .generatedImage(let value):
            GeneratedImageBlockView(block: value)
        case .codexReview(let value):
            CodexReviewBlockView(block: value)
        case .toolCall(let value):
            ToolCallBlockView(block: value, basePath: basePath)
        }
    }
}
