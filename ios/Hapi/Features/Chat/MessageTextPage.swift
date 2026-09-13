import Foundation

/// Bound the *input* to Text, not just its visible lines. A single log can be
/// larger than the rest of the transcript, defeating cell-level recycling.
struct MessageTextPage: Equatable, Sendable {
    static let inlineCharacters = 8_000
    static let inlineLines = 120
    static let previewCharacters = 2_000
    static let previewLines = 24
    static let pageCharacters = 4_000
    static let pageLines = 80

    let text: String
    let end: String.Index

    static func preview(_ source: String) -> Self {
        // Folding is a large-payload safeguard, not a one-screen reading
        // limit. Normal multi-screen prompts stay complete. This bounded
        // probe also avoids counting/scanning an entire giant log.
        let inline = read(source, from: source.startIndex, characters: inlineCharacters, lines: inlineLines)
        guard inline.end < source.endIndex else { return inline }
        return read(source, from: source.startIndex, characters: previewCharacters, lines: previewLines)
    }

    static func read(_ source: String, from start: String.Index,
                     characters: Int = pageCharacters, lines: Int = pageLines) -> Self {
        precondition(characters > 0 && lines > 0)
        var end = start
        var count = 0
        var lineCount = 1
        while end < source.endIndex, count < characters {
            let character = source[end]
            // CRLF is one Character. Preserve it (and all other whitespace)
            // exactly; the next page starts at this same grapheme boundary.
            if character.isNewline {
                if lineCount == lines { break }
                lineCount += 1
            }
            source.formIndex(after: &end)
            count += 1
        }
        // A page beginning with a newline still consumes it (lines >= 2 in
        // production); even an explicit one-line budget must make progress.
        if end == start, end < source.endIndex { source.formIndex(after: &end) }
        return Self(text: String(source[start..<end]), end: end)
    }
}

/// Only visited page boundaries are retained. Opening a megabyte log never
/// scans/splits the entire payload, and advancing never accumulates Text views.
struct MessageTextPager {
    let source: String
    private var starts: [String.Index]
    private(set) var page: MessageTextPage

    init(source: String) {
        self.source = source
        starts = [source.startIndex]
        page = .read(source, from: source.startIndex)
    }

    var number: Int { starts.count }
    var hasPrevious: Bool { starts.count > 1 }
    var hasNext: Bool { page.end < source.endIndex }

    mutating func next() {
        guard hasNext else { return }
        starts.append(page.end)
        page = .read(source, from: page.end)
    }

    mutating func previous() {
        guard hasPrevious else { return }
        starts.removeLast()
        page = .read(source, from: starts[starts.count - 1])
    }
}
