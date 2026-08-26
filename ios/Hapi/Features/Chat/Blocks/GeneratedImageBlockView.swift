import HapiProtocol
import SwiftUI
import UIKit

/// Hub-generated image (`/api/sessions/:id/generated-images/:imageId`),
/// loaded as authed bytes through the chat's `GeneratedImageLoader`
/// (`\.chatMedia`; URLCache underneath honors the hub's immutable ETag).
/// Tap opens a simple full-screen viewer. Without a loader (previews/tests)
/// the card degrades to a filename placeholder.
struct GeneratedImageBlockView: View {
    let block: GeneratedImageBlock

    @Environment(\.chatMedia) private var media
    @State private var image: UIImage?
    @State private var failed = false
    @State private var viewerOpen = false

    var body: some View {
        Group {
            if media == nil || failed {
                placeholder
            } else if let image {
                Button {
                    viewerOpen = true
                } label: {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxHeight: 360)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
            } else {
                loadingFrame
            }
        }
        .task(id: block.imageId) {
            guard let media, image == nil else { return }
            if let loaded = await media.image(for: block.imageId) {
                image = loaded
            } else {
                failed = true
            }
        }
        .fullScreenCover(isPresented: $viewerOpen) {
            ImageViewer(image: image, title: block.fileName)
        }
    }

    private var placeholder: some View {
        Label(block.fileName, systemImage: "photo")
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.vertical, 4)
    }

    private var loadingFrame: some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(Color.secondary.opacity(0.1))
            .frame(height: 160)
            .overlay {
                ProgressView()
            }
    }
}

/// Minimal full-screen viewer: dark backdrop, fit-scaled image, tap or the
/// close button dismisses. (Pinch-zoom lands with the files feature.)
private struct ImageViewer: View {
    let image: UIImage?
    let title: String

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(8)
            } else {
                Text(title)
                    .foregroundStyle(.white)
            }
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title2)
                    .foregroundStyle(.white.opacity(0.8))
                    .padding(16)
            }
        }
        .onTapGesture {
            dismiss()
        }
    }
}
