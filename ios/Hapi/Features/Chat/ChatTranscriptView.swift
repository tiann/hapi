import HapiClient
import HapiProtocol
import HapiUI
import SwiftUI

/// Presentation-only flattening; protocol groups and their semantics stay intact.
enum TranscriptRow: Identifiable, Equatable {
    case history(ChatHistoryPagingState.Phase, Bool)
    case message(VisibleChatBlock)
    case groupedTool(ToolCallBlock, groupID: String, isLast: Bool)
    case group(ToolGroupBlock, Bool)

    static let historyID = "chat-history-control"
    var role: TranscriptRowRole {
        switch self {
        case .history: .history
        case .group: .tool
        case .groupedTool: .tool
        case .message(.toolGroup): .tool
        case .message(.block(.userText)): .user
        case .message(.block(.toolCall)): .tool
        default: .content
        }
    }
    var id: String {
        switch self {
        case .history: Self.historyID
        case .message(let block): block.stableId
        case .group(let group, _): group.id
        case .groupedTool(let block, _, _): block.id
        }
    }

    var groupID: String? {
        switch self {
        case .group(let block, _): block.id
        case .groupedTool(_, let groupID, _): groupID
        default: nil
        }
    }

    func spacing(after previous: TranscriptRow?) -> CGFloat {
        if case .groupedTool = self, let previous, previous.groupID == groupID { return 0 }
        return role.spacing(after: previous?.role)
    }
}

struct ChatTranscriptView: View {
    let model: ChatModel

    private var rows: [TranscriptRow] {
        var rows: [TranscriptRow] = [.history(model.historyPaging.phase, model.hasMore)]
        for block in model.blocks {
            if case .toolGroup(let group) = block {
                let expanded = model.expandedToolGroups[group.id] ?? group.defaultOpen
                rows.append(.group(group, expanded))
                if expanded {
                    rows.append(contentsOf: group.tools.map {
                        .groupedTool($0, groupID: group.id, isLast: $0.id == group.tools.last?.id)
                    })
                }
            } else {
                rows.append(.message(block))
            }
        }
        return rows
    }

    var body: some View {
        AnchoredTranscriptList(
            items: rows,
            historyVersion: model.historyVersion,
            jumpToken: model.jumpToLatestToken,
            historyControlID: TranscriptRow.historyID,
            isInspectionPresented: model.isInspectingContent,
            onViewport: { viewport in
                model.readingViewportChanged(followsTail: viewport.followsTail, needsOlder: viewport.needsOlder)
            },
            onLayout: { version, progress in model.historyLaidOut(version: version, madeProgress: progress) },
            spacingBefore: { previous, row in row.spacing(after: previous) }
        ) { row in
            // The list bridges the current environment into its hosting roots.
            AnyView(rowView(row))
        }
        .overlay(alignment: .bottomTrailing) {
            if !model.followsTail || model.hasTrimmedTail || model.isJumpingToLatest {
                Button(action: model.jumpToLatest) {
                    HStack(spacing: 6) {
                        if model.isJumpingToLatest { ProgressView().controlSize(.small) }
                        Text("Back to latest")
                        Image(systemName: "arrow.down")
                    }
                    .font(.footnote.weight(.medium))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(.regularMaterial, in: Capsule())
                }
                .disabled(model.isJumpingToLatest)
                .accessibilityIdentifier("chat-latest")
                .padding(12)
            }
        }
    }

    @ViewBuilder
    private func rowView(_ row: TranscriptRow) -> some View {
        switch row {
        case .history(let phase, let hasMore):
            Button(action: model.retryHistory) {
                HStack(spacing: 8) {
                    if !hasMore {
                        Text("Beginning of conversation")
                    } else {
                        switch phase {
                        case .loading, .retrying, .awaitingLayout:
                            ProgressView().controlSize(.small)
                            Text("Loading older messages…")
                        case .failed: Text("Couldn't load history. Tap to retry.")
                        case .paused: Text("Continue loading history")
                        default: Text("Load older messages")
                        }
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!hasMore || model.isLoadingOlder || model.isSyncingTail)
            .accessibilityIdentifier("chat-history")
        case .message(let block):
            ChatBlockCard(block: block, basePath: model.basePath)
        case .groupedTool(let block, _, let isLast):
            ToolGroupChildRow(block: block, basePath: model.basePath, isLast: isLast)
        case .group(let group, let expanded):
            ToolGroupBlockView(
                block: group,
                basePath: model.basePath,
                expansion: Binding(get: { expanded }, set: { model.expandedToolGroups[group.id] = $0 }),
                showsTools: false
            )
        }
    }
}
