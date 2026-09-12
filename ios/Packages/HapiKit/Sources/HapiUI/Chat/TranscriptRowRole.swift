import Foundation

/// Presentation-only rhythm; independent of protocol grouping and stable IDs.
public enum TranscriptRowRole {
    case history, user, tool, content

    public func spacing(after previous: TranscriptRowRole?) -> CGFloat {
        guard let previous, previous != .history, self != .history else { return 12 }
        if self == .user { return previous == .user ? 8 : 24 }
        if previous == .user { return 16 }
        if self == .tool && previous == .tool { return 8 }
        return 12
    }
}
