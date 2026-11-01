import AVKit
import Combine
import HapiProtocol
import QuickLook
import SwiftUI
import UIKit

/// The wire kind stays `generated-image` for all media. MIME, not the tool
/// name or filename, selects the renderer. Reset card state on row reuse.
struct GeneratedImageBlockView: View {
    let block: GeneratedImageBlock
    @Environment(\.chatMedia) private var media

    var body: some View {
        GeneratedMediaCard(block: block, loader: media)
            .id(block.imageId)
    }
}

private struct GeneratedMediaCard: View {
    let loader: GeneratedMediaLoader?
    @State private var content: GeneratedMediaPresentation
    @State private var loadAttempt = 0
    @State private var imageOpen = false
    @State private var previewOpen = false
    @State private var shareOpen = false
    @Environment(\.scenePhase) private var scenePhase

    init(block: GeneratedImageBlock, loader: GeneratedMediaLoader?) {
        self.loader = loader
        _content = State(initialValue: GeneratedMediaPresentation(block: block))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label {
                Text(verbatim: content.block.fileName)
                    .lineLimit(2)
            } icon: {
                Image(systemName: content.kind.icon)
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            if let image = content.image {
                Button { imageOpen = true } label: {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxHeight: 360)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(content.block.fileName)
            } else if let file = content.file {
                loadedFile(file)
            } else if content.loadFailed {
                Text("Couldn't load media.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Retry", systemImage: "arrow.clockwise") { loadAttempt += 1 }
            } else if loader != nil && (content.kind == .image || content.isLoading) {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: 120)
            } else if content.kind != .image {
                loadButton
                    .disabled(loader == nil)
            }
        }
        .padding(12)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        .task(id: loadAttempt) {
            guard let loader, content.kind == .image || loadAttempt > 0 else { return }
            await content.load(using: loader)
        }
        .onDisappear { content.pause() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { content.pause() }
        }
        .fullScreenCover(isPresented: $imageOpen) {
            ImageViewer(image: content.image, title: content.block.fileName)
        }
        .sheet(isPresented: $previewOpen) {
            if let file = content.file {
                NavigationStack {
                    GeneratedMediaPreview(file: file)
                        .navigationTitle(content.block.fileName)
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Close") { previewOpen = false }
                            }
                        }
                }
            }
        }
        .sheet(isPresented: $shareOpen) {
            if let file = content.file { GeneratedMediaShareSheet(file: file) }
        }
    }

    @ViewBuilder
    private var loadButton: some View {
        switch content.kind {
        case .video:
            Button("Load video", systemImage: "play.circle") { loadAttempt += 1 }
        case .audio:
            Button("Load audio", systemImage: "play.circle") { loadAttempt += 1 }
        case .file:
            Button("Prepare download", systemImage: "arrow.down.circle") { loadAttempt += 1 }
        case .image:
            EmptyView()
        }
    }

    @ViewBuilder
    private func loadedFile(_ file: GeneratedMediaFile) -> some View {
        if let player = content.player, let item = player.currentItem {
            VideoPlayer(player: player)
                .frame(height: content.kind == .audio ? 100 : 220)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .onReceive(item.publisher(for: \.status)) { status in
                    if status == .failed { content.playbackFailed() }
                }
        }
        if content.playbackUnavailable {
            Text("This media cannot be played on this device.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 16) { fileActions(file) }
            VStack(alignment: .leading, spacing: 12) { fileActions(file) }
        }
    }

    @ViewBuilder
    private func fileActions(_ file: GeneratedMediaFile) -> some View {
        if content.kind == .file, QLPreviewController.canPreview(file.url as NSURL) {
            Button("Preview", systemImage: "doc.text.magnifyingglass") { previewOpen = true }
        }
        Button("Save or share", systemImage: "square.and.arrow.up") { shareOpen = true }
    }
}

private struct GeneratedMediaShareSheet: UIViewControllerRepresentable {
    let file: GeneratedMediaFile

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [file.url], applicationActivities: nil)
        // Supply an anchor when UIKit presents the activity UI as an iPad popover.
        controller.popoverPresentationController?.sourceView = controller.view
        // The activity controller may outlive the transcript row/cache entry.
        controller.completionWithItemsHandler = { [file] _, _, _, _ in _ = file }
        return controller
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

private struct GeneratedMediaPreview: UIViewControllerRepresentable {
    let file: GeneratedMediaFile

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let file: GeneratedMediaFile
        init(file: GeneratedMediaFile) { self.file = file }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem {
            file.url as NSURL
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(file: file) }
    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) {}
}

/// Minimal full-screen image viewer; keep the existing tap-to-dismiss behavior.
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
                Text(verbatim: title).foregroundStyle(.white)
            }
            Button { dismiss() } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title2)
                    .foregroundStyle(.white.opacity(0.8))
                    .padding(16)
            }
            .accessibilityLabel("Close")
        }
        .onTapGesture { dismiss() }
    }
}
