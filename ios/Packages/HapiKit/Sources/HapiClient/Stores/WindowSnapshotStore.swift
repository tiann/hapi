#if canImport(CryptoKit)
import CryptoKit
#endif
import Foundation
import HapiProtocol

/// Per-session message-window snapshots on disk: one JSON file per session in
/// ``directory``, written atomically, pruned LRU to ``maxSessions`` files.
///
/// Mirrors the web's `sessionStorage` persistence of
/// `PersistedMessageWindowState` (key `hapi:message-window:v2:`) and the
/// Android port's `WindowSnapshots`: messages + cursors + epoch for instant
/// cold-start rendering; `MessageWindowLogic.hydrate` restores interrupted
/// send states and flags stale snapshots for a latest reset.
///
/// All operations are best-effort and synchronous (files are small; the web
/// writes to `sessionStorage` synchronously too) — I/O errors are swallowed
/// like the web's `persistState` try/catch.
///
/// TODO(A-M2a dedup): the session-list work package introduces a generic
/// JSON snapshot cache; fold this store into it once both are on the branch
/// (Android carries the same TODO between `WindowSnapshots` and
/// `JsonSnapshotStore`).
public struct WindowSnapshotStore: Sendable {
    public let directory: URL
    public let maxSessions: Int

    private static let suffix = ".window.json"

    public init(directory: URL, maxSessions: Int = 10) {
        self.directory = directory
        self.maxSessions = maxSessions
    }

    /// Default location: `Caches/hapi-message-windows` (purgeable by the OS —
    /// snapshots are a warm-start optimization, never authoritative).
    public static func defaultStore() -> WindowSnapshotStore {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return WindowSnapshotStore(directory: caches.appendingPathComponent("hapi-message-windows"))
    }

    public func save(sessionId: String, snapshot: PersistedMessageWindow) {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let data = try HapiJSON.encoder.encode(snapshot)
            try data.write(to: fileURL(for: sessionId), options: .atomic)
            prune()
        } catch {
            // Best-effort persistence, mirroring the web store.
        }
    }

    public func load(sessionId: String) -> PersistedMessageWindow? {
        let url = fileURL(for: sessionId)
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let snapshot = try? HapiJSON.decoder.decode(PersistedMessageWindow.self, from: data) else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        // Touch for LRU recency: reading a snapshot marks the session live.
        try? FileManager.default.setAttributes(
            [.modificationDate: Date()],
            ofItemAtPath: url.path
        )
        return snapshot
    }

    public func delete(sessionId: String) {
        try? FileManager.default.removeItem(at: fileURL(for: sessionId))
    }

    /// Drop the least-recently-written files beyond ``maxSessions``.
    private func prune() {
        guard let contents = try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey]
        ) else { return }
        let snapshots = contents.filter { $0.lastPathComponent.hasSuffix(Self.suffix) }
        guard snapshots.count > maxSessions else { return }
        func modificationDate(_ url: URL) -> Date {
            (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
                ?? .distantPast
        }
        for stale in snapshots.sorted(by: { modificationDate($0) > modificationDate($1) }).dropFirst(maxSessions) {
            try? FileManager.default.removeItem(at: stale)
        }
    }

    /// Session ids are arbitrary strings — file names come from a digest
    /// (same scheme as the Android port: first 32 hex chars of SHA-256).
    private func fileURL(for sessionId: String) -> URL {
        directory.appendingPathComponent(Self.digestName(for: sessionId) + Self.suffix)
    }

    #if canImport(CryptoKit)
    static func digestName(for sessionId: String) -> String {
        let digest = SHA256.hash(data: Data(sessionId.utf8))
        return String(digest.map { String(format: "%02x", $0) }.joined().prefix(32))
    }
    #else
    /// Linux fallback (no CryptoKit, and no new deps allowed): FNV-1a 64-bit
    /// over the UTF-8 bytes, hex-encoded. The digest is only a filename — it
    /// never crosses devices or the wire, so the two platforms hashing
    /// differently is harmless; collisions are the only concern and FNV-1a
    /// is adequate for tens of session ids.
    static func digestName(for sessionId: String) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in sessionId.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01B3
        }
        // A second pass seeded differently widens the name to 32 hex chars so
        // both platforms produce equal-length filenames.
        var hash2: UInt64 = 0x84222325_cbf29ce4
        for byte in sessionId.utf8.reversed() {
            hash2 ^= UInt64(byte)
            hash2 = hash2 &* 0x0000_0100_0000_01B3
        }
        return String(format: "%016lx%016lx", hash, hash2)
    }
    #endif
}
