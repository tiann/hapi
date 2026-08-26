import Foundation

/// Merge/order semantics for window rows — a faithful port of
/// `web/src/lib/messages.ts` (`compareMessages`, `mergeMessages`), matching
/// the Android reference port (`window/MessageMerge.kt`) one-to-one.
public enum MessageMerge {

    /// Position comparator: ascending `at = invokedAt ?? createdAt`, ties by
    /// `seq`, full ties by ASCII (UTF-16 code unit) id comparison. The web
    /// uses `localeCompare` for the final tie-break, but the fixtures keep
    /// every position pair distinct and the fixtures README pins ASCII
    /// comparison for native ports (`shared/fixtures/README.md`, pagination
    /// determinism notes).
    public static func compare(_ a: WindowMessage, _ b: WindowMessage) -> Int {
        let aTime = a.invokedAtNumber ?? a.createdAt
        let bTime = b.invokedAtNumber ?? b.createdAt
        if aTime != bTime { return aTime < bTime ? -1 : 1 }
        if let aSeq = a.seq, let bSeq = b.seq, aSeq != bSeq {
            return aSeq < bSeq ? -1 : 1
        }
        if a.id == b.id { return 0 }
        return a.id.utf16.lexicographicallyPrecedes(b.id.utf16) ? -1 : 1
    }

    /// Stable sort by ``compare(_:_:)`` — JS `Array.prototype.sort` is
    /// specified stable; Swift's `sorted` is not documented stable, so ties
    /// (only possible for duplicate ids in raw input) are pinned by index.
    static func sortedByPosition(_ messages: [WindowMessage]) -> [WindowMessage] {
        messages.enumerated()
            .sorted { lhs, rhs in
                let comparison = compare(lhs.element, rhs.element)
                return comparison != 0 ? comparison < 0 : lhs.offset < rhs.offset
            }
            .map(\.element)
    }

    /// Merge `incoming` into `existing`:
    /// - by-id upsert (incoming wins — the incoming **instance** replaces the
    ///   row even when content-identical, which is what classifies it as
    ///   changed for the reset baseline; a numeric `invokedAt` already known
    ///   locally is preserved when the incoming copy lacks one);
    /// - stored rows carrying a `localId` evict the optimistic bubble with
    ///   the same `localId`, inheriting its client `status` (when the server
    ///   row has none) and any locally-known numeric `invokedAt`;
    /// - fallback: an optimistic row already `sent` is dropped when a server
    ///   user message sits within 10 s of the same position;
    /// - stable sort by the position comparator.
    public static func mergeMessages(
        _ existing: [WindowMessage],
        _ incoming: [WindowMessage]
    ) -> [WindowMessage] {
        if existing.isEmpty {
            return sortedByPosition(incoming)
        }
        if incoming.isEmpty {
            return sortedByPosition(existing)
        }

        // JS Map: first-insertion key order, later sets update in place.
        var order: [String] = []
        var byId: [String: WindowMessage] = [:]
        for message in existing {
            if byId.updateValue(message, forKey: message.id) == nil {
                order.append(message.id)
            }
        }
        for message in incoming {
            let current = byId[message.id]
            let replacement: WindowMessage
            // JS `existing.invokedAt != null && msg.invokedAt == null` — keep
            // a locally-known invocation stamp when the incoming copy has
            // none (explicit null or absent).
            if let current, let knownInvokedAt = current.invokedAtNumber, message.invokedAtNumber == nil {
                replacement = message.withInvokedAt(knownInvokedAt)
            } else {
                replacement = message
            }
            if byId.updateValue(replacement, forKey: message.id) == nil {
                order.append(message.id)
            }
        }

        var merged: [WindowMessage] = order.map { byId[$0]! }

        var incomingStoredLocalIds = Set<String>()
        for message in incoming {
            if let localId = message.localId, !message.isOptimistic {
                incomingStoredLocalIds.insert(localId)
            }
        }

        if !incomingStoredLocalIds.isEmpty {
            var optimisticStatusByLocalId: [String: MessageStatus] = [:]
            var optimisticInvokedAtByLocalId: [String: Int?] = [:]
            for message in merged {
                guard
                    let localId = message.localId,
                    message.isOptimistic,
                    incomingStoredLocalIds.contains(localId)
                else { continue }
                if let status = message.status {
                    optimisticStatusByLocalId[localId] = status
                }
                // JS `msg.invokedAt !== undefined` — record when the key was
                // present, even as an explicit null. `updateValue` (not the
                // subscript setter) so a nil VALUE still creates the entry,
                // mirroring the JS Map.
                if message.invokedAt.isPresent {
                    optimisticInvokedAtByLocalId.updateValue(message.invokedAtNumber, forKey: localId)
                }
            }
            merged = merged.filter { message in
                guard let localId = message.localId, incomingStoredLocalIds.contains(localId) else {
                    return true
                }
                return !message.isOptimistic
            }
            if !optimisticStatusByLocalId.isEmpty || !optimisticInvokedAtByLocalId.isEmpty {
                merged = merged.map { message in
                    guard let localId = message.localId else { return message }
                    var updated = message
                    if let preservedStatus = optimisticStatusByLocalId[localId], message.status == nil {
                        updated = updated.withStatus(preservedStatus)
                    }
                    if message.invokedAtNumber == nil,
                       let recorded = optimisticInvokedAtByLocalId[localId],
                       let optimisticInvokedAt = recorded {
                        updated = updated.withInvokedAt(optimisticInvokedAt)
                    }
                    return updated
                }
            }
        }

        let optimisticMessages = merged.filter(\.isOptimistic)
        let nonOptimisticMessages = merged.filter { !$0.isOptimistic }
        var result = nonOptimisticMessages

        for optimistic in optimisticMessages {
            if optimistic.status == .sent {
                // Compare by the position key (invokedAt ?? createdAt): a
                // late ack can attach invokedAt long after createdAt, and
                // matching on createdAt alone would render duplicates.
                let optimisticTime = optimistic.invokedAtNumber ?? optimistic.createdAt
                let hasServerUserMessage = nonOptimisticMessages.contains { message in
                    message.isUserMessage
                        && abs((message.invokedAtNumber ?? message.createdAt) - optimisticTime) < 10_000
                }
                if hasServerUserMessage { continue }
            }
            result.append(optimistic)
        }

        return sortedByPosition(result)
    }
}
