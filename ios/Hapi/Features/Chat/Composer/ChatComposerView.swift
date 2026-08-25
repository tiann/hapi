import AVFAudio
import HapiClient
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The chat input card (A-M3a, extended in A-M3f): attachments and the
/// multiline text field grow above a fixed bottom action row. The trailing
/// primary action is stateful: Stop while a turn runs with an empty draft,
/// otherwise Send (long-press offers "Send & steer" during a turn). The card
/// also hosts dictation and attachment controls.
struct ChatComposerView: View {
    let interactor: ChatInteractor
    /// nil ⇒ dictation unavailable (no controller wired) — mic button hidden.
    var dictation: DictationController?

    // Attachment pickers (the launchers live here; policy + upload live in
    // HapiKit — `AttachmentPreparer` / `ComposerAttachments`).
    @State private var attachDialogOpen = false
    @State private var photosPickerOpen = false
    @State private var photoSelection: [PhotosPickerItem] = []
    @State private var cameraOpen = false
    @State private var filePickerOpen = false

    private var text: Binding<String> {
        Binding(
            get: { interactor.composerText },
            set: { interactor.setComposerText($0) }
        )
    }

    /// Elevated iOS surface: white in light mode, lifted charcoal in dark
    /// mode. `secondarySystemBackground` made the whole composer read like a
    /// grouped form cell instead of a floating iOS control.
    private var composerSurfaceColor: Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(white: 0.12, alpha: 1)
                : .white
        })
    }

    var body: some View {
        let composer = interactor.composer
        let attachments = interactor.attachments.items
        VStack(spacing: 0) {
            VStack(spacing: 0) {
                if !attachments.isEmpty {
                    attachmentsRow(attachments)
                        .padding(.horizontal, 12)
                        .padding(.top, 8)
                }
                if let dictation, case .recording(let startedAtMs) = dictation.state {
                    RecordingChipView(startedAtMs: startedAtMs) {
                        dictation.cancel()
                    }
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                }
                TextField("Message the agent…", text: text, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12)
                    .padding(.top, 12)
                    .padding(.bottom, 4)
                HStack(spacing: 2) {
                    addAttachmentButton
                    Spacer()
                    if let dictation {
                        micButton(dictation)
                    }
                    primaryActionButton(composer, attachments: attachments)
                }
                // 44 pt touch slot with a centered 38 pt circle:
                // 9 + 3 = the shared 12 pt visual inset.
                .padding(.horizontal, 9)
                .padding(.bottom, 4)
            }
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(composerSurfaceColor)
            )
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .confirmationDialog("Attach", isPresented: $attachDialogOpen, titleVisibility: .visible) {
            Button("Photo library") {
                photosPickerOpen = true
            }
            if CameraCaptureView.isAvailable {
                Button("Camera") {
                    cameraOpen = true
                }
            }
            Button("Files") {
                filePickerOpen = true
            }
        }
        .photosPicker(
            isPresented: $photosPickerOpen,
            selection: $photoSelection,
            matching: .any(of: [.images, .videos])
        )
        .onChange(of: photoSelection) {
            let items = photoSelection
            guard !items.isEmpty else { return }
            photoSelection = []
            Task {
                for item in items {
                    await ingestPhotoItem(item)
                }
            }
        }
        .fullScreenCover(isPresented: $cameraOpen) {
            CameraCaptureView { jpeg in
                Task {
                    await handle(AttachmentPreparer.prepare(
                        data: jpeg,
                        filename: AttachmentPreparer.cameraFilename(),
                        mimeType: "image/jpeg"
                    ))
                }
            }
            .ignoresSafeArea()
        }
        .fileImporter(
            isPresented: $filePickerOpen,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { outcome in
            guard case .success(let urls) = outcome else { return }
            Task {
                for url in urls {
                    await handle(AttachmentPreparer.prepare(fileURL: url))
                }
            }
        }
    }

    // MARK: - Attachment ingestion

    private func ingestPhotoItem(_ item: PhotosPickerItem) async {
        let type = item.supportedContentTypes.first
        if type?.conforms(to: .audiovisualContent) == true {
            // Videos import as a temp file (capped read in the preparer) so a
            // multi-GB pick never has to fit in memory.
            guard let movie = try? await item.loadTransferable(type: PickedMovie.self) else {
                interactor.postNotice(String(localized: "Couldn't read the selected video"))
                return
            }
            let result = await AttachmentPreparer.prepare(fileURL: movie.url)
            try? FileManager.default.removeItem(at: movie.url)
            handle(result)
            return
        }
        let naming = AttachmentPreparer.photoFilename(for: type)
        guard let data = try? await item.loadTransferable(type: Data.self) else {
            interactor.postNotice(String(format: String(localized: "Couldn't read %@"), naming.filename))
            return
        }
        await handle(AttachmentPreparer.prepare(
            data: data,
            filename: naming.filename,
            mimeType: naming.mimeType
        ))
    }

    private func handle(_ result: PrepareResult) {
        switch result {
        case .ready(let prepared):
            interactor.attachments.add(prepared)
        case .tooLarge(let filename, _):
            interactor.postNotice(String(format: String(localized: "%@ is over the 50 MB upload limit"), filename))
        case .unreadable(let filename):
            interactor.postNotice(String(format: String(localized: "Couldn't read %@"), filename))
        }
    }

    // MARK: - Attachment chips

    private func attachmentsRow(_ attachments: [ComposerAttachmentUI]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(attachments) { attachment in
                    ComposerAttachmentChipView(
                        attachment: attachment,
                        onRetry: { interactor.attachments.retry(attachment.id) },
                        onRemove: { interactor.attachments.remove(attachment.id) }
                    )
                }
            }
        }
    }

    private var addAttachmentButton: some View {
        Button {
            attachDialogOpen = true
        } label: {
            actionCircle(
                background: AnyShapeStyle(.fill.tertiary),
                foreground: AnyShapeStyle(.secondary)
            ) {
                Image(systemName: "plus")
                    .font(.subheadline.weight(.medium))
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Add attachment")
    }

    // MARK: - Dictation

    private func micButton(_ dictation: DictationController) -> some View {
        let recording: Bool = {
            if case .recording = dictation.state { return true }
            return false
        }()
        let busy = dictation.state == .starting || dictation.state == .transcribing
        return Button {
            toggleDictation(dictation)
        } label: {
            actionCircle(
                background: recording
                    ? AnyShapeStyle(.red.opacity(0.15))
                    : AnyShapeStyle(.fill.tertiary),
                foreground: recording ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary)
            ) {
                if busy {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: recording ? "stop.fill" : "mic.fill")
                        .font(.subheadline)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel(recording ? String(localized: "Stop dictation") : String(localized: "Dictate"))
    }

    private func toggleDictation(_ dictation: DictationController) {
        // Stopping never needs the permission; starting checks + requests it.
        guard dictation.state == .idle else {
            dictation.toggle()
            return
        }
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            dictation.toggle()
        case .denied:
            interactor.postNotice(String(localized: "Microphone access is disabled — allow it in Settings to dictate"))
        case .undetermined:
            Task {
                let granted = await AVAudioApplication.requestRecordPermission()
                if granted {
                    dictation.toggle()
                } else {
                    interactor.postNotice(String(localized: "Microphone permission is needed for dictation"))
                }
            }
        @unknown default:
            dictation.toggle()
        }
    }

    // MARK: - Buttons

    @ViewBuilder
    private func primaryActionButton(_ composer: ComposerState, attachments: [ComposerAttachmentUI]) -> some View {
        let hasText = !composer.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasDraft = hasText || !attachments.isEmpty
        // Attachments gate the send like the web: every chip must settle
        // Ready (uploading waits, failed must be retried or removed); a ready
        // tray allows an attachments-only send (wire: text or attachments).
        let attachmentsBusy = attachments.contains { $0.status != .ready }
        let attachmentsReady = !attachments.isEmpty && !attachmentsBusy
        let canSubmit = (hasText || attachmentsReady) && !attachmentsBusy && !composer.isSending
        let action: ComposerPrimaryAction = if composer.isSending {
            .sending
        } else if composer.canSteer && !hasDraft {
            .stop
        } else {
            .send(enabled: canSubmit)
        }

        switch action {
        case .sending:
            Button {} label: {
                actionCircle(
                    background: AnyShapeStyle(.fill.tertiary),
                    foreground: AnyShapeStyle(.secondary)
                ) {
                    ProgressView()
                        .controlSize(.small)
                }
            }
            .buttonStyle(.plain)
            .disabled(true)
            .accessibilityLabel("Send")
        case .stop:
            Button {
                interactor.abortSession()
            } label: {
                actionCircle(
                    background: AnyShapeStyle(.red),
                    foreground: AnyShapeStyle(.white)
                ) {
                    Image(systemName: "stop.fill")
                        .font(.subheadline)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop the current turn")
        case .send(let enabled):
            let label = sendLabel(enabled: enabled)
            if composer.canSteer && enabled {
                // Tap sends (queue); long-press opens the deliberate steer intent.
                Menu {
                    Button("Send & steer into current turn") {
                        interactor.sendMessage(steer: true)
                    }
                } label: {
                    label
                } primaryAction: {
                    interactor.sendMessage()
                }
                .accessibilityLabel("Send — long-press to steer")
            } else {
                Button {
                    interactor.sendMessage()
                } label: {
                    label
                }
                .buttonStyle(.plain)
                .disabled(!enabled)
                .accessibilityLabel("Send")
            }
        }
    }

    private func sendLabel(enabled: Bool) -> some View {
        actionCircle(
            background: enabled ? AnyShapeStyle(.tint) : AnyShapeStyle(.fill.tertiary),
            foreground: enabled ? AnyShapeStyle(.white) : AnyShapeStyle(.secondary)
        ) {
            Image(systemName: "arrow.up")
                .font(.subheadline.weight(.semibold))
        }
    }

    private func actionCircle<Content: View>(
        background: AnyShapeStyle,
        foreground: AnyShapeStyle,
        @ViewBuilder content: () -> Content
    ) -> some View {
        content()
            .frame(width: 38, height: 38)
            .background(background, in: Circle())
            .foregroundStyle(foreground)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
    }
}

private enum ComposerPrimaryAction {
    case sending
    case stop
    case send(enabled: Bool)
}

// MARK: - Attachment chip

/// One tray chip: 36 pt thumb (image preview / MIME glyph, spinner while
/// uploading), filename + status line, ✕ to remove. A failed chip tints red
/// and taps to retry.
private struct ComposerAttachmentChipView: View {
    let attachment: ComposerAttachmentUI
    let onRetry: () -> Void
    let onRemove: () -> Void

    private var failed: Bool { attachment.status == .failed }

    var body: some View {
        HStack(spacing: 8) {
            thumb
            VStack(alignment: .leading, spacing: 0) {
                Text(attachment.filename)
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
                Text(statusLine)
                    .font(.caption2)
                    .foregroundStyle(failed ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                    .lineLimit(1)
            }
            .frame(maxWidth: 132, alignment: .leading)
            Button {
                onRemove()
            } label: {
                Image(systemName: "xmark")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(6)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(attachment.filename)")
        }
        .padding(6)
        .background(
            failed ? AnyShapeStyle(.red.opacity(0.12)) : AnyShapeStyle(.fill.tertiary),
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
        .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .onTapGesture {
            if failed { onRetry() }
        }
    }

    private var statusLine: String {
        switch attachment.status {
        case .uploading:
            return String(localized: "Uploading…")
        case .failed:
            return String(localized: "Failed — tap to retry")
        case .ready:
            return formatChipSize(attachment.sizeBytes)
        }
    }

    private var thumb: some View {
        ZStack {
            // Preparer-made ≤ 512 px JPEGs — cheap enough to decode inline.
            if let previewBytes = attachment.previewBytes,
               let image = UIImage(data: previewBytes) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 36, height: 36)
                    .clipped()
                    .opacity(attachment.status == .uploading ? 0.4 : 1)
            } else {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(.fill.secondary)
                    .frame(width: 36, height: 36)
                Image(systemName: attachment.mimeType.hasPrefix("image/") ? "photo" : "doc")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if attachment.status == .uploading {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .frame(width: 36, height: 36)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

/// `12.3 MB` / `456 KB` / `789 B` chip size label (Android `formatChipSize`).
func formatChipSize(_ bytes: Int) -> String {
    if bytes >= 1024 * 1024 {
        return String(format: "%.1f MB", Double(bytes) / (1024.0 * 1024.0))
    }
    if bytes >= 1024 {
        return String(format: "%.0f KB", Double(bytes) / 1024.0)
    }
    return "\(bytes) B"
}

// MARK: - Recording chip

/// Elapsed-time recording chip with a cancel affordance (discards the take).
private struct RecordingChipView: View {
    let startedAtMs: Int
    let onCancel: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.25)) { context in
            HStack(spacing: 8) {
                Text("● Recording…  \(formatElapsed(elapsedSeconds(at: context.date)))")
                    .font(.caption.weight(.medium))
                Spacer(minLength: 8)
                Button("Cancel") {
                    onCancel()
                }
                .font(.caption.weight(.semibold))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.red.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .foregroundStyle(.red)
        }
    }

    private func elapsedSeconds(at date: Date) -> Int {
        max(0, (Int(date.timeIntervalSince1970 * 1000) - startedAtMs) / 1000)
    }
}

/// `m:ss` elapsed-time label for the recording chip.
func formatElapsed(_ totalSeconds: Int) -> String {
    String(format: "%d:%02d", totalSeconds / 60, totalSeconds % 60)
}

// MARK: - Video import

/// Photo-picker videos land as a temp file (`FileRepresentation`) so the
/// preparer's capped read — not a full in-memory `Data` — bounds them.
private struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let ext = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
            let destination = FileManager.default.temporaryDirectory
                .appendingPathComponent("video-\(UUID().uuidString.prefix(8)).\(ext)")
            try FileManager.default.copyItem(at: received.file, to: destination)
            return PickedMovie(url: destination)
        }
    }
}
