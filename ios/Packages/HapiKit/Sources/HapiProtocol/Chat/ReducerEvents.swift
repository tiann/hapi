import Foundation

// Port of web/src/chat/reducerEvents.ts — CLI pipe-format limit parsing,
// consecutive-event dedupe, api-error folding.

private let limitReachedRegex = JSRegex("\\AClaude AI usage limit reached\\|(\\d+)(?:\\|([^|]*))?\\z")
private let limitWarningRegex = JSRegex("\\AClaude AI usage limit warning\\|(\\d+)\\|(\\d+)\\|([^|]*)\\z")

/// Port of `parseClaudeUsageLimit`.
func parseClaudeUsageLimit(_ text: String) -> AgentEvent? {
    if let match = limitReachedRegex.firstMatch(in: text), let rawTimestamp = match[1] {
        if let timestamp = Double(rawTimestamp), timestamp.isFinite {
            // `reachedMatch[2] || ''` — an absent or empty capture stays ''.
            return .limitReached(endsAt: timestamp, limitType: match.count > 2 ? (match[2] ?? "") : "")
        }
    }

    if let match = limitWarningRegex.firstMatch(in: text),
       let rawTimestamp = match[1], let rawUtilization = match[2] {
        if let timestamp = Double(rawTimestamp), timestamp.isFinite,
           let utilizationInt = Double(rawUtilization), utilizationInt.isFinite {
            let limitType = match.count > 3 ? (match[3] ?? "") : ""
            return .limitWarning(utilization: utilizationInt / 100, endsAt: timestamp, limitType: limitType)
        }
    }

    return nil
}

/// Port of `parseMessageAsEvent`.
func parseMessageAsEvent(_ msg: NormalizedMessage) -> AgentEvent? {
    if msg.isSidechain { return nil }
    guard let content = msg.agentContent else { return nil }

    for item in content {
        if case .text(let text) = item {
            if let limitEvent = parseClaudeUsageLimit(text.text) {
                return limitEvent
            }
        }
    }

    return nil
}

/// Port of `dedupeAgentEvents`: drops a consecutive repeat of the same
/// title-changed/message/error event (and, generically, any byte-identical
/// event), plus a message event echoing the immediately preceding
/// title-changed title.
public func dedupeAgentEvents(_ blocks: [ChatBlock]) -> [ChatBlock] {
    var result: [ChatBlock] = []
    var prevEventKey: String?
    var prevTitleChangedTo: String?

    for block in blocks {
        guard case .agentEvent(let eventBlock) = block else {
            result.append(block)
            prevEventKey = nil
            prevTitleChangedTo = nil
            continue
        }

        let event = eventBlock.event
        if event.type == "title-changed", let title = event["title"]?.stringValue {
            let trimmed = title.jsTrimmed
            let key = "title-changed:\(trimmed)"
            if key == prevEventKey {
                continue
            }
            result.append(block)
            prevEventKey = key
            prevTitleChangedTo = trimmed
            continue
        }

        if event.type == "message", let message = event["message"]?.stringValue {
            let trimmed = message.jsTrimmed
            let key = "message:\(trimmed)"
            if key == prevEventKey {
                continue
            }
            if let prevTitle = prevTitleChangedTo, trimmed == prevTitle {
                continue
            }
            result.append(block)
            prevEventKey = key
            prevTitleChangedTo = nil
            continue
        }

        if event.type == "error", let message = event["message"]?.stringValue {
            let trimmed = message.jsTrimmed
            let key = "error:\(trimmed)"
            if key == prevEventKey {
                continue
            }
            result.append(block)
            prevEventKey = key
            prevTitleChangedTo = nil
            continue
        }

        // Generic key: TS uses JSON.stringify(event); the canonical
        // serialization is its deterministic stand-in (fixture inputs are
        // key-sorted, so the reference's insertion order is sorted too).
        let key = "event:\(toCanonicalJSON(event.wireValue))"

        if key == prevEventKey {
            continue
        }

        result.append(block)
        prevEventKey = key
        prevTitleChangedTo = nil
    }

    return result
}

/// Port of `foldApiErrorEvents`: consecutive api-error events keep only the
/// latest state.
public func foldApiErrorEvents(_ blocks: [ChatBlock]) -> [ChatBlock] {
    var result: [ChatBlock] = []

    for block in blocks {
        guard case .agentEvent(let eventBlock) = block else {
            result.append(block)
            continue
        }

        if eventBlock.event.type != "api-error" {
            result.append(block)
            continue
        }

        if let last = result.last, case .agentEvent(let prev) = last, prev.event.type == "api-error" {
            result[result.count - 1] = block
        } else {
            result.append(block)
        }
    }

    return result
}
