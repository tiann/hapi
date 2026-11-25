import AVFoundation
import HapiProtocol
import Observation
import UIKit

enum GeneratedMediaKind {
    case image, video, audio, file

    init(mimeType: String?) {
        let mime = mimeType?.lowercased() ?? "image/"
        if mime.hasPrefix("image/") { self = .image }
        else if mime.hasPrefix("video/") { self = .video }
        else if mime.hasPrefix("audio/") { self = .audio }
        else { self = .file }
    }

    var icon: String {
        switch self {
        case .image: "photo"
        case .video: "video"
        case .audio: "waveform"
        case .file: "doc"
        }
    }
}

/// One card's state, separate from the per-chat cache. Creating a model never
/// downloads anything: the view auto-loads only images, just like web.
@Observable @MainActor
final class GeneratedMediaPresentation {
    let block: GeneratedImageBlock
    let kind: GeneratedMediaKind
    private(set) var image: UIImage?
    private(set) var file: GeneratedMediaFile?
    private(set) var player: AVPlayer?
    private(set) var isLoading = false
    private(set) var loadFailed = false
    private(set) var playbackUnavailable = false
    @ObservationIgnored private var loadGeneration = UUID()

    init(block: GeneratedImageBlock) {
        self.block = block
        kind = GeneratedMediaKind(mimeType: block.mimeType)
    }

    func load(using loader: GeneratedMediaLoader) async {
        guard image == nil, file == nil else { return }
        // A row can reappear before its cancelled task finishes awaiting the
        // shared download. Let the new task take over, not strand a spinner.
        let generation = UUID()
        loadGeneration = generation
        isLoading = true
        loadFailed = false
        defer {
            if loadGeneration == generation { isLoading = false }
        }
        do {
            if kind == .image {
                let image = try await loader.image(for: block.imageId)
                try Task.checkCancellation()
                guard loadGeneration == generation else { return }
                self.image = image
            } else {
                let file = try await loader.file(for: block.imageId, fileName: block.fileName, mimeType: block.mimeType)
                try Task.checkCancellation()
                if kind == .video || kind == .audio {
                    let asset = AVURLAsset(url: file.url)
                    let playable = (try? await asset.load(.isPlayable)) ?? false
                    try Task.checkCancellation()
                    guard loadGeneration == generation else { return }
                    if playable {
                        // No autoplay. Native controls start playback explicitly.
                        player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
                    } else {
                        playbackUnavailable = true
                    }
                }
                guard loadGeneration == generation else { return }
                self.file = file
            }
        } catch is CancellationError {
            // A recycled/disappearing card must not publish a late result.
        } catch {
            if !Task.isCancelled, loadGeneration == generation { loadFailed = true }
        }
    }

    func playbackFailed() {
        player?.pause()
        player = nil
        playbackUnavailable = true
    }

    func pause() {
        player?.pause()
    }
}
