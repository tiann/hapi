/// Presentation-only hysteresis. Being close enough to hide the latest
/// button never opts the reader back into tail following.
struct TranscriptBottomProximity {
    private(set) var isAwayFromBottom = false

    mutating func update(bottomDistance: Double, followsTail: Bool) {
        guard !followsTail else {
            isAwayFromBottom = false
            return
        }
        let distance = max(0, bottomDistance)
        if isAwayFromBottom {
            if distance <= 24 { isAwayFromBottom = false }
        } else if distance >= 80 {
            isAwayFromBottom = true
        }
    }
}
