import HapiClient
import HapiProtocol
import Observation

/// App-only selection state. The interactor remains the source of
/// truth, including optimistic updates, capability gates and server reloads.
@MainActor @Observable
final class SessionConfigModel {
    let interactor: ChatInteractor

    init(interactor: ChatInteractor) {
        self.interactor = interactor
    }

    var config: SessionConfigState { interactor.config }
    var isApplying: Bool { interactor.configOpPending }
    var modelLoadFailed: Bool { interactor.codexModels == .failed }
    var showsModel: Bool { config.modelOptions != nil || config.modelOptionsLoading }
    var showsEffort: Bool { config.effortOptions?.isEmpty == false }
    var showsCollaborationMode: Bool { config.flavor == "codex" }
    var hasSettings: Bool { !config.permissionModes.isEmpty || showsModel || showsEffort || showsCollaborationMode }

    var permission: PermissionMode { config.permissionMode ?? .default }
    var collaborationMode: CodexCollaborationMode { config.collaborationMode ?? .default }

    var currentModel: String? {
        if config.flavor == "claude" {
            return ModelCatalog.normalizeClaudeModel(config.model)
        }
        if config.flavor == "codex", config.model == nil,
           case .loaded(let models) = interactor.codexModels {
            return models.first(where: \.isDefault)?.id
        }
        return config.model
    }

    var modelLabel: String {
        config.modelOptions?.first { $0.value == currentModel }?.label
            ?? currentModel ?? "Default"
    }

    /// Give the menu a read-only matching tag, even when Codex has neither an
    /// explicit selection nor a catalog default. Never imply its first model.
    var unlistedModelOption: CatalogOption? {
        guard config.modelOptions?.contains(where: { $0.value == currentModel }) != true else { return nil }
        return CatalogOption(value: currentModel, label: modelLabel)
    }

    var currentEffort: String? {
        config.flavor == "claude" ? ModelCatalog.normalizeClaudeEffort(config.effort) : config.effort
    }

    /// An obsolete effort can arrive via SSE or remain after a model switch.
    /// Give Picker a matching, read-only tag without offering unsupported edits.
    var effortOptions: [CatalogOption] {
        guard var options = config.effortOptions, !options.isEmpty else { return [] }
        if !options.contains(where: { $0.value == currentEffort }) {
            options.insert(CatalogOption(value: currentEffort, label: currentEffort ?? "Default"), at: 0)
        }
        return options
    }

    func canSelectEffort(_ value: String?) -> Bool {
        config.effortOptions?.contains(where: { $0.value == value }) == true
    }

    func selectPermission(_ mode: PermissionMode) {
        guard !isApplying, config.permissionModes.contains(where: { $0.mode == mode }) else { return }
        if mode != permission { interactor.setPermissionMode(mode) }
    }

    func selectModel(_ value: String?) {
        guard !isApplying, config.modelOptions?.contains(where: { $0.value == value }) == true else { return }
        if value != currentModel { interactor.setModel(value) }
    }

    func selectCollaborationMode(_ mode: CodexCollaborationMode) {
        guard !isApplying, config.canChangeCollaborationMode, mode != collaborationMode else { return }
        interactor.setCollaborationMode(mode)
    }

    func selectEffort(_ value: String?) {
        guard !isApplying, value != currentEffort, canSelectEffort(value) else { return }
        interactor.setEffort(value)
    }

    func loadModels() {
        interactor.loadModelOptions()
    }
}
