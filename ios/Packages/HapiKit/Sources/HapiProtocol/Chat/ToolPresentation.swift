import Foundation

// Tool presentation helpers.
//
// Part 1 ports web/src/chat/codexCommandPresentation.ts — REQUIRED by the
// grouping pipeline (`isEligibleForToolGrouping` keys the codex-exploration
// family off these), so it is covered by the golden fixtures.
//
// Part 2 is a fixture-irrelevant convenience for the M2 UI milestones: a
// compact per-tool title/subtitle derivation. The web's full presentation
// catalog (web/src/components/ToolCard/knownTools.tsx, including the rich
// codex command-action rendering) is deliberately deferred to the HapiUI
// work — nothing here feeds the normative projection.

// MARK: - Codex command actions (fixture-relevant)

/// Port of `CodexCommandAction`.
public enum CodexCommandAction: Equatable, Sendable {
    case read(command: String, name: String, path: String)
    case listFiles(command: String, path: String?)
    case search(command: String, query: String?, path: String?)
    case unknown(command: String)
}

private func nonEmptyString(_ value: JSONValue?) -> String? {
    guard let text = value?.stringValue, !text.isEmpty else { return nil }
    return text
}

/// Port of `parseAction`.
private func parseCodexCommandAction(_ value: JSONValue) -> CodexCommandAction? {
    guard let action = value.objectValue else { return nil }
    guard let type = nonEmptyString(action["type"]), let command = nonEmptyString(action["command"]) else { return nil }

    if type == "read" {
        guard let name = nonEmptyString(action["name"]), let path = nonEmptyString(action["path"]) else { return nil }
        return .read(command: command, name: name, path: path)
    }
    if type == "listFiles" {
        return .listFiles(command: command, path: nonEmptyString(action["path"]))
    }
    if type == "search" {
        return .search(command: command, query: nonEmptyString(action["query"]), path: nonEmptyString(action["path"]))
    }
    if type == "unknown" {
        return .unknown(command: command)
    }
    return nil
}

/// Port of `getCodexCommandActions`.
public func getCodexCommandActions(_ block: ToolCallBlock) -> [CodexCommandAction] {
    guard block.tool.name == "CodexBash", let input = block.tool.input?.objectValue else {
        return []
    }
    let raw = jsCoalesce(input["command_actions"], input["commandActions"])
    guard let items = raw?.arrayValue else { return [] }
    return items.compactMap(parseCodexCommandAction)
}

/// Port of `isCodexExplorationTool`.
public func isCodexExplorationTool(_ block: ToolCallBlock) -> Bool {
    let input = block.tool.input?.objectValue
    let source = input.flatMap { nonEmptyString(jsCoalesce($0["command_source"], $0["commandSource"])) }
    if source?.lowercased() == "usershell" { return false }

    let actions = getCodexCommandActions(block)
    guard !actions.isEmpty else { return false }
    return actions.allSatisfy { action in
        switch action {
        case .read, .listFiles, .search: return true
        case .unknown: return false
        }
    }
}

// MARK: - Per-tool title/subtitle (presentation-only, not fixture-covered)

/// Minimal per-tool card labeling for native list rows. Mirrors the common
/// cases of the web `knownTools` catalog; the full catalog (icons, rich
/// views, codex command-action lines) lands with the HapiUI chat views.
public struct ToolPresentation: Equatable, Sendable {
    public var title: String
    public var subtitle: String?

    public static func forTool(_ tool: ChatToolCall) -> ToolPresentation {
        let input = tool.input
        switch tool.name {
        case "Bash", "CodexBash", "shell_command", "run_shell_command":
            return ToolPresentation(
                title: tool.description ?? "Terminal",
                subtitle: getInputStringAny(input, ["command", "cmd"])
            )
        case "Read", "NotebookRead":
            return ToolPresentation(
                title: "Read",
                subtitle: getInputStringAny(input, ["file_path", "path", "notebook_path"])
            )
        case "Write":
            return ToolPresentation(title: "Write", subtitle: getInputStringAny(input, ["file_path", "path"]))
        case "Edit", "MultiEdit":
            return ToolPresentation(title: "Edit", subtitle: getInputStringAny(input, ["file_path", "path"]))
        case "Grep":
            return ToolPresentation(title: "Grep", subtitle: getInputStringAny(input, ["pattern", "query"]))
        case "Glob":
            return ToolPresentation(title: "Glob", subtitle: getInputStringAny(input, ["pattern"]))
        case "LS":
            return ToolPresentation(title: "List files", subtitle: getInputStringAny(input, ["path"]))
        case "WebFetch", "WebSearch":
            return ToolPresentation(
                title: tool.name == "WebFetch" ? "Fetch" : "Web search",
                subtitle: getInputStringAny(input, ["url", "query"])
            )
        case "Task", "Agent":
            return ToolPresentation(
                title: getInputStringAny(input, ["description"]) ?? "Subagent",
                subtitle: getInputStringAny(input, ["subagent_type"])
            )
        case "TodoWrite", "update_plan":
            return ToolPresentation(title: "Plan", subtitle: nil)
        case "AskUserQuestion", "ask_user_question", "CursorAskQuestion":
            return ToolPresentation(title: "Question", subtitle: nil)
        case "request_user_input":
            return ToolPresentation(title: "Input requested", subtitle: nil)
        case "CodexAgent":
            return ToolPresentation(
                title: "Agent run",
                subtitle: getInputStringAny(input, ["statusText", "summary", "activity"])
            )
        case agyAsyncTaskTool:
            return ToolPresentation(title: "Background task", subtitle: tool.description)
        case agyErrorTool:
            return ToolPresentation(title: "Invalid tool call", subtitle: tool.description)
        case agyTaskLogTool:
            return ToolPresentation(title: "Task log", subtitle: getInputStringAny(input, ["task"]))
        default:
            return ToolPresentation(
                title: tool.nativeTitle ?? tool.description ?? tool.name,
                subtitle: getInputStringAny(input, ["file_path", "path", "pattern", "query", "command", "url"])
            )
        }
    }
}
