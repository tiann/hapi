import Foundation

// Port of web/src/chat/tracer.ts — groups sidechain messages under their
// parent Agent/Task tool call. `TracedMessage` is `NormalizedMessage` with
// `sidechainId` populated (the field lives on the struct).

/// Port of `isSubagentToolName` (web/src/chat/subagentTool.ts).
public func isSubagentToolName(_ name: String) -> Bool {
    name == "Task" || name == "Agent" || name.hasPrefix("Agent:") || name.hasPrefix("Task:")
}

private struct TracerState {
    var promptToTaskId: [String: String] = [:]
    var toolUseIdToTaskId: [String: String] = [:]
    var uuidToSidechainId: [String: String] = [:]
    var orphanMessages: [String: [NormalizedMessage]] = [:]
}

private func getMessageUuid(_ message: NormalizedMessage) -> String? {
    guard let content = message.agentContent, let first = content.first else { return nil }
    return first.uuid
}

private func getParentUuid(_ message: NormalizedMessage) -> String? {
    guard let content = message.agentContent, let first = content.first else { return nil }
    return first.parentUUID
}

private func getParentToolUseId(_ message: NormalizedMessage) -> String? {
    guard message.agentContent != nil else { return nil }
    return message.parentToolUseId
}

private func processOrphans(_ state: inout TracerState, parentUuid: String, sidechainId: String) -> [NormalizedMessage] {
    var results: [NormalizedMessage] = []
    guard let orphans = state.orphanMessages[parentUuid] else { return results }
    state.orphanMessages.removeValue(forKey: parentUuid)

    for orphan in orphans {
        let uuid = getMessageUuid(orphan)
        if let uuid {
            state.uuidToSidechainId[uuid] = sidechainId
        }

        var traced = orphan
        traced.sidechainId = sidechainId
        results.append(traced)

        if let uuid {
            results.append(contentsOf: processOrphans(&state, parentUuid: uuid, sidechainId: sidechainId))
        }
    }

    return results
}

/// Port of `traceMessages`.
public func traceMessages(_ messages: [NormalizedMessage]) -> [NormalizedMessage] {
    var state = TracerState()
    var results: [NormalizedMessage] = []

    // Index Task/Agent prompts and tool_use ids (sidechain ones included).
    for message in messages {
        guard let content = message.agentContent else { continue }
        for item in content {
            guard case .toolCall(let toolCall) = item, isSubagentToolName(toolCall.name) else { continue }
            state.toolUseIdToTaskId[toolCall.id] = message.id
            guard let prompt = toolCall.input?.objectValue?["prompt"]?.stringValue else { continue }
            state.promptToTaskId[prompt] = message.id
        }
    }

    for message in messages {
        if !message.isSidechain {
            results.append(message)
            continue
        }

        let uuid = getMessageUuid(message)
        let parentUuid = getParentUuid(message)

        // Preferred: group by the SDK's parent_tool_use_id.
        var sidechainId: String?
        if let parentToolUseId = getParentToolUseId(message) {
            sidechainId = state.toolUseIdToTaskId[parentToolUseId]
        }

        // Fallback: sidechain-root prompt matching (pre-parentToolUseId data).
        if sidechainId == nil, let content = message.agentContent {
            for item in content {
                guard case .sidechain(let sidechain) = item else { continue }
                if let taskId = state.promptToTaskId[sidechain.prompt] {
                    sidechainId = taskId
                    break
                }
            }
        }

        if let sidechainId, let uuid {
            state.uuidToSidechainId[uuid] = sidechainId
            var traced = message
            traced.sidechainId = sidechainId
            results.append(traced)
            results.append(contentsOf: processOrphans(&state, parentUuid: uuid, sidechainId: sidechainId))
            continue
        }

        if let parentUuid {
            if let parentSidechainId = state.uuidToSidechainId[parentUuid] {
                if let uuid {
                    state.uuidToSidechainId[uuid] = parentSidechainId
                }
                var traced = message
                traced.sidechainId = parentSidechainId
                results.append(traced)
                if let uuid {
                    results.append(contentsOf: processOrphans(&state, parentUuid: uuid, sidechainId: parentSidechainId))
                }
            } else {
                state.orphanMessages[parentUuid, default: []].append(message)
            }
            continue
        }

        results.append(message)
    }

    return results
}
