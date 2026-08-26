import Foundation

// Port of web/src/chat/reducerTools.ts.
//
// The TS reducer mutates block objects shared by reference between the
// timeline array and the by-id map. `BlockBox` reproduces that: a reference
// wrapper around the value-typed `ChatBlock`, mutated in place through the
// settable case accessors (`box.block.asToolCall?.tool.state = …`).

/// Reference cell for one timeline block during reduction. The final
/// pipeline output materializes back to plain `[ChatBlock]`.
final class BlockBox {
    var block: ChatBlock

    init(_ block: ChatBlock) {
        self.block = block
    }
}

extension Array where Element == BlockBox {
    var materialized: [ChatBlock] {
        map(\.block)
    }
}

/// Port of `PermissionEntry`.
struct PermissionEntry {
    var toolName: String
    /// `nil` == the request carried no arguments (TS `undefined`).
    var input: JSONValue?
    var permission: ToolPermission
}

/// Ordered stand-in for the TS `Map<string, PermissionEntry>`.
///
/// The reference iterates JS object keys in insertion order; fixture inputs
/// are canonically serialized (recursively sorted keys) and `JSON.parse`
/// preserves that order, so the order the reference actually observes when
/// replaying fixtures is ascending key order — which is what this map
/// imposes deterministically (completed requests first, then pending,
/// each sorted by request id).
struct PermissionMap {
    private(set) var order: [String] = []
    private(set) var byId: [String: PermissionEntry] = [:]

    subscript(id: String) -> PermissionEntry? {
        byId[id]
    }

    func has(_ id: String) -> Bool {
        byId[id] != nil
    }

    mutating func set(_ id: String, _ entry: PermissionEntry) {
        if byId[id] == nil { order.append(id) }
        byId[id] = entry
    }

    var entriesInOrder: [(id: String, entry: PermissionEntry)] {
        order.map { ($0, byId[$0]!) }
    }
}

/// Port of `getPermissions` — completed requests first (they win the id),
/// then pending requests.
func getPermissions(_ agentState: AgentState?) -> PermissionMap {
    var map = PermissionMap()

    if let completed = agentState?.completedRequests {
        for id in completed.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }) {
            let entry = completed[id]!
            let status: ToolPermissionStatus = {
                switch entry.status {
                case .canceled: return .canceled
                case .denied: return .denied
                case .approved: return .approved
                }
            }()
            map.set(id, PermissionEntry(
                toolName: entry.tool,
                input: entry.arguments,
                permission: ToolPermission(
                    id: id,
                    status: status,
                    reason: entry.reason,
                    mode: entry.mode,
                    allowedTools: entry.allowTools,
                    decision: entry.decision,
                    answers: entry.answers,
                    createdAt: entry.createdAt,
                    completedAt: entry.completedAt,
                    // Keys the TS object literal carries (spread overwrites
                    // these on merge even when the value is undefined);
                    // `date` is absent from this construction site.
                    presentKeys: [.reason, .mode, .decision, .allowedTools, .answers, .createdAt, .completedAt]
                )
            ))
        }
    }

    if let requests = agentState?.requests {
        for id in requests.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }) {
            if map.has(id) { continue }
            let request = requests[id]!
            map.set(id, PermissionEntry(
                toolName: request.tool,
                input: request.arguments,
                permission: ToolPermission(
                    id: id,
                    status: .pending,
                    createdAt: request.createdAt,
                    presentKeys: [.createdAt]
                )
            ))
        }
    }

    return map
}

/// Seed for `ensureToolBlock` — mirrors the TS parameter object. Optional
/// fields left `nil` reproduce an absent/`undefined` TS property.
struct ToolBlockSeed {
    var createdAt: Int
    var invokedAt: Int?
    var durationMs: Int?
    var usage: UsageData?
    var model: String?
    var localId: String?
    var meta: JSONValue?
    var name: String
    var input: JSONValue?
    var description: String?
    var nativeTitle: String?
    var nativeKind: String?
    var progress: JSONValue?
    var permission: ToolPermission?
    var agentTimestamp: Int?

    init(
        createdAt: Int,
        invokedAt: Int? = nil,
        durationMs: Int? = nil,
        usage: UsageData? = nil,
        model: String? = nil,
        localId: String? = nil,
        meta: JSONValue? = nil,
        name: String,
        input: JSONValue? = nil,
        description: String? = nil,
        nativeTitle: String? = nil,
        nativeKind: String? = nil,
        progress: JSONValue? = nil,
        permission: ToolPermission? = nil,
        agentTimestamp: Int? = nil
    ) {
        self.createdAt = createdAt
        self.invokedAt = invokedAt
        self.durationMs = durationMs
        self.usage = usage
        self.model = model
        self.localId = localId
        self.meta = meta
        self.name = name
        self.input = input
        self.description = description
        self.nativeTitle = nativeTitle
        self.nativeKind = nativeKind
        self.progress = progress
        self.permission = permission
        self.agentTimestamp = agentTimestamp
    }
}

private func isPlaceholderToolName(_ name: String) -> Bool {
    let normalized = name.jsTrimmed.lowercased()
    // 'generic' is agy's non-specific result wrapper — never let it
    // overwrite a specific name set by the permission request.
    return normalized.isEmpty || normalized == "tool" || normalized == "unknown" || normalized == "generic"
}

/// Port of `ensureToolBlock`: create-or-merge the tool card for `id`.
/// Mutates the shared box in place; appends a new box to `blocks` (and the
/// map) when the id is unseen.
@discardableResult
func ensureToolBlock(
    _ blocks: inout [BlockBox],
    _ toolBlocksById: inout [String: BlockBox],
    id: String,
    seed: ToolBlockSeed
) -> BlockBox {
    if let existingBox = toolBlocksById[id], var existing = existingBox.block.asToolCall {
        // Preserve earliest createdAt for stable ordering.
        if seed.createdAt < existing.createdAt {
            existing.createdAt = seed.createdAt
            existing.tool.createdAt = seed.createdAt
        }
        if let seedPermission = seed.permission {
            let nextPermission = ToolPermission.spreading(existing.tool.permission, with: seedPermission)
            var nextState = existing.tool.state
            if existing.tool.state == .running && seedPermission.status == .pending {
                nextState = .pending
            }
            existing.tool.permission = nextPermission
            existing.tool.state = nextState
        }
        if !seed.name.isEmpty && (!isPlaceholderToolName(seed.name) || isPlaceholderToolName(existing.tool.name)) {
            existing.tool.name = seed.name
        }
        if let input = seed.input, input != .null {
            existing.tool.input = input
        }
        if let description = seed.description {
            existing.tool.description = description
        }
        if let nativeTitle = seed.nativeTitle {
            existing.tool.nativeTitle = nativeTitle
        }
        if let nativeKind = seed.nativeKind {
            existing.tool.nativeKind = nativeKind
        }
        if let progress = seed.progress, existing.tool.state == .running {
            existing.tool.result = progress
        }
        // The tool_use records when the tool was invoked; a later
        // tool_result must not overwrite it.
        if let invokedAt = seed.invokedAt, existing.invokedAt == nil {
            existing.invokedAt = invokedAt
        }
        if let durationMs = seed.durationMs {
            existing.durationMs = durationMs
        }
        if let usage = seed.usage {
            existing.usage = usage
        }
        if let model = seed.model {
            existing.model = model
        }
        existingBox.block = .toolCall(existing)
        return existingBox
    }

    let initialState: ToolCallState = {
        if seed.permission?.status == .pending { return .pending }
        if seed.permission?.status == .denied || seed.permission?.status == .canceled { return .error }
        return .running
    }()

    let tool = ChatToolCall(
        id: id,
        name: seed.name,
        state: initialState,
        input: seed.input,
        createdAt: seed.createdAt,
        startedAt: initialState == .running ? seed.createdAt : nil,
        completedAt: nil,
        // Exec start is only ever a real Claude entry timestamp (never the
        // hub receive time); nil keeps the hub-time fallback.
        execStartedAt: initialState == .running ? seed.agentTimestamp : nil,
        execCompletedAt: nil,
        description: seed.description,
        nativeTitle: seed.nativeTitle,
        nativeKind: seed.nativeKind,
        result: seed.progress,
        permission: seed.permission
    )

    let block = ToolCallBlock(
        id: id,
        localId: seed.localId,
        createdAt: seed.createdAt,
        invokedAt: seed.invokedAt,
        durationMs: seed.durationMs,
        usage: seed.usage,
        model: seed.model,
        tool: tool,
        children: [],
        meta: seed.meta
    )

    let box = BlockBox(.toolCall(block))
    toolBlocksById[id] = box
    blocks.append(box)
    return box
}

/// Port of `collectToolIdsFromMessages`.
func collectToolIdsFromMessages(_ messages: [NormalizedMessage]) -> Set<String> {
    var ids = Set<String>()
    for msg in messages {
        guard let content = msg.agentContent else { continue }
        for item in content {
            switch item {
            case .toolCall(let toolCall):
                ids.insert(toolCall.id)
            case .toolResult(let toolResult):
                ids.insert(toolResult.toolUseId)
            default:
                break
            }
        }
    }
    return ids
}

/// Port of `isChangeTitleToolName`.
func isChangeTitleToolName(_ name: String) -> Bool {
    name == "mcp__hapi__change_title" || name == "hapi__change_title"
}

/// Port of `extractTitleFromChangeTitleInput`.
func extractTitleFromChangeTitleInput(_ input: JSONValue?) -> String? {
    guard let title = input?.objectValue?["title"]?.stringValue else { return nil }
    let trimmed = title.jsTrimmed
    return trimmed.isEmpty ? nil : trimmed
}

/// Port of `collectTitleChanges` — tool_use id → requested title.
func collectTitleChanges(_ messages: [NormalizedMessage]) -> [String: String] {
    var map: [String: String] = [:]
    for msg in messages {
        guard let content = msg.agentContent else { continue }
        for item in content {
            guard case .toolCall(let toolCall) = item else { continue }
            guard isChangeTitleToolName(toolCall.name) else { continue }
            guard let title = extractTitleFromChangeTitleInput(toolCall.input) else { continue }
            map[toolCall.id] = title
        }
    }
    return map
}
