import HapiClient
import HapiProtocol
import SwiftUI

/// Scroll state belongs to this mounted transcript. Clearing the message
/// window removes it, so refetched messages open at the latest row again.
struct ChatTranscriptView: View {
    let model: ChatModel

    @State private var isAtBottom = true
    @State private var isAtTop = false
    @State private var tailFollow = ChatTailFollowState()
    /// One history request per reader gesture; layout changes cannot arm it.
    @State private var automaticHistoryLoadArmed = false
    /// Newest block id last seen while at the bottom (new-messages pill).
    @State private var newestSeenID: String?
    /// First existing block captured when the reader requests older history.
    @State private var pendingAnchorID: String?

    private static let bottomSentinelID = "chat-bottom-sentinel"
    private static let scrollCoordinateSpace = "chat-viewport"

    // MARK: - Thread

    var body: some View {
        GeometryReader { viewport in
            ScrollViewReader { scroll in
                ScrollView(.vertical) {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if model.hasMore || model.isLoadingOlder {
                            Button(action: requestOlderPage) {
                                OlderHistoryRow(isLoading: model.isLoadingOlder)
                            }
                            .buttonStyle(.plain)
                            .disabled(model.isLoadingOlder || model.isSyncingTail)
                            .accessibilityLabel("Load older messages")
                        }
                        ForEach(model.blocks, id: \.stableId) { block in
                            ChatBlockCard(block: block, basePath: model.basePath)
                                // maxWidth: .infinity alone is only a proposal;
                                // wide markdown/code must not size the thread.
                                .frame(width: max(0, viewport.size.width - 24), alignment: .leading)
                        }
                        Color.clear
                            .frame(height: 1)
                            .id(Self.bottomSentinelID)
                    }
                    .padding(.horizontal, 12)
                    .padding(.top, 10)
                    .frame(width: viewport.size.width, alignment: .leading)
                    .onGeometryChange(for: ChatScrollGeometry.self) { geometry in
                        let frame = geometry.frame(in: .named(Self.scrollCoordinateSpace))
                        return ChatScrollGeometry(
                            isAtTop: frame.minY >= -40,
                            isAtBottom: frame.maxY <= viewport.size.height + 40,
                            isBottomAligned: frame.maxY <= viewport.size.height + 1,
                            contentHeight: frame.height,
                            viewportHeight: viewport.size.height
                        )
                    } action: { geometry in
                        isAtTop = geometry.isAtTop
                        isAtBottom = geometry.isAtBottom
                        tailFollow.layoutChanged(
                            contentHeight: Double(geometry.contentHeight),
                            viewportHeight: Double(geometry.viewportHeight),
                            // Even growth within the 40 pt follow threshold
                            // needs a correction to show the entire last row.
                            isAtBottom: geometry.isBottomAligned
                        )
                        if geometry.isAtBottom {
                            automaticHistoryLoadArmed = false
                            newestSeenID = newestBlockID
                        }
                        requestAutomaticHistoryIfNeeded()
                    }
                }
                .coordinateSpace(name: Self.scrollCoordinateSpace)
                .scrollDismissesKeyboard(.interactively)
                .simultaneousGesture(
                    DragGesture().onChanged { value in
                        guard abs(value.translation.height) > abs(value.translation.width) else { return }
                        if !tailFollow.isDragging {
                            tailFollow.beginDragging()
                        }
                    }.onEnded { value in
                        tailFollow.endDragging(isAtBottom: isAtBottom)
                        // Ignore horizontal pans inside code and tables.
                        guard abs(value.translation.height) > abs(value.translation.width) else { return }
                        automaticHistoryLoadArmed = value.translation.height > 0
                        requestAutomaticHistoryIfNeeded()
                    }
                )
                .overlay(alignment: .bottom) {
                    newMessagesPill
                }
                .task(id: tailFollow.scrollRequest) {
                    guard let request = tailFollow.scrollRequest else { return }
                    // Geometry has measured the new row heights. Coalesce
                    // layout changes, then issue one correction; a reader
                    // drag or transcript removal cancels the pending task.
                    await Task.yield()
                    guard !Task.isCancelled, tailFollow.scrollRequest == request else { return }
                    newestSeenID = newestBlockID
                    scroll.scrollTo(Self.bottomSentinelID, anchor: .bottom)
                }
                .onDisappear {
                    tailFollow.endDragging(isAtBottom: isAtBottom)
                }
                .onChange(of: model.historyVersion) {
                    reanchorAfterPrepend(scroll: scroll)
                }
                .onChange(of: newestBlockID, initial: true) {
                    if tailFollow.isFollowingTail {
                        newestSeenID = newestBlockID
                    }
                }
                .onChange(of: model.isSyncingTail) {
                    requestAutomaticHistoryIfNeeded()
                }
            }
        }
    }

    private var newestBlockID: String? {
        model.blocks.last?.stableId
    }

    private func requestAutomaticHistoryIfNeeded() {
        guard automaticHistoryLoadArmed, isAtTop, !isAtBottom else { return }
        requestOlderPage()
    }

    /// Capture the anchor BEFORE the prepend lands, then ask for the page.
    private func requestOlderPage() {
        // Paging starts with the history control visible, so the first real
        // block is the reading anchor. No per-row geometry/state feedback.
        let anchor = model.blocks.first?.stableId
        // Busy/rejected requests must not overwrite an in-flight anchor.
        if model.loadOlder() {
            automaticHistoryLoadArmed = false
            pendingAnchorID = anchor
        }
    }

    /// `historyVersion` bumped: rows were prepended above the viewport.
    /// Restore the captured row once, without retaining a scroll binding.
    /// Preservation is approximate to the row, as with lazy history before.
    private func reanchorAfterPrepend(scroll: ScrollViewProxy) {
        guard let anchor = pendingAnchorID else { return }
        pendingAnchorID = nil
        guard !isAtBottom else { return }
        scroll.scrollTo(anchor, anchor: .top)
    }

    // MARK: - New-messages pill

    private var unseenCount: Int {
        guard !tailFollow.isFollowingTail, let seen = newestSeenID else { return 0 }
        guard let index = model.blocks.lastIndex(where: { $0.stableId == seen }) else { return 0 }
        return model.blocks.count - 1 - index
    }

    @ViewBuilder
    private var newMessagesPill: some View {
        let count = unseenCount
        if count > 0 {
            Button {
                newestSeenID = newestBlockID
                tailFollow.followTail()
            } label: {
                Text(count == 1
                    ? String(localized: "1 new message ↓")
                    : String(format: String(localized: "%lld new messages ↓"), Int64(count)))
                    .font(.footnote.weight(.medium))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 7)
                    .background(.tint, in: Capsule())
                    .foregroundStyle(.white)
                    .shadow(radius: 3, y: 1)
            }
            .buttonStyle(.plain)
            .padding(.bottom, 12)
        }
    }
}

/// Observe row/viewport resizing as well as edges. Scrolling within the
/// middle of the thread still does not publish every point of a drag.
private struct ChatScrollGeometry: Equatable {
    let isAtTop: Bool
    let isAtBottom: Bool
    let isBottomAligned: Bool
    let contentHeight: CGFloat
    let viewportHeight: CGFloat
}

/// Centered "· · ·" / spinner row inside the load-older control.
private struct OlderHistoryRow: View {
    let isLoading: Bool

    var body: some View {
        HStack(spacing: 8) {
            if isLoading {
                ProgressView()
                    .controlSize(.small)
                Text("Loading older messages…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text("· · ·")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }
}
