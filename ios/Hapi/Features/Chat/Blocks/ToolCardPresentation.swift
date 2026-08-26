import Foundation
import HapiProtocol

/// Collapsed tool-card header: SF Symbol + title + optional subtitle. Port of
/// the presentation registry in `web/src/components/ToolCard/knownTools.tsx`
/// (read-only subset), matching the Android port's `ToolCardPresentation`
/// line for line so the three clients label tools identically. Kept in the
/// app layer — `HapiProtocol.ToolPresentation` stays the thin
/// fixture-adjacent helper it is.
struct ToolCardPresentation: Equatable {
    /// SF Symbol name.
    var icon: String
    var title: String
    var subtitle: String?
}

private enum ToolIcon {
    static let terminal = "terminal"
    static let read = "eye"
    static let search = "magnifyingglass"
    static let edit = "pencil"
    static let web = "globe"
    static let agent = "paperplane"
    static let question = "questionmark.circle"
    static let plan = "list.clipboard"
    static let idea = "lightbulb"
    static let puzzle = "puzzlepiece.extension"
    static let message = "bubble.left"
    static let team = "person.2"
    static let warning = "exclamationmark.triangle"
    static let wrench = "wrench.and.screwdriver"
}

// MARK: - Path display

/// Strip the session root so paths read workspace-relative
/// (web `resolveDisplayPath`).
func chatDisplayPath(_ path: String, basePath: String?) -> String {
    guard let basePath, !basePath.isEmpty else { return path }
    let root = trimTrailingSlashes(basePath)
    if path == root { return "." }
    if path.hasPrefix(root + "/") {
        return String(path.dropFirst(root.count + 1))
    }
    return path
}

private func trimTrailingSlashes(_ path: String) -> String {
    var value = path
    while value.hasSuffix("/") {
        value = String(value.dropLast())
    }
    return value
}

private func chatBasename(_ path: String) -> String {
    let trimmed = trimTrailingSlashes(path)
    return trimmed.split(separator: "/").last.map(String.init) ?? trimmed
}

// MARK: - Terminal parsing (web `formatTerminalCommandTitle`)

private let commandsWithSubcommand: Set<String> = [
    "git", "bun", "npm", "pnpm", "yarn", "docker", "systemctl", "cargo", "go",
]

private func isAssignment(_ part: String?) -> Bool {
    guard let part, let first = part.first,
          first == "_" || first.isLetter else { return false }
    var seenEquals = false
    for (index, character) in part.enumerated() {
        if character == "=" {
            seenEquals = index > 0
            break
        }
        let valid = character == "_" || character.isLetter || (index > 0 && character.isNumber)
        if !valid { return false }
    }
    return seenEquals
}

private func hasAmbiguousShellSyntax(_ command: String) -> Bool {
    command.contains(where: { ";&|<>$`(){}\n\r".contains($0) })
}

/// The leading executable(+subcommand) of a simple command; nil when the
/// command carries shell syntax that makes the guess ambiguous.
func formatTerminalCommandTitle(_ command: String?) -> String? {
    guard let command, !command.isEmpty, !hasAmbiguousShellSyntax(command) else { return nil }

    let parts = command
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .split(whereSeparator: { $0.isWhitespace })
        .map(String.init)
    var index = 0
    func part(_ offset: Int) -> String? {
        let position = index + offset
        return position >= 0 && position < parts.count ? parts[position] : nil
    }

    while isAssignment(part(0)) { index += 1 }
    if part(0) == "env" {
        index += 1
        while part(0) == "-i" || part(0) == "--ignore-environment" || isAssignment(part(0)) {
            index += 1
        }
    }
    if part(0) == "sudo" {
        index += 1
        while ["-n", "--non-interactive", "-E", "--preserve-env"].contains(part(0) ?? "") {
            index += 1
        }
    }
    if part(0)?.hasPrefix("-") == true { return nil }

    guard let head = part(0) else { return nil }
    let executable = chatBasename(head)
    guard !executable.isEmpty else { return nil }

    guard let subcommand = part(1), !subcommand.hasPrefix("-"),
          commandsWithSubcommand.contains(executable) else {
        return executable
    }
    if ["bun", "npm", "pnpm", "yarn"].contains(executable), subcommand == "run" {
        if let script = part(2), !script.hasPrefix("-") {
            return "\(executable) run \(script)"
        }
        return "\(executable) run"
    }
    if executable == "docker", subcommand == "compose" {
        if let action = part(2), !action.hasPrefix("-") {
            return "docker compose \(action)"
        }
        return "docker compose"
    }
    return "\(executable) \(subcommand)"
}

/// The command string, joining Codex-style `command: string[]` arrays.
func chatTerminalCommand(_ input: JSONValue?) -> String? {
    if let command = chatInputString(input, ["command", "cmd"]) {
        return command
    }
    guard let array = input?[chatKey: "command"]?.chatArray else { return nil }
    let parts = array.compactMap { $0.chatString }.filter { !$0.isEmpty }
    return parts.isEmpty ? nil : parts.joined(separator: " ")
}

private func terminalTitle(_ input: JSONValue?, description: String?) -> String {
    let command = chatTerminalCommand(input)
    if let description, description != command {
        return description
    }
    return formatTerminalCommandTitle(command) ?? description ?? String(localized: "Terminal")
}

private func terminalSubtitle(_ input: JSONValue?, description: String?) -> String? {
    let command = chatTerminalCommand(input)
    return command == terminalTitle(input, description: description) ? nil : command
}

// MARK: - Questions

private func questionTitle(_ input: JSONValue?) -> String {
    let questions = input?[chatKey: "questions"]?.chatArray ?? []
    if questions.count > 1 {
        return String(format: String(localized: "%lld Questions"), Int64(questions.count))
    }
    let header = questions.first?[chatKey: "header"]?.chatString?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return header.isEmpty ? String(localized: "Question") : header
}

private func questionSubtitle(_ input: JSONValue?) -> String? {
    let questions = input?[chatKey: "questions"]?.chatArray ?? []
    let question = questions.first?[chatKey: "question"]?.chatString?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if questions.count > 1, !question.isEmpty {
        return String(
            format: String(localized: "%@ (+%lld more)"),
            chatTruncate(question, 100),
            Int64(questions.count - 1)
        )
    }
    return question.isEmpty ? nil : chatTruncate(question, 120)
}

// MARK: - MCP names

private func snakeToTitle(_ value: String) -> String {
    value.split(separator: "_")
        .filter { !$0.isEmpty }
        .map { $0.lowercased().prefix(1).uppercased() + $0.lowercased().dropFirst() }
        .joined(separator: " ")
}

private func mcpTitle(_ toolName: String) -> String {
    let withoutPrefix = toolName.hasPrefix("mcp__")
        ? String(toolName.dropFirst("mcp__".count))
        : toolName
    let parts = withoutPrefix.components(separatedBy: "__")
    if parts.count >= 2 {
        let rest = parts.dropFirst().joined(separator: "_")
        return "MCP: \(snakeToTitle(parts[0])) \(snakeToTitle(rest))"
    }
    return "MCP: \(snakeToTitle(withoutPrefix))"
}

// MARK: - Entry point

func toolCardPresentation(_ tool: ChatToolCall, basePath: String?) -> ToolCardPresentation {
    let input = tool.input
    let name = tool.name
    let description = tool.description

    if name.hasPrefix("mcp__") {
        return ToolCardPresentation(icon: ToolIcon.puzzle, title: mcpTitle(name), subtitle: nil)
    }
    if isAskUserQuestionToolName(name) || isRequestUserInputToolName(name) {
        return ToolCardPresentation(
            icon: ToolIcon.question,
            title: questionTitle(input),
            subtitle: questionSubtitle(input)
        )
    }

    func filePathTitle(_ keys: [String], fallback: String) -> String {
        chatInputString(input, keys).map { chatDisplayPath($0, basePath: basePath) } ?? fallback
    }

    switch name {
    case "Bash", "CodexBash", "shell_command", "run_shell_command":
        // A CodexBash single parsed read renders as the file it reads.
        if name == "CodexBash",
           let parsed = input?[chatKey: "parsed_cmd"]?.chatArray,
           parsed.count == 1,
           parsed[0][chatKey: "type"]?.chatString == "read",
           let file = parsed[0][chatKey: "name"]?.chatString {
            return ToolCardPresentation(
                icon: ToolIcon.read,
                title: chatDisplayPath(file, basePath: basePath),
                subtitle: terminalSubtitle(input, description: description)
            )
        }
        return ToolCardPresentation(
            icon: ToolIcon.terminal,
            title: terminalTitle(input, description: description),
            subtitle: terminalSubtitle(input, description: description)
        )

    case "Read":
        return ToolCardPresentation(
            icon: ToolIcon.read,
            title: filePathTitle(["file_path", "path", "file"], fallback: String(localized: "Read file")),
            subtitle: nil
        )

    case "NotebookRead":
        return ToolCardPresentation(
            icon: ToolIcon.read,
            title: filePathTitle(["notebook_path"], fallback: String(localized: "Read notebook")),
            subtitle: nil
        )

    case "Edit":
        return ToolCardPresentation(
            icon: ToolIcon.edit,
            title: filePathTitle(["file_path", "path"], fallback: String(localized: "Edit file")),
            subtitle: nil
        )

    case "MultiEdit":
        guard let file = chatInputString(input, ["file_path", "path"]) else {
            return ToolCardPresentation(
                icon: ToolIcon.edit,
                title: String(localized: "Edit file"),
                subtitle: nil
            )
        }
        let count = input?[chatKey: "edits"]?.chatArray?.count ?? 0
        let path = chatDisplayPath(file, basePath: basePath)
        return ToolCardPresentation(
            icon: ToolIcon.edit,
            title: count > 1
                ? String(format: String(localized: "%@ (%lld edits)"), path, Int64(count))
                : path,
            subtitle: nil
        )

    case "Write":
        let content = chatInputString(input, ["content", "text"])
        let subtitle = content.map { text -> String in
            let lines = text.split(separator: "\n", omittingEmptySubsequences: false).count
            return lines > 1
                ? String(format: String(localized: "%lld lines"), Int64(lines))
                : String(format: String(localized: "%lld chars"), Int64(text.count))
        }
        return ToolCardPresentation(
            icon: ToolIcon.edit,
            title: filePathTitle(["file_path", "path"], fallback: String(localized: "Write file")),
            subtitle: subtitle
        )

    case "NotebookEdit":
        return ToolCardPresentation(
            icon: ToolIcon.edit,
            title: filePathTitle(["notebook_path"], fallback: String(localized: "Edit notebook")),
            subtitle: chatInputString(input, ["edit_mode"]).map { "mode: \($0)" }
        )

    case "Glob":
        return ToolCardPresentation(
            icon: ToolIcon.search,
            title: chatInputString(input, ["pattern"]) ?? String(localized: "Search files"),
            subtitle: nil
        )

    case "Grep":
        let pattern = chatInputString(input, ["pattern"])
        return ToolCardPresentation(
            icon: ToolIcon.search,
            title: pattern.map { "grep(pattern: \($0))" } ?? String(localized: "Search content"),
            subtitle: nil
        )

    case "LS":
        return ToolCardPresentation(
            icon: ToolIcon.search,
            title: filePathTitle(["path"], fallback: String(localized: "List files")),
            subtitle: nil
        )

    case "WebFetch":
        guard let url = chatInputString(input, ["url"]) else {
            return ToolCardPresentation(
                icon: ToolIcon.web,
                title: String(localized: "Web fetch"),
                subtitle: nil
            )
        }
        let host = URL(string: url)?.host ?? url
        return ToolCardPresentation(icon: ToolIcon.web, title: host, subtitle: url)

    case "WebSearch":
        let query = chatInputString(input, ["query"])
        return ToolCardPresentation(
            icon: ToolIcon.web,
            title: query ?? String(localized: "Web search"),
            subtitle: query.map { chatTruncate($0, 80) }
        )

    case "Task", "Agent":
        let inputName = chatInputString(input, ["name"])
        let teamName = chatInputString(input, ["team_name"])
        let title: String
        if name == "Task", let inputName, teamName != nil {
            title = String(format: String(localized: "Agent: %@"), inputName)
        } else {
            title = chatInputString(input, ["description"])
                ?? (name == "Task" ? "Task" : String(localized: "Launch Agent"))
        }
        let subtitle = chatInputString(input, ["prompt"]).map { chatTruncate($0, 120) }
            ?? chatInputString(input, ["subagent_type"])
        return ToolCardPresentation(icon: ToolIcon.agent, title: title, subtitle: subtitle)

    case "CodexAgent", "spawn_agent", "resume_agent", "wait_agent", "close_agent", "interrupt_agent":
        let title: String
        switch name {
        case "spawn_agent": title = String(localized: "Spawn agent")
        case "resume_agent": title = String(localized: "Resume agent")
        case "wait_agent": title = String(localized: "Wait for agent")
        case "close_agent": title = String(localized: "Close agent")
        case "interrupt_agent": title = String(localized: "Interrupt agent")
        default: title = String(localized: "Agent")
        }
        let prompt = chatInputString(input, ["prompt", "summary"])
        return ToolCardPresentation(
            icon: ToolIcon.agent,
            title: title,
            subtitle: prompt.map { chatTruncate($0, 120) }
        )

    case "SendMessage", "send_input", "send_message", "followup_task":
        let recipient = chatInputString(input, ["recipient"])
        let messageType = chatInputString(input, ["type"])
        let title: String
        if messageType == "broadcast" {
            title = String(localized: "Broadcast")
        } else if messageType == "shutdown_request" {
            title = String(format: String(localized: "Shutdown: %@"), recipient ?? "agent")
        } else if messageType == "shutdown_response" {
            title = String(localized: "Shutdown Response")
        } else if let recipient {
            title = String(format: String(localized: "Message: %@"), recipient)
        } else {
            title = String(localized: "Message agent")
        }
        let summary = chatInputString(input, ["summary"])
        return ToolCardPresentation(
            icon: ToolIcon.message,
            title: title,
            subtitle: summary.map { chatTruncate($0, 120) }
        )

    case "list_agents":
        return ToolCardPresentation(icon: ToolIcon.team, title: String(localized: "List agents"), subtitle: nil)

    case "TeamCreate":
        let teamName = chatInputString(input, ["team_name"])
        return ToolCardPresentation(
            icon: ToolIcon.team,
            title: teamName.map { String(format: String(localized: "Team: %@"), $0) }
                ?? String(localized: "Create Team"),
            subtitle: chatInputString(input, ["description"])
        )

    case "TeamDelete":
        return ToolCardPresentation(icon: ToolIcon.team, title: String(localized: "Delete Team"), subtitle: nil)

    case "TodoWrite":
        return ToolCardPresentation(icon: ToolIcon.idea, title: String(localized: "Todo list"), subtitle: nil)

    case "update_plan":
        return ToolCardPresentation(icon: ToolIcon.plan, title: String(localized: "Plan"), subtitle: nil)

    case "ExitPlanMode", "exit_plan_mode":
        return ToolCardPresentation(icon: ToolIcon.plan, title: String(localized: "Plan proposal"), subtitle: nil)

    case "Skill":
        let skill = chatInputString(input, ["skill"])
        return ToolCardPresentation(
            icon: ToolIcon.puzzle,
            title: skill.map { "Skill: \($0)" } ?? "Skill",
            subtitle: nil
        )

    case "CodexReasoning":
        return ToolCardPresentation(
            icon: ToolIcon.idea,
            title: chatInputString(input, ["title"]) ?? String(localized: "Reasoning"),
            subtitle: nil
        )

    case "CodexPermission":
        let permissionTool = chatInputString(input, ["tool"])
        return ToolCardPresentation(
            icon: ToolIcon.question,
            title: permissionTool.map { String(format: String(localized: "Permission: %@"), $0) }
                ?? String(localized: "Permission request"),
            subtitle: chatInputString(input, ["message", "command"])
        )

    case "CodexPatch":
        let files = input?[chatKey: "changes"]?.chatObject.map { Array($0.keys).sorted() } ?? []
        let subtitle = files.first.map { first -> String in
            let display = chatBasename(chatDisplayPath(first, basePath: basePath))
            return files.count > 1 ? "\(display) (+\(files.count - 1))" : display
        }
        return ToolCardPresentation(icon: ToolIcon.edit, title: String(localized: "Apply changes"), subtitle: subtitle)

    case "CodexDiff":
        let unified = chatInputString(input, ["unified_diff"])
        let subtitle = unified?
            .split(separator: "\n", omittingEmptySubsequences: false)
            .first(where: { $0.hasPrefix("+++ ") })
            .map { line -> String in
                var value = String(line.dropFirst("+++ ".count))
                if value.hasPrefix("b/") { value = String(value.dropFirst(2)) }
                return chatBasename(value)
            }
        return ToolCardPresentation(icon: ToolIcon.edit, title: "Diff", subtitle: subtitle)

    case "AgyTaskLog":
        let task = chatInputString(input, ["task"])
        return ToolCardPresentation(
            icon: ToolIcon.message,
            title: task.map { String(format: String(localized: "%@ log"), $0) }
                ?? String(localized: "Inspecting task log"),
            subtitle: nil
        )

    case "AgyAsyncTask":
        return ToolCardPresentation(
            icon: ToolIcon.plan,
            title: description ?? String(localized: "Background task"),
            subtitle: nil
        )

    case "AgyError":
        return ToolCardPresentation(
            icon: ToolIcon.warning,
            title: description ?? String(localized: "Error"),
            subtitle: nil
        )

    default:
        break
    }

    // Generic fallback (web `getToolPresentation` tail): promote a semantic
    // label when an ACP agent's title is the verbatim argument.
    let filePath = chatInputString(input, ["file_path", "path", "filePath", "file"])
    let command = chatInputString(input, ["command", "cmd"])
    let pattern = chatInputString(input, ["pattern"])
    let url = chatInputString(input, ["url"])
    let query = chatInputString(input, ["query"])
    let nameInput = chatInputString(input, ["name"])
    let subtitle = filePath ?? command ?? pattern ?? url ?? query ?? nameInput

    var title = description ?? name
    if let subtitle, subtitle == title {
        if filePath != nil {
            title = String(localized: "Read file")
        } else if command != nil {
            title = String(localized: "Run shell")
        } else if pattern != nil {
            title = String(localized: "Search")
        } else if url != nil {
            title = String(localized: "Open URL")
        } else if query != nil {
            title = String(localized: "Query")
        }
    }
    return ToolCardPresentation(
        icon: ToolIcon.wrench,
        title: title,
        subtitle: subtitle.flatMap { $0 == title ? nil : chatTruncate($0, 80) }
    )
}
