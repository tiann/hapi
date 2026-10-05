import CoreGraphics
import HapiClient
import HapiProtocol
import SwiftUI
import UIKit

/// One user-bubble attachment: image mimes with a decodable `previewUrl`
/// data URL or durable `attachmentId` render the image; everything else —
/// plus decode failures — falls back to the filename chip. Port of the
/// Android `AttachmentView`/`rememberPreviewImage`.
///
/// Mobile-authored previews are ≤ 512 px JPEGs, but web-authored ones embed
/// the full original (up to 5 MB), so the decode downsamples to 512 px and
/// runs off the main actor.
struct AttachmentPreviewView: View {
    let attachment: AttachmentMetadata

    private enum Phase {
        /// Decode still running — render a sized neutral placeholder.
        case loading

        case ready(Image)

        /// Not a data URL / undecodable — fall back to the filename chip.
        case unavailable
    }

    @State private var phase: Phase = .loading
    @Environment(\.chatMedia) private var media

    var body: some View {
        let hasInlinePreview = attachment.previewUrl?.hasPrefix("data:") == true
        if !attachment.mimeType.hasPrefix("image/")
            || (!hasInlinePreview && (attachment.attachmentId == nil || media == nil)) {
            AttachmentChipView(attachment: attachment)
        } else {
            switch phase {
            case .ready(let image):
                image
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 180)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            case .loading:
                // Sized placeholder while decoding keeps the bubble from
                // jumping.
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(.background.opacity(0.4))
                    .frame(width: 120, height: 90)
                    .task(id: attachment.previewUrl ?? attachment.attachmentId) {
                        await decode()
                    }
            case .unavailable:
                AttachmentChipView(attachment: attachment)
            }
        }
    }

    private func decode() async {
        if let previewUrl = attachment.previewUrl, previewUrl.hasPrefix("data:") {
            // Nonisolated async helper — runs off the main actor.
            let decoded = await Self.decodeImage(previewUrl: previewUrl)
            if let decoded {
                phase = .ready(Image(decoded, scale: 1, label: Text(attachment.filename)))
            } else {
                phase = .unavailable
            }
            return
        }
        if let attachmentId = attachment.attachmentId {
            if let original = await media?.attachmentImage(for: attachmentId) {
                phase = .ready(Image(uiImage: original))
            } else {
                phase = .unavailable
            }
            return
        }
        phase = .unavailable
    }

    private nonisolated static func decodeImage(previewUrl: String) async -> CGImage? {
        guard let bytes = AttachmentPolicy.bytesFromDataUrl(previewUrl) else { return nil }
        return AttachmentPreparer.decodeDownsampled(
            bytes,
            maxDimension: AttachmentPolicy.previewMaxDimension
        )
    }
}

/// Filename chip fallback (also the non-image rendering).
struct AttachmentChipView: View {
    let attachment: AttachmentMetadata

    var body: some View {
        Label(
            attachment.filename,
            systemImage: attachment.mimeType.hasPrefix("image/") ? "photo" : "paperclip"
        )
        .font(.caption)
        .lineLimit(1)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
    }
}
