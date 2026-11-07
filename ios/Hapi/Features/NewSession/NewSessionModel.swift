import Foundation
import HapiClient
import HapiProtocol
import Observation

// MARK: - UI models

/// One machine row of the picker (Android `MachineOptionUi` port).
struct MachineOptionUI: Identifiable, Equatable {
    let id: String
    /// `displayName || host || id.prefix(8)` plus ` (platform)` and CLI version.
    let label: String
    /// e.g. `CPU 12% · Mem 45%`; nil when the runner reports no health.
    let healthLabel: String?
}

/// Directory hint under the input (web `directoryStatusMessage` + tone).
struct DirectoryStatusUI: Equatable {
    let message: String
    let isError: Bool
}

/// Which permission control the current flavor renders (web `PermissionField`).
enum PermissionUI: Equatable {
    /// Native permission-mode picker (claude, grok, codex-family —
    /// `NewSessionLogic.usesNativePermissionSelect`).
    case nativeSelect([PermissionModeOption])
    /// HAPI YOLO toggle (agy/cursor) with the native mode it maps to.
    case yoloToggle(nativeModeLabel: String?)
    /// Pi: the agent manages its own permissions.
    case managed
}

/// Machine codex-models catalog state (web `useCodexModels`).
enum CodexModelsState: Equatable {
    case hidden
    case loading
    case loaded([CodexModelSummary])
    /// Runner has no machine RPC (`rpc_target_missing`) — hide the picker.
    case unsupported
    case failed(String)
}

/// Discovered model catalog of the selected non-Claude/Codex agent.
enum AgentModelsState: Equatable {
    case hidden
    case loading
    case loaded(AgentModelsResponse)
    /// Runner has no catalog RPC (`rpc_target_missing`) — hide the picker.
    case unsupported
    case failed(String)
}

/// What the discovered-model picker fetches: per machine, plus the target
/// directory for directory-scoped flavors (`AgentModelCatalog.Scope`).
struct AgentModelsRequest: Hashable {
    let flavor: AgentFlavor
    let machineId: String
    let cwd: String?
}

/// Installed/static-configured Agent catalog for the selected machine.
enum AgentAvailabilityState: Equatable {
    case loading
    case loaded([AgentAvailabilityEntry])
    case failed(message: String, upgradeRequired: Bool)
}

private struct CachedAgentModels {
    let response: AgentModelsResponse
    let variants: [String: [String]]?
}

// MARK: - Persistence

/// Create-form persistence: last-used machine + per-machine recent paths
/// (web `useRecentPaths`) and the in-progress draft (web
/// `newSessionFormDraft.ts`) so backing out of the sheet loses nothing.
/// JSON blobs in `UserDefaults`, keyed per hub (the Android original keys
/// app-wide; per-hub matches this app's multi-hub stores).
struct NewSessionPrefsData: Codable, Equatable {
    var lastMachineId: String?
    /// Machine id → most-recent-first spawn directories
    /// (cap `NewSessionLogic.maxRecentPaths`).
    var recentPaths: [String: [String]] = [:]
}

struct NewSessionPrefsStore {
    let hubUrl: String
    var defaults: UserDefaults = .standard

    private var prefsKey: String { "newSession.prefs.\(hubUrl)" }
    private var draftKey: String { "newSession.draft.\(hubUrl)" }

    func readPrefs() -> NewSessionPrefsData {
        decode(prefsKey) ?? NewSessionPrefsData()
    }

    func writePrefs(_ data: NewSessionPrefsData) {
        encode(data, key: prefsKey)
    }

    /// Nil when no draft is stored (or it fails to decode).
    func readDraft() -> NewSessionForm? {
        decode(draftKey)
    }

    func writeDraft(_ draft: NewSessionForm) {
        encode(draft, key: draftKey)
    }

    func clearDraft() {
        defaults.removeObject(forKey: draftKey)
    }

    private func decode<T: Decodable>(_ key: String) -> T? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? HapiJSON.decoder.decode(T.self, from: data)
    }

    private func encode<T: Encodable>(_ value: T, key: String) {
        guard let data = try? HapiJSON.encoder.encode(value) else { return }
        defaults.set(data, forKey: key)
    }
}

// MARK: - Model

/// New-session state machine (A-M3c): machine → directory → agent/options →
/// spawn — the iOS counterpart of the Android reference's
/// `NewSessionViewModel` in this app's viewModel-less `@Observable` style.
/// Pure mapping/validation lives in `NewSessionLogic` (HapiClient, tested);
/// this model orchestrates debounce, caching, fetches, and persistence.
/// Web reference: `web/src/components/NewSession/index.tsx`.
///
/// Option matrix (web create form):
/// - model pickers: claude (static presets), codex (machine catalog; hidden
///   when the runner lacks the RPC) and the `AgentModelCatalog` flavors —
///   agy/cursor/dsh/pi per machine, copilot/grok/kimi/opencode once the
///   directory exists. Cursor is a flat list of ACP ids (no variant drill-down).
/// - effort: claude static levels, grok per-model efforts, pi thinking
///   levels; reasoning effort: codex catalog, opencode variants.
/// - `startingMode` stays unset → the runner spawns `'remote'` (pty deferred).
@MainActor @Observable
final class NewSessionModel {
    static let msgWorktreeMissing =
        String(localized: "Worktree sessions require an existing repository directory.")
    static let msgDirectoryMissing =
        String(localized: "Directory does not exist. Creating the session will create it automatically.")
    static let msgDirectoryMissingConfirm =
        String(localized: "Directory does not exist. Tap Create again to create it automatically.")
    static let msgDirectoryOutsideWorkspaceRoots =
        String(localized: "Directory must be inside one of this machine's workspace roots.")
    static let msgDirectoryLookupFailed = String(localized: "Failed to browse directories")
    static let msgDirectoryCheckFailed = String(localized: "Failed to check directory")
    static let msgMachineOffline = String(localized: "Selected machine is offline. Choose an online machine.")
    static let msgAgentAvailabilityFailed = String(localized: "Failed to check installed Agents")
    static let msgRunnerUpgradeRequired =
        String(localized: "Upgrade and restart this machine's HAPI runner before creating sessions.")
    static let msgNoAvailableAgents =
        String(localized: "No supported Agents are installed on this machine.")
    static let msgSelectedAgentUnavailable =
        String(localized: "The selected Agent is not available on this machine.")

    // MARK: Observable state

    private(set) var form = NewSessionForm()
    let directoryInput: NewSessionDirectoryModel
    var suggestions: [String] { directoryInput.suggestions }
    private(set) var codexModels: CodexModelsState = .hidden
    private(set) var agentModels: AgentModelsState = .hidden
    /// OpenCode variants keyed `provider/model`; nil until loaded.
    private(set) var opencodeVariants: [String: [String]]?
    private(set) var agentAvailability: AgentAvailabilityState = .loading
    private(set) var isSpawning = false
    private(set) var spawnError: String?
    private(set) var confirmCreateDirectoryArmed = false
    private(set) var machinesSettled = false
    private(set) var prefsData = NewSessionPrefsData()
    let directoryBrowser: RemoteDirectoryBrowserModel

    // MARK: Wiring

    private let session: HubSession
    private let prefsStore: NewSessionPrefsStore
    /// Fired once with the new session id — navigate-replace to the chat.
    private let onCreated: @MainActor (String) -> Void

    @ObservationIgnored private var codexTask: Task<Void, Never>?
    @ObservationIgnored private var availabilityTask: Task<Void, Never>?
    @ObservationIgnored private var defaultDirectoryTask: Task<Void, Never>?
    @ObservationIgnored private var codexFetchedForMachine: String?
    @ObservationIgnored private var agentModelsTask: Task<Void, Never>?
    @ObservationIgnored private var agentModelsFetched: AgentModelsRequest??
    @ObservationIgnored private var agentModelsCache: [AgentModelsRequest: CachedAgentModels] = [:]
    @ObservationIgnored private var availabilityFetchedForMachine: String?
    @ObservationIgnored private var suppressSuggestions = false
    @ObservationIgnored private var spawnInFlight = false
    @ObservationIgnored private var hasStarted = false
    @ObservationIgnored private var directoryEdited = false
    @ObservationIgnored private var directoryEditVersion = 0

    init(
        session: HubSession,
        defaults: UserDefaults = .standard,
        onCreated: @escaping @MainActor (String) -> Void
    ) {
        self.session = session
        self.prefsStore = NewSessionPrefsStore(hubUrl: session.hubUrl, defaults: defaults)
        self.onCreated = onCreated
        self.directoryInput = NewSessionDirectoryModel(
            requester: session.api,
            lookupError: Self.msgDirectoryLookupFailed,
            checkError: Self.msgDirectoryCheckFailed
        )
        self.directoryBrowser = RemoteDirectoryBrowserModel(
            requester: session.api,
            fallbackError: Self.msgDirectoryLookupFailed
        )
    }

    // MARK: - Lifecycle (paired with the sheet's `.task`)

    /// Restore prefs + sanitized draft, preselect a machine, refresh the
    /// roster. Call once per presentation.
    func start() async {
        if !hasStarted {
            hasStarted = true
            prefsData = prefsStore.readPrefs()
            let draft = prefsStore.readDraft().map(NewSessionLogic.sanitizeDraft)
            form = draft ?? NewSessionForm()
            // A saved empty path can be intentional; never replace it on refresh.
            directoryEdited = draft != nil
            suppressSuggestions = true
        }
        reconcileMachineSelection()
        refreshAgentAvailability()
        refreshCodexModelsIfNeeded()
        refreshAgentModelsIfNeeded()
        scheduleDirectoryWork()

        do {
            try await session.machineStore.refresh()
        } catch {
            // Snapshot (if any) keeps serving; the picker shows what it has.
        }
        guard !Task.isCancelled else { return }
        machinesSettled = true
        machinesChanged()
    }

    /// Only an unselected form is auto-selected. Losing a machine must not
    /// move the user's path or pending Create action onto a different host.
    func machinesChanged() {
        guard hasStarted else { return }
        reconcileMachineSelection()
        if selectedMachine == nil {
            cancelDefaultDirectoryResolution()
            directoryBrowser.close()
            availabilityTask?.cancel()
            codexTask?.cancel()
            availabilityFetchedForMachine = nil
            codexFetchedForMachine = nil
        } else {
            if directoryBrowser.isPresented,
               directoryBrowser.roots != selectedMachine.map(RemoteDirectoryPath.browseRoots) {
                directoryBrowser.close()
            }
            refreshAgentAvailability()
            refreshCodexModelsIfNeeded()
        }
        refreshAgentModelsIfNeeded()
        scheduleDirectoryWork()
    }

    func stopDirectoryWork() {
        cancelDefaultDirectoryResolution()
        directoryInput.stop()
    }

    private func cancelDefaultDirectoryResolution() {
        directoryEditVersion += 1
        defaultDirectoryTask?.cancel()
        defaultDirectoryTask = nil
    }

    // MARK: - Derived state

    var machines: [MachineOptionUI] {
        session.machineStore.machines.map(Self.machineOption)
    }

    var machinesLoading: Bool {
        session.machineStore.machines.isEmpty && !machinesSettled
    }

    var machineUnavailable: Bool {
        machinesSettled && form.machineId != nil && selectedMachine == nil
    }

    var normalizedDirectory: String {
        RemoteDirectoryPath.expandHome(form.directory, homeDirectory: selectedMachine?.metadata?.homeDir)
    }

    /// `runnerState.lastSpawnError` of the selected machine, formatted
    /// (`web/src/utils/formatRunnerSpawnError.ts`).
    var runnerSpawnError: String? {
        Self.formatRunnerSpawnError(selectedMachine)
    }

    var recentPaths: [String] {
        recentPaths(for: form.machineId)
    }

    var directoryStatus: DirectoryStatusUI? {
        if directoryOutsideWorkspaceRoots {
            return DirectoryStatusUI(message: Self.msgDirectoryOutsideWorkspaceRoots, isError: true)
        }
        if missingWorktreeDirectory {
            return DirectoryStatusUI(message: Self.msgWorktreeMissing, isError: true)
        }
        if needsCreationWarning {
            return DirectoryStatusUI(
                message: confirmCreateDirectory
                    ? Self.msgDirectoryMissingConfirm
                    : Self.msgDirectoryMissing,
                isError: false
            )
        }
        if let error = directoryInput.existenceError {
            return DirectoryStatusUI(message: error, isError: true)
        }
        return nil
    }

    /// Installed creatable flavors, in runner catalog order.
    var agents: [NewSessionOption] {
        availableAgentFlavors.map {
            NewSessionOption(value: $0.rawValue, label: $0.displayLabel)
        }
    }

    var agentAvailabilityLoading: Bool {
        agentAvailability == .loading
    }

    var agentAvailabilityError: String? {
        switch agentAvailability {
        case .loading:
            return nil
        case .failed(let message, _):
            return message
        case .loaded:
            return availableAgentFlavors.isEmpty ? Self.msgNoAvailableAgents : nil
        }
    }

    /// Nil hides the model picker.
    var modelOptions: [NewSessionOption]? {
        switch (form.agent, codexModels) {
        case (.claude, _):
            return NewSessionCatalogs.claudeModels
        case (.codex, .loaded(let models)):
            return [NewSessionOption(value: "auto", label: "Default")]
                + models.map { NewSessionOption(value: $0.id, label: $0.displayName) }
        case (.codex, .loading), (.codex, .failed):
            return [NewSessionOption(value: "auto", label: "Default")]
        case (.codex, _):
            return nil // `.unsupported` (old runner)
        default:
            break
        }
        switch agentModels {
        case .loaded(let response):
            return AgentModelCatalog.newSessionModelOptions(flavor: form.agent, response: response)
        case .loading, .failed:
            return AgentModelCatalog.newSessionModelOptions(
                flavor: form.agent,
                response: AgentModelsResponse(success: true)
            )
        case .hidden, .unsupported:
            return nil
        }
    }

    var modelsLoading: Bool {
        (form.agent == .codex && codexModels == .loading) || agentModels == .loading
    }

    var modelsError: String? {
        if case .failed(let message) = codexModels {
            return String(format: String(localized: "Failed to load models: %@"), message)
        }
        if case .failed(let message) = agentModels {
            return String(format: String(localized: "Failed to load models: %@"), message)
        }
        return nil
    }

    private var loadedAgentModels: AgentModelsResponse? {
        if case .loaded(let response) = agentModels { return response }
        return nil
    }

    /// Claude effort, grok effort or pi thinking level; nil hides the field.
    var effortOptions: [NewSessionOption]? {
        switch form.agent {
        case .claude: return NewSessionCatalogs.claudeEfforts
        case .grok: return AgentModelCatalog.grokEffortOptions(response: loadedAgentModels, model: form.model)
        case .pi: return AgentModelCatalog.piEffortOptions(response: loadedAgentModels, model: form.model)
        default: return nil
        }
    }

    /// Codex reasoning effort or opencode variant; nil hides the field.
    var reasoningEffortOptions: [NewSessionOption]? {
        if form.agent == .opencode {
            return AgentModelCatalog.opencodeReasoningEffortOptions(
                variants: opencodeVariants,
                response: loadedAgentModels,
                model: form.model
            )
        }
        guard form.agent == .codex, codexModels != .unsupported else { return nil }
        if case .loaded(let models) = codexModels,
           let advertised = NewSessionLogic.codexReasoningEfforts(models: models, model: form.model) {
            return [NewSessionOption(value: "default", label: "Default")]
                + advertised.map {
                    NewSessionOption(value: $0, label: NewSessionCatalogs.effortLabel($0))
                }
        }
        return NewSessionCatalogs.codexReasoningEfforts
    }

    var permission: PermissionUI {
        let agent = form.agent
        if agent == .pi {
            return .managed
        }
        if NewSessionLogic.usesNativePermissionSelect(agent) {
            return .nativeSelect(permissionModes.map { PermissionModeOption(mode: $0) })
        }
        return .yoloToggle(nativeModeLabel: NewSessionLogic.hapiYoloNativeMode(for: agent)?.label)
    }

    /// Grok probes report whether its `auto` mode works in this directory.
    private var permissionModes: [PermissionMode] {
        let modes = form.agent.permissionModes
        guard form.agent == .grok, loadedAgentModels?.autoPermissionModeSupported == false else { return modes }
        return modes.filter { $0 != .auto }
    }

    /// The discovered-model fetch the form needs now; nil when the flavor
    /// has no catalog, no machine is selected, or a directory-scoped catalog
    /// has no existing directory to probe yet.
    var agentModelsRequest: AgentModelsRequest? {
        guard let scope = AgentModelCatalog.scope(for: form.agent),
              let machineId = selectedMachine?.id else { return nil }
        switch scope {
        case .machine:
            return AgentModelsRequest(flavor: form.agent, machineId: machineId, cwd: nil)
        case .directory:
            let cwd = normalizedDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !cwd.isEmpty, directoryExists == true, !directoryOutsideWorkspaceRoots else { return nil }
            return AgentModelsRequest(flavor: form.agent, machineId: machineId, cwd: cwd)
        }
    }

    var showCollaborationMode: Bool {
        form.agent == .codex
    }

    var showCopilotAgentMode: Bool {
        form.agent == .copilot
    }

    var showFastMode: Bool {
        guard form.agent == .codex, case .loaded(let models) = codexModels else { return false }
        return NewSessionLogic.codexModelAdvertisesFastTier(model: form.model, models: models)
    }

    var worktreeNameError: String? {
        form.sessionType == .worktree
            ? NewSessionLogic.worktreeNameError(form.worktreeName)
            : nil
    }

    /// Armed after the first Create tap on a missing simple directory.
    var confirmCreateDirectory: Bool {
        confirmCreateDirectoryArmed && needsCreationWarning
    }

    var canCreate: Bool {
        selectedMachine != nil
            && !normalizedDirectory.isEmpty
            && !isSpawning
            && !missingWorktreeDirectory
            && !directoryOutsideWorkspaceRoots
            && selectedAgentAvailable
            && worktreeNameError == nil
            && !codexValidationPending
            && !agentModelsValidationPending
    }

    private var selectedMachine: Machine? {
        session.machineStore.machines.first { $0.id == form.machineId && $0.active }
    }

    private var directoryExists: Bool? {
        directoryInput.exists
    }

    private var directoryOutsideWorkspaceRoots: Bool {
        directoryInput.outsideWorkspaceRoots
    }

    private var missingWorktreeDirectory: Bool {
        !directoryOutsideWorkspaceRoots && form.sessionType == .worktree && directoryExists == false
    }

    private var needsCreationWarning: Bool {
        !directoryOutsideWorkspaceRoots && form.sessionType == .simple && directoryExists == false
    }

    private var availableAgentFlavors: [AgentFlavor] {
        guard case .loaded(let entries) = agentAvailability else { return [] }
        return entries.compactMap { entry in
            guard entry.available, AgentFlavor.creatableFlavors.contains(entry.agent) else { return nil }
            return entry.agent
        }
    }

    private var selectedAgentAvailable: Bool {
        availableAgentFlavors.contains(form.agent)
    }

    /// Web `isLaunchPreferenceValidationPending` (codex slice): a restored
    /// codex model/effort must not spawn before the catalog validated it.
    private var codexValidationPending: Bool {
        form.agent == .codex && codexModels == .loading
            && (form.model != "auto"
                || form.modelReasoningEffort != "default"
                || form.serviceTier == .fast)
    }

    /// A restored non-default model/effort must not spawn before the
    /// discovered catalog validated it (web `isLaunchPreferenceValidationPending`).
    private var agentModelsValidationPending: Bool {
        agentModels == .loading
            && (form.model != "auto" || form.effort != "auto" || form.modelReasoningEffort != "default")
    }

    // MARK: - Actions

    func setMachine(_ machineId: String) {
        guard !isSpawning, machineId != form.machineId,
              session.machineStore.machines.contains(where: { $0.id == machineId && $0.active })
        else { return }
        applyMachineSelection(machineId, resetDirectory: true)
    }

    func setDirectory(_ value: String) {
        cancelDefaultDirectoryResolution()
        directoryEdited = true
        suppressSuggestions = false
        confirmCreateDirectoryArmed = false
        form.directory = value
        persistDraft()
        scheduleDirectoryWork()
    }

    func pickSuggestion(_ path: String) {
        pickPath(path)
    }

    func pickRecentPath(_ path: String) {
        pickPath(path)
    }

    func openDirectoryBrowser() {
        guard let machine = selectedMachine else { return }
        directoryBrowser.open(
            machineId: machine.id,
            roots: RemoteDirectoryPath.browseRoots(for: machine),
            initialPath: normalizedDirectory,
            defaultPath: RemoteDirectoryPath.defaultDirectory(for: machine)
        )
    }

    func selectBrowsedDirectory(_ path: String) {
        if !path.isEmpty {
            pickPath(path)
        }
    }

    func setAgent(_ agent: AgentFlavor) {
        guard agent != form.agent else { return }
        // Web parity: switching agents resets every agent-dependent field
        // (yolo is a cross-flavor preference and survives).
        form.agent = agent
        form.model = "auto"
        form.effort = "auto"
        form.modelReasoningEffort = "default"
        form.permissionMode = .default
        form.serviceTier = .standard
        form.collaborationMode = .default
        form.copilotAgentMode = .interactive
        persistDraft()
        refreshCodexModelsIfNeeded()
        refreshAgentModelsIfNeeded()
    }

    func setModel(_ model: String) {
        form.model = model
        if form.agent == .codex {
            form = reconcileCodexSelections(form)
        }
        form = reconcileAgentModelSelections(form)
        persistDraft()
    }

    func setEffort(_ effort: String) {
        form.effort = effort
        persistDraft()
    }

    func setModelReasoningEffort(_ value: String) {
        form.modelReasoningEffort = value
        persistDraft()
    }

    func setPermissionMode(_ mode: PermissionMode) {
        form.permissionMode = mode
        persistDraft()
    }

    func setYolo(_ enabled: Bool) {
        form.yolo = enabled
        persistDraft()
    }

    func setSessionType(_ sessionType: SpawnSessionType) {
        confirmCreateDirectoryArmed = false
        form.sessionType = sessionType
        persistDraft()
    }

    func setWorktreeName(_ name: String) {
        form.worktreeName = name
        persistDraft()
    }

    func setServiceTier(_ tier: ServiceTier) {
        form.serviceTier = tier
        persistDraft()
    }

    func setCollaborationMode(_ mode: CodexCollaborationMode) {
        form.collaborationMode = mode
        persistDraft()
    }

    func setCopilotAgentMode(_ mode: CopilotAgentMode) {
        form.copilotAgentMode = mode
        persistDraft()
    }

    func retryModels() {
        codexFetchedForMachine = nil
        refreshCodexModelsIfNeeded()
        refreshAgentModelsIfNeeded(force: true)
    }

    func retryAgentAvailability() {
        refreshAgentAvailability(force: true)
    }

    /// Spawn. Directory existence is re-checked server-side first (web
    /// `handleCreate`): a missing worktree base is an error; a missing
    /// simple directory arms a second-tap confirmation, after which the hub
    /// creates it. Success persists prefs, clears the draft, and hands the
    /// new session id to `onCreated`; failure lands in the inline error.
    func create() {
        guard canCreate, !spawnInFlight else { return }
        cancelDefaultDirectoryResolution()
        var current = form
        current.directory = normalizedDirectory
        guard let machineId = current.machineId else { return }
        let directory = current.trimmedDirectory
        guard !directory.isEmpty, !spawnInFlight else { return }
        if current.sessionType == .worktree,
           NewSessionLogic.worktreeNameError(current.worktreeName) != nil {
            return
        }
        guard selectedAgentAvailable else {
            spawnError = agentAvailabilityError ?? Self.msgSelectedAgentUnavailable
            return
        }
        spawnInFlight = true
        isSpawning = true
        spawnError = nil
        Task { [weak self, current] in
            defer {
                self?.spawnInFlight = false
                self?.isSpawning = false
            }
            guard let self else { return }
            let api = self.session.api
            do {
                let pathResult = try await api.machinePathsExist(
                    machineId: machineId,
                    paths: [directory]
                )
                let exists = pathResult.exists[directory]
                guard self.selectedMachine?.id == machineId else {
                    self.spawnError = Self.msgMachineOffline
                    return
                }
                self.directoryInput.acceptExistence(pathResult, machineId: machineId, path: directory)
                if pathResult.outsideWorkspaceRoots?.contains(directory) == true {
                    self.spawnError = Self.msgDirectoryOutsideWorkspaceRoots
                    return
                }
                if current.sessionType == .worktree, exists == false {
                    self.spawnError = Self.msgWorktreeMissing
                    return
                }
                if current.sessionType == .simple,
                   exists == false,
                   !self.confirmCreateDirectoryArmed {
                    self.confirmCreateDirectoryArmed = true
                    return
                }

                let request = NewSessionLogic.buildSpawnRequest(
                    form: current,
                    codexFastTierVisible: self.codexFastTierVisible(current)
                )
                switch try await api.spawnSession(machineId: machineId, request) {
                case .success(let sessionId):
                    self.persistOnSuccess(machineId: machineId, directory: directory)
                    self.onCreated(sessionId)
                case .error(let message, let code, _):
                    self.spawnError = Self.spawnErrorMessage(code: code, fallback: message)
                }
            } catch let error as APIError {
                self.spawnError = Self.spawnErrorMessage(
                    code: error.code,
                    fallback: error.errorDescription
                )
            } catch {
                self.spawnError = (error as? LocalizedError)?.errorDescription
                    ?? String(localized: "Failed to create session")
            }
        }
    }

    // MARK: - Internals

    private func pickPath(_ path: String) {
        cancelDefaultDirectoryResolution()
        directoryEdited = true
        suppressSuggestions = true
        confirmCreateDirectoryArmed = false
        form.directory = path
        persistDraft()
        scheduleDirectoryWork()
    }

    private func recentPaths(for machineId: String?) -> [String] {
        machineId.flatMap { prefsData.recentPaths[$0] } ?? []
    }

    private func reconcileMachineSelection() {
        guard form.machineId == nil else { return }
        let machines = session.machineStore.machines.filter(\.active)
        guard !machines.isEmpty else { return }
        let target = machines.first { $0.id == prefsData.lastMachineId } ?? machines[0]
        applyMachineSelection(target.id, resetDirectory: !directoryEdited && form.trimmedDirectory.isEmpty)
    }

    private func applyMachineSelection(_ machineId: String, resetDirectory: Bool) {
        directoryBrowser.close()
        cancelDefaultDirectoryResolution()
        directoryInput.stop()
        confirmCreateDirectoryArmed = false
        // The seeded recent path is a pick, not typing — no dropdown.
        suppressSuggestions = true
        form.machineId = machineId
        form.model = "auto"
        if resetDirectory {
            let machine = session.machineStore.machines.first { $0.id == machineId }
            directoryEdited = false
            form.directory = machine.map(RemoteDirectoryPath.defaultDirectory) ?? ""
        }
        persistDraft()
        if resetDirectory {
            resolveDefaultDirectory(machineId: machineId, fallback: form.directory)
        }
        refreshAgentAvailability(force: true)
        refreshCodexModelsIfNeeded()
        refreshAgentModelsIfNeeded()
        scheduleDirectoryWork()
    }

    private func resolveDefaultDirectory(machineId: String, fallback: String) {
        cancelDefaultDirectoryResolution()
        let editVersion = directoryEditVersion
        let roots = selectedMachine.map(RemoteDirectoryPath.browseRoots)
        let recent = recentPaths(for: machineId)
        guard !recent.isEmpty else { return }
        defaultDirectoryTask = Task { [weak self] in
            guard let self else { return }
            let result: MachinePathsExistsResponse
            do {
                result = try await self.session.api.machinePathsExist(
                    machineId: machineId,
                    paths: recent
                )
            } catch is CancellationError {
                return
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            let outside = Set(result.outsideWorkspaceRoots ?? [])
            guard let valid = recent.first(where: {
                result.exists[$0] == true && !outside.contains($0)
            }) else {
                return
            }
            guard self.selectedMachine?.id == machineId,
                  self.selectedMachine.map(RemoteDirectoryPath.browseRoots) == roots,
                  self.directoryEditVersion == editVersion,
                  self.form.directory == fallback else { return }
            self.suppressSuggestions = true
            self.form.directory = valid
            self.persistDraft()
            self.scheduleDirectoryWork()
        }
    }

    private func scheduleDirectoryWork() {
        directoryInput.update(
            machine: selectedMachine,
            path: form.directory,
            showSuggestions: !suppressSuggestions
        )
    }

    private func refreshAgentAvailability(force: Bool = false) {
        guard let machineId = selectedMachine?.id else {
            availabilityTask?.cancel()
            availabilityFetchedForMachine = nil
            agentAvailability = .loading
            return
        }
        if !force, availabilityFetchedForMachine == machineId {
            return
        }
        availabilityTask?.cancel()
        availabilityFetchedForMachine = machineId
        agentAvailability = .loading
        availabilityTask = Task { [weak self] in
            guard let self else { return }
            let state: AgentAvailabilityState
            do {
                let response = try await self.session.api.machineAgentAvailability(machineId: machineId)
                state = .loaded(response.agents)
            } catch let error as APIError where error.code == "runner_upgrade_required" {
                state = .failed(message: Self.msgRunnerUpgradeRequired, upgradeRequired: true)
            } catch is CancellationError {
                return
            } catch is APIError {
                state = .failed(message: Self.msgAgentAvailabilityFailed, upgradeRequired: false)
            } catch {
                state = .failed(
                    message: (error as? LocalizedError)?.errorDescription
                        ?? Self.msgAgentAvailabilityFailed,
                    upgradeRequired: false
                )
            }
            guard !Task.isCancelled, self.form.machineId == machineId else { return }
            self.agentAvailability = state
            guard case .loaded = state,
                  let firstAvailable = self.availableAgentFlavors.first,
                  !self.availableAgentFlavors.contains(self.form.agent)
            else {
                return
            }
            self.setAgent(firstAvailable)
        }
    }

    private func refreshCodexModelsIfNeeded() {
        guard form.agent == .codex else {
            codexTask?.cancel()
            codexFetchedForMachine = nil
            codexModels = .hidden
            return
        }
        guard let machineId = selectedMachine?.id else {
            codexModels = .hidden
            return
        }
        if codexFetchedForMachine == machineId, codexModels != .hidden {
            return
        }
        codexFetchedForMachine = machineId
        codexTask?.cancel()
        codexModels = .loading
        codexTask = Task { [weak self] in
            guard let self else { return }
            let state: CodexModelsState
            do {
                let response = try await self.session.api.machineCodexModels(machineId: machineId)
                state = response.success
                    ? .loaded(response.models ?? [])
                    : .failed(response.error ?? String(localized: "Failed to load Codex models"))
            } catch let error as APIError where error.code == "rpc_target_missing" {
                state = .unsupported
            } catch is CancellationError {
                return
            } catch {
                state = .failed(
                    (error as? LocalizedError)?.errorDescription
                        ?? String(localized: "Failed to load Codex models")
                )
            }
            guard !Task.isCancelled,
                  self.form.machineId == machineId,
                  self.form.agent == .codex
            else {
                return
            }
            self.codexModels = state
            if case .loaded = state {
                // Reconcile restored selections with the live catalog (web
                // validation effects): unknown model → auto; unsupported
                // effort → default; no fast tier → standard.
                self.form = self.reconcileCodexSelections(self.form)
                self.persistDraft()
            }
        }
    }

    /// Fetches (or reuses) the catalog for ``agentModelsRequest``. The view
    /// calls this whenever the request changes — including when a typed
    /// directory turns out to exist.
    func refreshAgentModelsIfNeeded(force: Bool = false) {
        let request = agentModelsRequest
        guard force || agentModelsFetched != .some(request) else { return }
        agentModelsTask?.cancel()
        agentModelsFetched = .some(request)
        guard let request else {
            agentModels = .hidden
            opencodeVariants = nil
            return
        }
        if !force, let cached = agentModelsCache[request] {
            agentModels = .loaded(cached.response)
            opencodeVariants = cached.variants
            form = reconcileAgentModelSelections(form)
            persistDraft()
            return
        }
        agentModels = .loading
        opencodeVariants = nil
        agentModelsTask = Task { [weak self] in
            guard let self else { return }
            let api = self.session.api
            let state: AgentModelsState
            var variants: [String: [String]]?
            do {
                let response = try await api.machineAgentModels(
                    machineId: request.machineId,
                    flavor: request.flavor,
                    cwd: request.cwd
                )
                // agy pairs `success` with an error for a stale catalog.
                state = response.success
                    ? .loaded(response)
                    : .failed(response.error ?? String(localized: "Failed to load models"))
                if request.flavor == .opencode, response.success, let cwd = request.cwd,
                   let answer = try? await api.machineOpencodeModelVariants(machineId: request.machineId, cwd: cwd),
                   answer.success {
                    variants = answer.variants
                }
            } catch let error as APIError where error.code == "rpc_target_missing" {
                state = .unsupported
            } catch is CancellationError {
                return
            } catch {
                state = .failed(
                    (error as? LocalizedError)?.errorDescription ?? String(localized: "Failed to load models")
                )
            }
            guard !Task.isCancelled, self.agentModelsFetched == .some(.some(request)) else { return }
            self.agentModels = state
            self.opencodeVariants = variants
            if case .loaded(let response) = state {
                self.agentModelsCache[request] = CachedAgentModels(response: response, variants: variants)
                self.form = self.reconcileAgentModelSelections(self.form)
                self.persistDraft()
            }
        }
    }

    private func reconcileAgentModelSelections(_ current: NewSessionForm) -> NewSessionForm {
        guard let response = loadedAgentModels else { return current }
        var next = NewSessionLogic.reconcileAgentModelSelections(current, response: response, variants: opencodeVariants)
        if next.agent == .grok, next.permissionMode == .auto, !permissionModes.contains(.auto) {
            next.permissionMode = .default
        }
        return next
    }

    private func reconcileCodexSelections(_ current: NewSessionForm) -> NewSessionForm {
        guard case .loaded(let models) = codexModels else { return current }
        var next = current
        if next.model != "auto", !models.contains(where: { $0.id == next.model }) {
            next.model = "auto"
        }
        if next.modelReasoningEffort != "default",
           let supported = NewSessionLogic.codexReasoningEfforts(models: models, model: next.model),
           !supported.contains(next.modelReasoningEffort) {
            next.modelReasoningEffort = "default"
        }
        if next.serviceTier != .standard,
           !NewSessionLogic.codexModelAdvertisesFastTier(model: next.model, models: models) {
            next.serviceTier = .standard
        }
        return next
    }

    private func codexFastTierVisible(_ current: NewSessionForm) -> Bool {
        guard current.agent == .codex, case .loaded(let models) = codexModels else { return false }
        return NewSessionLogic.codexModelAdvertisesFastTier(model: current.model, models: models)
    }

    private func persistDraft() {
        prefsStore.writeDraft(form)
    }

    private func persistOnSuccess(machineId: String, directory: String) {
        prefsData.lastMachineId = machineId
        prefsData.recentPaths[machineId] = NewSessionLogic.pushRecent(
            prefsData.recentPaths[machineId] ?? [],
            path: directory
        )
        prefsStore.writePrefs(prefsData)
        prefsStore.clearDraft()
    }

    private static func spawnErrorMessage(code: String?, fallback: String?) -> String {
        switch code {
        case "runner_upgrade_required":
            return msgRunnerUpgradeRequired
        case "agent_unavailable":
            return msgSelectedAgentUnavailable
        case "outside_workspace_roots":
            return msgDirectoryOutsideWorkspaceRoots
        default:
            let trimmed = fallback?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? String(localized: "Failed to create session") : trimmed
        }
    }

    // MARK: - Formatting (Android `NewSessionViewModel` companion ports)

    /// `getMachineOptionLabel` (web `MachineSelector`), minus capability-skew
    /// (TODO with the machine detail screen).
    static func machineOption(_ machine: Machine) -> MachineOptionUI {
        let metadata = machine.metadata
        let title = metadata?.displayName.flatMap { name in
            name.trimmingCharacters(in: .whitespaces).isEmpty ? nil : name
        }
            ?? metadata?.host
            ?? String(machine.id.prefix(8))
        let platform = metadata.map { " (\($0.platform))" } ?? ""
        let version = metadata.map { " · CLI \($0.happyCliVersion)" } ?? ""
        let healthParts: [String] = [
            machine.health?.cpuPercent.map { "CPU \(Int($0))%" },
            machine.health?.memoryPercent.map { "Mem \(Int($0))%" },
        ].compactMap { $0 }
        return MachineOptionUI(
            id: machine.id,
            label: "\(title)\(platform)\(version)",
            healthLabel: healthParts.isEmpty ? nil : healthParts.joined(separator: " · ")
        )
    }

    /// `formatRunnerSpawnError` (`web/src/utils/formatRunnerSpawnError.ts`).
    static func formatRunnerSpawnError(_ machine: Machine?) -> String? {
        guard case .object(let error)? = machine?.runnerState?.lastSpawnError else { return nil }
        guard case .string(let message)? = error["message"], !message.isEmpty else { return nil }
        if case .number(let at)? = error["at"] {
            let date = Date(timeIntervalSince1970: at / 1000)
            return "\(message) (\(date.formatted(date: .abbreviated, time: .shortened)))"
        }
        return message
    }
}
