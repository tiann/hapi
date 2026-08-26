import HapiClient
import HapiProtocol
import PhotosUI
import SwiftUI

/// Per-session scratchlist workbench (A-M4b): notes/drafts parked until the
/// operator promotes them — presented as a sheet off the chat toolbar's note
/// icon. Entry cards (text preview, age, attachment thumbs) open an edit
/// sheet; the toolbar + drafts a new note; "To composer" inserts an entry's
/// text into the chat composer and closes the sheet.
///
/// Placement divergence from Android (deliberate, A-M3f owns the composer
/// UI): "Park current draft" lives in this screen's header instead of the
/// composer bar. The seam itself (`ChatInteractor.parkComposerDraft`) matches
/// Android — the composer clears only after the hub accepts, and an at-cap or
/// failed park keeps the draft.
struct ScratchlistView: View {
    @State private var model: ScratchlistScreenModel
    private let attachments: ScratchlistAttachmentLoader
    private let interactor: ChatInteractor?

    @Environment(\.dismiss) private var dismiss
    @State private var viewerAttachment: ScratchlistAttachment?

    init(
        store: ScratchlistStore,
        sessionId: String,
        attachments: ScratchlistAttachmentLoader,
        interactor: ChatInteractor? = nil
    ) {
        _model = State(initialValue: ScratchlistScreenModel(sessionId: sessionId, store: store))
        self.attachments = attachments
        self.interactor = interactor
    }

    var body: some View {
        NavigationStack {
            content
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Done") {
                            dismiss()
                        }
                    }
                    ToolbarItem(placement: .principal) {
                        VStack(spacing: 0) {
                            Text("Scratchlist")
                                .font(.headline)
                            Text(countLine)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    if interactor != nil {
                        ToolbarItem(placement: .topBarTrailing) {
                            parkButton
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            model.openEditor(nil)
                        } label: {
                            Image(systemName: "plus")
                        }
                        .accessibilityLabel("New note")
                    }
                }
                .overlay(alignment: .bottom) {
                    noticeToast
                }
        }
        .sheet(isPresented: editorPresented) {
            ScratchlistEditorSheet(
                model: model,
                attachments: attachments,
                onOpenAttachment: { viewerAttachment = $0 }
            )
        }
        .fullScreenCover(item: $viewerAttachment) { attachment in
            ScratchlistAttachmentViewer(attachment: attachment, loader: attachments)
        }
        .onAppear {
            model.start()
        }
        .onDisappear {
            model.stop()
        }
    }

    // MARK: - Content states

    @ViewBuilder
    private var content: some View {
        let state = model.state
        VStack(spacing: 0) {
            if !state.uploadsInFlight.isEmpty {
                ProgressView()
                    .progressViewStyle(.linear)
            }
            if model.isLoading {
                Spacer()
                ProgressView()
                Spacer()
            } else if state.loadFailed {
                loadFailedState
            } else if state.entries.isEmpty {
                emptyState
            } else {
                entryList(state.entries)
            }
        }
    }

    private func entryList(_ entries: [ScratchlistEntry]) -> some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                ForEach(entries) { entry in
                    ScratchlistEntryCard(
                        entry: entry,
                        attachments: attachments,
                        onOpen: { model.openEditor(entry) },
                        onSendToComposer: sendToComposerAction(entry),
                        onOpenAttachment: { viewerAttachment = $0 }
                    )
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
    }

    /// "To composer": insert the entry's text into the chat composer and
    /// close the sheet (the entry itself stays on the scratchlist). Nil when
    /// no interactor is wired (previews) — the affordance is hidden.
    private func sendToComposerAction(_ entry: ScratchlistEntry) -> (() -> Void)? {
        guard let interactor else { return nil }
        return {
            interactor.insertComposerText(entry.text)
            dismiss()
        }
    }

    private var loadFailedState: some View {
        ContentUnavailableView {
            Label("Couldn't load the scratchlist", systemImage: "wifi.slash")
        } description: {
            Text("Check the connection to your hub and try again.")
        } actions: {
            Button("Retry") {
                model.retry()
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No notes yet", systemImage: "note.text")
        } description: {
            Text("Park drafts from the header, or tap + to jot a note for this session.")
        }
    }

    // MARK: - Chrome

    private var countLine: String {
        let state = model.state
        if !model.isLoading, state.entries.isEmpty {
            return String(localized: "No notes")
        }
        return state.entries.count == 1
            ? String(localized: "1 note")
            : String(format: String(localized: "%lld notes"), Int64(state.entries.count))
    }

    /// "Park current draft": the composer draft becomes an entry (disabled
    /// while the composer is blank or the list is at cap; the new row appears
    /// optimistically once the hub accepts).
    @ViewBuilder
    private var parkButton: some View {
        if let interactor {
            let blank = interactor.composer.text
                .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            Button {
                interactor.parkComposerDraft()
            } label: {
                Image(systemName: "tray.and.arrow.down")
            }
            .disabled(blank || model.state.atCap)
            .accessibilityLabel("Park current draft")
        }
    }

    @ViewBuilder
    private var noticeToast: some View {
        if let notice = model.notice {
            Text(notice)
                .font(.footnote)
                .lineLimit(3)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .shadow(radius: 4, y: 2)
                .padding(.horizontal, 24)
                .padding(.bottom, 8)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    private var editorPresented: Binding<Bool> {
        Binding(
            get: { model.editor != nil },
            set: { open in
                if !open {
                    model.dismissEditor()
                }
            }
        )
    }
}

// MARK: - Entry card

/// One note: attachment strip, 4-line text preview, relative age, and the
/// optional "To composer" promote action.
private struct ScratchlistEntryCard: View {
    let entry: ScratchlistEntry
    let attachments: ScratchlistAttachmentLoader
    let onOpen: () -> Void
    let onSendToComposer: (() -> Void)?
    let onOpenAttachment: (ScratchlistAttachment) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !entry.attachments.isEmpty {
                ScratchlistAttachmentStrip(
                    attachments: entry.attachments,
                    loader: attachments,
                    thumbSize: 64,
                    onOpen: onOpenAttachment,
                    onRemove: nil
                )
            }
            if entry.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("Attachment only")
                    .font(.subheadline)
                    .italic()
                    .foregroundStyle(.secondary)
            } else {
                Text(entry.text)
                    .font(.subheadline)
                    .lineLimit(4)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Text(scratchlistRelativeAge(
                    nowMs: Int(Date().timeIntervalSince1970 * 1000),
                    thenMs: entry.updatedAt
                ))
                .font(.caption2)
                .foregroundStyle(.tertiary)
                Spacer()
                if let onSendToComposer {
                    Button("To composer", action: onSendToComposer)
                        .font(.caption.weight(.medium))
                        .buttonStyle(.borderless)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .onTapGesture(perform: onOpen)
    }
}

/// Relative age like the session list's Android `formatRelativeAge`.
private func scratchlistRelativeAge(nowMs: Int, thenMs: Int) -> String {
    let delta = nowMs - thenMs
    if delta < 60_000 { return String(localized: "now") }
    let minutes = delta / 60_000
    if minutes < 60 { return "\(minutes)m" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours)h" }
    let days = hours / 24
    if days < 7 { return "\(days)d" }
    let weeks = days / 7
    if weeks < 5 { return "\(weeks)w" }
    let months = days / 30
    if months < 12 { return "\(months)mo" }
    return "\(days / 365)y"
}

// MARK: - Attachment strip

/// Horizontal thumbnails: images render through the authed loader, other
/// mime types (pdf/text) degrade to filename chips; an optional ✕ badge
/// removes (editor strip).
private struct ScratchlistAttachmentStrip: View {
    let attachments: [ScratchlistAttachment]
    let loader: ScratchlistAttachmentLoader
    let thumbSize: CGFloat
    let onOpen: (ScratchlistAttachment) -> Void
    let onRemove: ((ScratchlistAttachment) -> Void)?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(attachments) { attachment in
                    ScratchlistAttachmentThumb(
                        attachment: attachment,
                        loader: loader,
                        size: thumbSize,
                        onOpen: { onOpen(attachment) },
                        onRemove: removeAction(for: attachment)
                    )
                }
            }
        }
    }

    private func removeAction(for attachment: ScratchlistAttachment) -> (() -> Void)? {
        guard let onRemove else { return nil }
        return { onRemove(attachment) }
    }
}

/// One thumbnail (image via the authed loader, otherwise a filename chip).
private struct ScratchlistAttachmentThumb: View {
    let attachment: ScratchlistAttachment
    let loader: ScratchlistAttachmentLoader
    let size: CGFloat
    let onOpen: () -> Void
    let onRemove: (() -> Void)?

    @State private var image: UIImage?
    @State private var failed = false

    private var isImage: Bool {
        attachment.mimeType.hasPrefix("image/")
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Button(action: onOpen) {
                tile
            }
            .buttonStyle(.plain)
            if let onRemove {
                Button(action: onRemove) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(.white, .black.opacity(0.6))
                }
                .buttonStyle(.plain)
                .padding(2)
                .accessibilityLabel("Remove \(attachment.filename)")
            }
        }
        .task(id: attachment.id) {
            guard isImage, image == nil, !failed else { return }
            if let loaded = await loader.image(for: attachment.id) {
                image = loaded
            } else {
                failed = true
            }
        }
    }

    @ViewBuilder
    private var tile: some View {
        if isImage, !failed {
            Group {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    ProgressView()
                        .controlSize(.small)
                }
            }
            .frame(width: size, height: size)
            .background(Color(uiColor: .tertiarySystemFill))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        } else {
            Text("📎 \(attachment.filename)")
                .font(.caption2)
                .lineLimit(3)
                .multilineTextAlignment(.center)
                .padding(4)
                .frame(width: size, height: size)
                .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }
}

// MARK: - Editor sheet

/// Edit sheet: text field + attachment strip (photo picker → guard →
/// downscale → upload spinner tile, remove) + Delete for existing entries +
/// Save.
private struct ScratchlistEditorSheet: View {
    let model: ScratchlistScreenModel
    let attachments: ScratchlistAttachmentLoader
    let onOpenAttachment: (ScratchlistAttachment) -> Void

    @State private var pickedItem: PhotosPickerItem?

    var body: some View {
        let editor = model.editor ?? ScratchlistEditorState()
        VStack(alignment: .leading, spacing: 12) {
            Text(editor.entryId == nil ? String(localized: "New note") : String(localized: "Edit note"))
                .font(.headline)
            TextField(
                "Note, draft, parking-lot idea…",
                text: Binding(
                    get: { model.editor?.text ?? "" },
                    set: { model.setEditorText($0) }
                ),
                axis: .vertical
            )
            .lineLimit(3...8)
            .textFieldStyle(.roundedBorder)
            attachmentRow(editor)
            HStack {
                if let entryId = editor.entryId {
                    Button("Delete", role: .destructive) {
                        model.deleteEntry(entryId)
                    }
                }
                Spacer()
                Button("Cancel") {
                    model.dismissEditor()
                }
                Button("Save") {
                    model.saveEditor()
                }
                .buttonStyle(.borderedProminent)
                .disabled(editor.isUploading)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .onChange(of: pickedItem) {
            guard let item = pickedItem else { return }
            pickedItem = nil
            model.addAttachment(item)
        }
    }

    private func attachmentRow(_ editor: ScratchlistEditorState) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(editor.attachments) { attachment in
                    ScratchlistAttachmentThumb(
                        attachment: attachment,
                        loader: attachments,
                        size: 72,
                        onOpen: { onOpenAttachment(attachment) },
                        onRemove: { model.removeAttachment(attachment) }
                    )
                }
                if editor.isUploading {
                    ProgressView()
                        .frame(width: 72, height: 72)
                        .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                } else {
                    PhotosPicker(selection: $pickedItem, matching: .images) {
                        Image(systemName: "plus")
                            .frame(width: 72, height: 72)
                            .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .accessibilityLabel("Add photo")
                }
            }
        }
    }
}

// MARK: - Viewer

/// Full-screen attachment viewer (the generated-image viewer pattern): dark
/// backdrop, fit-scaled image via the authed loader, tap or the close button
/// dismisses. Non-image attachments show a filename placeholder.
private struct ScratchlistAttachmentViewer: View {
    let attachment: ScratchlistAttachment
    let loader: ScratchlistAttachmentLoader

    @Environment(\.dismiss) private var dismiss
    @State private var image: UIImage?

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
                Text(attachment.filename)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        .task {
            guard attachment.mimeType.hasPrefix("image/") else { return }
            image = await loader.image(for: attachment.id)
        }
    }
}
