import Foundation

// Port of web/src/chat/reducerTimeline.ts — the timeline reducer: tool
// pairing, stream coalescing, agent-run cards, title-changed synthesis,
// sentinel suppression.

// MARK: - Event record helpers

private func getEventString(_ event: [String: JSONValue], _ key: String) -> String? {
    asString(event[key])
}

private func getEventNumber(_ event: [String: JSONValue], _ key: String) -> Double? {
    asNumber(event[key])
}

private func getAgentRunStartedAt(_ event: [String: JSONValue]) -> Int? {
    (getEventNumber(event, "startedAt") ?? getEventNumber(event, "started_at")).map { Int($0.rounded()) }
}

private func getAgentRunCompletedAt(_ event: [String: JSONValue]) -> Int? {
    (getEventNumber(event, "completedAt") ?? getEventNumber(event, "completed_at")).map { Int($0.rounded()) }
}

private func getAgentRunCardId(_ event: [String: JSONValue], fallback: String) -> String {
    getEventString(event, "cardId") ?? getEventString(event, "card_id") ?? fallback
}

private func isFallbackAgentRunCardId(_ cardId: String, agentId: String?) -> Bool {
    guard let agentId else { return false }
    return cardId == "codex-agent:\(agentId)"
}

private func mapAgentRunStatusToToolState(_ status: String?) -> ToolCallState {
    if status == "completed" { return .completed }
    if status == "failed" || status == "error" || status == "canceled" || status == "cancelled"
        || status == "notFound" || status == "not_found" {
        return .error
    }
    if status == "pending" { return .pending }
    return .running
}

private func isTerminalAgentRunState(_ state: ToolCallState) -> Bool {
    state == .completed || state == .error
}

private func isNonTerminalAgentRunState(_ state: ToolCallState) -> Bool {
    state == .running || state == .pending
}

private func shouldIgnoreAgentRunNonTerminalUpdateAfterTerminal(
    _ block: ToolCallBlock,
    nextState: ToolCallState,
    event: [String: JSONValue]
) -> Bool {
    guard isTerminalAgentRunState(block.tool.state) else { return false }
    guard isNonTerminalAgentRunState(nextState) else { return false }

    let activityKind = getEventString(event, "activityKind") ?? getEventString(event, "activity_kind")
    return activityKind == "wait_agent" || activityKind == "close_agent"
}

private func isCloseAgentCleanupUpdate(_ event: [String: JSONValue]) -> Bool {
    let activityKind = getEventString(event, "activityKind") ?? getEventString(event, "activity_kind")
    if activityKind == "close_agent" || activityKind == "closed" { return true }

    let activity = getEventString(event, "activity")
    let statusText = getEventString(event, "statusText") ?? getEventString(event, "status_text")
    guard activityKind == "canceled" && (activity == "Closed" || statusText == "Closed") else { return false }

    guard let result = event["result"]?.objectValue else { return false }
    return result["previous_status"]?.objectValue != nil || result["previousStatus"]?.objectValue != nil
}

private func shouldIgnoreAgentRunCloseCleanupAfterTerminal(
    _ block: ToolCallBlock,
    status: String?,
    event: [String: JSONValue]
) -> Bool {
    guard isTerminalAgentRunState(block.tool.state) else { return false }
    if status == "failed" || status == "error" { return false }
    return isCloseAgentCleanupUpdate(event)
}

private func getAgentRunDisplayPatch(_ event: [String: JSONValue]) -> [String: JSONValue] {
    var patch: [String: JSONValue] = [:]
    let summary = getEventString(event, "summary")
    let activity = getEventString(event, "activity")
    let activityKind = getEventString(event, "activityKind") ?? getEventString(event, "activity_kind")

    // TS truthiness: an empty string does not patch.
    if let summary, !summary.isEmpty { patch["summary"] = .string(summary) }
    if let activity, !activity.isEmpty { patch["activity"] = .string(activity) }
    if let activityKind, !activityKind.isEmpty { patch["activityKind"] = .string(activityKind) }

    return patch
}

private let whitespaceRunRegex = JSRegex("\\s+")

/// JS `text.replace(/\s+/g, ' ').trim()`.
private func collapseWhitespace(_ text: String) -> String {
    whitespaceRunRegex.replacingAllMatches(in: text, with: " ").jsTrimmed
}

private func getAgentRunFingerprint(_ event: [String: JSONValue]) -> String? {
    if let summary = getEventString(event, "summary"), !summary.isEmpty { return summary }

    let input = event["input"]?.objectValue
    // TS: `asString(input.message) ?? asString(input.prompt)` — a non-string
    // `message` falls through to `prompt`.
    let direct = input.flatMap { asString($0["message"]) ?? asString($0["prompt"]) }
    if let direct, !direct.isEmpty { return collapseWhitespace(direct) }

    if let items = input?["items"]?.arrayValue {
        let text = items
            .compactMap { item -> String? in
                guard let object = item.objectValue else { return nil }
                let part = asString(object["text"])
                return (part?.isEmpty == false) ? part : nil
            }
            .joined(separator: "\n\n")
        let collapsed = collapseWhitespace(text)
        return collapsed.isEmpty ? nil : collapsed
    }

    return nil
}

private func isAgentNotFoundUpdate(_ event: [String: JSONValue]) -> Bool {
    let status = getEventString(event, "status")
    let activityKind = getEventString(event, "activityKind") ?? getEventString(event, "activity_kind")
    return status == "notFound" || status == "not_found" || activityKind == "not_found"
}

private func isAgentToolOnlyUpdate(_ event: [String: JSONValue]) -> Bool {
    let activityKind = getEventString(event, "activityKind") ?? getEventString(event, "activity_kind")
    return activityKind == "wait_agent"
        || activityKind == "send_input"
        || activityKind == "resume_agent"
        || activityKind == "close_agent"
        || isAgentNotFoundUpdate(event)
}

private func isOrphanAgentRunBlock(_ block: ToolCallBlock) -> Bool {
    if !block.children.isEmpty { return false }
    if block.tool.result != nil { return false }
    if block.tool.state == .completed || block.tool.state == .error { return false }
    if let input = block.tool.input?.objectValue {
        let agentId = asString(input["agentId"]) ?? asString(input["agent_id"])
        if let agentId, !agentId.isEmpty { return false }
    }
    return true
}

private func prefixAgentTraceId(agentId: String, kind: String, id: String) -> String {
    let prefix = "codex-agent:\(agentId):"
    return id.hasPrefix(prefix) ? id : "\(prefix)\(kind):\(id)"
}

/// Port of `normalizeTraceMessage` — one agent-run trace payload becomes
/// synthetic timeline messages for the nested reduction.
private func normalizeTraceMessage(
    agentId: String,
    message: JSONValue?,
    source: NormalizedMessage
) -> [NormalizedMessage] {
    guard let data = message?.objectValue, let dataType = data["type"]?.stringValue else { return [] }

    let traceId = prefixAgentTraceId(agentId: agentId, kind: "trace", id: asString(data["id"]) ?? "\(source.id):trace")
    let createdAt = source.createdAt

    func base(content: NormalizedMessage.Content) -> NormalizedMessage {
        NormalizedMessage(
            id: traceId,
            localId: nil,
            createdAt: createdAt,
            content: content,
            isSidechain: false,
            meta: source.meta
        )
    }

    if dataType == "error", let messageText = data["message"]?.stringValue {
        return [base(content: .event(.error(messageText)))]
    }

    if dataType == "message", let messageText = data["message"]?.stringValue {
        return [base(content: .agent([.text(.init(text: messageText, uuid: traceId, parentUUID: nil))]))]
    }

    if dataType == "reasoning", let messageText = data["message"]?.stringValue {
        return [base(content: .agent([.reasoning(.init(text: messageText, uuid: traceId, streamId: traceId, parentUUID: nil))]))]
    }

    if dataType == "tool-call", let rawCallId = data["callId"]?.stringValue {
        let callId = prefixAgentTraceId(agentId: agentId, kind: "call", id: rawCallId)
        return [base(content: .agent([.toolCall(ToolUseContent(
            id: callId,
            name: asString(data["name"]) ?? "unknown",
            input: data["input"],
            description: nil,
            uuid: traceId,
            parentUUID: nil
        ))]))]
    }

    if dataType == "tool-call-result", let rawCallId = data["callId"]?.stringValue {
        let callId = prefixAgentTraceId(agentId: agentId, kind: "call", id: rawCallId)
        return [base(content: .agent([.toolResult(ToolResultContent(
            toolUseId: callId,
            content: data["output"],
            isError: data["is_error"]?.jsTruthy ?? false,
            uuid: traceId,
            parentUUID: nil
        ))]))]
    }

    if dataType == "token_count" {
        return []
    }

    if dataType == "ready" || dataType == "task_complete" {
        return [base(content: .event(.ready(agentId: agentId)))]
    }

    return [base(content: .event(.message(
        asString(data["statusText"]) ?? asString(data["status"]) ?? dataType
    )))]
}

// MARK: - Reducer context

/// Shared mutable context threaded through nested reductions (the TS object
/// is shared by reference; a class reproduces that).
final class ReducerContext {
    let permissionsById: PermissionMap
    let groups: [String: [NormalizedMessage]]
    var consumedGroupIds: Set<String>
    let titleChangesByToolUseId: [String: String]
    var emittedTitleChangeToolUseIds: Set<String>

    init(
        permissionsById: PermissionMap,
        groups: [String: [NormalizedMessage]],
        consumedGroupIds: Set<String> = [],
        titleChangesByToolUseId: [String: String],
        emittedTitleChangeToolUseIds: Set<String> = []
    ) {
        self.permissionsById = permissionsById
        self.groups = groups
        self.consumedGroupIds = consumedGroupIds
        self.titleChangesByToolUseId = titleChangesByToolUseId
        self.emittedTitleChangeToolUseIds = emittedTitleChangeToolUseIds
    }
}

struct TimelineResult {
    var blocks: [BlockBox]
    var toolBlocksById: [String: BlockBox]
    var hasReadyEvent: Bool
}

// MARK: - Block mutation helpers

private func setEarliestStartedAt(_ box: BlockBox, _ startedAt: Int?) {
    guard let startedAt, var block = box.block.asToolCall else { return }
    let next = block.tool.startedAt.map { min($0, startedAt) } ?? startedAt
    if next != block.tool.startedAt {
        block.tool.startedAt = next
        box.block = .toolCall(block)
    }
}

/// Only ever fed a real Claude `agentTimestamp`; nil is a no-op.
private func setEarliestExecStartedAt(_ box: BlockBox, _ execStartedAt: Int?) {
    guard let execStartedAt, var block = box.block.asToolCall else { return }
    let next = block.tool.execStartedAt.map { min($0, execStartedAt) } ?? execStartedAt
    if next != block.tool.execStartedAt {
        block.tool.execStartedAt = next
        box.block = .toolCall(block)
    }
}

private func isDurationTargetBlock(_ block: ChatBlock) -> Bool {
    switch block {
    case .agentText, .agentReasoning, .codexReview, .cliOutput, .toolCall:
        return true
    default:
        return false
    }
}

private func setDurationMs(_ box: BlockBox, _ durationMs: Int) {
    switch box.block {
    case .agentText(var block):
        block.durationMs = durationMs
        box.block = .agentText(block)
    case .agentReasoning(var block):
        block.durationMs = durationMs
        box.block = .agentReasoning(block)
    case .codexReview(var block):
        block.durationMs = durationMs
        box.block = .codexReview(block)
    case .cliOutput(var block):
        block.durationMs = durationMs
        box.block = .cliOutput(block)
    case .toolCall(var block):
        block.durationMs = durationMs
        box.block = .toolCall(block)
    default:
        break
    }
}

// MARK: - reduceTimeline

/// Port of `reduceTimeline`.
// swiftlint:disable:next cyclomatic_complexity function_body_length
func reduceTimeline(_ messages: [NormalizedMessage], context: ReducerContext) -> TimelineResult {
    var blocks: [BlockBox] = []
    var toolBlocksById: [String: BlockBox] = [:]
    var agentRunBlocksByCardId: [String: BlockBox] = [:]
    var agentRunCardByAgentId: [String: String] = [:]
    var agentRunTraceMessagesByCardId: [String: [NormalizedMessage]] = [:]
    var pendingAgentRunCardByFingerprint: [String: String] = [:]
    var textBlocksByStreamId: [String: BlockBox] = [:]
    var reasoningBlocksByStreamId: [String: BlockBox] = [:]
    var hasReadyEvent = false

    func ensureAgentRunBlock(
        cardId: String,
        createdAt: Int,
        invokedAt: Int?,
        model: String?,
        localId: String?,
        meta: JSONValue?,
        input: JSONValue?
    ) -> BlockBox {
        let box = ensureToolBlock(&blocks, &toolBlocksById, id: cardId, seed: ToolBlockSeed(
            createdAt: createdAt,
            invokedAt: invokedAt,
            model: model,
            localId: localId,
            meta: meta,
            name: "CodexAgent",
            input: input,
            description: nil
        ))
        agentRunBlocksByCardId[cardId] = box
        return box
    }

    func refreshAgentRunChildren(cardId: String) {
        guard let box = agentRunBlocksByCardId[cardId], var block = box.block.asToolCall else { return }
        let traceMessages = agentRunTraceMessagesByCardId[cardId] ?? []
        if traceMessages.isEmpty {
            block.children = []
            box.block = .toolCall(block)
            return
        }

        let child = reduceTimeline(traceMessages, context: ReducerContext(
            permissionsById: context.permissionsById,
            groups: [:],
            consumedGroupIds: [],
            titleChangesByToolUseId: collectTitleChanges(traceMessages),
            emittedTitleChangeToolUseIds: []
        ))
        block.children = child.blocks.materialized
        box.block = .toolCall(block)
    }

    func patchAgentRunInput(_ box: BlockBox, _ patch: [String: JSONValue]) {
        guard var block = box.block.asToolCall else { return }
        var merged = block.tool.input?.objectValue ?? [:]
        for (key, value) in patch { merged[key] = value }
        block.tool.input = .object(merged)
        box.block = .toolCall(block)
    }

    func removeAgentRunBlock(cardId: String) {
        guard let box = agentRunBlocksByCardId[cardId] else { return }
        if let index = blocks.firstIndex(where: { $0 === box }) {
            blocks.remove(at: index)
        }
        toolBlocksById.removeValue(forKey: cardId)
        agentRunBlocksByCardId.removeValue(forKey: cardId)
        agentRunTraceMessagesByCardId.removeValue(forKey: cardId)
        for (fingerprint, pendingCardId) in pendingAgentRunCardByFingerprint where pendingCardId == cardId {
            pendingAgentRunCardByFingerprint.removeValue(forKey: fingerprint)
        }
    }

    func mergeAgentRunBlock(fromCardId: String, toCardId: String, toBox: BlockBox) {
        if fromCardId == toCardId { return }

        guard let fromBox = agentRunBlocksByCardId[fromCardId], fromBox !== toBox,
              let fromBlock = fromBox.block.asToolCall,
              var toBlock = toBox.block.asToolCall else { return }

        let fromInput = fromBlock.tool.input?.objectValue ?? [:]
        let toInput = toBlock.tool.input?.objectValue ?? [:]
        if !fromInput.isEmpty || !toInput.isEmpty {
            var merged = fromInput
            for (key, value) in toInput { merged[key] = value }
            toBlock.tool.input = .object(merged)
        }

        toBlock.createdAt = min(toBlock.createdAt, fromBlock.createdAt)
        toBlock.tool.createdAt = min(toBlock.tool.createdAt, fromBlock.tool.createdAt)
        if let fromStartedAt = fromBlock.tool.startedAt {
            toBlock.tool.startedAt = toBlock.tool.startedAt.map { min($0, fromStartedAt) } ?? fromStartedAt
        }
        if let fromCompletedAt = fromBlock.tool.completedAt {
            toBlock.tool.completedAt = toBlock.tool.completedAt.map { max($0, fromCompletedAt) } ?? fromCompletedAt
        }
        if let fromExecStartedAt = fromBlock.tool.execStartedAt {
            toBlock.tool.execStartedAt = toBlock.tool.execStartedAt.map { min($0, fromExecStartedAt) } ?? fromExecStartedAt
        }
        if let fromExecCompletedAt = fromBlock.tool.execCompletedAt {
            toBlock.tool.execCompletedAt = toBlock.tool.execCompletedAt.map { max($0, fromExecCompletedAt) } ?? fromExecCompletedAt
        }
        toBlock.durationMs = toBlock.durationMs ?? fromBlock.durationMs
        toBlock.usage = toBlock.usage ?? fromBlock.usage
        toBlock.model = toBlock.model ?? fromBlock.model

        if !isTerminalAgentRunState(toBlock.tool.state) && isTerminalAgentRunState(fromBlock.tool.state) {
            toBlock.tool.state = fromBlock.tool.state
        }
        if toBlock.tool.result == nil, let fromResult = fromBlock.tool.result {
            toBlock.tool.result = fromResult
        }

        toBox.block = .toolCall(toBlock)

        let fromTrace = agentRunTraceMessagesByCardId[fromCardId] ?? []
        let toTrace = agentRunTraceMessagesByCardId[toCardId] ?? []
        if !fromTrace.isEmpty || !toTrace.isEmpty {
            let mergedTrace = (toTrace + fromTrace).sorted { left, right in
                if left.createdAt != right.createdAt { return left.createdAt < right.createdAt }
                return left.id.utf16.lexicographicallyPrecedes(right.id.utf16)
            }
            agentRunTraceMessagesByCardId[toCardId] = mergedTrace
            agentRunTraceMessagesByCardId.removeValue(forKey: fromCardId)
            refreshAgentRunChildren(cardId: toCardId)
        } else if toBlock.children.isEmpty && !fromBlock.children.isEmpty {
            if var refreshed = toBox.block.asToolCall {
                refreshed.children = fromBlock.children
                toBox.block = .toolCall(refreshed)
            }
        }

        if let index = blocks.firstIndex(where: { $0 === fromBox }) {
            blocks.remove(at: index)
        }
        toolBlocksById.removeValue(forKey: fromCardId)
        agentRunBlocksByCardId.removeValue(forKey: fromCardId)

        for (fingerprint, pendingCardId) in pendingAgentRunCardByFingerprint where pendingCardId == fromCardId {
            pendingAgentRunCardByFingerprint[fingerprint] = toCardId
        }
        for (mappedAgentId, mappedCardId) in agentRunCardByAgentId where mappedCardId == fromCardId {
            agentRunCardByAgentId[mappedAgentId] = toCardId
        }
    }

    // Pre-scan: UUIDs of system-injected user turns, used to identify the
    // "No response requested." sentinel auto-replies below.
    var injectedTurnUuids = Set<String>()
    for msg in messages {
        guard msg.isSidechain, let content = msg.agentContent else { continue }
        for item in content {
            if case .sidechain(let sidechain) = item {
                injectedTurnUuids.insert(sidechain.uuid)
            }
        }
    }

    for msg in messages {
        if case .event(let msgEvent) = msg.content {
            if msgEvent.type == "ready" {
                hasReadyEvent = true
                continue
            }
            if msgEvent.type == "token-count" {
                continue
            }
            // abort-restore is a composer side-effect signal, not a visible
            // chat event.
            if msgEvent.type == "abort-restore" {
                continue
            }
            if msgEvent.type == "turn-duration" {
                let targetId = msgEvent["targetMessageId"]?.stringValue
                let durationMs = Int((msgEvent["durationMs"]?.numberValue ?? 0).rounded())
                var foundIndex = -1

                if let targetId {
                    foundIndex = blocks.lastIndex(where: { box in
                        isDurationTargetBlock(box.block)
                            && (box.block.id == targetId || box.block.id.hasPrefix("\(targetId):"))
                    }) ?? -1
                    if foundIndex == -1 {
                        foundIndex = blocks.lastIndex(where: { $0.block.asToolCall?.tool.id == targetId }) ?? -1
                    }
                }

                if foundIndex == -1 {
                    foundIndex = blocks.lastIndex(where: { isDurationTargetBlock($0.block) }) ?? -1
                }

                if foundIndex != -1, isDurationTargetBlock(blocks[foundIndex].block) {
                    setDurationMs(blocks[foundIndex], durationMs)
                }
                continue
            }

            if msgEvent.type == "agent-run-start" || msgEvent.type == "agent-run-update" || msgEvent.type == "agent-run-trace" {
                let event = msgEvent.object
                let agentId = getEventString(event, "agentId") ?? getEventString(event, "agent_id")
                let fallbackCardId = agentId.map { "codex-agent:\($0)" } ?? msg.id
                let rawCardId = getAgentRunCardId(event, fallback: fallbackCardId)
                let previousCardId = agentId.flatMap { agentRunCardByAgentId[$0] }
                let previousIsFallback = previousCardId.map { isFallbackAgentRunCardId($0, agentId: agentId) } ?? false
                let rawIsFallback = isFallbackAgentRunCardId(rawCardId, agentId: agentId)
                let cardId: String = {
                    if agentId != nil, let previousCardId, !previousIsFallback, rawIsFallback {
                        return previousCardId
                    }
                    return rawCardId
                }()
                let mergeFromCardId: String? = {
                    if agentId != nil, let previousCardId, previousCardId != cardId, previousIsFallback, !rawIsFallback {
                        return previousCardId
                    }
                    return nil
                }()
                let fingerprint = getAgentRunFingerprint(event)

                if msgEvent.type == "agent-run-update",
                   agentId != nil,
                   previousCardId == nil,
                   rawIsFallback,
                   isAgentToolOnlyUpdate(event) {
                    continue
                }

                if msgEvent.type == "agent-run-start", agentId == nil, let fingerprint {
                    let previousPendingCardId = pendingAgentRunCardByFingerprint[fingerprint]
                    let previousBlock = previousPendingCardId.flatMap { agentRunBlocksByCardId[$0] }
                    if let previousPendingCardId,
                       previousPendingCardId != cardId,
                       let previousBlock,
                       let previousToolBlock = previousBlock.block.asToolCall,
                       isOrphanAgentRunBlock(previousToolBlock) {
                        removeAgentRunBlock(cardId: previousPendingCardId)
                    }
                    pendingAgentRunCardByFingerprint[fingerprint] = cardId
                }

                let box = ensureAgentRunBlock(
                    cardId: cardId,
                    createdAt: msg.createdAt,
                    invokedAt: msg.invokedAt,
                    model: msg.model,
                    localId: msg.localId,
                    meta: msg.meta,
                    input: event["input"]
                )

                if let mergeFromCardId {
                    mergeAgentRunBlock(fromCardId: mergeFromCardId, toCardId: cardId, toBox: box)
                }
                if let agentId {
                    agentRunCardByAgentId[agentId] = cardId
                }

                if msgEvent.type == "agent-run-start" {
                    let status = getEventString(event, "status") ?? "running"
                    let startedAt = getAgentRunStartedAt(event) ?? msg.createdAt
                    var patch: [String: JSONValue] = [:]
                    // TS patches `agentId` unconditionally — getEventString
                    // yields null (not undefined), which JSON keeps.
                    patch["agentId"] = agentId.map { JSONValue.string($0) } ?? .null
                    patch["agentStatus"] = .string(status)
                    patch["statusText"] = .string(
                        getEventString(event, "statusText") ?? getEventString(event, "status_text") ?? "Starting"
                    )
                    for (key, value) in getAgentRunDisplayPatch(event) { patch[key] = value }
                    patchAgentRunInput(box, patch)
                    let nextState = mapAgentRunStatusToToolState(status)
                    if var block = box.block.asToolCall {
                        block.tool.state = nextState
                        box.block = .toolCall(block)
                    }
                    if nextState == .running {
                        setEarliestStartedAt(box, startedAt)
                    }
                    continue
                }

                if msgEvent.type == "agent-run-update" {
                    let status = getEventString(event, "status") ?? "running"
                    let nextState = mapAgentRunStatusToToolState(status)
                    let startedAt = getAgentRunStartedAt(event)
                    if let blockValue = box.block.asToolCall,
                       shouldIgnoreAgentRunNonTerminalUpdateAfterTerminal(blockValue, nextState: nextState, event: event)
                           || shouldIgnoreAgentRunCloseCleanupAfterTerminal(blockValue, status: status, event: event) {
                        continue
                    }
                    var patch: [String: JSONValue] = [:]
                    patch["agentId"] = agentId.map { JSONValue.string($0) } ?? .null
                    patch["agentStatus"] = .string(status)
                    patch["statusText"] = .string(
                        getEventString(event, "statusText") ?? getEventString(event, "status_text") ?? status
                    )
                    for (key, value) in getAgentRunDisplayPatch(event) { patch[key] = value }
                    patchAgentRunInput(box, patch)
                    if var block = box.block.asToolCall {
                        block.tool.state = nextState
                        box.block = .toolCall(block)
                    }
                    if nextState == .running {
                        setEarliestStartedAt(box, startedAt ?? msg.createdAt)
                    }
                    if nextState == .completed || nextState == .error {
                        setEarliestStartedAt(box, startedAt)
                        if var block = box.block.asToolCall {
                            block.tool.completedAt = getAgentRunCompletedAt(event) ?? msg.createdAt
                            box.block = .toolCall(block)
                        }
                    }
                    if var block = box.block.asToolCall {
                        if let result = event["result"] {
                            block.tool.result = result
                            box.block = .toolCall(block)
                        } else if let error = event["error"] {
                            block.tool.result = error
                            box.block = .toolCall(block)
                        } else if let spawnResult = event["spawnResult"] {
                            block.tool.result = spawnResult
                            box.block = .toolCall(block)
                        }
                    }
                    continue
                }

                if msgEvent.type == "agent-run-trace" {
                    guard let traceAgentId = agentId else { continue }
                    let startedAt = getAgentRunStartedAt(event)
                    let traceCardId = agentRunCardByAgentId[traceAgentId] ?? cardId
                    let traceInput: JSONValue? = agentRunBlocksByCardId[traceCardId] != nil
                        ? nil
                        : .object(["agentId": .string(traceAgentId)])
                    let traceBox = ensureAgentRunBlock(
                        cardId: traceCardId,
                        createdAt: msg.createdAt,
                        invokedAt: msg.invokedAt,
                        model: msg.model,
                        localId: msg.localId,
                        meta: msg.meta,
                        input: traceInput
                    )
                    guard let traceBlockValue = traceBox.block.asToolCall else { continue }
                    var tracePatch: [String: JSONValue] = [
                        "agentId": .string(traceAgentId),
                        "agentStatus": .string(traceBlockValue.tool.state.rawValue),
                    ]
                    for (key, value) in getAgentRunDisplayPatch(event) { tracePatch[key] = value }
                    if !isTerminalAgentRunState(traceBlockValue.tool.state) {
                        tracePatch["statusText"] = .string(
                            getEventString(event, "statusText") ?? getEventString(event, "status_text") ?? "Running"
                        )
                    }
                    patchAgentRunInput(traceBox, tracePatch)
                    var traceMessages = agentRunTraceMessagesByCardId[traceCardId] ?? []
                    traceMessages.append(contentsOf: normalizeTraceMessage(agentId: traceAgentId, message: event["message"], source: msg))
                    agentRunTraceMessagesByCardId[traceCardId] = traceMessages
                    refreshAgentRunChildren(cardId: traceCardId)
                    if var block = traceBox.block.asToolCall,
                       block.tool.state != .completed && block.tool.state != .error {
                        block.tool.state = .running
                        traceBox.block = .toolCall(block)
                        setEarliestStartedAt(traceBox, startedAt ?? msg.createdAt)
                    }
                    continue
                }
            }

            blocks.append(BlockBox(.agentEvent(AgentEventBlock(
                id: msg.id,
                createdAt: msg.createdAt,
                invokedAt: msg.invokedAt,
                model: msg.model,
                event: msgEvent,
                meta: msg.meta
            ))))
            continue
        }

        if let event = parseMessageAsEvent(msg) {
            blocks.append(BlockBox(.agentEvent(AgentEventBlock(
                id: msg.id,
                createdAt: msg.createdAt,
                invokedAt: msg.invokedAt,
                model: msg.model,
                event: event,
                meta: msg.meta
            ))))
            continue
        }

        if case .user(let text, let attachments) = msg.content {
            if isCliOutputText(text, meta: msg.meta) {
                blocks.append(BlockBox(.cliOutput(CliOutputBlock(
                    id: msg.id,
                    localId: msg.localId,
                    createdAt: msg.createdAt,
                    invokedAt: msg.invokedAt,
                    durationMs: nil,
                    usage: nil,
                    model: nil,
                    text: text,
                    source: .user,
                    meta: msg.meta
                ))))
                continue
            }
            blocks.append(BlockBox(.userText(UserTextBlock(
                id: msg.id,
                localId: msg.localId,
                createdAt: msg.createdAt,
                invokedAt: msg.invokedAt,
                text: text,
                attachments: attachments,
                status: msg.status,
                originalText: msg.originalText,
                meta: msg.meta
            ))))
            continue
        }

        if case .agent(let contentItems) = msg.content {
            // Suppress a text block repeating the Task tool prompt (already
            // shown in the tool card) — only that exact prompt text.
            let taskToolCall: ToolUseContent? = contentItems.lazy.compactMap { item -> ToolUseContent? in
                if case .toolCall(let toolCall) = item, isSubagentToolName(toolCall.name) { return toolCall }
                return nil
            }.first
            let taskPromptText: String? = taskToolCall?.input?.objectValue?["prompt"]?.stringValue

            for (idx, item) in contentItems.enumerated() {
                switch item {
                case .text(let textContent):
                    // Skip "No response requested." — the sentinel
                    // auto-response to system-injected messages.
                    if contentItems.count == 1,
                       let parentUUID = textContent.parentUUID,
                       injectedTurnUuids.contains(parentUUID) {
                        let trimmedText = textContent.text.jsTrimmed
                        if trimmedText == "No response requested." || trimmedText == "No response requested" {
                            continue
                        }
                    }

                    if let taskPromptText, textContent.text.jsTrimmed == taskPromptText.jsTrimmed {
                        continue
                    }

                    if isCliOutputText(textContent.text, meta: msg.meta) {
                        blocks.append(BlockBox(.cliOutput(CliOutputBlock(
                            id: "\(msg.id):\(idx)",
                            localId: msg.localId,
                            createdAt: msg.createdAt,
                            invokedAt: msg.invokedAt,
                            durationMs: nil,
                            usage: msg.usage,
                            model: msg.model,
                            text: textContent.text,
                            source: .assistant,
                            meta: msg.meta
                        ))))
                        continue
                    }
                    if let streamId = textContent.streamId, let existingBox = textBlocksByStreamId[streamId] {
                        if var existing = existingBox.block.asAgentText {
                            existing.text = textContent.text
                            existing.usage = msg.usage
                            existing.model = msg.model
                            existing.meta = msg.meta
                            existing.invokedAt = msg.invokedAt
                            existingBox.block = .agentText(existing)
                            continue
                        }
                    }

                    let box = BlockBox(.agentText(AgentTextBlock(
                        id: "\(msg.id):\(idx)",
                        localId: msg.localId,
                        createdAt: msg.createdAt,
                        invokedAt: msg.invokedAt,
                        durationMs: nil,
                        usage: msg.usage,
                        model: msg.model,
                        text: textContent.text,
                        meta: msg.meta
                    )))
                    blocks.append(box)
                    if let streamId = textContent.streamId {
                        textBlocksByStreamId[streamId] = box
                    }
                    continue

                case .generatedImage(let image):
                    blocks.append(BlockBox(.generatedImage(GeneratedImageBlock(
                        id: "\(msg.id):\(idx)",
                        localId: msg.localId,
                        createdAt: msg.createdAt,
                        invokedAt: msg.invokedAt,
                        imageId: image.imageId,
                        fileName: image.fileName,
                        mimeType: image.mimeType,
                        source: image.source,
                        meta: msg.meta
                    ))))
                    continue

                case .reasoning(let reasoningContent):
                    if let streamId = reasoningContent.streamId, let existingBox = reasoningBlocksByStreamId[streamId] {
                        if var existing = existingBox.block.asAgentReasoning {
                            existing.text = reasoningContent.text
                            existing.usage = msg.usage
                            existing.model = msg.model
                            existing.meta = msg.meta
                            existing.invokedAt = msg.invokedAt
                            existingBox.block = .agentReasoning(existing)
                            continue
                        }
                    }

                    let box = BlockBox(.agentReasoning(AgentReasoningBlock(
                        id: "\(msg.id):\(idx)",
                        localId: msg.localId,
                        createdAt: msg.createdAt,
                        invokedAt: msg.invokedAt,
                        durationMs: nil,
                        usage: msg.usage,
                        model: msg.model,
                        text: reasoningContent.text,
                        meta: msg.meta
                    )))
                    blocks.append(box)
                    if let streamId = reasoningContent.streamId {
                        reasoningBlocksByStreamId[streamId] = box
                    }
                    continue

                case .codexReview(let review, _, _):
                    blocks.append(BlockBox(.codexReview(CodexReviewBlock(
                        id: "\(msg.id):\(idx)",
                        localId: msg.localId,
                        createdAt: msg.createdAt,
                        invokedAt: msg.invokedAt,
                        durationMs: nil,
                        usage: msg.usage,
                        model: msg.model,
                        review: review,
                        meta: msg.meta
                    ))))
                    continue

                case .summary(let summary):
                    blocks.append(BlockBox(.agentEvent(AgentEventBlock(
                        id: "\(msg.id):\(idx)",
                        createdAt: msg.createdAt,
                        invokedAt: msg.invokedAt,
                        model: msg.model,
                        event: .message(summary),
                        meta: msg.meta
                    ))))
                    continue

                case .toolCall(let toolCall):
                    if isChangeTitleToolName(toolCall.name) {
                        let title = context.titleChangesByToolUseId[toolCall.id]
                            ?? extractTitleFromChangeTitleInput(toolCall.input)
                        if let title, !context.emittedTitleChangeToolUseIds.contains(toolCall.id) {
                            context.emittedTitleChangeToolUseIds.insert(toolCall.id)
                            blocks.append(BlockBox(.agentEvent(AgentEventBlock(
                                id: "\(msg.id):\(idx)",
                                createdAt: msg.createdAt,
                                invokedAt: msg.invokedAt,
                                model: msg.model,
                                event: .titleChanged(title),
                                meta: msg.meta
                            ))))
                        }
                        continue
                    }

                    let permission = context.permissionsById[toolCall.id]?.permission

                    let box = ensureToolBlock(&blocks, &toolBlocksById, id: toolCall.id, seed: ToolBlockSeed(
                        createdAt: msg.createdAt,
                        invokedAt: msg.invokedAt,
                        usage: msg.usage,
                        model: msg.model,
                        localId: msg.localId,
                        meta: msg.meta,
                        name: toolCall.name,
                        input: toolCall.input,
                        description: toolCall.description,
                        nativeTitle: toolCall.nativeTitle,
                        nativeKind: toolCall.nativeKind,
                        progress: toolCall.progress,
                        permission: permission,
                        agentTimestamp: msg.agentTimestamp
                    ))

                    if var block = box.block.asToolCall, block.tool.state == .pending {
                        block.tool.state = .running
                        box.block = .toolCall(block)
                    }
                    // Backfill both clocks regardless of state so a
                    // tool_result reduced before its tool_use still lowers
                    // startedAt to the earlier tool_use receive time.
                    setEarliestStartedAt(box, msg.createdAt)
                    setEarliestExecStartedAt(box, msg.agentTimestamp)

                    if isSubagentToolName(toolCall.name) && !context.consumedGroupIds.contains(msg.id) {
                        let sidechain = context.groups[msg.id]
                        if let sidechain, !sidechain.isEmpty {
                            context.consumedGroupIds.insert(msg.id)
                            let child = reduceTimeline(sidechain, context: context)
                            hasReadyEvent = hasReadyEvent || child.hasReadyEvent
                            if var block = box.block.asToolCall {
                                block.children = child.blocks.materialized
                                box.block = .toolCall(block)
                            }
                        }
                    }
                    continue

                case .toolResult(let toolResult):
                    let title = context.titleChangesByToolUseId[toolResult.toolUseId]
                    if let title {
                        if !context.emittedTitleChangeToolUseIds.contains(toolResult.toolUseId) {
                            context.emittedTitleChangeToolUseIds.insert(toolResult.toolUseId)
                            blocks.append(BlockBox(.agentEvent(AgentEventBlock(
                                id: "\(msg.id):\(idx)",
                                createdAt: msg.createdAt,
                                invokedAt: msg.invokedAt,
                                model: msg.model,
                                event: .titleChanged(title),
                                meta: msg.meta
                            ))))
                        }
                        continue
                    }

                    let permissionEntry = context.permissionsById[toolResult.toolUseId]
                    let permissionFromResult: ToolPermission? = toolResult.permissions.map { perms in
                        ToolPermission(
                            id: toolResult.toolUseId,
                            status: perms.result == .approved ? .approved : .denied,
                            mode: perms.mode,
                            allowedTools: perms.allowedTools,
                            decision: perms.decision,
                            date: perms.date,
                            // The TS literal carries these keys (values may
                            // be undefined): date, mode, allowedTools,
                            // decision — id/status are always present.
                            presentKeys: [.date, .mode, .allowedTools, .decision]
                        )
                    }

                    let permission: ToolPermission? = {
                        if let fromResult = permissionFromResult, let entryPermission = permissionEntry?.permission {
                            var merged = ToolPermission.spreading(entryPermission, with: fromResult)
                            merged.allowedTools = fromResult.allowedTools ?? entryPermission.allowedTools
                            merged.decision = fromResult.decision ?? entryPermission.decision
                            merged.presentKeys.formUnion([.allowedTools, .decision])
                            return merged
                        }
                        return permissionFromResult ?? permissionEntry?.permission
                    }()

                    let box = ensureToolBlock(&blocks, &toolBlocksById, id: toolResult.toolUseId, seed: ToolBlockSeed(
                        createdAt: msg.createdAt,
                        invokedAt: msg.invokedAt,
                        usage: msg.usage,
                        model: msg.model,
                        localId: msg.localId,
                        meta: msg.meta,
                        name: permissionEntry?.toolName ?? "Tool",
                        input: permissionEntry?.input ?? .null,
                        description: nil,
                        permission: permission
                        // No agentTimestamp seed: execStartedAt must only
                        // ever originate from a tool_use entry.
                    ))

                    if var block = box.block.asToolCall {
                        block.tool.result = toolResult.content
                        block.tool.completedAt = msg.createdAt
                        block.tool.execCompletedAt = msg.agentTimestamp
                        block.tool.state = toolResult.isError ? .error : .completed
                        box.block = .toolCall(block)
                    }
                    continue

                case .sidechain(let sidechain):
                    // Extract task-notification summaries as visible events.
                    let trimmedPrompt = sidechain.prompt.jsTrimmedStart
                    if trimmedPrompt.hasPrefix("<task-notification>") {
                        if let summaryStart = trimmedPrompt.range(of: "<summary>"),
                           let summaryEnd = trimmedPrompt.range(of: "</summary>", range: summaryStart.upperBound..<trimmedPrompt.endIndex) {
                            let summary = String(trimmedPrompt[summaryStart.upperBound..<summaryEnd.lowerBound]).jsTrimmed
                            if !summary.isEmpty {
                                blocks.append(BlockBox(.agentEvent(AgentEventBlock(
                                    id: "\(msg.id):\(idx)",
                                    createdAt: msg.createdAt,
                                    invokedAt: msg.invokedAt,
                                    model: msg.model,
                                    event: .message(summary),
                                    meta: msg.meta
                                ))))
                            }
                        }
                    }
                    // The prompt text itself is never rendered.
                    continue
                }
            }
        }
    }

    return TimelineResult(
        blocks: mergeCliOutputBlocks(blocks),
        toolBlocksById: toolBlocksById,
        hasReadyEvent: hasReadyEvent
    )
}
