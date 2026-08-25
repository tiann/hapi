import Foundation

/// Generic debounced JSON snapshot: one value ↔ one file. Backs the stores'
/// cold-start cache (no database, per the plan) — load synchronously at
/// construction, ``scheduleWrite(_:)`` on every state change, and the
/// debounce collapses SSE bursts into one atomic write.
///
/// Mirrors the Android reference port (`JsonSnapshotStore`): atomicity comes
/// from `Data.write(options: .atomic)` (write-to-temp + rename, Foundation's
/// equivalent of androidx `AtomicFile`), and a torn/corrupt snapshot degrades
/// to `nil` on ``load()`` — the stores then start empty and a REST refetch
/// repopulates.
///
/// `@MainActor` by design: the owning stores are main-actor `@Observable`
/// classes, so the pending-value bookkeeping needs no locking; only the
/// actual file write hops off the main actor.
@MainActor
public final class DiskCache<Value: Codable> {
    /// Snapshot location: `<directory>/<filename>`.
    public let fileURL: URL

    private let debounce: Duration
    private var pending: Value?
    /// Bumped by every ``scheduleWrite(_:)``; a flush clears `pending` only
    /// when no newer value was scheduled while its write was in flight
    /// (value-type stand-in for the reference's identity comparison).
    private var generation = 0
    private var writeTask: Task<Void, Never>?

    /// The debounce defaults to 500 ms (the reference's
    /// `DEFAULT_DEBOUNCE_MS`); tests inject shorter windows.
    public init(
        directory: URL,
        filename: String,
        debounce: Duration = .milliseconds(500)
    ) {
        self.fileURL = directory.appendingPathComponent(filename, isDirectory: false)
        self.debounce = debounce
    }

    /// Synchronous load for cold start; `nil` when absent or undecodable.
    public func load() -> Value? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? HapiJSON.decoder.decode(Value.self, from: data)
    }

    /// Records `value` as the latest state and (re)starts the debounce window.
    public func scheduleWrite(_ value: Value) {
        pending = value
        generation += 1
        writeTask?.cancel()
        writeTask = Task { [debounce] in
            do {
                try await Task.sleep(for: debounce)
            } catch {
                return // superseded by a newer scheduleWrite or a flush
            }
            await self.flushPending()
        }
    }

    /// Writes any pending value immediately (app background / tests).
    public func flush() async {
        writeTask?.cancel()
        writeTask = nil
        await flushPending()
    }

    private func flushPending() async {
        guard let value = pending else { return }
        let flushedGeneration = generation
        let url = fileURL
        // Encode on the main actor (small JSON), write off it.
        let data = try? HapiJSON.encoder.encode(value)
        if let data {
            await Task.detached(priority: .utility) {
                do {
                    try FileManager.default.createDirectory(
                        at: url.deletingLastPathComponent(),
                        withIntermediateDirectories: true
                    )
                    try data.write(to: url, options: .atomic)
                } catch {
                    // A failed snapshot write only costs the next cold start.
                }
            }.value
        }
        // Cleared only when no newer value arrived during the write — a
        // superseding scheduleWrite keeps its value pending for its own
        // flush (same guarantee as the reference's identity check).
        if generation == flushedGeneration {
            pending = nil
        }
    }
}

/// Where per-hub snapshots live:
/// `<Application Support>/HapiKit/hubs/<encoded-origin>/`.
///
/// The base directory is injectable (tests use a temp dir); the origin is
/// percent-encoded down to alphanumerics so it is filesystem-safe and
/// deterministic per hub.
public enum SnapshotLocations {
    public static func directory(forHub hubUrl: String, base: URL? = nil) -> URL {
        let root = base
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let encoded = hubUrl.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "hub"
        return root
            .appendingPathComponent("HapiKit", isDirectory: true)
            .appendingPathComponent("hubs", isDirectory: true)
            .appendingPathComponent(encoded, isDirectory: true)
    }
}
