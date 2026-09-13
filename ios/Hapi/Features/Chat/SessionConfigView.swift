import HapiClient
import HapiProtocol
import SwiftUI

/// Compact, catalog-driven settings: navigation lists for permissions/models,
/// a menu picker for effort. Selecting applies immediately; Done only dismisses.
struct SessionConfigView: View {
    @State private var model: SessionConfigModel
    let notice: String?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(interactor: ChatInteractor, notice: String? = nil) {
        self.init(model: SessionConfigModel(interactor: interactor), notice: notice)
    }

    init(model: SessionConfigModel, notice: String? = nil) {
        _model = State(initialValue: model)
        self.notice = notice
    }

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.path) {
            settingsForm
                .navigationTitle("Session Settings")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { doneButton }
                .navigationDestination(for: SessionConfigModel.Page.self) { page in
                    Group {
                        switch page {
                        case .permission: permissionList
                        case .model: modelList
                        }
                    }
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { doneButton }
                }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { feedback }
        .presentationDetents(
            dynamicTypeSize.isAccessibilitySize || !model.path.isEmpty ? [.large] : [.medium, .large],
            selection: Binding(
                get: { dynamicTypeSize.isAccessibilitySize ? .large : model.detent },
                set: { model.detent = $0 }
            )
        )
        .onAppear { model.loadModels() }
    }

    private var settingsForm: some View {
        Form {
            if !model.config.active {
                statusNotice("Session is offline — changes apply after it resumes or may be rejected.")
            } else if model.config.controlledByUser {
                statusNotice("Session is controlled from the terminal — config changes will be rejected.")
            }

            if model.hasSettings {
                Section {
                    if !model.config.permissionModes.isEmpty {
                        NavigationLink(value: SessionConfigModel.Page.permission) {
                            SessionConfigSummaryRow(
                                title: "Permission mode", value: model.permission.label, tone: model.permission.tone
                            )
                        }
                        .accessibilityIdentifier("session-config-permission")
                    }
                    if model.showsModel {
                        NavigationLink(value: SessionConfigModel.Page.model) {
                            SessionConfigSummaryRow(title: "Model", value: model.modelLabel)
                        }
                        .accessibilityIdentifier("session-config-model")
                    }
                    if model.showsEffort {
                        Picker("Effort", selection: Binding(
                            get: { model.currentEffort },
                            set: { model.selectEffort($0) }
                        )) {
                            ForEach(model.effortOptions, id: \.value) { option in
                                Text(verbatim: option.label)
                                    .tag(option.value)
                                    .disabled(!model.canSelectEffort(option.value))
                            }
                        }
                        .pickerStyle(.menu)
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("session-config-effort")
                    }
                }
                .disabled(model.isApplying)
            } else {
                statusNotice("No settings available for this session.")
            }
        }
    }

    private var permissionList: some View {
        List {
            Section {
                ForEach(model.config.permissionModes, id: \.mode) { option in
                    SessionConfigOptionRow(
                        label: option.label, selected: option.mode == model.permission, tone: option.tone
                    ) {
                        model.selectPermission(option.mode)
                    }
                    .accessibilityIdentifier("session-config-permission-\(option.mode.rawValue)")
                }
            } footer: {
                Text("Permission modes control how the agent requests approval. Behavior varies by agent.")
            }
            .disabled(model.isApplying)
        }
        .navigationTitle("Permission mode")
    }

    private var modelList: some View {
        List {
            if model.config.modelOptionsLoading {
                Section {
                    ProgressView("Loading models…")
                }
            } else if model.modelLoadFailed {
                Section {
                    Text("Failed to load models")
                        .foregroundStyle(.secondary)
                    Button("Retry") { model.loadModels() }
                        .accessibilityIdentifier("session-config-model-retry")
                }
            } else if model.config.modelOptions?.isEmpty != false {
                statusNotice("Model list unavailable for this session.")
            } else {
                Section {
                    if let current = model.unlistedModel {
                        SessionConfigOptionRow(label: current, selected: true) {}
                            .disabled(true)
                    }
                    ForEach(model.config.modelOptions ?? [], id: \.value) { option in
                        SessionConfigOptionRow(label: option.label, selected: option.value == model.currentModel) {
                            model.selectModel(option.value)
                        }
                        .accessibilityIdentifier("session-config-model-\(option.value ?? "default")")
                    }
                }
                .disabled(model.isApplying)
            }
        }
        .navigationTitle("Model")
    }

    @ToolbarContentBuilder
    private var doneButton: some ToolbarContent {
        ToolbarItem(placement: .confirmationAction) {
            Button("Done") { dismiss() }
                .accessibilityIdentifier("session-config-done")
        }
    }

    /// ChatModel owns the event callback. Mirroring its notice here keeps
    /// failures visible above the modal without stealing chat's event handler.
    @ViewBuilder
    private var feedback: some View {
        if model.isApplying || notice != nil {
            VStack(alignment: .leading, spacing: 8) {
                if model.isApplying {
                    ProgressView("Applying changes…")
                        .accessibilityIdentifier("session-config-applying")
                }
                if let notice {
                    Label {
                        Text(verbatim: LocalizedNoticeMapper.map(notice))
                            .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "info.circle")
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("session-config-notice")
                }
            }
            .font(.footnote)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
            .background(.regularMaterial)
        }
    }

    private func statusNotice(_ text: LocalizedStringKey) -> some View {
        Section {
            Label(text, systemImage: "info.circle")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

private struct SessionConfigSummaryRow: View {
    let title: LocalizedStringKey
    let value: String
    var tone: PermissionModeTone = .neutral
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                stackedSummary
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 16) {
                        Text(title).fixedSize()
                        Spacer(minLength: 0)
                        currentValue.fixedSize()
                    }
                    stackedSummary
                }
            }
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(
            tone == .danger
                ? Text(verbatim: value) + Text(verbatim: ", ") + Text("High risk")
                : Text(verbatim: value)
        )
    }

    private var stackedSummary: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
            currentValue
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var currentValue: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: value)
                .foregroundStyle(tone == .neutral || tone == .info ? .secondary : tone.color)
            if tone == .danger {
                SessionConfigRiskLabel()
            }
        }
    }
}

struct SessionConfigOptionRow: View {
    let label: String
    let selected: Bool
    var tone: PermissionModeTone = .neutral
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: label)
                        .foregroundStyle(tone.color)
                    if tone == .danger {
                        SessionConfigRiskLabel()
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.tint)
                        .accessibilityHidden(true)
                }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Explicit layout avoids Form's automatic Label style treating this subtitle
/// as a separate list-row label (which can clip or stretch its warning text).
private struct SessionConfigRiskLabel: View {
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "exclamationmark.triangle")
                .accessibilityHidden(true)
            Text("High risk")
        }
        .font(.caption)
        .foregroundStyle(.red)
    }
}

private extension PermissionModeTone {
    var color: Color {
        switch self {
        case .danger: .red
        case .warning: .orange
        case .neutral, .info: .primary
        }
    }
}
