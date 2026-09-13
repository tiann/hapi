import HapiProtocol
import Observation
import SwiftUI

/// One inspector per chat, owned outside recycled transcript cells. Its
/// identity stays fixed while its group and selected tool resolve from live data.
@MainActor @Observable
final class ToolInspectionState {
    struct Selection {
        let owner: String
        var block: ToolCallBlock
    }

    struct GroupSelection {
        let owner: String
        var block: ToolGroupBlock
    }

    private(set) var tools: [String: ToolCallBlock] = [:]
    private var groups: [String: ToolGroupBlock] = [:]
    private var groupIDsByTool: [String: String] = [:]
    private(set) var selection: Selection?
    private(set) var groupSelection: GroupSelection?
    private(set) var invalidation = 0

    /// A group browser owns the presentation even when no detail is selected.
    var owner: String? { groupSelection?.owner ?? selection?.owner }

    var isGroupStale: Bool {
        guard let groupSelection else { return false }
        return groups[groupSelection.block.id] == nil
    }

    var isStale: Bool {
        guard let selection else { return false }
        return tools[selection.block.id] == nil
    }

    var siblingIDs: [String] {
        guard let selection else { return [] }
        if let groupSelection {
            let ids = groupSelection.block.tools.map(\.id)
            // Regrouping must not substitute a different tool at the same index.
            return ids.contains(selection.block.id) ? ids : []
        }
        guard !isStale else { return [] }
        return groupIDsByTool[selection.block.id].flatMap { groups[$0]?.tools.map(\.id) }
            ?? [selection.block.id]
    }

    var selectedIndex: Int? {
        guard let selection else { return nil }
        return siblingIDs.firstIndex(of: selection.block.id)
    }

    func update(_ blocks: [VisibleChatBlock]) {
        var nextTools: [String: ToolCallBlock] = [:]
        var nextGroups: [String: ToolGroupBlock] = [:]
        var nextGroupIDsByTool: [String: String] = [:]
        func collect(_ block: ChatBlock) {
            guard case .toolCall(let tool) = block else { return }
            nextTools[tool.id] = tool
            tool.children.forEach(collect)
        }
        for block in blocks {
            switch block {
            case .block(let value): collect(value)
            case .toolGroup(let group):
                nextGroups[group.id] = group
                for tool in group.tools {
                    nextGroupIDsByTool[tool.id] = group.id
                    collect(.toolCall(tool))
                }
            }
        }
        if tools != nextTools { tools = nextTools }
        if groups != nextGroups { groups = nextGroups }
        if groupIDsByTool != nextGroupIDsByTool { groupIDsByTool = nextGroupIDsByTool }
        if let selected = groupSelection {
            var latest = nextGroups[selected.block.id] ?? selected.block
            if nextGroups[selected.block.id] == nil {
                // Membership is a snapshot after regrouping, but remember each
                // member's last available value when navigating back to it.
                latest.tools = latest.tools.map { nextTools[$0.id] ?? $0 }
            }
            if latest != selected.block {
                groupSelection = GroupSelection(owner: selected.owner, block: latest)
            }
        }
        if let selected = selection, let latest = nextTools[selected.block.id], latest != selected.block {
            selection = Selection(owner: selected.owner, block: latest)
        }
    }

    func open(_ block: ToolCallBlock, owner: String) {
        groupSelection = nil
        selection = Selection(owner: owner, block: tools[block.id] ?? block)
    }

    @discardableResult
    func openGroup(_ id: String, owner: String) -> Bool {
        guard let group = groups[id] else { return false }
        selection = nil
        groupSelection = GroupSelection(owner: owner, block: group)
        return true
    }

    @discardableResult
    func selectGroupTool(_ id: String) -> Bool {
        guard let groupSelection, let block = groupTool(id) else { return false }
        selection = Selection(owner: groupSelection.owner, block: block)
        return true
    }

    func groupTool(_ id: String) -> ToolCallBlock? {
        guard let snapshot = groupSelection?.block.tools.first(where: { $0.id == id }) else { return nil }
        return tools[id] ?? snapshot
    }

    func returnToGroup() {
        if groupSelection != nil { selection = nil }
    }

    func dismiss(owner: String) {
        guard self.owner == owner else { return }
        selection = nil
        groupSelection = nil
    }

    func move(by offset: Int) {
        guard let selection, let index = selectedIndex else { return }
        let ids = siblingIDs
        let next = index + offset
        guard ids.indices.contains(next) else { return }
        if groupSelection != nil {
            selectGroupTool(ids[next])
            return
        }
        guard let block = tools[ids[next]] else { return }
        self.selection = Selection(owner: selection.owner, block: block)
    }

    func invalidate() {
        selection = nil
        groupSelection = nil
        tools = [:]
        groups = [:]
        groupIDsByTool = [:]
        invalidation += 1
    }
}

func opensToolProcess(_ block: ToolCallBlock) -> Bool {
    !block.children.isEmpty || isSubagentToolName(block.tool.name) || block.tool.name == "CodexAgent"
}

private struct OpenChatToolKey: EnvironmentKey {
    static let defaultValue: (@MainActor (ToolCallBlock) -> Void)? = nil
}

private struct OpenChatToolGroupKey: EnvironmentKey {
    static let defaultValue: (@MainActor (String) -> Void)? = nil
}

extension EnvironmentValues {
    var openChatToolGroup: (@MainActor (String) -> Void)? {
        get { self[OpenChatToolGroupKey.self] }
        set { self[OpenChatToolGroupKey.self] = newValue }
    }

    var openChatTool: (@MainActor (ToolCallBlock) -> Void)? {
        get { self[OpenChatToolKey.self] }
        set { self[OpenChatToolKey.self] = newValue }
    }
}
