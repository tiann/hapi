import Foundation
import HapiProtocol
import Observation

public struct PendingRead: Codable, Equatable, Sendable {
    public var id: UUID
    public var request: SessionReadStateRequest
}

/// Durable read revisions and outbox, isolated by hub directory and namespace.
public struct LastSeenState: Codable, Equatable, Sendable {
    public var lastSeen: [String: Int] = [:]
    public var server: [String: SessionReadState] = [:]
    public var pending: [String: PendingRead] = [:]
    public init() {}
}

private actor ReadStateWriter {
    func write(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
    }
}

@MainActor @Observable
public final class LastSeenStore {
    public private(set) var state: LastSeenState
    public private(set) var persistenceError: String?
    /// Sessions whose visible chat follows its tail; never persisted.
    public private(set) var followedTails: [String: Int] = [:]
    @ObservationIgnored private let directory: URL?
    @ObservationIgnored private var namespace: String?
    @ObservationIgnored private let writer = ReadStateWriter()
    @ObservationIgnored private var mutationTask: Task<Void, Never>?
    @ObservationIgnored private var mutationToken: UUID?
    @ObservationIgnored private var syncTask: Task<Void, Never>?
    @ObservationIgnored private var syncToken: UUID?
    @ObservationIgnored private var sender: (@Sendable (String, SessionReadStateRequest) async throws -> SessionReadState)?
    @ObservationIgnored private var foreground = true
    @ObservationIgnored private var closed = false
    public var isPersisting: Bool { mutationTask != nil }

    public init(snapshotDirectory: URL? = nil, namespace: String? = "default") {
        self.directory = snapshotDirectory
        self.namespace = namespace
        self.state = Self.load(directory: snapshotDirectory, namespace: namespace)
    }

    private static func file(directory: URL?, namespace: String?) -> URL? {
        guard let directory, let namespace else { return nil }
        let name = namespace.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        return directory.appendingPathComponent("read-state-\(name).json")
    }

    private static func load(directory: URL?, namespace: String?) -> LastSeenState {
        guard let url = file(directory: directory, namespace: namespace),
              let data = try? Data(contentsOf: url),
              let state = try? HapiJSON.decoder.decode(LastSeenState.self, from: data) else { return LastSeenState() }
        return state
    }

    public func configure(namespace: String, sender: @escaping @Sendable (String, SessionReadStateRequest) async throws -> SessionReadState) async {
        guard !closed else { return }
        await flushPersistence()
        if self.namespace != namespace {
            syncTask?.cancel()
            syncTask = nil
            syncToken = nil
            self.namespace = namespace
            state = Self.load(directory: directory, namespace: namespace)
        }
        self.sender = sender
        sync()
    }

    public func setForeground(_ value: Bool) {
        foreground = value
        if value { sync() }
    }

    public func shutdown() { closed = true; foreground = false; syncTask?.cancel(); syncTask = nil; syncToken = nil }

    public func lastSeenAt(_ sessionId: String) -> Int { state.lastSeen[sessionId] ?? 0 }

    /// A followed tail acknowledges output as it lays out. Until that lands,
    /// rows hide its ordinary dot rather than flash it per message.
    public func setFollowingTail(_ sessionId: String, _ following: Bool) {
        let count = (followedTails[sessionId] ?? 0) + (following ? 1 : -1)
        followedTails[sessionId] = count > 0 ? count : nil
    }

    /// Every successful mark is already persisted; this waits for in-flight writes.
    public func flushPersistence() async { await mutationTask?.value }

    private func commit(namespace expectedNamespace: String? = nil, _ transform: @escaping @MainActor (LastSeenState) -> LastSeenState) async {
        let previous = mutationTask
        let identity = expectedNamespace ?? namespace
        let token = UUID()
        mutationToken = token
        let task = Task { @MainActor in
            await previous?.value
            guard self.namespace == identity else { return }
            let next = transform(self.state)
            guard next != self.state else { return }
            do {
                if let url = Self.file(directory: self.directory, namespace: identity) {
                    let data = try HapiJSON.encoder.encode(next)
                    try await self.writer.write(data, to: url)
                }
                guard self.namespace == identity else { return }
                self.state = next
                self.persistenceError = nil
            } catch { self.persistenceError = error.localizedDescription }
        }
        mutationTask = task
        await task.value
        if mutationToken == token { mutationTask = nil; mutationToken = nil }
    }

    public func markSeen(sessionId: String, revision: Int, serverState: SessionReadState? = nil) async {
        guard !closed, namespace != nil, !sessionId.isEmpty, revision >= 0 else { return }
        await commit { current in
            let server = SessionReadState.merge(current.server[sessionId], serverState) ?? SessionReadState()
            let seen = max(current.lastSeen[sessionId] ?? 0, server.readRevision)
            let manual = server.manualUnread && current.pending[sessionId]?.request.expectedVersion != server.version
            guard seen < revision || manual else { return current }
            var next = current
            next.lastSeen[sessionId] = max(seen, revision)
            next.server[sessionId] = server
            next.pending[sessionId] = PendingRead(id: UUID(), request: SessionReadStateRequest(
                readRevision: max(seen, revision), expectedVersion: serverState?.version ?? server.version
            ))
            return next
        }
        sync()
    }

    private func sync() {
        guard !closed, foreground, syncTask == nil, !state.pending.isEmpty, let sender else { return }
        let identity = namespace
        let token = UUID()
        syncToken = token
        syncTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if self.syncToken == token {
                    self.syncTask = nil
                    self.syncToken = nil
                    if !Task.isCancelled { self.sync() }
                }
            }
            while !Task.isCancelled && self.foreground && self.namespace == identity {
                guard let (id, pending) = self.state.pending.first else { break }
                do {
                    let response = try await sender(id, pending.request)
                    guard !Task.isCancelled, self.namespace == identity else { break }
                    await self.commit(namespace: identity) { current in
                        var next = current
                        next.server[id] = SessionReadState.merge(current.server[id], response)
                        if next.pending[id]?.id == pending.id { next.pending[id] = nil }
                        return next
                    }
                    if self.persistenceError != nil { try await Task.sleep(for: .seconds(5)) }
                } catch is CancellationError { break
                } catch let error as APIError where [400, 403, 404, 409].contains(error.status) {
                    guard !Task.isCancelled, self.namespace == identity else { break }
                    let authoritative = error.body?.data(using: .utf8).flatMap {
                        try? HapiJSON.decoder.decode(SessionReadStateResponse.self, from: $0).readState
                    }
                    await self.commit(namespace: identity) { current in
                        var next = current
                        next.server[id] = SessionReadState.merge(current.server[id], authoritative)
                        if next.pending[id]?.id == pending.id {
                            next.pending[id] = nil
                            next.lastSeen[id] = next.server[id]?.readRevision ?? 0
                        }
                        return next
                    }
                    if self.persistenceError != nil { try? await Task.sleep(for: .seconds(5)) }
                } catch {
                    do { try await Task.sleep(for: .seconds(5)) } catch { break }
                }
            }
        }
    }

    /// Running sessions count too; `followedTails` only affects display.
    public static func isUnread(_ summary: SessionSummary, state: LastSeenState, followedTails: [String: Int] = [:]) -> Bool {
        let server = SessionReadState.merge(state.server[summary.id], summary.readState) ?? SessionReadState()
        let manual = server.manualUnread && state.pending[summary.id]?.request.expectedVersion != server.version
        return manual || (followedTails[summary.id] == nil
            && (summary.contentRevision ?? 0) > max(server.readRevision, state.lastSeen[summary.id] ?? 0))
    }
}
