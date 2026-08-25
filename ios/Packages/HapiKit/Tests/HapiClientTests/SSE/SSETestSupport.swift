import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking  // URLSession types live here on Linux
#endif
import HapiProtocol
@testable import HapiClient

// MARK: - Manual clock

/// Deterministic clock: `sleep` parks on a continuation until test code
/// advances time. Cancellation resumes the sleeper with `CancellationError`,
/// including the cancel-before-park race.
final class ManualClock: SSEClock, @unchecked Sendable {
    private struct Sleeper {
        let id: Int
        let deadlineMs: Int
        let continuation: CheckedContinuation<Void, Error>
    }

    private let lock = NSLock()
    private var currentMs = 0
    private var nextSleeperId = 0
    private var sleepers: [Sleeper] = []
    private var cancelledIds: Set<Int> = []

    func nowMs() -> Int {
        lock.withLock { currentMs }
    }

    func sleep(ms: Int) async throws {
        let id: Int = lock.withLock {
            nextSleeperId += 1
            return nextSleeperId
        }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                enum Immediate { case resume, cancel, park }
                let action: Immediate = lock.withLock {
                    if cancelledIds.remove(id) != nil {
                        return .cancel
                    }
                    if ms <= 0 {
                        return .resume
                    }
                    sleepers.append(Sleeper(id: id, deadlineMs: currentMs + ms, continuation: continuation))
                    return .park
                }
                switch action {
                case .resume: continuation.resume()
                case .cancel: continuation.resume(throwing: CancellationError())
                case .park: break
                }
            }
        } onCancel: {
            let sleeper: Sleeper? = lock.withLock {
                if let index = sleepers.firstIndex(where: { $0.id == id }) {
                    return sleepers.remove(at: index)
                }
                cancelledIds.insert(id)
                return nil
            }
            sleeper?.continuation.resume(throwing: CancellationError())
        }
    }

    /// Number of currently parked sleepers. Tests gate clock advances on
    /// this: the client's watchdog registers its sleep asynchronously, and
    /// advancing before it parked would leave it waiting for a deadline the
    /// test never reaches.
    func activeSleeperCount() -> Int {
        lock.withLock { sleepers.count }
    }

    func advance(byMs delta: Int) {
        let due: [Sleeper] = lock.withLock {
            currentMs += delta
            let now = currentMs
            let ready = sleepers.filter { $0.deadlineMs <= now }.sorted { $0.deadlineMs < $1.deadlineMs }
            sleepers.removeAll { $0.deadlineMs <= now }
            return ready
        }
        for sleeper in due {
            sleeper.continuation.resume()
        }
    }
}

// MARK: - Fake transport

final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    func set() {
        lock.withLock { value = true }
    }

    var isSet: Bool {
        lock.withLock { value }
    }
}

final class FakeConnection: @unchecked Sendable {
    let request: URLRequest
    private let continuation: AsyncThrowingStream<SSETransportEvent, Error>.Continuation
    private let terminated = Flag()

    init(request: URLRequest, continuation: AsyncThrowingStream<SSETransportEvent, Error>.Continuation) {
        self.request = request
        self.continuation = continuation
        let flag = terminated
        continuation.onTermination = { _ in flag.set() }
    }

    var isTerminated: Bool {
        terminated.isSet
    }

    func open(status: Int = 200) {
        let response = HTTPURLResponse(
            url: request.url ?? URL(string: "https://hub.test")!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: nil
        )!
        continuation.yield(.connected(response))
    }

    func send(_ text: String) {
        continuation.yield(.bytes(Data(text.utf8)))
    }

    func sendEvent(_ json: String, id: String? = nil) {
        var block = ""
        if let id {
            block += "id: \(id)\n"
        }
        block += "data: \(json)\n\n"
        send(block)
    }

    func sendHeartbeat(timestamp: Int = 1) {
        sendEvent("{\"type\":\"heartbeat\",\"namespace\":\"ns\",\"data\":{\"timestamp\":\(timestamp)}}")
    }

    func sendHandshake(resume: String? = "ok", subscriptionId: String = "sub-1") {
        let resumeField = resume.map { ",\"resume\":\"\($0)\"" } ?? ""
        sendEvent("{\"type\":\"connection-changed\",\"data\":{\"status\":\"connected\",\"subscriptionId\":\"\(subscriptionId)\"\(resumeField)}}")
    }

    func finish() {
        continuation.finish()
    }

    func fail(_ error: Error = URLError(.networkConnectionLost)) {
        continuation.finish(throwing: error)
    }

    var queryItems: [String: String] {
        guard let url = request.url,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return [:]
        }
        var result: [String: String] = [:]
        for item in components.queryItems ?? [] {
            result[item.name] = item.value ?? ""
        }
        return result
    }
}

final class FakeTransport: SSETransport, @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [FakeConnection] = []
    private var connectCount = 0

    func connect(_ request: URLRequest) -> AsyncThrowingStream<SSETransportEvent, Error> {
        let (stream, continuation) = AsyncThrowingStream.makeStream(of: SSETransportEvent.self)
        let connection = FakeConnection(request: request, continuation: continuation)
        lock.withLock {
            connectCount += 1
            pending.append(connection)
        }
        return stream
    }

    func totalConnections() -> Int {
        lock.withLock { connectCount }
    }

    /// Real-time bounded wait for the next unclaimed connection.
    func nextConnection(timeoutMs: Int = 2_000) async -> FakeConnection? {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1_000)
        while Date() < deadline {
            let claimed: FakeConnection? = lock.withLock {
                pending.isEmpty ? nil : pending.removeFirst()
            }
            if let claimed {
                return claimed
            }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return nil
    }

    /// True when no NEW connection shows up within the grace window.
    func expectNoConnection(forMs ms: Int = 200) async -> Bool {
        let deadline = Date().addingTimeInterval(Double(ms) / 1_000)
        while Date() < deadline {
            let hasPending = lock.withLock { !pending.isEmpty }
            if hasPending {
                return false
            }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return lock.withLock { pending.isEmpty }
    }
}

// MARK: - Fake path observer

final class FakePathObserver: NetworkPathObserving, @unchecked Sendable {
    private let lock = NSLock()
    private var continuations: [AsyncStream<NetworkPathUpdate>.Continuation] = []

    func pathUpdates() -> AsyncStream<NetworkPathUpdate> {
        let (stream, continuation) = AsyncStream.makeStream(of: NetworkPathUpdate.self)
        lock.withLock { continuations.append(continuation) }
        // NWPathMonitor always fires the current path on subscription.
        continuation.yield(NetworkPathUpdate(isSatisfied: true))
        return stream
    }

    /// Tests gate `emitChange` on this: the client subscribes from an async
    /// task, and a change emitted before subscription would be lost.
    func subscriberCount() -> Int {
        lock.withLock { continuations.count }
    }

    func emitChange(isSatisfied: Bool = true) {
        let all = lock.withLock { continuations }
        for continuation in all {
            continuation.yield(NetworkPathUpdate(isSatisfied: isSatisfied))
        }
    }
}

// MARK: - Token source

final class TokenSource: @unchecked Sendable {
    private let lock = NSLock()
    private var queue: [String?]
    private(set) var calls = 0

    /// Returns the queued tokens in order, sticking on the last one.
    init(_ tokens: [String?]) {
        queue = tokens
    }

    func next() -> String? {
        lock.withLock {
            calls += 1
            if queue.count > 1 {
                return queue.removeFirst()
            }
            return queue.first ?? nil
        }
    }

    func callCount() -> Int {
        lock.withLock { calls }
    }
}

// MARK: - Event collection

final class EventBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [SSEClientEvent] = []

    func append(_ event: SSEClientEvent) {
        lock.withLock { storage.append(event) }
    }

    var snapshot: [SSEClientEvent] {
        lock.withLock { storage }
    }

    var syncEvents: [SyncEvent] {
        snapshot.compactMap {
            if case .event(let event) = $0 { return event }
            return nil
        }
    }

    var handshakes: [SSEClientEvent] {
        snapshot.filter {
            if case .handshake = $0 { return true }
            return false
        }
    }

    var states: [SSEConnectionState] {
        snapshot.compactMap {
            if case .stateChanged(let state) = $0 { return state }
            return nil
        }
    }
}

func collect(_ stream: AsyncStream<SSEClientEvent>) -> (box: EventBox, task: Task<Void, Never>) {
    let box = EventBox()
    let task = Task {
        for await event in stream {
            box.append(event)
        }
    }
    return (box, task)
}

/// Real-time bounded poll for an async condition.
@discardableResult
func waitUntil(
    timeoutMs: Int = 2_000,
    _ condition: @Sendable () async -> Bool
) async -> Bool {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1_000)
    while Date() < deadline {
        if await condition() {
            return true
        }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    return await condition()
}
