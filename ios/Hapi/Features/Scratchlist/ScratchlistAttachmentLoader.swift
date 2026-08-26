import Foundation
import HapiClient
import UIKit

/// Per-chat scratchlist-attachment image loading (A-M4b), the
/// `GeneratedImageLoader` pattern: `GET /scratchlist/attachments/:id` bytes
/// through the authed `APIClient` (URLCache underneath serves immutable
/// repeats — attachment content never changes for an id), plus a small
/// in-memory decode cache so list scrolling does not re-decode, with
/// single-flight per attachment id.
@MainActor
final class ScratchlistAttachmentLoader {
    private let api: APIClient
    private let sessionId: String
    private let cache = NSCache<NSString, UIImage>()
    private var inFlight: [String: Task<UIImage?, Never>] = [:]

    init(api: APIClient, sessionId: String) {
        self.api = api
        self.sessionId = sessionId
        cache.countLimit = 60
    }

    func image(for attachmentId: String) async -> UIImage? {
        if let cached = cache.object(forKey: attachmentId as NSString) {
            return cached
        }
        if let running = inFlight[attachmentId] {
            return await running.value
        }
        let api = api
        let sessionId = sessionId
        let task = Task<UIImage?, Never> {
            guard let payload = try? await api.scratchlistAttachment(
                sessionId: sessionId,
                attachmentId: attachmentId
            ) else {
                return nil
            }
            return UIImage(data: payload.data)
        }
        inFlight[attachmentId] = task
        let image = await task.value
        inFlight[attachmentId] = nil
        if let image {
            cache.setObject(image, forKey: attachmentId as NSString)
        }
        return image
    }
}
