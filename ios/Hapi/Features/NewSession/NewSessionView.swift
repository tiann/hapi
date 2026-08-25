import HapiClient
import HapiProtocol
import SwiftUI

/// NEW SESSION (A-M3c): machine → directory → agent/options → spawn,
/// presented as a sheet off the session list's "+" button. State and
/// behavior live in `NewSessionModel`; this view renders it and forwards
/// intents. A successful spawn surfaces through `onCreated` (the presenter
/// dismisses the sheet and pushes the chat — navigate-replace).
struct NewSessionView: View {
    @State private var model: NewSessionModel
    @Environment(\.dismiss) private var dismiss
    private let session: HubSession

    init(session: HubSession, onCreated: @escaping @MainActor (String) -> Void) {
        _model = State(initialValue: NewSessionModel(session: session, onCreated: onCreated))
        self.session = session
    }

    var body: some View {
        NavigationStack {
            Form {
                machineSection
                directorySection
                sessionTypeSection
                agentSection
                optionsSection
                createSection
            }
            .navigationTitle("New Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
            }
            .task {
                await model.start()
            }
            .onChange(of: session.machineStore.listRevision) {
                model.machinesChanged()
            }
        }
        .sheet(isPresented: directoryBrowserPresented) {
            RemoteDirectoryBrowserView(
                model: model.directoryBrowser,
                onSelect: model.selectBrowsedDirectory
            )
        }
    }

    // MARK: - Machine

    private var machineSection: some View {
        Section("Machine") {
            if model.machines.isEmpty {
                Text(model.machinesLoading
                    ? String(localized: "Loading machines…")
                    : String(localized: "No machines online"))
                    .foregroundStyle(.secondary)
            } else {
                Picker("Machine", selection: machineBinding) {
                    ForEach(model.machines) { machine in
                        Text(machine.label).tag(machine.id)
                    }
                }
                if let health = selectedMachineHealth {
                    Text(health)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if let error = model.runnerSpawnError {
                Text("Runner last spawn error: \(error)")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
        .disabled(model.isSpawning)
    }

    private var selectedMachineHealth: String? {
        model.machines.first { $0.id == model.form.machineId }?.healthLabel
    }

    private var machineBinding: Binding<String> {
        Binding(
            get: { model.form.machineId ?? "" },
            set: { model.setMachine($0) }
        )
    }

    // MARK: - Directory

    private var directorySection: some View {
        Section {
            HStack(spacing: 8) {
                TextField(
                    "/path/to/project",
                    text: Binding(get: { model.form.directory }, set: { model.setDirectory($0) })
                )
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .font(.system(.callout, design: .monospaced))

                Button {
                    model.openDirectoryBrowser()
                } label: {
                    Image(systemName: "folder.badge.plus")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Browse")
            }

            // Server-side autocomplete (list-directory on the parent path).
            ForEach(model.suggestions, id: \.self) { suggestion in
                Button {
                    model.pickSuggestion(suggestion)
                } label: {
                    Label {
                        Text(suggestion)
                            .lineLimit(1)
                            .truncationMode(.head)
                    } icon: {
                        Image(systemName: "folder")
                    }
                    .font(.callout)
                }
                .buttonStyle(.plain)
            }

            if !model.recentPaths.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.recentPaths, id: \.self) { path in
                            FilterChip(label: path, selected: false) {
                                model.pickRecentPath(path)
                            }
                        }
                    }
                }
                .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
            }
        } header: {
            Text("Directory")
        } footer: {
            if let status = model.directoryStatus {
                Text(status.message)
                    .foregroundStyle(status.isError ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
            }
        }
        .disabled(model.isSpawning)
    }

    private var directoryBrowserPresented: Binding<Bool> {
        Binding(
            get: { model.directoryBrowser.isPresented },
            set: { presented in
                if !presented {
                    model.directoryBrowser.close()
                }
            }
        )
    }

    // MARK: - Session type

    private var sessionTypeSection: some View {
        Section {
            Picker("Session type", selection: sessionTypeBinding) {
                Text("Simple").tag(SpawnSessionType.simple)
                Text("Worktree").tag(SpawnSessionType.worktree)
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            if model.form.sessionType == .worktree {
                TextField(
                    "feature-x (optional)",
                    text: Binding(
                        get: { model.form.worktreeName },
                        set: { model.setWorktreeName($0) }
                    )
                )
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            }
        } header: {
            Text("Session Type")
        } footer: {
            if let error = model.worktreeNameError {
                Text(LocalizedNoticeMapper.map(error)).foregroundStyle(.red)
            } else {
                Text(
                    model.form.sessionType == .worktree
                        ? String(localized: "Create a new git worktree next to the repo")
                        : String(localized: "Use selected directory as-is")
                )
            }
        }
        .disabled(model.isSpawning)
    }

    private var sessionTypeBinding: Binding<SpawnSessionType> {
        Binding(
            get: { model.form.sessionType },
            set: { model.setSessionType($0) }
        )
    }

    // MARK: - Agent

    private var agentSection: some View {
        Section("Agent") {
            Picker("Agent", selection: agentBinding) {
                ForEach(model.agents, id: \.value) { agent in
                    // Plain `Image` icon so the menu representation keeps it
                    // (UIMenu drops custom icon views); template monos take
                    // the menu tint, color marks render as-is.
                    if let asset = AgentFlavorIconView.assetName(forFlavor: agent.value) {
                        Label {
                            Text(agent.label)
                        } icon: {
                            Image(asset)
                        }
                        .tag(agent.value)
                    } else {
                        Text(agent.label).tag(agent.value)
                    }
                }
            }
            .disabled(
                model.isSpawning
                    || model.agentAvailabilityLoading
                    || model.agentAvailabilityError != nil
            )
            if model.agentAvailabilityLoading {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Checking installed Agents…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            if let error = model.agentAvailabilityError {
                HStack(alignment: .firstTextBaseline) {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                    Spacer()
                    Button("Retry") {
                        model.retryAgentAvailability()
                    }
                    .font(.footnote)
                }
            }
        }
    }

    private var agentBinding: Binding<String> {
        Binding(
            get: { model.form.agent.rawValue },
            set: { model.setAgent(AgentFlavor(rawValue: $0)) }
        )
    }

    // MARK: - Options

    @ViewBuilder
    private var optionsSection: some View {
        Section("Options") {
            if let options = model.modelOptions {
                optionPicker(
                    "Model",
                    options: options,
                    selection: Binding(get: { model.form.model }, set: { model.setModel($0) })
                )
                .disabled(model.modelsLoading || model.modelsError != nil)
                if model.modelsLoading {
                    Text("Loading…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let error = model.modelsError {
                    HStack {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                        Spacer()
                        Button("Retry") {
                            model.retryCodexModels()
                        }
                        .font(.footnote)
                    }
                }
            }

            if let options = model.effortOptions {
                optionPicker(
                    "Effort",
                    options: options,
                    selection: Binding(get: { model.form.effort }, set: { model.setEffort($0) })
                )
            }

            if let options = model.reasoningEffortOptions {
                optionPicker(
                    "Reasoning Effort",
                    options: options,
                    selection: Binding(
                        get: { model.form.modelReasoningEffort },
                        set: { model.setModelReasoningEffort($0) }
                    )
                )
                .disabled(model.modelsLoading)
            }

            permissionControl

            if model.showCollaborationMode {
                Picker("Collaboration Mode", selection: collaborationModeBinding) {
                    ForEach(CodexCollaborationMode.allCases, id: \.self) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
            }

            if model.showCopilotAgentMode {
                Picker("Agent Mode", selection: copilotAgentModeBinding) {
                    ForEach(CopilotAgentMode.allCases, id: \.self) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
            }

            if model.showFastMode {
                Picker("Fast Mode", selection: serviceTierBinding) {
                    Text("Standard").tag(ServiceTier.standard)
                    Text("Fast").tag(ServiceTier.fast)
                }
            }
        }
        .disabled(model.isSpawning)
    }

    @ViewBuilder
    private var permissionControl: some View {
        switch model.permission {
        case .nativeSelect(let options):
            Picker("Permission Mode", selection: permissionModeBinding) {
                ForEach(options, id: \.mode) { option in
                    Text(option.label).tag(option.mode)
                }
            }
        case .yoloToggle(let nativeModeLabel):
            VStack(alignment: .leading, spacing: 2) {
                Toggle(
                    "Bypass approvals and sandbox",
                    isOn: Binding(get: { model.form.yolo }, set: { model.setYolo($0) })
                )
                Text(
                    nativeModeLabel.map {
                        String(format: String(localized: "Uses dangerous agent flags when spawning. Applies native %@ mode."), $0)
                    }
                        ?? String(localized: "Uses dangerous agent flags when spawning.")
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        case .managed:
            VStack(alignment: .leading, spacing: 2) {
                LabeledContent("Permission Mode", value: String(localized: "Managed by agent"))
                Text("This agent manages its own permissions. YOLO mode is not available.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var permissionModeBinding: Binding<PermissionMode> {
        Binding(
            get: { model.form.permissionMode },
            set: { model.setPermissionMode($0) }
        )
    }

    private var collaborationModeBinding: Binding<CodexCollaborationMode> {
        Binding(
            get: { model.form.collaborationMode },
            set: { model.setCollaborationMode($0) }
        )
    }

    private var copilotAgentModeBinding: Binding<CopilotAgentMode> {
        Binding(
            get: { model.form.copilotAgentMode },
            set: { model.setCopilotAgentMode($0) }
        )
    }

    private var serviceTierBinding: Binding<ServiceTier> {
        Binding(
            get: { model.form.serviceTier },
            set: { model.setServiceTier($0) }
        )
    }

    private func optionPicker(
        _ title: LocalizedStringKey,
        options: [NewSessionOption],
        selection: Binding<String>
    ) -> some View {
        Picker(title, selection: selection) {
            ForEach(options, id: \.value) { option in
                Text(option.label).tag(option.value)
            }
        }
    }

    // MARK: - Create

    private var createSection: some View {
        Section {
            Button {
                model.create()
            } label: {
                HStack(spacing: 8) {
                    if model.isSpawning {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Text(createLabel)
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
            }
            .disabled(!model.canCreate)
        } footer: {
            if let error = model.spawnError {
                Text(error).foregroundStyle(.red)
            }
        }
    }

    private var createLabel: String {
        if model.isSpawning {
            return String(localized: "Creating…")
        }
        if model.confirmCreateDirectory {
            return String(localized: "Create and Make Directory")
        }
        return String(localized: "Create")
    }
}
