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
    /// Native permission-mode picker (grok + codex-family).
    case nativeSelect([PermissionModeOption])
    /// HAPI YOLO toggle (claude/agy/cursor) with the native mode it maps to.
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

/// Installed/static-configured Agent catalog for the selected machine.
enum AgentAvailabilityState: Equatable {
    case loading
    case loaded([AgentAvailabilityEntry])
    case failed(message: String, upgradeRequired: Bool)
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
/// v1 notes (deliberate cuts, mirrored from the Android/web option matrix):
/// - model pickers: claude (static presets) + codex (machine catalog; hidden
///   when the runner lacks the RPC). agy/opencode/grok/copilot/cursor/pi
///   model discovery is TODO — spawn omits `model` so the agent default
///   applies.
/// - effort: claude static levels; codex reasoning effort from the catalog.
/// - `startingMode` stays unset → the runner spawns `'remote'` (pty deferred).
@MainActor @Observable
final class NewSessionModel {
    static let debounce: Duration = .milliseconds(250)

    static let msgWorktreeMissing =
        String(localized: "Worktree sessions require an existing repository directory.")
    static let msgDirectoryMissing =
        String(localized: "Directory does not exist. Creating the session will create it automatically.")
    static let msgDirectoryMissingConfirm =
        String(localized: "Directory does not exist. Tap Create again to create it automatically.")
    static let msgDirectoryOutsideWorkspaceRoots =
        String(localized: "Directory must be inside one of this machine's workspace roots.")
    static let msgDirectoryLookupFailed = String(localized: "Failed to browse directories")
    static let msgAgentAvailabilityFailed = String(localized: "Failed to check installed Agents")
    static let msgRunnerUpgradeRequired =
        String(localized: "Upgrade and restart this machine's HAPI runner before creating sessions.")
    static let msgNoAvailableAgents =
        String(localized: "No supported Agents are installed on this machine.")
    static let msgSelectedAgentUnavailable =
        String(localized: "The selected Agent is not available on this machine.")

    // MARK: Observable state

    private(set) var form = NewSessionForm()
    private(set) var suggestions: [String] = []
    private(set) var codexModels: CodexModelsState = .hidden
    private(set) var agentAvailability: AgentAvailabilityState = .loading
    private(set) var isSpawning = false
    private(set) var spawnError: String?
    private(set) var confirmCreateDirectoryArmed = false
    private(set) var machinesSettled = false
    /// Probed existence per trimmed path (feeds the directory status hint).
    private(set) var pathExistence: [String: Bool] = [:]
    private(set) var outsideWorkspaceRoots: Set<String> = []
    private(set) var directoryLookupError: String?
    private(set) var prefsData = NewSessionPrefsData()
    let directoryBrowser: RemoteDirectoryBrowserModel

    // MARK: Wiring

    private let session: HubSession
    private let prefsStore: NewSessionPrefsStore
    /// Fired once with the new session id — navigate-replace to the chat.
    private let onCreated: @MainActor (String) -> Void

    @ObservationIgnored private var directoryTask: Task<Void, Never>?
    @ObservationIgnored private var codexTask: Task<Void, Never>?
    @ObservationIgnored private var availabilityTask: Task<Void, Never>?
    @ObservationIgnored private var defaultDirectoryTask: Task<Void, Never>?
    @ObservationIgnored private var codexFetchedForMachine: String?
    @ObservationIgnored private var availabilityFetchedForMachine: String?
    @ObservationIgnored private var suppressSuggestions = false
    @ObservationIgnored private var spawnInFlight = false
    @ObservationIgnored private var directoryRequestVersion = 0
    /// Parent-listing cache: retyping within the same parent re-filters
    /// locally instead of re-requesting.
    @ObservationIgnored private var cachedListing:
        (machineId: String, parent: String, entries: [MachineDirectoryEntry])?

    init(session: HubSession, onCreated: @escaping @MainActor (String) -> Void) {
        self.session = session
        self.prefsStore = NewSessionPrefsStore(hubUrl: session.hubUrl)
        self.onCreated = onCreated
        self.directoryBrowser = RemoteDirectoryBrowserModel(
            requester: session.api,
            fallbackError: Self.msgDirectoryLookupFailed
        )
    }

    // MARK: - Lifecycle (paired with the sheet's `.task`)

    /// Restore prefs + sanitized draft, preselect a machine, refresh the
    /// roster. Call once per presentation.
    func start() async {
        prefsData = prefsStore.readPrefs()
        let initial = prefsStore.readDraft().map(NewSessionLogic.sanitizeDraft) ?? NewSessionForm()
        form = initial
        reconcileMachineSelection()
        refreshAgentAvailability()
        refreshCodexModelsIfNeeded()
        // A restored directory should probe existence but not pop the
        // autocomplete dropdown — suggestions belong to typing.
        suppressSuggestions = true
        scheduleDirectoryWork()

        do {
            try await session.machineStore.refresh()
        } catch {
            // Snapshot (if any) keeps serving; the picker shows what it has.
        }
        machinesSettled = true
        reconcileMachineSelection()
    }

    /// Machine roster changed (SSE / refresh) — re-run the preselection:
    /// keep a still-online selection; otherwise last-used, else first.
    func machinesChanged() {
        reconcileMachineSelection()
    }

    // MARK: - Derived state

    var machines: [MachineOptionUI] {
        session.machineStore.machines.map(Self.machineOption)
    }

    var machinesLoading: Bool {
        session.machineStore.machines.isEmpty && !machinesSettled
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
        if let directoryLookupError {
            return DirectoryStatusUI(message: directoryLookupError, isError: true)
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

    /// Nil hides the model picker (v1: only claude + supported codex).
    var modelOptions: [NewSessionOption]? {
        switch (form.agent, codexModels) {
        case (.claude, _):
            return NewSessionCatalogs.claudeModels
        case (.codex, .loaded(let models)):
            return [NewSessionOption(value: "auto", label: "Default")]
                + models.map { NewSessionOption(value: $0.id, label: $0.displayName) }
        case (.codex, .loading), (.codex, .failed):
            return [NewSessionOption(value: "auto", label: "Default")]
        default:
            // codex `.unsupported` (old runner) and every other flavor: hidden.
            return nil
        }
    }

    var modelsLoading: Bool {
        form.agent == .codex && codexModels == .loading
    }

    var modelsError: String? {
        if case .failed(let message) = codexModels {
            return String(format: String(localized: "Failed to load models: %@"), message)
        }
        return nil
    }

    /// Claude launch-effort options; nil hides the field.
    var effortOptions: [NewSessionOption]? {
        form.agent == .claude ? NewSessionCatalogs.claudeEfforts : nil
    }

    /// Codex reasoning-effort options; nil hides the field.
    var reasoningEffortOptions: [NewSessionOption]? {
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
        if agent == .pi || agent == .dsh {
            return .managed
        }
        if NewSessionLogic.usesNativePermissionSelect(agent) {
            return .nativeSelect(agent.permissionModes.map { PermissionModeOption(mode: $0) })
        }
        return .yoloToggle(nativeModeLabel: NewSessionLogic.hapiYoloNativeMode(for: agent)?.label)
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
        form.machineId != nil
            && !form.trimmedDirectory.isEmpty
            && !isSpawning
            && !missingWorktreeDirectory
            && !directoryOutsideWorkspaceRoots
            && selectedAgentAvailable
            && worktreeNameError == nil
            && !codexValidationPending
    }

    private var selectedMachine: Machine? {
        session.machineStore.machines.first { $0.id == form.machineId }
    }

    private var directoryExists: Bool? {
        let trimmed = form.trimmedDirectory
        guard !trimmed.isEmpty else { return nil }
        return pathExistence[trimmed]
    }

    private var directoryOutsideWorkspaceRoots: Bool {
        let trimmed = form.trimmedDirectory
        return !trimmed.isEmpty && outsideWorkspaceRoots.contains(trimmed)
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

    // MARK: - Actions

    func setMachine(_ machineId: String) {
        guard machineId != form.machineId else { return }
        applyMachineSelection(machineId, resetDirectory: true)
    }

    func setDirectory(_ value: String) {
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
            initialPath: form.trimmedDirectory
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
    }

    func setModel(_ model: String) {
        form.model = model
        if form.agent == .codex {
            form = reconcileCodexSelections(form)
        }
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

    func retryCodexModels() {
        codexFetchedForMachine = nil
        refreshCodexModelsIfNeeded()
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
        let current = form
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
        Task { [weak self] in
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
                if let exists {
                    self.pathExistence[directory] = exists
                }
                self.outsideWorkspaceRoots.remove(directory)
                self.outsideWorkspaceRoots.formUnion(pathResult.outsideWorkspaceRoots ?? [])
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
        suppressSuggestions = true
        confirmCreateDirectoryArmed = false
        suggestions = []
        form.directory = path
        persistDraft()
        scheduleDirectoryWork()
    }

    private func recentPaths(for machineId: String?) -> [String] {
        machineId.flatMap { prefsData.recentPaths[$0] } ?? []
    }

    private func reconcileMachineSelection() {
        let machines = session.machineStore.machines
        guard !machines.isEmpty else { return }
        if let current = form.machineId, machines.contains(where: { $0.id == current }) {
            if form.trimmedDirectory.isEmpty {
                applyMachineSelection(current, resetDirectory: true)
            }
            return
        }
        let target = machines.first { $0.id == prefsData.lastMachineId } ?? machines[0]
        applyMachineSelection(target.id, resetDirectory: form.trimmedDirectory.isEmpty)
    }

    private func applyMachineSelection(_ machineId: String, resetDirectory: Bool) {
        directoryBrowser.close()
        defaultDirectoryTask?.cancel()
        pathExistence = [:]
        outsideWorkspaceRoots = []
        directoryLookupError = nil
        suggestions = []
        cachedListing = nil
        confirmCreateDirectoryArmed = false
        // The seeded recent path is a pick, not typing — no dropdown.
        suppressSuggestions = true
        form.machineId = machineId
        form.model = "auto"
        if resetDirectory {
            let machine = session.machineStore.machines.first { $0.id == machineId }
            form.directory = machine.flatMap { RemoteDirectoryPath.browseRoots(for: $0).first } ?? ""
        }
        persistDraft()
        if resetDirectory {
            resolveDefaultDirectory(machineId: machineId, fallback: form.directory)
        }
        refreshAgentAvailability(force: true)
        refreshCodexModelsIfNeeded()
        scheduleDirectoryWork()
    }

    private func resolveDefaultDirectory(machineId: String, fallback: String) {
        defaultDirectoryTask?.cancel()
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
            guard self.form.machineId == machineId, self.form.directory == fallback else { return }
            self.suppressSuggestions = true
            self.form.directory = valid
            self.persistDraft()
            self.scheduleDirectoryWork()
        }
    }

    /// Debounced directory work: parent listing for autocomplete + exists
    /// probe, both riding one 250 ms debounce like the Android reference.
    private func scheduleDirectoryWork() {
        directoryTask?.cancel()
        directoryRequestVersion += 1
        let requestVersion = directoryRequestVersion
        guard let machineId = form.machineId else {
            suggestions = []
            return
        }
        directoryTask = Task { [weak self] in
            try? await Task.sleep(for: Self.debounce)
            guard !Task.isCancelled, let self else { return }
            guard self.directoryRequestVersion == requestVersion,
                  self.form.machineId == machineId
            else {
                return
            }
            await self.performDirectoryWork(machineId: machineId, requestVersion: requestVersion)
        }
    }

    private func performDirectoryWork(machineId: String, requestVersion: Int) async {
        let text = form.directory
        let trimmed = form.trimmedDirectory
        let api = session.api

        let query = suppressSuggestions ? nil : NewSessionLogic.parentQuery(for: text)
        if let query {
            let cacheKey = (machineId, query.parent)
            let entries: [MachineDirectoryEntry]
            if let cached = cachedListing, (cached.machineId, cached.parent) == cacheKey {
                entries = cached.entries
                directoryLookupError = nil
            } else {
                do {
                    let response = try await api.listMachineDirectory(
                        machineId: machineId,
                        path: query.parent
                    )
                    guard isCurrentDirectoryRequest(requestVersion, machineId: machineId) else { return }
                    if response.success {
                        entries = response.entries ?? []
                        cachedListing = (machineId, query.parent, entries)
                        directoryLookupError = nil
                    } else {
                        entries = []
                        directoryLookupError = response.error ?? Self.msgDirectoryLookupFailed
                    }
                } catch is CancellationError {
                    return
                } catch {
                    guard isCurrentDirectoryRequest(requestVersion, machineId: machineId) else { return }
                    directoryLookupError = (error as? LocalizedError)?.errorDescription
                        ?? Self.msgDirectoryLookupFailed
                    entries = []
                }
            }
            guard isCurrentDirectoryRequest(requestVersion, machineId: machineId) else { return }
            // Never suggest the path already typed verbatim.
            suggestions = NewSessionLogic.buildSuggestions(query: query, entries: entries)
                .filter { $0 != trimmed }
        } else {
            suggestions = []
            directoryLookupError = nil
        }

        if !trimmed.isEmpty {
            // Unknown existence (request failed): no status hint, the spawn
            // re-checks anyway.
            do {
                let result = try await api.machinePathsExist(machineId: machineId, paths: [trimmed])
                guard isCurrentDirectoryRequest(requestVersion, machineId: machineId) else { return }
                pathExistence.merge(result.exists) { _, new in new }
                outsideWorkspaceRoots.remove(trimmed)
                outsideWorkspaceRoots.formUnion(result.outsideWorkspaceRoots ?? [])
            } catch is CancellationError {
                return
            } catch {
                // Unknown existence: no status hint, spawn re-checks anyway.
            }
        }
    }

    private func isCurrentDirectoryRequest(_ requestVersion: Int, machineId: String) -> Bool {
        !Task.isCancelled
            && directoryRequestVersion == requestVersion
            && form.machineId == machineId
    }

    private func refreshAgentAvailability(force: Bool = false) {
        guard let machineId = form.machineId else {
            availabilityTask?.cancel()
            availabilityFetchedForMachine = nil
            agentAvailability = .loading
            return
        }
        if !force,
           availabilityFetchedForMachine == machineId,
           agentAvailability != .loading {
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
        guard let machineId = form.machineId else {
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
