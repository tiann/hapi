import Foundation

// Port of web/src/chat/toolGroups.ts — collapsing runs of low-signal tool
// calls into tool-group blocks, plus the codex-exploration grouping family
// (which needs the CodexBash command_actions parsing from
// web/src/chat/codexCommandPresentation.ts, ported in ToolPresentation.swift).

// MARK: - Tool input access (web/src/lib/toolInputUtils.ts)

/// Port of `getInputString` — non-string values yield nil; the `Any` variant
/// additionally skips empty strings (JS truthiness).
func getInputString(_ input: JSONValue?, _ key: String) -> String? {
    input?.objectValue?[key]?.stringValue
}

/// Port of `getInputStringAny`.
func getInputStringAny(_ input: JSONValue?, _ keys: [String]) -> String? {
    for key in keys {
        if let value = getInputString(input, key), !value.isEmpty {
            return value
        }
    }
    return nil
}

// MARK: - Group model

public enum ToolGroupActionKind: String, Equatable, Sendable, CaseIterable {
    case read
    case search
    case command
    case mutation
    case web
    case other
}

/// Port of `ToolGroupSummary`.
public struct ToolGroupSummary: Equatable, Sendable {
    public var totalTools: Int
    public var countsByKind: [ToolGroupActionKind: Int]
    public var fileTargets: [String]
    public var commandTargets: [String]
    public var searchTargets: [String]
    public var urlTargets: [String]
    public var otherTargets: [String]
    public var errorCount: Int
    public var runningCount: Int
    public var pendingCount: Int
}

/// Port of `ToolGroupBlock`.
public struct ToolGroupBlock: Equatable, Sendable {
    public var id: String
    public var createdAt: Int
    public var invokedAt: Int?
    public var firstToolId: String
    public var lastToolId: String
    public var tools: [ToolCallBlock]
    public var defaultOpen: Bool
    public var historyState: HistoryState
    public var needsOlderHistory: Bool
    public var activityTitle: String?
    public var presentationMode: PresentationMode
    public var summary: ToolGroupSummary

    public enum HistoryState: String, Equatable, Sendable {
        case complete
        case needsOlderHistory = "needs-older-history"
    }

    public enum PresentationMode: String, Equatable, Sendable {
        case `default`
        case codexExploration = "codex-exploration"
    }
}

/// Port of `VisibleChatBlock`.
public enum VisibleChatBlock: Equatable, Sendable {
    case block(ChatBlock)
    case toolGroup(ToolGroupBlock)
}

public enum VisibleChatBlockRole: String, Equatable, Sendable {
    case user
    case assistant
    case system
}

/// Port of `visibleBlockRole`.
public func visibleBlockRole(_ block: VisibleChatBlock) -> VisibleChatBlockRole {
    switch block {
    case .toolGroup:
        return .assistant
    case .block(let chatBlock):
        switch chatBlock {
        case .userText: return .user
        case .agentEvent: return .system
        case .cliOutput(let cliOutput): return cliOutput.source == .user ? .user : .assistant
        default: return .assistant
        }
    }
}

/// Port of `ToolGroupingOptions`.
public struct ToolGroupingOptions: Sendable {
    public var hasMoreMessages: Bool
    public var previousGroups: [ToolGroupBlock]
    /// Tri-state like the TS optional boolean: only an explicit `false`
    /// opens codex-exploration groups by default.
    public var codexExplorationCollapsed: Bool?

    public init(hasMoreMessages: Bool, previousGroups: [ToolGroupBlock] = [], codexExplorationCollapsed: Bool? = nil) {
        self.hasMoreMessages = hasMoreMessages
        self.previousGroups = previousGroups
        self.codexExplorationCollapsed = codexExplorationCollapsed
    }
}

// MARK: - Name tables

private let planToolNames: Set<String> = [
    "TodoWrite",
    "update_plan",
    "ExitPlanMode",
    "exit_plan_mode",
    "CodexReasoning",
]

private let milestoneToolNames: Set<String> = [
    "Task",
    "Agent",
    "CodexAgent",
    "TeamCreate",
    "TeamDelete",
    "SendMessage",
    "AgyTaskLog",
    "Skill",
    "spawn_agent",
    "send_input",
    "send_message",
    "resume_agent",
    "followup_task",
    "wait_agent",
    "close_agent",
    "interrupt_agent",
    "list_agents",
]

private let interactiveToolNames: Set<String> = [
    "CodexPermission",
]

/// Port of `isAskUserQuestionToolName` (web ToolCard/askUserQuestion.ts).
public func isAskUserQuestionToolName(_ toolName: String) -> Bool {
    toolName == "AskUserQuestion" || toolName == "ask_user_question" || toolName == "CursorAskQuestion"
}

/// Port of `isRequestUserInputToolName` (web ToolCard/requestUserInput.ts).
public func isRequestUserInputToolName(_ toolName: String) -> Bool {
    toolName == "request_user_input"
}

// MARK: - Summaries

private func pushUnique(_ target: inout [String], _ value: String?) {
    guard let value, !value.isEmpty else { return }
    if target.contains(value) { return }
    target.append(value)
}

/// Port of `normalizeCommandInput`.
private func normalizeCommandInput(_ input: JSONValue?) -> String? {
    if let direct = getInputStringAny(input, ["command", "cmd"]) { return direct }

    guard let command = input?.objectValue?["command"]?.arrayValue else { return nil }
    let parts = command.compactMap { part -> String? in
        guard let text = part.stringValue, !text.isEmpty else { return nil }
        return text
    }
    return parts.isEmpty ? nil : parts.joined(separator: " ")
}

/// Port of `getToolGroupActionKind`.
public func getToolGroupActionKind(_ block: ToolCallBlock) -> ToolGroupActionKind {
    let name = block.tool.name

    if name == "Read" || name == "NotebookRead" { return .read }
    if name == "Grep" || name == "Glob" || name == "LS" { return .search }
    if name == "Bash" || name == "CodexBash" || name == "shell_command" || name == "run_shell_command" { return .command }
    if name == "Edit" || name == "MultiEdit" || name == "Write" || name == "NotebookEdit"
        || name == "CodexPatch" || name == "CodexDiff" {
        return .mutation
    }
    if name == "WebFetch" || name == "WebSearch" { return .web }
    return .other
}

private func getPrimaryFileTarget(_ block: ToolCallBlock) -> String? {
    getInputStringAny(block.tool.input, ["file_path", "path", "file", "filePath", "notebook_path", "name"])
}

private func getPrimarySearchTarget(_ block: ToolCallBlock) -> String? {
    getInputStringAny(block.tool.input, ["pattern", "query"])
}

private func getPrimaryUrlTarget(_ block: ToolCallBlock) -> String? {
    getInputStringAny(block.tool.input, ["url"])
}

private func getPrimaryOtherTarget(_ block: ToolCallBlock) -> String? {
    if let fileTarget = getPrimaryFileTarget(block) { return fileTarget }
    if let searchTarget = getPrimarySearchTarget(block) { return searchTarget }
    if let commandTarget = normalizeCommandInput(block.tool.input) { return commandTarget }
    if let urlTarget = getPrimaryUrlTarget(block) { return urlTarget }
    return block.tool.name
}

/// Port of `summarizeToolGroup`.
private func summarizeToolGroup(_ tools: [ToolCallBlock]) -> ToolGroupSummary {
    var countsByKind: [ToolGroupActionKind: Int] = [
        .read: 0, .search: 0, .command: 0, .mutation: 0, .web: 0, .other: 0,
    ]
    var fileTargets: [String] = []
    var commandTargets: [String] = []
    var searchTargets: [String] = []
    var urlTargets: [String] = []
    var otherTargets: [String] = []
    var errorCount = 0
    var runningCount = 0
    var pendingCount = 0

    for tool in tools {
        let kind = getToolGroupActionKind(tool)
        countsByKind[kind, default: 0] += 1

        switch tool.tool.state {
        case .error: errorCount += 1
        case .running: runningCount += 1
        case .pending: pendingCount += 1
        case .completed: break
        }

        if kind == .read || kind == .mutation {
            pushUnique(&fileTargets, getPrimaryFileTarget(tool))
            continue
        }
        if kind == .search {
            pushUnique(&searchTargets, getPrimarySearchTarget(tool))
            continue
        }
        if kind == .command {
            pushUnique(&commandTargets, normalizeCommandInput(tool.tool.input))
            continue
        }
        if kind == .web {
            pushUnique(&urlTargets, getPrimaryUrlTarget(tool) ?? getPrimarySearchTarget(tool))
            continue
        }
        pushUnique(&otherTargets, getPrimaryOtherTarget(tool))
    }

    return ToolGroupSummary(
        totalTools: tools.count,
        countsByKind: countsByKind,
        fileTargets: fileTargets,
        commandTargets: commandTargets,
        searchTargets: searchTargets,
        urlTargets: urlTargets,
        otherTargets: otherTargets,
        errorCount: errorCount,
        runningCount: runningCount,
        pendingCount: pendingCount
    )
}

// MARK: - Eligibility

private func isInteractiveToolBlock(_ block: ToolCallBlock) -> Bool {
    interactiveToolNames.contains(block.tool.name)
        || block.tool.permission?.status == .pending
        || isAskUserQuestionToolName(block.tool.name)
        || isRequestUserInputToolName(block.tool.name)
}

/// Port of `isEligibleForToolGrouping`.
public func isEligibleForToolGrouping(_ block: ToolCallBlock) -> Bool {
    if isSubagentToolName(block.tool.name) { return false }
    if planToolNames.contains(block.tool.name) { return false }
    if milestoneToolNames.contains(block.tool.name) { return false }
    if isInteractiveToolBlock(block) { return false }
    if block.tool.name == "CodexBash" && !getCodexCommandActions(block).isEmpty {
        return isCodexExplorationTool(block)
    }
    return true
}

private func getGroupingFamily(_ block: ToolCallBlock) -> ToolGroupBlock.PresentationMode? {
    guard isEligibleForToolGrouping(block) else { return nil }
    return isCodexExplorationTool(block) ? .codexExploration : .default
}

/// Port of `createToolGroupId` — reuses a previous group's id when the run
/// still shares a boundary tool with it (scroll-anchor stability).
private func createToolGroupId(
    tools: [ToolCallBlock],
    needsOlderHistory: Bool,
    previousGroups: [ToolGroupBlock]
) -> String {
    let firstToolId = tools.first?.id ?? "unknown"
    let lastToolId = tools.last?.id ?? firstToolId

    if let previous = previousGroups.first(where: { $0.firstToolId == firstToolId || $0.lastToolId == lastToolId }) {
        return previous.id
    }

    return needsOlderHistory
        ? "tool-group:\(lastToolId)"
        : "tool-group:\(firstToolId)"
}

// MARK: - buildVisibleChatBlocks

/// Port of `buildVisibleChatBlocks`.
public func buildVisibleChatBlocks(
    _ blocks: [ChatBlock],
    options: ToolGroupingOptions
) -> [VisibleChatBlock] {
    var visibleBlocks: [VisibleChatBlock] = []
    let previousGroups = options.previousGroups

    var index = 0
    while index < blocks.count {
        let block = blocks[index]
        guard case .toolCall(let toolBlock) = block else {
            visibleBlocks.append(.block(block))
            index += 1
            continue
        }
        guard let groupingFamily = getGroupingFamily(toolBlock) else {
            visibleBlocks.append(.block(block))
            index += 1
            continue
        }

        var tools: [ToolCallBlock] = [toolBlock]
        var cursor = index + 1
        while cursor < blocks.count {
            guard case .toolCall(let candidate) = blocks[cursor],
                  getGroupingFamily(candidate) == groupingFamily else {
                break
            }
            tools.append(candidate)
            cursor += 1
        }

        if tools.count < 2 && groupingFamily != .codexExploration {
            visibleBlocks.append(.block(block))
            index += 1
            continue
        }

        let startsAtOldestVisibleBoundary = visibleBlocks.isEmpty
        let needsOlderHistory = options.hasMoreMessages && startsAtOldestVisibleBoundary
        let activityTitle: String? = {
            guard case .block(.toolCall(let previousBlock))? = visibleBlocks.last,
                  previousBlock.tool.name == "CodexReasoning" else { return nil }
            return getInputStringAny(previousBlock.tool.input, ["title"])
        }()
        visibleBlocks.append(.toolGroup(ToolGroupBlock(
            id: createToolGroupId(tools: tools, needsOlderHistory: needsOlderHistory, previousGroups: previousGroups),
            createdAt: tools[0].createdAt,
            invokedAt: tools[0].invokedAt,
            firstToolId: tools[0].id,
            lastToolId: tools[tools.count - 1].id,
            tools: tools,
            defaultOpen: groupingFamily == .codexExploration && options.codexExplorationCollapsed == false,
            historyState: needsOlderHistory ? .needsOlderHistory : .complete,
            needsOlderHistory: needsOlderHistory,
            activityTitle: activityTitle,
            presentationMode: groupingFamily,
            summary: summarizeToolGroup(tools)
        )))
        index = cursor
    }

    return visibleBlocks
}
