import Foundation
import HapiProtocol

/// Centered event-row wording: port of `web/src/chat/presentation.ts` via the
/// Android `getEventPresentation`. Render-only (the fixture projection never
/// includes presentation), so date formatting uses Foundation formatters
/// instead of the browser's `toLocaleString` while keeping the same rules.
struct EventPresentation: Equatable {
    /// Leading glyph; nil for plain informational rows.
    var icon: String?
    var text: String
}

// MARK: - Formatting helpers

private func normalizedTimestampMs(_ value: Double) -> Double {
    value < 1_000_000_000_000 ? value * 1000 : value
}

func chatFormatUnixTimestamp(_ value: Double) -> String {
    let date = Date(timeIntervalSince1970: normalizedTimestampMs(value) / 1000)
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy/M/d HH:mm:ss"
    return formatter.string(from: date)
}

func chatFormatResetTime(_ value: Double, now: Date = Date()) -> String {
    let date = Date(timeIntervalSince1970: normalizedTimestampMs(value) / 1000)
    let formatter = DateFormatter()
    formatter.dateFormat = Calendar.current.isDate(date, inSameDayAs: now) ? "H:mm" : "MMM d, H:mm"
    return formatter.string(from: date)
}

/// Known limit types: five_hour → "5-hour", seven_day → "7-day"; otherwise
/// underscores become spaces.
private func formatLimitType(_ limitType: String?) -> String {
    guard let limitType, !limitType.isEmpty else { return "" }
    if limitType == "five_hour" { return "5-hour" }
    if limitType == "seven_day" { return "7-day" }
    return limitType.replacingOccurrences(of: "_", with: " ")
}

func chatFormatDuration(ms: Double) -> String {
    let seconds = ms / 1000
    if seconds < 60 {
        return String(format: "%.1fs", seconds)
    }
    let minutes = Int(seconds / 60)
    let remainder = Int((seconds.truncatingRemainder(dividingBy: 60)).rounded())
    return "\(minutes)m \(remainder)s"
}

private func formatTokenCount(_ value: Double) -> String {
    if value >= 1_000_000 { return String(format: "%.1fM", value / 1_000_000) }
    if value >= 10_000 { return String(format: "%.1fk", value / 1_000) }
    if value >= 1_000 { return "\(Int((value / 1_000).rounded()))k" }
    return formatJSONNumber(value)
}

private func formatGoalStatus(_ status: String) -> String {
    switch status {
    case "active": return "active"
    case "paused": return "paused"
    case "budgetLimited": return "limited by budget"
    case "usageLimited": return "limited by usage"
    case "blocked": return "blocked"
    case "complete": return "complete"
    default: return status
    }
}

private func threadGoalPresentation(_ event: AgentEvent) -> EventPresentation {
    guard let goal = event["goal"]?.chatObject else {
        return EventPresentation(icon: nil, text: "Goal updated")
    }
    let status = goal["status"]?.chatString ?? "updated"
    var parts = ["Goal \(formatGoalStatus(status))"]
    let tokensUsed = goal["tokensUsed"]?.chatNumber ?? goal["tokens_used"]?.chatNumber
    let tokenBudget = goal["tokenBudget"]?.chatNumber ?? goal["token_budget"]?.chatNumber
    if let tokensUsed, let tokenBudget {
        parts.append("\(formatTokenCount(tokensUsed)) / \(formatTokenCount(tokenBudget))")
    }
    return EventPresentation(icon: nil, text: parts.joined(separator: " · "))
}

private func tokenCountPresentation(_ event: AgentEvent) -> EventPresentation {
    let info = event["info"]?.chatObject
    guard let total = info?["total"]?.chatObject ?? info else {
        return EventPresentation(icon: "◷", text: "Context updated")
    }
    let inputTokens = total["inputTokens"]?.chatNumber ?? total["input_tokens"]?.chatNumber
    let outputTokens = total["outputTokens"]?.chatNumber ?? total["output_tokens"]?.chatNumber
    let cachedTokens = total["cachedInputTokens"]?.chatNumber
        ?? total["cacheReadInputTokens"]?.chatNumber
        ?? total["cache_read_input_tokens"]?.chatNumber
    let reasoningTokens = total["reasoningOutputTokens"]?.chatNumber
        ?? total["reasoning_output_tokens"]?.chatNumber
    let contextWindow = total["modelContextWindow"]?.chatNumber
        ?? total["model_context_window"]?.chatNumber

    var parts: [String] = []
    if let inputTokens, let contextWindow, contextWindow > 0 {
        let percent = Int((inputTokens / contextWindow * 100).rounded())
        parts.append("Context \(formatTokenCount(inputTokens)) / \(formatTokenCount(contextWindow)) (\(percent)%)")
    } else if let inputTokens {
        parts.append("Context \(formatTokenCount(inputTokens))")
    } else {
        parts.append("Context updated")
    }
    if let outputTokens { parts.append("out \(formatTokenCount(outputTokens))") }
    if let cachedTokens, cachedTokens > 0 { parts.append("cached \(formatTokenCount(cachedTokens))") }
    if let reasoningTokens, reasoningTokens > 0 { parts.append("reasoning \(formatTokenCount(reasoningTokens))") }
    return EventPresentation(icon: "◷", text: parts.joined(separator: " · "))
}

private func apiErrorDetail(_ error: JSONValue?) -> String? {
    if let text = error?.chatString {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    guard let record = error?.chatObject, record["message"] != nil else { return nil }
    let trimmed = record["message"]?.chatString?.trimmingCharacters(in: .whitespacesAndNewlines)
    return (trimmed?.isEmpty ?? true) ? nil : trimmed
}

// MARK: - Entry point

func eventPresentation(_ event: AgentEvent) -> EventPresentation {
    switch event.type {
    case "api-error":
        let retryAttempt = event["retryAttempt"]?.chatNumber ?? 0
        let maxRetries = event["maxRetries"]?.chatNumber ?? 0
        if maxRetries > 0, retryAttempt >= maxRetries {
            return EventPresentation(icon: "⚠️", text: "API error: Max retries reached")
        }
        if maxRetries > 0 {
            return EventPresentation(
                icon: "⏳",
                text: "API error: Retrying (\(formatJSONNumber(retryAttempt))/\(formatJSONNumber(maxRetries)))"
            )
        }
        if retryAttempt > 0 {
            if let detail = apiErrorDetail(event["error"]) {
                return EventPresentation(icon: "⏳", text: "API error: Retrying... \(detail)")
            }
            return EventPresentation(icon: "⏳", text: "API error: Retrying...")
        }
        return EventPresentation(icon: "⚠️", text: "API error")

    case "switch":
        let mode = event["mode"]?.chatString == "local" ? "local" : "remote"
        return EventPresentation(icon: "🔄", text: "Switched to \(mode)")

    case "title-changed":
        let title = event["title"]?.chatString ?? ""
        return EventPresentation(
            icon: nil,
            text: title.isEmpty ? "Title changed" : "Title changed to \"\(title)\""
        )

    case "permission-mode-changed":
        let mode = event["mode"]?.chatString ?? "default"
        return EventPresentation(icon: "🔐", text: "Permission mode: \(mode)")

    case "limit-warning":
        let percent = Int(((event["utilization"]?.chatNumber ?? 0) * 100).rounded())
        let typeLabel = formatLimitType(event["limitType"]?.chatString)
        let suffix = typeLabel.isEmpty ? "" : " (\(typeLabel))"
        if let endsAt = event["endsAt"]?.chatNumber {
            return EventPresentation(
                icon: "⚠️",
                text: "Usage limit \(percent)%\(suffix) · resets \(chatFormatResetTime(endsAt))"
            )
        }
        return EventPresentation(icon: "⚠️", text: "Usage limit \(percent)%\(suffix)")

    case "limit-reached":
        let typeLabel = formatLimitType(event["limitType"]?.chatString)
        let suffix = typeLabel.isEmpty ? "" : " (\(typeLabel))"
        if let endsAt = event["endsAt"]?.chatNumber {
            return EventPresentation(
                icon: "⏳",
                text: "Usage limit reached\(suffix) until \(chatFormatUnixTimestamp(endsAt))"
            )
        }
        return EventPresentation(icon: "⏳", text: "Usage limit reached\(suffix)")

    case "error":
        return EventPresentation(icon: "⚠️", text: event["message"]?.chatString ?? "Error")

    case "message":
        return EventPresentation(icon: nil, text: event["message"]?.chatString ?? "Message")

    case "turn-duration":
        let ms = event["durationMs"]?.chatNumber ?? 0
        return EventPresentation(icon: "⏱️", text: "Turn: \(chatFormatDuration(ms: ms))")

    case "microcompact":
        let saved = event["tokensSaved"]?.chatNumber ?? 0
        let formatted = saved >= 1000
            ? "\(Int((saved / 1000).rounded()))K"
            : formatJSONNumber(saved)
        return EventPresentation(icon: "📦", text: "Context compacted (saved \(formatted) tokens)")

    case "compact":
        return EventPresentation(icon: "📦", text: "Conversation compacted")

    case "compact-summary":
        return EventPresentation(icon: "📦", text: "Context compacted")

    case "recap":
        let text = event["text"]?.chatString ?? ""
        return EventPresentation(icon: "💭", text: "recap: \(text)")

    case "thread-goal-updated":
        return threadGoalPresentation(event)

    case "thread-goal-cleared":
        return EventPresentation(icon: nil, text: "Goal cleared")

    case "token-count":
        return tokenCountPresentation(event)

    default:
        // Unknown event types: generic raw rendering, truncated.
        return EventPresentation(icon: nil, text: chatTruncate(chatPrettyJSON(event.wireValue), 300))
    }
}
