import Foundation

/// Renderability predicate for window retention — the web store's
/// `shouldRetainWindowMessage` calls `normalizeDecryptedMessage(message) !==
/// null` (`web/src/lib/message-window-store.ts:468`); rows the chat pipeline
/// would hide never enter the window (but still advance cursors).
///
/// Unlike the Android port (which predates its chat-pipeline port and keeps a
/// hand-mirrored null-decision tree with a dedup TODO), iOS already has the
/// full fixtures-green pipeline in `Chat/` — so this predicate simply asks
/// it, exactly like the web, and the two cannot drift. The pipeline returns
/// `nil` only for skippable agent output and codex payloads its switch cannot
/// render; the drop decision depends solely on `content`, so the probe wraps
/// the content in a synthetic row (id/timestamps never affect nil-ness).
public enum MessageRetention {

    public static func isRenderable(_ content: JSONValue) -> Bool {
        let probe = DecryptedMessage(
            id: "window-retention-probe",
            content: content,
            createdAt: 0
        )
        return normalizeDecryptedMessage(probe) != nil
    }
}
