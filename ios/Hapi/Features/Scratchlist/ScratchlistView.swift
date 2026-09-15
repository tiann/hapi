import HapiClient
import HapiProtocol
import HapiUI
import PhotosUI
import SwiftUI

/// Full inventory and a single navigation stack for reading/editing drafts.
struct ScratchlistView: View {
    @State private var model: ScratchlistScreenModel
    private let attachments: ScratchlistAttachmentLoader
    private let interactor: ChatInteractor?
    private let initialEntry: ScratchlistEntry?
    private let initiallyEditing: Bool
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var path: [String] = []
    @State private var viewerAttachment: ScratchlistAttachment?
    @State private var discardAndClose = false

    init(store: any SessionScratchlistStoring, sessionId: String, attachments: ScratchlistAttachmentLoader,
         interactor: ChatInteractor? = nil, initialEntry: ScratchlistEntry? = nil, initiallyEditing: Bool = false) {
        _model = State(initialValue: ScratchlistScreenModel(sessionId: sessionId, store: store))
        self.attachments = attachments
        self.interactor = interactor
        self.initialEntry = initialEntry
        self.initiallyEditing = initiallyEditing
    }

    private var entries: [ScratchlistEntry] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return model.state.entries.filter {
            query.isEmpty || $0.text.localizedStandardContains(query)
                || $0.attachments.contains { $0.filename.localizedStandardContains(query) }
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
            inventory
                .navigationTitle("Scratchlist")
                .navigationBarTitleDisplayMode(.inline)
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search drafts")
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
                }
                .navigationDestination(for: String.self) { entryId in
                    ScratchlistDetailView(model: model, entryId: entryId, loader: attachments,
                        interactor: interactor, onRestore: { dismiss() },
                        onOpenAttachment: { viewerAttachment = $0 })
                }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .background(ScratchlistDismissGuard(blocked: model.editor?.isDirty == true || model.editor?.isSaving == true) {
            if model.editor?.isSaving != true { discardAndClose = true }
        })
        .confirmationDialog("Discard your changes?", isPresented: $discardAndClose, titleVisibility: .visible) {
            Button("Discard changes", role: .destructive) { model.dismissEditor(); dismiss() }
            Button("Keep editing", role: .cancel) {}
        }
        .fullScreenCover(item: $viewerAttachment) { attachment in
            ScratchlistAttachmentViewer(attachment: attachment, loader: attachments)
        }
        .onAppear {
            model.start()
            if path.isEmpty, let initialEntry {
                path = [initialEntry.entryId]
                if initiallyEditing { model.openEditor(initialEntry) }
            }
        }
        .onDisappear {
            model.stop()
            if viewerAttachment == nil { model.dismissEditor() }
        }
    }

    @ViewBuilder
    private var inventory: some View {
        if model.isLoading {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if model.state.loadFailed {
            ContentUnavailableView {
                Label("Couldn't load the scratchlist", systemImage: "wifi.slash")
            } description: {
                Text("Check the connection to your hub and try again.")
            } actions: { Button("Retry") { model.retry() }.buttonStyle(.borderedProminent) }
        } else {
            List {
                Section {
                    if let notice = model.notice {
                        ScratchlistErrorBanner(message: notice, actionTitle: "Dismiss") { model.clearNotice() }
                    }
                    if model.state.refreshFailed {
                        ScratchlistErrorBanner(message: String(localized: "Couldn't refresh — showing saved drafts")) { model.retry() }
                    }
                    if model.state.atCap {
                        Text("Scratchlist is full (200 entries)").font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(entries) { entry in
                        ScratchlistEntryRow(entry: entry, interactor: interactor,
                            onOpen: { path.append(entry.entryId) },
                            onEdit: { model.openEditor(entry); path.append(entry.entryId) },
                            onDelete: { model.deleteEntry(entry.entryId) }, onRestore: { dismiss() })
                            .disabled(model.deletingEntryId != nil)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .overlay {
                if model.state.entries.isEmpty {
                    ContentUnavailableView {
                        Label("No drafts yet", systemImage: "tray")
                    } actions: {
                        if let interactor {
                            Button("Write draft") {
                                interactor.setComposerDestination(.scratchlist)
                                interactor.focusComposer()
                                dismiss()
                            }.buttonStyle(.borderedProminent)
                        }
                    }
                } else if entries.isEmpty {
                    ContentUnavailableView.search(text: query)
                }
            }
            .refreshable { await model.refresh() }
        }
    }
}

/// Each affordance is a real button: tapping a row never also takes a draft.
struct ScratchlistEntryRow: View {
    @Environment(\.hapiTypography) private var typography
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let entry: ScratchlistEntry
    let interactor: ChatInteractor?
    let onOpen: () -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void
    var onRestore: () -> Void = {}
    var compact = false
    var showsPreview = true
    var showsEditAction = true
    @State private var confirmRestore = false
    @State private var confirmDelete = false
    @State private var restoreError: String?

    private var queued: Bool { interactor?.queuedScratchlistEntries.contains(entry.entryId) == true }
    private var busy: Bool { interactor?.scratchlistBusy == true || interactor?.isSending == true }
    // The compact row shares the composer's error banner. Do not repeat a
    // failed park/restore there; the sheet needs its own local feedback.
    private var error: String? {
        (compact ? nil : restoreError) ?? interactor?.scratchlistEntryErrors[entry.entryId]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if dynamicTypeSize.isAccessibilitySize {
                if showsPreview { preview }
                actions.frame(maxWidth: .infinity, alignment: .trailing)
            } else {
                HStack(alignment: .center, spacing: 12) {
                    if showsPreview { preview }
                    else { Spacer(minLength: 0) }
                    actions
                }
            }
            if let error {
                Text(LocalizedNoticeMapper.map(error)).font(.footnote).foregroundStyle(.red)
            }
        }
        .confirmationDialog("You already have a draft", isPresented: $confirmRestore, titleVisibility: .visible) {
            Button("Append to input") { restore(.append) }
            Button("Save input, then take draft") { restore(.parkCurrent) }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog("Delete this draft?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive, action: onDelete)
            Button("Cancel", role: .cancel) {}
        }
    }

    private var preview: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 5) {
                Text(entry.text.isEmpty ? String(localized: "Attachment only") : entry.text)
                    .font(typography.bodyFont)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !compact, !entry.attachments.isEmpty {
                    Label {
                        Text(verbatim: "\(entry.attachments.count)")
                    } icon: { Image(systemName: "paperclip") }
                    .font(typography.captionFont).foregroundStyle(.secondary)
                    .accessibilityLabel(Text("\(entry.attachments.count) attachments"))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("View the full draft")
        .accessibilityIdentifier("scratchlist.preview.\(entry.entryId)")
    }

    private var actions: some View {
        HStack(spacing: 8) {
            if let interactor {
                Button {
                    if queued { queue() }
                    else if interactor.hasComposerDraft { confirmRestore = true }
                    else { restore(.append) }
                } label: {
                    Text(queued ? "Retry removal" : "Take draft")
                        .font(.subheadline.weight(.medium))
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityIdentifier("scratchlist.take.\(entry.entryId)")
                .disabled(busy)
            }
            if !compact {
                Menu {
                    if interactor != nil, !queued {
                        Button("Add to send queue", systemImage: "text.line.first.and.arrowtriangle.forward", action: queue)
                    }
                    if showsEditAction {
                        Button("Edit", systemImage: "pencil", action: onEdit).disabled(queued)
                    }
                    Button("Copy text", systemImage: "doc.on.doc") { UIPasteboard.general.string = entry.text }
                        .disabled(entry.text.isEmpty)
                    Button("Delete", systemImage: "trash", role: .destructive) { confirmDelete = true }.disabled(queued)
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 18, weight: .medium))
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .accessibilityLabel("Draft actions")
                .accessibilityIdentifier("scratchlist.actions.\(entry.entryId)")
                .disabled(busy)
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(.tint)
    }

    private func queue() {
        guard let interactor else { return }
        restoreError = nil
        Task { if await interactor.queueScratchlistEntry(entry) { onRestore() } }
    }

    private func restore(_ choice: ScratchlistRestoreChoice) {
        guard let interactor else { return }
        restoreError = nil
        Task {
            if await interactor.restoreScratchlistEntry(entry, choice: choice) { onRestore() }
            else { restoreError = interactor.scratchlistError }
        }
    }
}

struct ScratchlistErrorBanner: View {
    let message: String
    var actionTitle: LocalizedStringKey = "Retry"
    let retry: () -> Void
    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Image(systemName: "exclamationmark.circle").foregroundStyle(.red)
            Text(LocalizedNoticeMapper.map(message)).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
            Button(action: retry) {
                Text(actionTitle).frame(minHeight: 44).contentShape(Rectangle())
            }
        }
        .accessibilityElement(children: .contain)
    }
}

private struct ScratchlistAgeLabel: View {
    let updatedAt: Int
    @Environment(\.locale) private var locale
    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            Text(verbatim: age(relativeTo: context.date))
        }
    }
    private func age(relativeTo now: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.unitsStyle = .short
        return formatter.localizedString(for: Date(timeIntervalSince1970: Double(updatedAt) / 1000), relativeTo: now)
    }
}

private struct ScratchlistDetailView: View {
    let model: ScratchlistScreenModel
    let entryId: String
    let loader: ScratchlistAttachmentLoader
    let interactor: ChatInteractor?
    let onRestore: () -> Void
    let onOpenAttachment: (ScratchlistAttachment) -> Void
    @Environment(\.hapiTypography) private var typography
    @State private var discardChanges = false

    private var entry: ScratchlistEntry? { model.state.entries.first { $0.entryId == entryId } }

    var body: some View {
        Group {
            if model.editor != nil {
                ScratchlistEditorView(model: model, attachments: loader, onOpenAttachment: onOpenAttachment)
            } else if let entry {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if let notice = model.notice {
                            ScratchlistErrorBanner(message: notice, actionTitle: "Dismiss") { model.clearNotice() }
                        }
                        Text(entry.text).font(typography.bodyFont).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if !entry.attachments.isEmpty {
                            ScratchlistAttachmentStrip(attachments: entry.attachments, loader: loader,
                                thumbSize: 88, onOpen: onOpenAttachment, onRemove: nil, showsFilenames: true)
                        }
                        ScratchlistAgeLabel(updatedAt: entry.updatedAt)
                            .font(typography.captionFont).foregroundStyle(.secondary)
                        ScratchlistEntryRow(entry: entry, interactor: interactor, onOpen: {},
                            onEdit: { model.openEditor(entry) }, onDelete: { model.deleteEntry(entryId) }, onRestore: onRestore,
                            showsPreview: false, showsEditAction: false)
                    }.padding(16)
                }
            } else {
                ContentUnavailableView("Draft no longer available", systemImage: "tray")
            }
        }
        .navigationTitle(model.editor == nil ? "Draft" : "Edit draft")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(model.editor != nil)
        .toolbar {
            if let editor = model.editor {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") {
                        if editor.isDirty { discardChanges = true } else { model.dismissEditor() }
                    }.disabled(editor.isSaving)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Save") { model.saveEditor() }.disabled(!editor.canSave)
                }
            } else if let entry {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit") { model.openEditor(entry) }
                        .disabled(interactor?.scratchlistBusy == true || interactor?.queuedScratchlistEntries.contains(entryId) == true)
                }
            }
        }
        .confirmationDialog("Discard your changes?", isPresented: $discardChanges, titleVisibility: .visible) {
            Button("Discard changes", role: .destructive) { model.dismissEditor() }
            Button("Keep editing", role: .cancel) {}
        }
    }
}

private struct ScratchlistEditorView: View {
    let model: ScratchlistScreenModel
    let attachments: ScratchlistAttachmentLoader
    let onOpenAttachment: (ScratchlistAttachment) -> Void
    @Environment(\.hapiTypography) private var typography
    @State private var pickedItem: PhotosPickerItem?
    @State private var photosPickerOpen = false
    @State private var filePickerOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let editor = model.editor {
                if editor.isSaving { ProgressView().frame(maxWidth: .infinity) }
                if let error = editor.error {
                    ScratchlistErrorBanner(message: error, actionTitle: model.editorErrorIsRetryable ? "Retry" : "Dismiss",
                        retry: model.retryEditorOperation)
                }
                if editor.text.utf16.count > ScratchlistCaps.maxTextLength {
                    Text("Drafts can contain at most 10,000 characters — shorten the text before saving")
                        .font(.footnote).foregroundStyle(.red)
                }
                TextEditor(text: Binding(get: { model.editor?.text ?? "" }, set: model.setEditorText))
                    .font(typography.bodyFont)
                    .accessibilityLabel("Draft text")
                    .disabled(editor.isSaving)
                if !editor.attachments.isEmpty {
                    ScratchlistAttachmentStrip(attachments: editor.attachments, loader: attachments, thumbSize: 72,
                        onOpen: onOpenAttachment, onRemove: model.removeAttachment)
                        .frame(height: 78)
                        .disabled(editor.isSaving || editor.isUploading)
                }
                if let filename = editor.failedUploadName {
                    HStack {
                        Label(filename, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(.red)
                        Spacer()
                        Button("Remove", role: .destructive) { model.removeFailedUpload() }.frame(minHeight: 44)
                    }.disabled(editor.isUploading)
                }
                HStack {
                    Menu {
                        Button("Photo library", systemImage: "photo") { photosPickerOpen = true }
                        Button("Files", systemImage: "doc") { filePickerOpen = true }
                    } label: {
                        Image(systemName: "plus")
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .accessibilityLabel("Add attachment")
                    .accessibilityIdentifier("scratchlist.editor.attach")
                    Spacer()
                    if editor.isUploading { ProgressView() }
                }
                .frame(minHeight: 44)
                .disabled(editor.isSaving || editor.isUploading || editor.failedUploadName != nil)
            }
        }
        .padding(16)
        .photosPicker(isPresented: $photosPickerOpen, selection: $pickedItem, matching: .images)
        .onChange(of: pickedItem) {
            guard let item = pickedItem else { return }
            pickedItem = nil
            model.addAttachment(item)
        }
        .fileImporter(isPresented: $filePickerOpen, allowedContentTypes: [.item]) { result in
            guard case .success(let url) = result else { return }
            let editorId = model.editor?.id
            Task {
                let prepared = await AttachmentPreparer.prepare(fileURL: url)
                guard model.editor?.id == editorId else { return }
                switch prepared {
                case .ready(let prepared):
                    model.addPreparedAttachment(prepared)
                case .tooLarge(let filename, _):
                    model.reportEditorError(String(format: String(localized: "%@ is over the 50 MB upload limit"), filename))
                case .unreadable(let filename):
                    model.reportEditorError(String(format: String(localized: "Couldn't read %@"), filename))
                }
            }
        }
    }
}
// MARK: - Attachment strip

/// Horizontal thumbnails: images render through the authed loader, other
/// mime types (pdf/text) degrade to filename chips; an optional ✕ badge
/// removes (editor strip).
struct ScratchlistAttachmentStrip: View {
    let attachments: [ScratchlistAttachment]
    let loader: ScratchlistAttachmentLoader
    let thumbSize: CGFloat
    let onOpen: (ScratchlistAttachment) -> Void
    let onRemove: ((ScratchlistAttachment) -> Void)?
    var showsFilenames = false

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: showsFilenames ? 12 : 6) {
                ForEach(attachments) { attachment in
                    VStack(spacing: 6) {
                        ScratchlistAttachmentThumb(
                            attachment: attachment,
                            loader: loader,
                            size: thumbSize,
                            onOpen: { onOpen(attachment) },
                            onRemove: removeAction(for: attachment),
                            showsFilename: !showsFilenames
                        )
                        if showsFilenames {
                            Text(verbatim: attachment.filename)
                                .font(.caption).foregroundStyle(.secondary)
                                .frame(width: max(thumbSize, 140))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
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
struct ScratchlistAttachmentThumb: View {
    let attachment: ScratchlistAttachment
    let loader: ScratchlistAttachmentLoader
    let size: CGFloat
    let onOpen: () -> Void
    let onRemove: (() -> Void)?
    var showsFilename = true

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
            .accessibilityLabel(attachment.filename)
            if let onRemove {
                Button(action: onRemove) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(.white, .black.opacity(0.6))
                }
                .buttonStyle(.plain)
                .frame(minWidth: 44, minHeight: 44)
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
            Group {
                if showsFilename {
                    Text(verbatim: "📎 \(attachment.filename)")
                        .font(.caption2).lineLimit(3).multilineTextAlignment(.center)
                } else {
                    Image(systemName: isImage ? "photo" : "doc")
                        .font(.title2).foregroundStyle(.secondary)
                }
            }
            .padding(4)
            .frame(width: size, height: size)
            .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }
}


// MARK: - Viewer

/// Full-screen attachment viewer (the generated-image viewer pattern): dark
/// backdrop, fit-scaled image via the authed loader, tap or the close button
/// dismisses. Non-image attachments show a filename placeholder.
struct ScratchlistAttachmentViewer: View {
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
