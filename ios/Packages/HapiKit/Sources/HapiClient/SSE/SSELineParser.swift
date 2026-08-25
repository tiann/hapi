import Foundation

/// One dispatched SSE message.
///
/// `id` is the value of the `id:` field seen in THIS event block only — `nil`
/// when the block carried no `id:` line (heartbeat / connection-changed /
/// toast frames). Cursor stickiness is deliberately NOT the parser's job: the
/// caller keeps its last-seen id and lets only non-nil (and non-empty) frame
/// ids overwrite it, so an id-less heartbeat can never reset the cursor.
public struct SSEFrame: Equatable, Sendable {
    public var id: String?
    /// Value of the `event:` field, `nil` for default `message` frames.
    /// The hub only ever sends unnamed frames; kept for completeness.
    public var event: String?
    /// All `data:` lines of the block joined with `\n`.
    public var data: String

    public init(id: String? = nil, event: String? = nil, data: String) {
        self.id = id
        self.event = event
        self.data = data
    }
}

/// Incremental parser for a `text/event-stream` byte stream.
///
/// Feed it raw chunks as they arrive (`consume`); it buffers partial lines
/// across chunk boundaries, understands LF and CRLF line endings, and emits
/// an `SSEFrame` for every blank-line dispatch that accumulated at least one
/// `data:` line. Field handling follows the WHATWG EventSource algorithm:
///
/// - `data:` — multi-line, joined with `\n` at dispatch.
/// - `id:` — sets the block id (ignored when it contains U+0000, per spec).
///   Like EventSource's last-event-id buffer, an id from a block that never
///   dispatched (no data lines) carries over into the next block; a real
///   dispatch consumes it.
/// - `event:` — sets the frame's event name.
/// - `retry:` — ignored; reconnect policy is entirely client-owned (sse.md).
/// - `: comment` lines and unknown fields — ignored.
///
/// Not handled (the hub never produces them): lone-CR line endings and a
/// leading UTF-8 BOM. Create a fresh parser per connection; state must never
/// bleed across reconnects.
public struct SSELineParser: Sendable {
    private var pendingLine = Data()
    private var dataLines: [String] = []
    private var eventType: String?
    private var eventId: String?

    public init() {}

    /// Consumes one chunk and returns every frame completed by it, in order.
    public mutating func consume(_ chunk: Data) -> [SSEFrame] {
        var frames: [SSEFrame] = []
        for byte in chunk {
            if byte == 0x0A { // LF terminates a line; strip an optional CR.
                if pendingLine.last == 0x0D {
                    pendingLine.removeLast()
                }
                process(line: pendingLine, into: &frames)
                pendingLine.removeAll(keepingCapacity: true)
            } else {
                pendingLine.append(byte)
            }
        }
        return frames
    }

    private mutating func process(line: Data, into frames: inout [SSEFrame]) {
        if line.isEmpty {
            // Blank line: dispatch. Per spec, no data lines means no event —
            // the event type buffer resets, but the id buffer survives so a
            // (hypothetical) id-only block still tags the next dispatch.
            if !dataLines.isEmpty {
                frames.append(SSEFrame(id: eventId, event: eventType, data: dataLines.joined(separator: "\n")))
                dataLines.removeAll(keepingCapacity: true)
                eventId = nil
            }
            eventType = nil
            return
        }
        if line.first == 0x3A { // ':' — comment line.
            return
        }

        let field: String
        let value: String
        if let colonIndex = line.firstIndex(of: 0x3A) {
            field = String(decoding: line[line.startIndex..<colonIndex], as: UTF8.self)
            var valueBytes = line[line.index(after: colonIndex)...]
            if valueBytes.first == 0x20 { // A single leading space is stripped.
                valueBytes = valueBytes.dropFirst()
            }
            value = String(decoding: valueBytes, as: UTF8.self)
        } else {
            field = String(decoding: line, as: UTF8.self)
            value = ""
        }

        switch field {
        case "data":
            dataLines.append(value)
        case "event":
            eventType = value
        case "id":
            if !value.contains("\u{0000}") {
                eventId = value
            }
        case "retry":
            break // Server-suggested delays are ignored; policy is ours.
        default:
            break // Unknown fields are ignored per spec.
        }
    }
}
