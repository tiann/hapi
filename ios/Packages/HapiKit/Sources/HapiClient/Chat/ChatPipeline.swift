import Foundation
import HapiProtocol

/// Off-main executor for the read-only chat reduction path (M2f): window rows
/// → `normalizeDecryptedMessage` → `reduceChatBlocks` → `buildVisibleChatBlocks`.
/// Mirrors the web `SessionChat.tsx` pipeline via the Android port's
/// `ChatViewModel.buildUiState`:
///
/// - **Queued-not-invoked rows are filtered out** — they belong to the
///   composer's queue bar (M3a), not the thread (shared predicate with the
///   window store: `WindowMessage.isQueuedForInvocation`).
/// - **Normalization is memoized per message id by row *instance* identity**
///   (the web `normalizedCache` keyed on object identity). ``WindowMessage``
///   is an identity-carrying class whose transitions allocate a new instance
///   for every changed row, so `===` on the cached source is exactly the
///   web's `cached.source !== message` invalidation. The entry retains the
///   source row (instead of a bare `ObjectIdentifier`) so a deallocated
///   row's identity can never be recycled into a false cache hit.
/// - **Group ids are stabilized across recomputes** by feeding the previous
///   run's `ToolGroupBlock`s back through `ToolGroupingOptions.previousGroups`
///   (web `buildVisibleChatBlocks`'s `previousGroups` contract) — scroll
///   anchoring and expansion state key off `ToolGroupBlock.id`.
///
/// An `actor` so (a) the synchronous pipeline body runs on the cooperative
/// pool, off the main actor that publishes the result, and (b) the memo
/// dictionaries are data-race free while staying plain mutable state. The
/// app-side `ChatModel` is the single caller and awaits each run to
/// completion, so runs never interleave in practice; the actor makes that a
/// guarantee rather than a convention.
public actor ChatPipeline {
    private struct NormalizeCacheEntry {
        /// The exact row instance the cached result was computed from.
        let source: WindowMessage
        /// `nil` == the reference dropped this row (skippable output).
        let normalized: NormalizedMessage?
    }

    private var normalizeCache: [String: NormalizeCacheEntry] = [:]
    private var previousGroups: [ToolGroupBlock] = []

    public init() {}

    /// One pipeline run over the current window + agent state. Pure with
    /// respect to its inputs except for the two memo fields above.
    public func run(
        messages: [WindowMessage],
        agentState: AgentState?,
        hasMoreMessages: Bool
    ) -> [VisibleChatBlock] {
        // Composer-owned rows out; duplicate ids keep the first occurrence
        // (merge output cannot contain duplicates — defensive, like Android).
        let visibleRows = messages.filter { !$0.isQueuedForInvocation }

        var normalized: [NormalizedMessage] = []
        normalized.reserveCapacity(visibleRows.count)
        var seenIds = Set<String>(minimumCapacity: visibleRows.count * 2)
        for row in visibleRows {
            guard seenIds.insert(row.id).inserted else { continue }
            if let cached = normalizeCache[row.id], cached.source === row {
                if let value = cached.normalized {
                    normalized.append(value)
                }
                continue
            }
            var next = normalizeDecryptedMessage(row.asDecryptedMessage)
            // The wire model carries no client send-state; re-attach the
            // window row's status so failed optimistic rows render their
            // retry affordance (the web normalizes `DecryptedMessage &
            // {status}` directly — `normalize.ts` copies `message.status`).
            // Cache correctness holds: a status change allocates a new row
            // instance, which invalidates the memo entry above.
            if let status = row.status {
                next?.status = status.rawValue
            }
            normalizeCache[row.id] = NormalizeCacheEntry(source: row, normalized: next)
            if let next {
                normalized.append(next)
            }
        }
        // Drop cache entries for rows no longer in the window (trims, resets).
        if normalizeCache.count > seenIds.count {
            normalizeCache = normalizeCache.filter { seenIds.contains($0.key) }
        }

        let reduced = reduceChatBlocks(normalized, agentState: agentState)
        let visible = buildVisibleChatBlocks(
            reduced.blocks,
            options: ToolGroupingOptions(
                hasMoreMessages: hasMoreMessages,
                previousGroups: previousGroups
            )
        )
        previousGroups = visible.compactMap { block in
            if case .toolGroup(let group) = block { return group }
            return nil
        }
        return visible
    }

    /// Forget all memo state (session switch / tests).
    public func reset() {
        normalizeCache = [:]
        previousGroups = []
    }
}
