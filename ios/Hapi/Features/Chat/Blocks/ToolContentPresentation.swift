import Foundation
import HapiProtocol

/// Presentation aliases only. Keep the recorded name/input and chat grouping intact.
func toolPresentationName(_ name: String) -> String {
    let name = name.hasPrefix("functions.") ? String(name.dropFirst("functions.".count)) : name
    switch name {
    case "exec_command": return "Bash"
    case "apply_patch": return "CodexPatch"
    default: return name
    }
}

let terminalToolNames: Set<String> = [
    "Bash", "CodexBash", "shell_command", "run_shell_command", "write_stdin",
]

func toolSourceInput(_ input: JSONValue?, keys: [String]) -> String? {
    input?.chatString ?? chatInputString(input, keys)
}

func isPlanProposalTool(_ name: String) -> Bool {
    name == "ExitPlanMode" || name == "exit_plan_mode"
}

/// Plans are documents in input.plan, not update_plan's checklist or a tool result.
func planProposalMarkdown(_ tool: ChatToolCall) -> String? {
    guard isPlanProposalTool(tool.name),
          let plan = tool.input?[chatKey: "plan"]?.chatString,
          !plan.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    return plan
}

/// A synthesized Codex proposal completes with null output. Keep diagnostics,
/// but don't suggest that its visible document is still waiting for output.
func planProposalShowsResult(_ tool: ChatToolCall) -> Bool {
    if tool.state == .error { return true }
    guard let result = tool.result, result != .null else { return false }
    if let text = result.chatString {
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    return true
}

/// Bounded wrapper traversal; mixed/non-text blocks deliberately retain their
/// JSON representation rather than silently dropping images or resources.
func extractResultText(_ result: JSONValue, depth: Int = 0) -> String? {
    guard depth <= 4 else { return nil }
    switch result {
    case .string(let text): return text
    case .array(let entries):
        var texts: [String] = []
        for entry in entries {
            if let text = entry.chatString {
                texts.append(text)
            } else if let object = entry.chatObject,
                      object["type"] == nil || object["type"]?.chatString == "text",
                      let text = object["text"]?.chatString {
                texts.append(text)
            } else {
                return nil
            }
        }
        return texts.joined(separator: "\n")
    case .object(let object):
        let stdout = object["stdout"]?.chatString
        let stderr = object["stderr"]?.chatString
        if stdout != nil || stderr != nil {
            var parts: [String] = []
            if let out = stdout, !out.isEmpty { parts.append(out) }
            if let err = stderr, !err.isEmpty { parts.append("stderr:\n\(err)") }
            if !parts.isEmpty { return parts.joined(separator: "\n\n") }
            // Empty stdout must not hide a structured error.
        }
        if let content = object["file"]?[chatKey: "content"]?.chatString { return content }
        var emptyText: String?
        for key in ["content", "text", "output", "error", "message", "result", "data"] {
            if let value = object[key], value != .null {
                let text = extractResultText(value, depth: depth + 1)
                if let text, !text.isEmpty { return text }
                if text != nil { emptyText = "" }
                // Preserve a mixed content array in full, not just another field.
                if key == "content", case .array = value, text == nil {
                    return nil
                }
            }
        }
        if stdout != nil || stderr != nil { return "" }
        return emptyText
    default: return nil
    }
}

enum ToolResultStyle: Equatable {
    case terminal
    case code(String?)
    case markdown
}

func toolResultStyle(_ tool: ChatToolCall) -> ToolResultStyle {
    let name = toolPresentationName(tool.name)
    // Errors are literal diagnostics, not markdown or source code.
    if tool.state == .error { return .terminal }
    let parsed = tool.input?[chatKey: "parsed_cmd"]?.chatArray
    let readCommand = name == "CodexBash" && parsed?.count == 1 && parsed?.first?[chatKey: "type"]?.chatString == "read"
    if ["Read", "NotebookRead"].contains(name) || readCommand {
        let file = tool.result?[chatKey: "file"]
        let path = chatInputString(file, ["filePath", "file_path"])
            ?? chatInputString(tool.input, ["file_path", "path", "file", "notebook_path"])
            ?? (readCommand ? chatInputString(parsed?.first, ["name", "path", "file_path"]) : nil)
        return .code(languageForPath(path))
    }
    if ["WebFetch", "WebSearch", "Task", "Agent", "Skill", "ExitPlanMode", "exit_plan_mode"].contains(name) {
        return .markdown
    }
    return .terminal
}

func toolQuestionOptionText(_ option: JSONValue) -> String {
    if let text = option.chatString { return text }
    if let label = chatInputString(option, ["label", "value"]) {
        if let description = chatInputString(option, ["description"]), !description.isEmpty {
            return "\(label) — \(description)"
        }
        return label
    }
    return chatPrettyJSON(option)
}

/// Keep command status visible even when stdout is empty. Technical wire labels
/// avoid conflating the process exit code with the tool call's transport state.
func toolResultMetadata(_ result: JSONValue?, depth: Int = 0) -> [String] {
    guard depth <= 4, let object = result?.chatObject else { return [] }
    let fields = [("exit_code", ["exit_code", "exitCode"]), ("status", ["status"]),
                  ("session_id", ["session_id"]), ("wall_time_seconds", ["wall_time_seconds"])]
    let metadata = fields.compactMap { label, keys -> String? in
        for key in keys {
            guard let value = object[key] else { continue }
            switch value {
            case .string(let text) where !text.isEmpty: return "\(label): \(text)"
            case .number: return "\(label): \(chatPrettyJSON(value))"
            default: continue
            }
        }
        return nil
    }
    if !metadata.isEmpty { return metadata }
    for key in ["output", "result", "data"] {
        let nested = toolResultMetadata(object[key], depth: depth + 1)
        if !nested.isEmpty { return nested }
    }
    return []
}
