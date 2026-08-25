import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking  // URLSession types live here on Linux
#endif

/// What a transport reports while a single SSE connection attempt is alive:
/// exactly one `.connected` first (the HTTP response headers), then raw body
/// chunks. The stream finishes when the server closes the connection and
/// throws on transport errors.
public enum SSETransportEvent: Sendable {
    case connected(HTTPURLResponse)
    case bytes(Data)
}

public enum SSETransportError: Error, Sendable {
    /// The response was not HTTP at all (never happens against a hub).
    case notHTTP
}

/// One-shot connection factory. `SSEClient` calls `connect` once per attempt
/// and drives every retry itself; a transport must never auto-reconnect.
/// Cancelling the consuming task (or dropping the iterator) must tear the
/// underlying connection down.
public protocol SSETransport: Sendable {
    func connect(_ request: URLRequest) -> AsyncThrowingStream<SSETransportEvent, Error>
}

/// Production transport on `URLSession.bytes(for:)`.
///
/// Uses a dedicated session configuration because the defaults are wrong for
/// a long-lived stream that manages its own retries:
///
/// - `timeoutIntervalForRequest` 300 s — this is URLSession's *idle* timeout
///   (time between chunks). It must exceed the 30 s heartbeat interval by a
///   wide margin (≥ 120 s required; the 90 s staleness watchdog in
///   `SSEClient` fires long before it anyway).
/// - `timeoutIntervalForResource` 7 days — the stream is expected to live
///   "forever"; the default 7-minute-per-resource cap would kill it.
/// - `waitsForConnectivity` false — a dead link must surface as an error
///   immediately so the reconnect state machine owns the schedule.
/// - No caching, ephemeral storage — an event stream must never be served
///   from or written to a cache.
public struct URLSessionSSETransport: SSETransport {
    private let session: URLSession

    public init(session: URLSession = URLSessionSSETransport.makeSession()) {
        self.session = session
    }

    public static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 300
        configuration.timeoutIntervalForResource = 7 * 24 * 60 * 60
        #if !canImport(FoundationNetworking)
        // corelibs-foundation declares this get-only (unsupported there); the
        // Linux build is harness/CI-only so the default is acceptable.
        configuration.waitsForConnectivity = false
        #endif
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        return URLSession(configuration: configuration)
    }

    #if canImport(FoundationNetworking)
    // corelibs-foundation has no `URLSession.bytes(for:)`; stream through the
    // classic data-task delegate instead. Linux is harness/CI-only — chunks
    // arrive as delivered by the network stack rather than line-coalesced,
    // which `SSELineParser` handles by contract (arbitrary chunking).
    public func connect(_ request: URLRequest) -> AsyncThrowingStream<SSETransportEvent, Error> {
        let configuration = session.configuration
        return AsyncThrowingStream { continuation in
            let delegate = StreamingDelegate(continuation: continuation)
            let streamingSession = URLSession(
                configuration: configuration,
                delegate: delegate,
                delegateQueue: nil
            )
            let task = streamingSession.dataTask(with: request)
            continuation.onTermination = { _ in
                task.cancel()
                streamingSession.finishTasksAndInvalidate()
            }
            task.resume()
        }
    }

    /// Bridges delegate callbacks into the stream continuation. URLSession
    /// serializes its delegate callbacks, and the continuation is Sendable,
    /// so the unchecked conformance is safe.
    private final class StreamingDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
        private let continuation: AsyncThrowingStream<SSETransportEvent, Error>.Continuation

        init(continuation: AsyncThrowingStream<SSETransportEvent, Error>.Continuation) {
            self.continuation = continuation
        }

        func urlSession(
            _ session: URLSession,
            dataTask: URLSessionDataTask,
            didReceive response: URLResponse,
            completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
        ) {
            guard let http = response as? HTTPURLResponse else {
                continuation.finish(throwing: SSETransportError.notHTTP)
                completionHandler(.cancel)
                return
            }
            continuation.yield(.connected(http))
            completionHandler(.allow)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            continuation.yield(.bytes(data))
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            if let error {
                continuation.finish(throwing: error)
            } else {
                continuation.finish()
            }
        }
    }
    #else
    public func connect(_ request: URLRequest) -> AsyncThrowingStream<SSETransportEvent, Error> {
        let session = self.session
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else {
                        throw SSETransportError.notHTTP
                    }
                    continuation.yield(.connected(http))
                    // AsyncBytes iterates single bytes (buffered internally);
                    // coalesce to one chunk per line so the parser is called
                    // O(lines), not O(bytes).
                    var chunk = Data()
                    chunk.reserveCapacity(1024)
                    for try await byte in bytes {
                        chunk.append(byte)
                        if byte == 0x0A {
                            continuation.yield(.bytes(chunk))
                            chunk.removeAll(keepingCapacity: true)
                        }
                    }
                    if !chunk.isEmpty {
                        continuation.yield(.bytes(chunk))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }
    #endif
}
