import Foundation

// Port of web/src/chat/normalizeAgent.ts (1:1 function mapping, same order).

/// `AGENT_MESSAGE_PAYLOAD_TYPE` (shared/src/modes.ts) — the generic agent
/// envelope used by the non-Claude-SDK flavors.
let agentMessagePayloadType = "codex"

// MARK: - Small helpers

/// Port of `parseAgentTimestampMs` (web/src/chat/agentTimestamp.ts):
/// ISO-8601 `timestamp` → epoch ms; `nil` when missing/unparseable.
func parseAgentTimestampMs(_ value: JSONValue?) -> Int? {
    guard let text = value?.stringValue, !text.jsTrimmed.isEmpty else { return nil }
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    guard let date = withFraction.date(from: text) ?? plain.date(from: text) else { return nil }
    return Int((date.timeIntervalSince1970 * 1000).rounded())
}

/// Port of `normalizeToolResultPermissions`.
func normalizeToolResultPermissions(_ value: JSONValue?) -> ToolResultPermission? {
    guard let object = value?.objectValue else { return nil }
    guard let date = asNumber(object["date"]) else { return nil }
    guard let rawResult = object["result"]?.stringValue,
          let result = ToolResultPermission.Result(rawValue: rawResult) else { return nil }

    let mode = asString(object["mode"])
    let allowedTools: [String]? = {
        guard let items = object["allowedTools"]?.arrayValue else { return nil }
        return items.compactMap(\.stringValue)
    }()
    let decision: ToolPermissionDecision? = {
        guard let raw = object["decision"]?.stringValue else { return nil }
        return ToolPermissionDecision(rawValue: raw)
    }()

    return ToolResultPermission(
        date: date,
        result: result,
        mode: mode,
        allowedTools: allowedTools,
        decision: decision
    )
}

/// Port of `normalizeAgentEvent`: any record with a string `type` is an
/// event, carried verbatim.
func normalizeAgentEvent(_ value: JSONValue?) -> AgentEvent? {
    guard let object = value?.objectValue, object["type"]?.stringValue != nil else { return nil }
    return AgentEvent(object: object)
}

/// Port of `normalizeThreadGoal`. Returns the goal as the exact record the
/// reference constructs (`tokenBudget` explicitly null when absent).
func normalizeThreadGoal(_ value: JSONValue?) -> JSONValue? {
    guard let object = value?.objectValue else { return nil }
    let threadId = asString(jsCoalesce(object["threadId"], object["thread_id"]))
    let objective = asString(object["objective"])
    let status = asString(object["status"])
    guard let threadId, !threadId.isEmpty, let objective, !objective.isEmpty,
          let status, !status.isEmpty else { return nil }
    switch status {
    case "active", "paused", "budgetLimited", "usageLimited", "blocked", "complete":
        break
    default:
        return nil
    }
    return .object([
        "threadId": .string(threadId),
        "objective": .string(objective),
        "status": .string(status),
        "tokenBudget": asNumber(jsCoalesce(object["tokenBudget"], object["token_budget"]))
            .map { JSONValue.number($0) } ?? .null,
        "tokensUsed": .number(asNumber(jsCoalesce(object["tokensUsed"], object["tokens_used"])) ?? 0),
        "timeUsedSeconds": .number(asNumber(jsCoalesce(object["timeUsedSeconds"], object["time_used_seconds"])) ?? 0),
        "createdAt": .number(asNumber(jsCoalesce(object["createdAt"], object["created_at"])) ?? 0),
        "updatedAt": .number(asNumber(jsCoalesce(object["updatedAt"], object["updated_at"])) ?? 0),
    ])
}

/// Port of `normalizeCodexTokenUsage`.
func normalizeCodexTokenUsage(_ value: JSONValue?, data: [String: JSONValue]?) -> UsageData? {
    guard let info = value, info.objectValue != nil || info.arrayValue != nil else { return nil }
    // TS `isObject` is truthy for arrays too; property access on an array
    // yields undefined, which the accessor below reproduces.
    let scope: JSONValue? = {
        guard let data, let scopeValue = data["scope"], scopeValue.jsIsObjectLike else { return nil }
        return scopeValue
    }()

    func prop(_ base: JSONValue?, _ key: String) -> JSONValue? {
        base?[key]
    }

    // Prefer `last` over `total`; fall back to the info record itself.
    let usageSource: JSONValue = {
        let candidates = ["last", "lastTokenUsage", "last_token_usage", "total", "totalTokenUsage", "total_token_usage"]
        for key in candidates {
            if let candidate = prop(info, key), candidate.jsIsObjectLike {
                return candidate
            }
        }
        return info
    }()

    guard let inputTokens = asNumber(jsCoalesce(prop(usageSource, "inputTokens"), prop(usageSource, "input_tokens"))),
          let outputTokens = asNumber(jsCoalesce(prop(usageSource, "outputTokens"), prop(usageSource, "output_tokens")))
    else { return nil }

    let cacheRead = asNumber(jsCoalesce(
        prop(usageSource, "cachedInputTokens"),
        prop(usageSource, "cached_input_tokens"),
        prop(usageSource, "cacheReadInputTokens"),
        prop(usageSource, "cache_read_input_tokens")
    ))
    let contextTokens = asNumber(jsCoalesce(
        prop(info, "contextTokens"),
        prop(info, "context_tokens"),
        prop(usageSource, "contextTokens"),
        prop(usageSource, "context_tokens")
    )) ?? inputTokens
    let contextWindow = asNumber(jsCoalesce(prop(info, "modelContextWindow"), prop(info, "model_context_window")))
    let threadId = asString(jsCoalesce(
        data?["thread_id"],
        data?["threadId"],
        prop(scope, "thread_id"),
        prop(scope, "threadId"),
        prop(info, "thread_id"),
        prop(info, "threadId")
    ))
    let scopeRole = asString(jsCoalesce(data?["scope_role"], data?["scopeRole"], prop(scope, "role")))

    return UsageData(
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        cacheCreationInputTokens: nil,
        cacheReadInputTokens: cacheRead,
        contextTokens: contextTokens,
        contextWindow: contextWindow,
        threadId: threadId,
        scopeRole: scopeRole
    )
}

/// Port of `normalizePlanStatus`.
func normalizePlanStatus(_ value: JSONValue?) -> String {
    let raw: String = {
        guard let text = value?.stringValue else { return "" }
        var lowered = text.jsTrimmed.lowercased()
        lowered = lowered.replacingOccurrences(of: " ", with: "_")
        lowered = lowered.replacingOccurrences(of: "-", with: "_")
        // JS `[\s-]` also folds tabs/newlines; whitespace inside a status
        // token is not observed on this wire, but stay faithful.
        lowered = lowered.replacingOccurrences(of: "\t", with: "_")
        lowered = lowered.replacingOccurrences(of: "\n", with: "_")
        lowered = lowered.replacingOccurrences(of: "\r", with: "_")
        return lowered
    }()
    if raw == "completed" || raw == "complete" || raw == "done" { return "completed" }
    if raw == "in_progress" || raw == "inprogress" || raw == "active" || raw == "running" { return "in_progress" }
    return "pending"
}

/// Port of `normalizePlanEntries` — returns `{step, status}` records.
func normalizePlanEntries(_ value: JSONValue?) -> [JSONValue] {
    let record = value?.objectValue
    let entries: [JSONValue] = {
        if let items = value?.arrayValue { return items }
        if let items = record?["plan"]?.arrayValue { return items }
        if let items = record?["items"]?.arrayValue { return items }
        if let items = record?["steps"]?.arrayValue { return items }
        return []
    }()

    var plan: [JSONValue] = []
    for entry in entries {
        if let text = entry.stringValue {
            plan.append(.object(["step": .string(text), "status": .string("pending")]))
            continue
        }
        guard let object = entry.objectValue else { continue }
        let step = asString(object["step"])
            ?? asString(object["content"])
            ?? asString(object["text"])
            ?? asString(object["title"])
            ?? asString(object["description"])
        guard let step, !step.isEmpty else { continue }
        plan.append(.object([
            "step": .string(step),
            "status": .string(normalizePlanStatus(jsCoalesce(object["status"], object["state"]))),
        ]))
    }
    return plan
}

// MARK: - Codex review parsing

/// Port of `normalizeCodexReviewFinding`.
func normalizeCodexReviewFinding(_ value: JSONValue) -> CodexReviewFinding? {
    guard let object = value.objectValue else { return nil }
    guard let title = asString(object["title"]), !title.isEmpty,
          let body = asString(object["body"]), !body.isEmpty else { return nil }

    let codeLocation: [String: JSONValue]? =
        object["code_location"]?.objectValue ?? object["codeLocation"]?.objectValue
    let lineRange: [String: JSONValue]? = codeLocation.flatMap { location in
        location["line_range"]?.objectValue ?? location["lineRange"]?.objectValue
    }

    return CodexReviewFinding(
        title: title,
        body: body,
        priority: asNumber(object["priority"]),
        confidenceScore: asNumber(jsCoalesce(object["confidence_score"], object["confidenceScore"])),
        filePath: codeLocation.flatMap { location in
            asString(jsCoalesce(location["absolute_file_path"], location["absoluteFilePath"], location["path"]))
        },
        lineStart: lineRange.flatMap { asNumber($0["start"]) },
        lineEnd: lineRange.flatMap { asNumber($0["end"]) }
    )
}

/// Port of `normalizeCodexReviewJson`.
func normalizeCodexReviewJson(_ value: JSONValue) -> CodexReview? {
    guard let object = value.objectValue else { return nil }
    let hasReviewMarker = object["findings"]?.arrayValue != nil
        || object.keys.contains("overall_correctness")
        || object.keys.contains("overallCorrectness")
        || object.keys.contains("overall_explanation")
        || object.keys.contains("overallExplanation")
    guard hasReviewMarker else { return nil }

    let findings: [CodexReviewFinding] = object["findings"]?.arrayValue?
        .compactMap(normalizeCodexReviewFinding) ?? []

    let overallCorrectness = asString(jsCoalesce(object["overall_correctness"], object["overallCorrectness"]))
    let overallExplanation = asString(jsCoalesce(object["overall_explanation"], object["overallExplanation"]))
    let overallConfidenceScore = asNumber(jsCoalesce(object["overall_confidence_score"], object["overallConfidenceScore"]))

    // TS treats an empty-string correctness/explanation as falsy here.
    let correctnessPresent = (overallCorrectness ?? "").isEmpty == false
    let explanationPresent = (overallExplanation ?? "").isEmpty == false
    if findings.isEmpty && !correctnessPresent && !explanationPresent && overallConfidenceScore == nil {
        return nil
    }

    return CodexReview(
        findings: findings,
        overallCorrectness: overallCorrectness,
        overallExplanation: overallExplanation,
        overallConfidenceScore: overallConfidenceScore
    )
}

/// Port of `parseCodexReviewMessage`.
func parseCodexReviewMessage(_ message: String) -> CodexReview? {
    let trimmed = message.jsTrimmed
    guard trimmed.hasPrefix("{") && trimmed.hasSuffix("}") else { return nil }
    guard let parsed = try? JSONDecoder().decode(JSONValue.self, from: Data(trimmed.utf8)) else { return nil }
    return normalizeCodexReviewJson(parsed)
}

// MARK: - Claude 'output' family

/// Port of `normalizeAssistantOutput`.
func normalizeAssistantOutput(
    messageId: String,
    localId: String?,
    createdAt: Int,
    data: [String: JSONValue],
    meta: JSONValue?
) -> NormalizedMessage? {
    let uuid = asString(data["uuid"]) ?? messageId
    let parentUUID = asString(data["parentUuid"])
    let isSidechain = data["isSidechain"]?.jsTruthy ?? false
    let agentTimestamp = parseAgentTimestampMs(data["timestamp"])
    let parentToolUseId = asString(data["parentToolUseId"])

    guard let message = data["message"], message.jsIsObjectLike else { return nil }

    let modelContent = message["content"]
    var blocks: [NormalizedAgentContent] = []

    if let text = modelContent?.stringValue {
        blocks.append(.text(.init(text: text, uuid: uuid, parentUUID: parentUUID)))
    } else if let items = modelContent?.arrayValue {
        for block in items {
            guard let object = block.objectValue, let type = object["type"]?.stringValue else { continue }
            if type == "text", let text = object["text"]?.stringValue {
                blocks.append(.text(.init(text: text, uuid: uuid, parentUUID: parentUUID)))
                continue
            }
            if type == "thinking", let thinking = object["thinking"]?.stringValue {
                blocks.append(.reasoning(.init(text: thinking, uuid: uuid, parentUUID: parentUUID)))
                continue
            }
            if type == "tool_use", let id = object["id"]?.stringValue {
                let name = asString(object["name"]) ?? "Tool"
                let input = object["input"] // key-presence == TS `'input' in block`
                let description: String? = {
                    guard let inputObject = input?.objectValue else { return nil }
                    return inputObject["description"]?.stringValue
                }()
                blocks.append(.toolCall(ToolUseContent(
                    id: id,
                    name: name,
                    input: input,
                    description: description,
                    uuid: uuid,
                    parentUUID: parentUUID
                )))
            }
        }
    }

    let usage = message["usage"]?.objectValue
    let inputTokens = usage.flatMap { asNumber($0["input_tokens"]) }
    let outputTokens = usage.flatMap { asNumber($0["output_tokens"]) }
    let model = asString(message["model"])

    let usageData: UsageData? = {
        guard let inputTokens, let outputTokens else { return nil }
        return UsageData(
            inputTokens: inputTokens,
            outputTokens: outputTokens,
            cacheCreationInputTokens: usage.flatMap { asNumber($0["cache_creation_input_tokens"]) },
            cacheReadInputTokens: usage.flatMap { asNumber($0["cache_read_input_tokens"]) },
            contextWindow: usage.flatMap { asNumber($0["context_window"]) },
            serviceTier: usage.flatMap { asString($0["service_tier"]) }
        )
    }()

    return NormalizedMessage(
        id: messageId,
        localId: localId,
        createdAt: createdAt,
        content: .agent(blocks),
        isSidechain: isSidechain,
        parentToolUseId: parentToolUseId,
        meta: meta,
        usage: usageData,
        model: model,
        agentTimestamp: agentTimestamp
    )
}

/// Port of `normalizeUserOutput` — tool results, sidechain markers, and
/// CLI-wrapped real user messages arriving through the agent output path.
func normalizeUserOutput(
    messageId: String,
    localId: String?,
    createdAt: Int,
    data: [String: JSONValue],
    meta: JSONValue?
) -> NormalizedMessage? {
    let uuid = asString(data["uuid"]) ?? messageId
    let parentUUID = asString(data["parentUuid"])
    let isSidechain = data["isSidechain"]?.jsTruthy ?? false
    let agentTimestamp = parseAgentTimestampMs(data["timestamp"])
    let parentToolUseId = asString(data["parentToolUseId"])

    guard let message = data["message"], message.jsIsObjectLike else { return nil }

    let messageContent = message["content"]

    // All string-content user messages here are system-injected (subagent
    // prompts, task notifications, system reminders): emit as sidechain so
    // the uuid/parentUUID chain is preserved (sidechain and non-sidechain
    // alike — the two TS branches collapse to one shape).
    if let prompt = messageContent?.stringValue {
        return NormalizedMessage(
            id: messageId,
            localId: localId,
            createdAt: createdAt,
            content: .agent([.sidechain(.init(uuid: uuid, parentUUID: parentUUID, prompt: prompt))]),
            isSidechain: true,
            parentToolUseId: parentToolUseId,
            agentTimestamp: agentTimestamp
        )
    }

    // Sidechain array content serialized as [{type:'text', …}] — join the
    // text parts and treat as the sidechain prompt.
    if isSidechain, let items = messageContent?.arrayValue {
        let textParts: [String] = items.compactMap { block in
            guard let object = block.objectValue, object["type"] == .string("text") else { return nil }
            return object["text"]?.stringValue
        }
        if !textParts.isEmpty {
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .agent([.sidechain(.init(uuid: uuid, parentUUID: parentUUID, prompt: textParts.joined(separator: "\n\n")))]),
                isSidechain: true,
                parentToolUseId: parentToolUseId,
                agentTimestamp: agentTimestamp
            )
        }
    }

    // Non-sidechain array content that is entirely text blocks: a real user
    // message the CLI wrapped as agent output — render in the user lane.
    if !isSidechain, let items = messageContent?.arrayValue {
        let textParts: [String] = items.compactMap { block in
            guard let object = block.objectValue, object["type"] == .string("text") else { return nil }
            return object["text"]?.stringValue
        }
        if !textParts.isEmpty && textParts.count == items.count {
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .user(text: textParts.joined(separator: "\n\n"), attachments: nil),
                isSidechain: false,
                meta: meta,
                agentTimestamp: agentTimestamp
            )
        }
    }

    var blocks: [NormalizedAgentContent] = []

    if let items = messageContent?.arrayValue {
        for block in items {
            guard let object = block.objectValue, let type = object["type"]?.stringValue else { continue }
            if type == "text", let text = object["text"]?.stringValue {
                blocks.append(.text(.init(text: text, uuid: uuid, parentUUID: parentUUID)))
                continue
            }
            if type == "tool_result", let toolUseId = object["tool_use_id"]?.stringValue {
                let isError = object["is_error"]?.jsTruthy ?? false
                let rawContent = object["content"] // key presence == `'content' in block`
                // `embeddedToolUseResult ?? rawContent` — an absent or null
                // `data.toolUseResult` falls through to the block content.
                let content = jsCoalesce(data["toolUseResult"]) ?? rawContent

                let permissions = normalizeToolResultPermissions(object["permissions"])

                blocks.append(.toolResult(ToolResultContent(
                    toolUseId: toolUseId,
                    content: content,
                    isError: isError,
                    uuid: uuid,
                    parentUUID: parentUUID,
                    permissions: permissions
                )))
            }
        }
    }

    return NormalizedMessage(
        id: messageId,
        localId: localId,
        createdAt: createdAt,
        content: .agent(blocks),
        isSidechain: isSidechain,
        parentToolUseId: parentToolUseId,
        meta: meta,
        agentTimestamp: agentTimestamp
    )
}

// MARK: - agy (Antigravity)

/// Port of `humanizeAgyActionType`: "RUN_COMMAND" → "Run command".
func humanizeAgyActionType(_ type: String) -> String {
    let words = type.lowercased().split(separator: "_").map(String.init).filter { !$0.isEmpty }
    guard !words.isEmpty else { return "Tool" }
    return words.enumerated().map { index, word in
        index == 0 ? word.prefix(1).uppercased() + word.dropFirst() : word
    }.joined(separator: " ")
}

/// Canonical tool ids for agy synthetic cards (normalizeAgent.ts).
public let agyTaskLogTool = "AgyTaskLog"
public let agyAsyncTaskTool = "AgyAsyncTask"
public let agyErrorTool = "AgyError"

/// Port of `stripAgyActionPreamble`: drop the bookkeeping timestamp lines,
/// the per-file metadata header on reads, and the model-directed instruction
/// on write/edit confirmations; keep the substantive result.
func stripAgyActionPreamble(_ content: String, name: String, rawActionName: String?) -> String {
    var result = content

    // /^(?:Created At:.*(?:\r?\n|$))?(?:Completed At:.*(?:\r?\n|$))?/ —
    // anchored optional lines, in this order.
    if let stripped = stripLeadingLine(of: result, prefix: "Created At:") { result = stripped }
    if let stripped = stripLeadingLine(of: result, prefix: "Completed At:") { result = stripped }

    if name == "Read" || rawActionName == "VIEW_FILE" {
        // /^(?:(?:File Path:|Total Lines:|Total Bytes:|Showing lines\b).*(?:\r?\n|$))+/
        while true {
            let next = stripLeadingLine(of: result, prefix: "File Path:")
                ?? stripLeadingLine(of: result, prefix: "Total Lines:")
                ?? stripLeadingLine(of: result, prefix: "Total Bytes:")
                ?? stripLeadingLine(of: result, wordBoundedPrefix: "Showing lines")
            guard let next else { break }
            result = next
        }
        // /^The following code has been modified to include a line number.*(?:\r?\n|$)/
        if let stripped = stripLeadingLine(
            of: result,
            prefix: "The following code has been modified to include a line number"
        ) { result = stripped }
    }

    if name == "Write" || name == "Edit" || rawActionName == "CODE_ACTION" {
        // /\s*If relevant, proactively run terminal commands[\s\S]*$/ —
        // first occurrence, the whitespace run directly before it included,
        // to end of string (`trimEnd` of the prefix is exactly what the
        // greedy leading `\s*` consumes).
        if let range = result.range(of: "If relevant, proactively run terminal commands") {
            result = String(result[..<range.lowerBound]).jsTrimmedEnd
        }
    }

    return result.jsTrimmed
}

/// Remove one leading line (terminator included) when the text starts with
/// `prefix`; `nil` when it does not.
private func stripLeadingLine(of text: String, prefix: String) -> String? {
    guard text.hasPrefix(prefix) else { return nil }
    return dropFirstLine(of: text)
}

/// Same, requiring a `\b` word boundary right after the prefix.
private func stripLeadingLine(of text: String, wordBoundedPrefix prefix: String) -> String? {
    guard text.hasPrefix(prefix) else { return nil }
    let afterIndex = text.index(text.startIndex, offsetBy: prefix.count)
    if afterIndex < text.endIndex {
        let next = text[afterIndex]
        if next.isLetter || next.isNumber || next == "_" { return nil }
    }
    return dropFirstLine(of: text)
}

private func dropFirstLine(of text: String) -> String {
    guard let newlineRange = text.range(of: "\n") else { return "" }
    // Also swallow a preceding \r (the JS pattern is `\r?\n`).
    return String(text[newlineRange.upperBound...])
}

/// Port of `stripAgyReadArtifacts`: drop the trailing
/// "The above content shows/does NOT show…" note.
func stripAgyReadArtifacts(_ content: String) -> String {
    // /\n?The above content (?:shows|does NOT show)[\s\S]*$/
    let showsRange = content.range(of: "The above content shows")
    let notShowsRange = content.range(of: "The above content does NOT show")
    let matchRange: Range<String.Index>? = {
        switch (showsRange, notShowsRange) {
        case (nil, nil): return nil
        case (let some?, nil): return some
        case (nil, let some?): return some
        case (let a?, let b?): return a.lowerBound < b.lowerBound ? a : b
        }
    }()
    guard let matchRange else { return content.jsTrimmedEnd }
    var start = matchRange.lowerBound
    if start > content.startIndex {
        let previous = content.index(before: start)
        if content[previous] == "\n" { start = previous }
    }
    return String(content[..<start]).jsTrimmedEnd
}

/// Port of `stripAgyEchoedTaskResult`: strip an echoed
/// "[Message] timestamp=…" task-result block from planner prose.
func stripAgyEchoedTaskResult(_ text: String) -> String {
    agyEchoedTaskResultRegex.removingFirstMatch(in: text).jsTrimmed
}

private let agyEchoedTaskResultRegex = JSRegex("\\n*\\[Message\\]\\s+timestamp=[\\s\\S]*\\z")

/// Port of `parseAgyAsyncTaskMessage`.
func parseAgyAsyncTaskMessage(_ raw: String) -> (body: String, summary: String, isError: Bool) {
    var body = raw
    let contentEq = raw.range(of: "content=")
    let endTag = raw.range(of: "</SYSTEM_MESSAGE>")
    if let contentEq {
        let end = endTag?.lowerBound ?? raw.endIndex
        // JS slice tolerates end < start (yields ''): mirror that.
        body = end > contentEq.upperBound ? String(raw[contentEq.upperBound..<end]) : ""
    } else if let endTag {
        body = String(raw[..<endTag.lowerBound])
    }
    // De-indent: /^[\t ]+/gm → strip leading tabs/spaces per line.
    body = body
        .components(separatedBy: "\n")
        .map { line -> String in
            var view = Substring(line)
            while let first = view.first, first == " " || first == "\t" {
                view.removeFirst()
            }
            return String(view)
        }
        .joined(separator: "\n")
        .jsTrimmed

    let taskNumber: String? = agyTaskIdRegex.firstMatch(in: raw).flatMap { $0.count > 1 ? $0[1] : nil }
    let taskLabel = taskNumber.map { "task-\($0)" } ?? "Background task"
    let failMatch = agyFailExitRegex.firstMatch(in: body)
    let isError = failMatch != nil
    var outcome = ""
    if let failMatch, failMatch.count > 1, let exitCode = failMatch[1] {
        outcome = "failed (exit \(exitCode))"
    } else if agyCompletedRegex.test(body) {
        outcome = "completed"
    }
    let summary = outcome.isEmpty ? taskLabel : "\(taskLabel) \u{00B7} \(outcome)"
    return (body, summary, isError)
}

private let agyTaskIdRegex = JSRegex("task-(\\d+)")
private let agyFailExitRegex = JSRegex("failed with exit code:?\\s*(\\d+)", caseInsensitive: true)
private let agyCompletedRegex = JSRegex("completed successfully", caseInsensitive: true)

/// Port of `parseAgyErrorMessage`.
func parseAgyErrorMessage(_ raw: String) -> (body: String, summary: String) {
    // /^Created At:.*(?:\r?\n)?/gm — drop every line starting "Created At:".
    var body = raw
        .components(separatedBy: "\n")
        .filter { !$0.hasPrefix("Created At:") }
        .joined(separator: "\n")
    // /\n?Guidance:[\s\S]*$/ — cut from the first "Guidance:" (preceding \n
    // included) to the end.
    if let range = body.range(of: "Guidance:") {
        var start = range.lowerBound
        if start > body.startIndex {
            let previous = body.index(before: start)
            if body[previous] == "\n" { start = previous }
        }
        body = String(body[..<start])
    }
    // /\n?Retries remaining:.*$/m — remove the first such segment up to its
    // line end (preceding \n included).
    if let range = body.range(of: "Retries remaining:") {
        var start = range.lowerBound
        if start > body.startIndex {
            let previous = body.index(before: start)
            if body[previous] == "\n" { start = previous }
        }
        let lineEnd = body.range(of: "\n", range: range.upperBound..<body.endIndex)?.lowerBound ?? body.endIndex
        body.removeSubrange(start..<lineEnd)
    }
    body = body.jsTrimmed
    let summary = agyInvalidToolCallRegex.test(raw) ? "Invalid tool call" : "Error"
    return (body, summary)
}

private let agyInvalidToolCallRegex = JSRegex("invalid tool call", caseInsensitive: true)

/// Port of `AGY_TOOL_SPECS` + `AGY_ARG_KEY_MAP` + `AGY_ARG_NOISE`.
private struct AgyToolSpec: Sendable {
    let name: String
    let buildInput: @Sendable ([String: JSONValue]) -> [(String, JSONValue?)]
}

private let agyToolSpecs: [String: AgyToolSpec] = [
    "run_command": AgyToolSpec(name: "Bash") { args in
        [("command", args["CommandLine"]), ("cwd", args["Cwd"])]
    },
    "view_file": AgyToolSpec(name: "Read") { args in
        [("file_path", jsCoalesce(args["AbsolutePath"], args["RelativePath"]))]
    },
    "write_to_file": AgyToolSpec(name: "Write") { args in
        [("file_path", args["TargetFile"]), ("content", args["CodeContent"])]
    },
    "replace_file_content": AgyToolSpec(name: "Edit") { args in
        [
            ("file_path", args["TargetFile"]),
            ("old_string", args["TargetContent"]),
            ("new_string", args["ReplacementContent"]),
        ]
    },
    "grep_search": AgyToolSpec(name: "Grep") { args in
        [
            ("pattern", jsCoalesce(args["Query"], args["SearchQuery"])),
            ("path", jsCoalesce(args["SearchDirectory"], args["SearchPath"])),
        ]
    },
    "list_dir": AgyToolSpec(name: "LS") { args in
        [("path", jsCoalesce(args["DirectoryPath"], args["AbsolutePath"]))]
    },
]

private let agyArgKeyMap: [String: String] = [
    "CommandLine": "command",
    "Cwd": "cwd",
    "AbsolutePath": "file_path",
    "RelativePath": "file_path",
    "TargetFile": "file_path",
    "FilePath": "file_path",
    "Path": "path",
    "DirectoryPath": "path",
    "Query": "query",
    "SearchQuery": "query",
    "Pattern": "pattern",
    "Url": "url",
    "URL": "url",
]

private let agyArgNoise: Set<String> = ["toolAction", "toolSummary", "WaitMsBeforeAsync", "Blocking"]

/// A value agy considers "empty" and drops: null, undefined, or ''.
private func isAgyEmptyValue(_ value: JSONValue?) -> Bool {
    guard let value else { return true }
    if value == .null { return true }
    if value == .string("") { return true }
    return false
}

/// Port of `normalizeAgyToolInput`.
private func normalizeAgyToolInput(_ args: [String: JSONValue]) -> JSONValue? {
    var out: [String: JSONValue] = [:]
    for (key, value) in args {
        if agyArgNoise.contains(key) { continue }
        if isAgyEmptyValue(value) { continue }
        out[agyArgKeyMap[key] ?? key] = value
    }
    return out.isEmpty ? nil : .object(out)
}

/// Port of `mapAgyToolCall`.
private func mapAgyToolCall(
    toolName: String?,
    actionType: String,
    args: [String: JSONValue]?
) -> (name: String, input: JSONValue?, description: String?) {
    let description = args.flatMap { asString($0["toolSummary"]) }
    let spec = toolName.flatMap { agyToolSpecs[$0] }
    if let spec {
        var built: [String: JSONValue] = [:]
        for (key, value) in spec.buildInput(args ?? [:]) {
            if !isAgyEmptyValue(value) { built[key] = value }
        }
        return (spec.name, built.isEmpty ? nil : .object(built), description)
    }
    let name = humanizeAgyActionType(toolName ?? actionType)
    let input = args.flatMap(normalizeAgyToolInput)
    return (name, input, description)
}

// MARK: - Skip filters

/// Port of `isSkippableAgentContent`.
public func isSkippableAgentContent(_ content: JSONValue) -> Bool {
    guard let object = content.objectValue, object["type"] == .string("output") else { return false }
    guard let data = object["data"]?.objectValue else { return false }
    if data["isMeta"]?.jsTruthy == true || data["isCompactSummary"]?.jsTruthy == true { return true }
    // Empty away_summary recaps and empty agy planner steps carry nothing
    // to render — skip cleanly.
    if data["type"] == .string("system"), data["subtype"] == .string("away_summary"),
       (asString(data["content"]) ?? "").jsTrimmed.isEmpty {
        return true
    }
    if data["type"] == .string("agy_message"),
       (asString(data["content"]) ?? "").jsTrimmed.isEmpty {
        return true
    }
    return !isClaudeChatVisibleMessage(type: data["type"], subtype: data["subtype"])
}

/// Port of `isCodexContent`.
public func isCodexContent(_ content: JSONValue) -> Bool {
    content.objectValue?["type"] == .string(agentMessagePayloadType)
}

// MARK: - normalizeAgentRecord

private let piStreamSnapshotIdRegex = JSRegex("\\Api-.+-turn-\\d+-message-\\d+-text-\\d+\\z")
private let agyTaskLogRegex = JSRegex("\\AInside the task-(\\d+) log\\b")

/// Port of `normalizeAgentRecord` — dispatch on the agent payload family.
// swiftlint:disable:next cyclomatic_complexity function_body_length
func normalizeAgentRecord(
    messageId: String,
    localId: String?,
    createdAt: Int,
    content: JSONValue,
    meta: JSONValue?
) -> NormalizedMessage? {
    guard let contentObject = content.objectValue,
          let contentType = contentObject["type"]?.stringValue else { return nil }

    if contentType == "output" {
        guard let data = contentObject["data"]?.objectValue,
              let dataType = data["type"]?.stringValue else { return nil }

        // Skip meta/compact-summary messages (parity with hapi-app).
        if data["isMeta"]?.jsTruthy == true { return nil }
        if data["isCompactSummary"]?.jsTruthy == true { return nil }
        if !isClaudeChatVisibleMessage(type: data["type"], subtype: data["subtype"]) { return nil }

        if dataType == "assistant" {
            return normalizeAssistantOutput(messageId: messageId, localId: localId, createdAt: createdAt, data: data, meta: meta)
        }
        if dataType == "user" {
            return normalizeUserOutput(messageId: messageId, localId: localId, createdAt: createdAt, data: data, meta: meta)
        }
        if dataType == "summary", let summary = data["summary"]?.stringValue {
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .agent([.summary(summary)]),
                isSidechain: false,
                meta: meta
            )
        }
        if dataType == "system", data["subtype"] == .string("api_error") {
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .event(.apiError(
                    retryAttempt: asNumber(data["retryAttempt"]) ?? 0,
                    maxRetries: asNumber(data["maxRetries"]) ?? 0,
                    error: data["error"]
                )),
                isSidechain: false,
                meta: meta
            )
        }
        if dataType == "system", data["subtype"] == .string("turn_duration") {
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .event(.turnDuration(
                    durationMs: asNumber(data["durationMs"]) ?? 0,
                    targetMessageId: asString(data["messageId"])
                )),
                isSidechain: false,
                meta: meta
            )
        }
        if dataType == "system", data["subtype"] == .string("away_summary") {
            // Empty recaps were dropped by isSkippableAgentContent upstream.
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .event(.recap(text: asString(data["content"]) ?? "")),
                isSidechain: false,
                meta: meta
            )
        }
        if dataType == "system", data["subtype"] == .string("microcompact_boundary") {
            let metadata = data["microcompactMetadata"]?.objectValue
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .event(.microcompact(
                    trigger: metadata.flatMap { asString($0["trigger"]) } ?? "auto",
                    preTokens: metadata.flatMap { asNumber($0["preTokens"]) } ?? 0,
                    tokensSaved: metadata.flatMap { asNumber($0["tokensSaved"]) } ?? 0
                )),
                isSidechain: false,
                meta: meta
            )
        }
        if dataType == "system", data["subtype"] == .string("compact_boundary") {
            let metadata = data["compactMetadata"]?.objectValue
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .event(.compact(
                    trigger: metadata.flatMap { asString($0["trigger"]) } ?? "auto",
                    preTokens: metadata.flatMap { asNumber($0["preTokens"]) } ?? 0
                )),
                isSidechain: false,
                meta: meta
            )
        }

        // agy (Antigravity) PTY messages.
        if dataType == "agy_message" {
            let text = stripAgyEchoedTaskResult(asString(data["content"]) ?? "")
            if text.jsTrimmed.isEmpty { return nil }
            // Transitional "Inside the task-NNN log…" narration → compact chip.
            if let taskLog = agyTaskLogRegex.firstMatch(in: text), let taskNumber = taskLog[1] {
                let toolCallId = "\(messageId):tasklog"
                return NormalizedMessage(
                    id: messageId,
                    localId: localId,
                    createdAt: createdAt,
                    content: .agent([
                        .toolCall(ToolUseContent(
                            id: toolCallId,
                            name: agyTaskLogTool,
                            input: .object(["task": .string("task-\(taskNumber)")]),
                            description: nil,
                            uuid: messageId,
                            parentUUID: nil
                        )),
                        .toolResult(ToolResultContent(
                            toolUseId: toolCallId,
                            content: .string(""),
                            isError: false,
                            uuid: messageId,
                            parentUUID: nil
                        )),
                    ]),
                    isSidechain: false,
                    meta: meta
                )
            }
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .agent([.text(.init(text: text, uuid: messageId, parentUUID: nil))]),
                isSidechain: false,
                meta: meta,
                model: asString(data["model"])
            )
        }

        // agy tool ACTION → completed tool card.
        if dataType == "agy_tool_action" {
            let rawActionName = asString(data["name"]) ?? "Tool"
            let toolCallId = asString(data["toolUseId"]) ?? messageId

            var name: String
            var input: JSONValue?
            var description: String?
            var resultContent: String
            var isError = false
            if rawActionName == "SYSTEM_MESSAGE" {
                let parsed = parseAgyAsyncTaskMessage(asString(data["content"]) ?? "")
                name = agyAsyncTaskTool
                input = nil
                description = parsed.summary
                resultContent = parsed.body
                isError = parsed.isError
            } else if rawActionName == "ERROR_MESSAGE" {
                let parsed = parseAgyErrorMessage(asString(data["content"]) ?? "")
                name = agyErrorTool
                input = nil
                description = parsed.summary
                resultContent = parsed.body
                isError = true
            } else {
                let mapped = mapAgyToolCall(
                    toolName: asString(data["toolName"]),
                    actionType: rawActionName,
                    args: data["input"]?.objectValue
                )
                name = mapped.name
                input = mapped.input
                description = mapped.description
                resultContent = stripAgyActionPreamble(asString(data["content"]) ?? "", name: name, rawActionName: rawActionName)
                if name == "Read" || rawActionName == "VIEW_FILE" {
                    resultContent = stripAgyReadArtifacts(resultContent)
                }
            }
            let nativeKind: String? = (name == "Read" || rawActionName == "VIEW_FILE") ? "agy-numbered-read" : nil
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .agent([
                    .toolCall(ToolUseContent(
                        id: toolCallId,
                        name: name,
                        input: input,
                        description: description,
                        nativeKind: nativeKind,
                        uuid: messageId,
                        parentUUID: nil
                    )),
                    .toolResult(ToolResultContent(
                        toolUseId: toolCallId,
                        content: .string(resultContent),
                        isError: isError,
                        uuid: messageId,
                        parentUUID: nil
                    )),
                ]),
                isSidechain: false,
                meta: meta
            )
        }
        return nil
    }

    if contentType == "event" {
        guard let event = normalizeAgentEvent(contentObject["data"]) else { return nil }
        return NormalizedMessage(
            id: messageId,
            localId: localId,
            createdAt: createdAt,
            content: .event(event),
            isSidechain: false,
            meta: meta
        )
    }

    if contentType == agentMessagePayloadType {
        guard let data = contentObject["data"]?.objectValue,
              let dataType = data["type"]?.stringValue else { return nil }

        if dataType == "agent-run-start" || dataType == "agent-run-update" || dataType == "agent-run-trace" {
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .event(AgentEvent(object: data)),
                isSidechain: false,
                meta: meta
            )
        }

        if dataType == "generated-image" {
            guard let imageId = asString(jsCoalesce(data["imageId"], data["image_id"])), !imageId.isEmpty else { return nil }
            let uuid = asString(data["id"]) ?? messageId
            let source = InlineMediaSource.fromWire(data["source"])
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .agent([.generatedImage(GeneratedImageContent(
                    imageId: imageId,
                    fileName: asString(jsCoalesce(data["fileName"], data["file_name"])) ?? "generated-image",
                    mimeType: asString(jsCoalesce(data["mimeType"], data["mime_type"])),
                    uuid: uuid,
                    parentUUID: nil,
                    source: source
                ))]),
                isSidechain: false,
                meta: meta
            )
        }

        if dataType == "error", let message = data["message"]?.stringValue {
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .event(.error(message)),
                isSidechain: false,
                meta: meta
            )
        }

        if dataType == "message", let message = data["message"]?.stringValue {
            let streamId = asString(data["id"])
            let isPiStreamSnapshot = data["streamSnapshot"] == .bool(true)
                || (streamId.map { piStreamSnapshotIdRegex.test($0) } ?? false)
            let review = isPiStreamSnapshot ? nil : parseCodexReviewMessage(message)
            if let review {
                return NormalizedMessage(
                    id: messageId,
                    localId: localId,
                    createdAt: createdAt,
                    content: .agent([.codexReview(review: review, uuid: messageId, parentUUID: nil)]),
                    isSidechain: false,
                    meta: meta
                )
            }
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .agent([.text(.init(text: message, uuid: messageId, streamId: streamId, parentUUID: nil))]),
                isSidechain: false,
                meta: meta
            )
        }

        if dataType == "reasoning", let message = data["message"]?.stringValue {
            let streamId = asString(data["id"]) ?? messageId
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .agent([.reasoning(.init(text: message, uuid: messageId, streamId: streamId, parentUUID: nil))]),
                isSidechain: false,
                meta: meta
            )
        }

        if dataType == "context_compacted" {
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .event(.compact(
                    trigger: asString(data["trigger"]) ?? "auto",
                    preTokens: asNumber(jsCoalesce(data["preTokens"], data["pre_tokens"])) ?? 0
                )),
                isSidechain: false,
                meta: meta
            )
        }

        if dataType == "compact-summary", let summary = data["summary"]?.stringValue {
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .event(.compactSummary(
                    summary: summary,
                    tokensBefore: asNumber(data["tokensBefore"]),
                    estimatedTokensAfter: asNumber(data["estimatedTokensAfter"])
                )),
                isSidechain: false,
                meta: meta
            )
        }

        if dataType == "token_count" {
            guard let usage = normalizeCodexTokenUsage(data["info"], data: data) else { return nil }
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .event(.tokenCount(info: data["info"])),
                isSidechain: false,
                meta: meta,
                usage: usage
            )
        }

        if dataType == "thread_goal_updated" {
            guard let goal = normalizeThreadGoal(data["goal"]) else { return nil }
            let goalThreadId = goal["threadId"]?.stringValue ?? ""
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .event(.threadGoalUpdated(
                    threadId: asString(jsCoalesce(data["threadId"], data["thread_id"])) ?? goalThreadId,
                    turnId: asString(jsCoalesce(data["turnId"], data["turn_id"])),
                    goal: goal
                )),
                isSidechain: false,
                meta: meta
            )
        }

        if dataType == "thread_goal_cleared" {
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .event(.threadGoalCleared(
                    threadId: asString(jsCoalesce(data["threadId"], data["thread_id"]))
                )),
                isSidechain: false,
                meta: meta
            )
        }

        if dataType == "tool-call", let callId = data["callId"]?.stringValue {
            let uuid = asString(data["id"]) ?? messageId
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .agent([.toolCall(ToolUseContent(
                    id: callId,
                    name: asString(data["name"]) ?? "unknown",
                    input: data["input"],
                    description: asString(data["description"]),
                    nativeTitle: asString(jsCoalesce(data["nativeTitle"], data["title"])),
                    nativeKind: asString(jsCoalesce(data["nativeKind"], data["kind"])),
                    progress: data["progress"], // key presence == `'progress' in data`
                    uuid: uuid,
                    parentUUID: nil
                ))]),
                isSidechain: false,
                meta: meta
            )
        }

        if dataType == "tool-call-result", let callId = data["callId"]?.stringValue {
            let uuid = asString(data["id"]) ?? messageId
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .agent([.toolResult(ToolResultContent(
                    toolUseId: callId,
                    content: data["output"],
                    isError: data["is_error"]?.jsTruthy ?? false,
                    uuid: uuid,
                    parentUUID: nil
                ))]),
                isSidechain: false,
                meta: meta
            )
        }

        if dataType == "plan" {
            let plan = normalizePlanEntries(jsCoalesce(data["entries"], data["items"]) ?? .object(data))
            if plan.isEmpty { return nil }
            let uuid = asString(data["id"]) ?? messageId
            let planPayload: JSONValue = .object(["plan": .array(plan), "source": .string("cursor")])
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .agent([
                    .toolCall(ToolUseContent(
                        id: "cursor-plan-state",
                        name: "update_plan",
                        input: planPayload,
                        description: nil,
                        uuid: uuid,
                        parentUUID: nil
                    )),
                    .toolResult(ToolResultContent(
                        toolUseId: "cursor-plan-state",
                        content: planPayload,
                        isError: false,
                        uuid: uuid,
                        parentUUID: nil
                    )),
                ]),
                isSidechain: false,
                meta: meta
            )
        }

        if dataType == "plan_update" {
            let plan = normalizePlanEntries(
                jsCoalesce(data["plan"], data["update"], data["items"], data["steps"]) ?? .object(data)
            )
            if plan.isEmpty { return nil }
            let uuid = asString(data["id"]) ?? messageId
            return NormalizedMessage(
                id: messageId,
                localId: localId,
                createdAt: createdAt,
                content: .agent([
                    .toolCall(ToolUseContent(
                        id: "codex-plan-state",
                        name: "update_plan",
                        input: .object(["plan": .array(plan), "source": .string("codex")]),
                        description: nil,
                        uuid: uuid,
                        parentUUID: nil
                    )),
                    .toolResult(ToolResultContent(
                        toolUseId: "codex-plan-state",
                        content: .object(["plan": .array(plan), "source": .string("codex"), "status": .string("updated")]),
                        isError: false,
                        uuid: "\(uuid):result",
                        parentUUID: nil
                    )),
                ]),
                isSidechain: false,
                meta: meta
            )
        }
    }

    return nil
}
