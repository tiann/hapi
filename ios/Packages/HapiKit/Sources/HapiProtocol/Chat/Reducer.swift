import Foundation

// Port of web/src/chat/reducer.ts — the pipeline entry point:
// trace → timeline → pending-permission synthesis → latestUsage →
// api-error fold → dedupe → silent-goal filtering.

/// Port of `calculateContextSize`.
private func calculateContextSize(_ usage: UsageData) -> Double {
    if let contextTokens = usage.contextTokens {
        return contextTokens
    }
    return (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) + usage.inputTokens
}

/// Port of `isUsageVisibleInParentContext` — subagent usage must not drive
/// the parent thread's context bar.
private func isUsageVisibleInParentContext(_ msg: NormalizedMessage) -> Bool {
    if msg.isSidechain { return false }
    return msg.usage?.scopeRole != "child"
}

private let goalCommandRegex = JSRegex("\\A\\s*/goal(?:\\s|\\z)", caseInsensitive: true)

/// Port of `getLatestThreadGoal`. Returns the normalized goal record
/// (advisory; not part of the fixture projection).
func getLatestThreadGoal(_ normalized: [NormalizedMessage]) -> JSONValue? {
    var sawNewerNonGoalUserMessage = false
    for msg in normalized.reversed() {
        if case .user(let text, _) = msg.content {
            if !goalCommandRegex.test(text) {
                sawNewerNonGoalUserMessage = true
            }
            continue
        }
        guard let event = msg.eventContent else { continue }
        if event.type == "thread-goal-cleared" { return nil }
        if event.type == "thread-goal-updated" {
            let goal = event["goal"]
            if goal?["status"] == .string("complete") && sawNewerNonGoalUserMessage {
                return nil
            }
            return goal
        }
    }
    return nil
}

/// Port of `isRedundantGoalStatusMessage`.
private func isRedundantGoalStatusMessage(_ event: AgentEvent) -> Bool {
    guard event.type == "message" else { return false }
    return isRedundantGoalStatusMessageText(event["message"]?.stringValue)
}

/// Port of `isSilentGoalEventBlock`.
private func isSilentGoalEventBlock(_ block: ChatBlock) -> Bool {
    guard case .agentEvent(let eventBlock) = block else { return false }
    return eventBlock.event.type == "thread-goal-updated"
        || eventBlock.event.type == "thread-goal-cleared"
        || isRedundantGoalStatusMessage(eventBlock.event)
}

/// Port of `filterSilentGoalBlocks` — recursive over tool children.
func filterSilentGoalBlocks(_ blocks: [ChatBlock]) -> [ChatBlock] {
    var filtered: [ChatBlock] = []

    for block in blocks {
        if isSilentGoalEventBlock(block) { continue }
        if case .toolCall(var toolBlock) = block, !toolBlock.children.isEmpty {
            toolBlock.children = filterSilentGoalBlocks(toolBlock.children)
            filtered.append(.toolCall(toolBlock))
            continue
        }
        filtered.append(block)
    }

    return filtered
}

/// Result of `reduceChatBlocks`.
public struct ReducedChat: Equatable, Sendable {
    public var blocks: [ChatBlock]
    public var hasReadyEvent: Bool
    public var latestUsage: LatestUsage?
    /// The latest thread goal record (advisory, dropped by the projection).
    public var latestGoal: JSONValue?
}

/// Port of `reduceChatBlocks`.
public func reduceChatBlocks(
    _ normalized: [NormalizedMessage],
    agentState: AgentState?,
    goalStateMessages: [NormalizedMessage]? = nil
) -> ReducedChat {
    let permissionsById = getPermissions(agentState)
    let toolIdsInMessages = collectToolIdsFromMessages(normalized)
    let titleChangesByToolUseId = collectTitleChanges(normalized)

    let traced = traceMessages(normalized)
    var groups: [String: [NormalizedMessage]] = [:]
    var root: [NormalizedMessage] = []

    for msg in traced {
        if let sidechainId = msg.sidechainId {
            groups[sidechainId, default: []].append(msg)
        } else {
            root.append(msg)
        }
    }

    let reducerContext = ReducerContext(
        permissionsById: permissionsById,
        groups: groups,
        consumedGroupIds: [],
        titleChangesByToolUseId: titleChangesByToolUseId,
        emittedTitleChangeToolUseIds: []
    )
    var rootResult = reduceTimeline(root, context: reducerContext)
    let hasReadyEvent = rootResult.hasReadyEvent

    // Synthesize a tool card only for a *pending* permission that has no
    // tool call/result in the transcript, and only when it is not older than
    // the oldest message in the current window (older ones surface when the
    // user pages back).
    let oldestMessageTime: Int? = normalized.map(\.createdAt).min()

    for (id, entry) in permissionsById.entriesInOrder {
        if entry.permission.status != .pending { continue }
        if toolIdsInMessages.contains(id) { continue }
        if rootResult.toolBlocksById[id] != nil { continue }

        let createdAt = entry.permission.createdAt
            ?? Int(Date().timeIntervalSince1970 * 1000)

        if let oldestMessageTime, createdAt < oldestMessageTime {
            continue
        }

        ensureToolBlock(&rootResult.blocks, &rootResult.toolBlocksById, id: id, seed: ToolBlockSeed(
            createdAt: createdAt,
            localId: nil,
            name: entry.toolName,
            input: entry.input,
            description: nil,
            permission: entry.permission
        ))
    }

    // Latest usage: the most recent parent-context message with usage data.
    var latestUsage: LatestUsage?
    for msg in normalized.reversed() {
        if let usage = msg.usage, isUsageVisibleInParentContext(msg) {
            latestUsage = LatestUsage(
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheCreation: usage.cacheCreationInputTokens ?? 0,
                cacheRead: usage.cacheReadInputTokens ?? 0,
                contextSize: calculateContextSize(usage),
                contextWindow: usage.contextWindow,
                model: msg.model,
                timestamp: msg.createdAt
            )
            break
        }
    }

    let materialized = rootResult.blocks.materialized

    return ReducedChat(
        blocks: filterSilentGoalBlocks(dedupeAgentEvents(foldApiErrorEvents(materialized))),
        hasReadyEvent: hasReadyEvent,
        latestUsage: latestUsage,
        latestGoal: getLatestThreadGoal(goalStateMessages ?? normalized)
    )
}
