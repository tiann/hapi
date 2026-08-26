import Foundation

// Port of web/scripts/fixtures/projection.ts — the NORMATIVE projection the
// golden fixtures pin. Field-for-field: structure + semantics in,
// web-presentation out. Keep in sync with shared/fixtures/README.md.

private func projectAttachments(_ attachments: [AttachmentMetadata]?) -> JSONValue? {
    guard let attachments, !attachments.isEmpty else { return nil }
    // previewUrl is a web-serving convenience — dropped.
    return .array(attachments.map { attachment in
        .object([
            "id": .string(attachment.id),
            "filename": .string(attachment.filename),
            "mimeType": .string(attachment.mimeType),
            "size": .number(Double(attachment.size)),
            "path": .string(attachment.path),
        ])
    })
}

private func projectPermission(_ permission: ToolPermission?) -> JSONValue? {
    guard let permission else { return nil }
    // Dropped: id (duplicates the tool id), date/createdAt/completedAt.
    var projected: [String: JSONValue] = ["status": .string(permission.status.rawValue)]
    if let mode = permission.mode { projected["mode"] = .string(mode) }
    if let decision = permission.decision { projected["decision"] = .string(decision.rawValue) }
    if let allowedTools = permission.allowedTools {
        projected["allowedTools"] = .array(allowedTools.map { .string($0) })
    }
    if let answers = permission.answers { projected["answers"] = answers }
    if let reason = permission.reason { projected["reason"] = .string(reason) }
    return .object(projected)
}

private func projectTool(_ tool: ChatToolCall) -> JSONValue {
    // Dropped: timing fields, description/nativeTitle/nativeKind, progress.
    var projected: [String: JSONValue] = [
        "id": .string(tool.id),
        "name": .string(tool.name),
        "state": .string(tool.state.rawValue),
    ]
    if let input = tool.input { projected["input"] = input }
    if let result = tool.result { projected["result"] = result }
    if let permission = projectPermission(tool.permission) { projected["permission"] = permission }
    return .object(projected)
}

private func projectBlockBase(_ block: ChatBlock) -> [String: JSONValue] {
    var projected: [String: JSONValue] = [
        "kind": .string(block.kind),
        "id": .string(block.id),
        "createdAt": .number(Double(block.createdAt)),
    ]
    if let invokedAt = block.invokedAt {
        projected["invokedAt"] = .number(Double(invokedAt))
    }
    return projected
}

private func localIdValue(_ localId: String?) -> JSONValue {
    localId.map { JSONValue.string($0) } ?? .null
}

/// Port of `projectChatBlock`. Dropped on every kind: meta, usage, model,
/// durationMs, status, originalText.
public func projectChatBlock(_ block: ChatBlock) -> JSONValue {
    var projected = projectBlockBase(block)
    switch block {
    case .userText(let userText):
        projected["localId"] = localIdValue(userText.localId)
        projected["text"] = .string(userText.text)
        if let attachments = projectAttachments(userText.attachments) {
            projected["attachments"] = attachments
        }
        return .object(projected)
    case .agentText(let agentText):
        projected["localId"] = localIdValue(agentText.localId)
        projected["text"] = .string(agentText.text)
        return .object(projected)
    case .agentReasoning(let reasoning):
        projected["localId"] = localIdValue(reasoning.localId)
        projected["text"] = .string(reasoning.text)
        return .object(projected)
    case .cliOutput(let cliOutput):
        projected["localId"] = localIdValue(cliOutput.localId)
        projected["text"] = .string(cliOutput.text)
        projected["source"] = .string(cliOutput.source.rawValue)
        return .object(projected)
    case .codexReview(let review):
        projected["localId"] = localIdValue(review.localId)
        projected["review"] = review.review.wireValue
        return .object(projected)
    case .generatedImage(let image):
        // `source` is a web rendering concern — natives fetch by imageId.
        projected["localId"] = localIdValue(image.localId)
        projected["imageId"] = .string(image.imageId)
        projected["fileName"] = .string(image.fileName)
        projected["mimeType"] = image.mimeType.map { JSONValue.string($0) } ?? .null
        return .object(projected)
    case .agentEvent(let eventBlock):
        // The normalized AgentEvent record is wire-semantic by construction:
        // carried verbatim.
        projected["event"] = eventBlock.event.wireValue
        return .object(projected)
    case .toolCall(let toolCall):
        projected["localId"] = localIdValue(toolCall.localId)
        projected["tool"] = projectTool(toolCall.tool)
        if !toolCall.children.isEmpty {
            projected["children"] = .array(toolCall.children.map(projectChatBlock))
        }
        return .object(projected)
    }
}

/// Port of `projectVisibleChatBlock`: tool groups keep membership, order and
/// boundary ids; presentation state is dropped.
public func projectVisibleChatBlock(_ block: VisibleChatBlock) -> JSONValue {
    switch block {
    case .block(let chatBlock):
        return projectChatBlock(chatBlock)
    case .toolGroup(let group):
        var projected: [String: JSONValue] = [
            "kind": .string("tool-group"),
            "id": .string(group.id),
            "createdAt": .number(Double(group.createdAt)),
        ]
        if let invokedAt = group.invokedAt {
            projected["invokedAt"] = .number(Double(invokedAt))
        }
        projected["firstToolId"] = .string(group.firstToolId)
        projected["lastToolId"] = .string(group.lastToolId)
        projected["tools"] = .array(group.tools.map { projectChatBlock(.toolCall($0)) })
        return .object(projected)
    }
}

/// Port of `projectLatestUsage`. Dropped: cacheCreation/cacheRead, model,
/// timestamp. `contextWindow` stays, null included.
public func projectLatestUsage(_ usage: LatestUsage?) -> JSONValue {
    guard let usage else { return .null }
    return .object([
        "inputTokens": .number(usage.inputTokens),
        "outputTokens": .number(usage.outputTokens),
        "contextSize": .number(usage.contextSize),
        "contextWindow": usage.contextWindow.map { JSONValue.number($0) } ?? .null,
    ])
}

/// Port of `runFixturePipeline` (web/scripts/fixtures/pipeline.ts): the
/// exact pipeline a client must implement for chat rendering — normalize →
/// reduce → group — followed by the normative projection.
public func runChatFixturePipeline(
    messages: [DecryptedMessage],
    agentState: AgentState?,
    hasMoreMessages: Bool
) -> JSONValue {
    let normalized = messages.compactMap(normalizeDecryptedMessage)
    let reduced = reduceChatBlocks(normalized, agentState: agentState)
    let visibleBlocks = buildVisibleChatBlocks(
        reduced.blocks,
        options: ToolGroupingOptions(hasMoreMessages: hasMoreMessages)
    )
    return .object([
        "blocks": .array(reduced.blocks.map(projectChatBlock)),
        "hasReadyEvent": .bool(reduced.hasReadyEvent),
        "latestUsage": projectLatestUsage(reduced.latestUsage),
        "visibleBlocks": .array(visibleBlocks.map(projectVisibleChatBlock)),
    ])
}
