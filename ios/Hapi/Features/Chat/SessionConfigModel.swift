import HapiClient
import HapiProtocol
import Observation
import SwiftUI

/// App-only selection/navigation state. The interactor remains the source of
/// truth, including optimistic updates, capability gates and server reloads.
@MainActor @Observable
final class SessionConfigModel {
    enum Page: Hashable {
        case permission
        case model
    }

    let interactor: ChatInteractor
    var path: [Page] = []
    private var rootDetent: PresentationDetent = .medium

    init(interactor: ChatInteractor) {
        self.interactor = interactor
    }

    var config: SessionConfigState { interactor.config }
    var isApplying: Bool { interactor.configOpPending }
    var modelLoadFailed: Bool { interactor.codexModels == .failed }
    var showsModel: Bool { config.modelOptions != nil || config.modelOptionsLoading }
    var showsEffort: Bool { config.effortOptions?.isEmpty == false }
    var hasSettings: Bool { !config.permissionModes.isEmpty || showsModel || showsEffort }

    /// Details always expand; returning restores the user's root-sheet height.
    var detent: PresentationDetent {
        get { path.isEmpty ? rootDetent : .large }
        set { if path.isEmpty { rootDetent = newValue } }
    }

    var permission: PermissionMode { config.permissionMode ?? .default }

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

    /// Do not misrepresent an unlisted current model as the first catalog item.
    var unlistedModel: String? {
        guard let currentModel,
              config.modelOptions?.contains(where: { $0.value == currentModel }) != true else { return nil }
        return currentModel
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
        path.removeAll()
    }

    func selectModel(_ value: String?) {
        guard !isApplying, config.modelOptions?.contains(where: { $0.value == value }) == true else { return }
        if value != currentModel { interactor.setModel(value) }
        path.removeAll()
    }

    func selectEffort(_ value: String?) {
        guard !isApplying, value != currentEffort, canSelectEffort(value) else { return }
        interactor.setEffort(value)
    }

    func loadModels() {
        interactor.loadModelOptions()
    }
}
