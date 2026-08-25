import Foundation

// Port of web/src/chat/reducerCliOutput.ts — CLI-echo detection and the
// command-name → local-command-stdout merge.

private let cliTagRegex = JSRegex("<(?:local-command-[a-z-]+|command-(?:name|message|args))>", caseInsensitive: true)
private let cliCommandNameRegex = JSRegex("<command-name>", caseInsensitive: true)
private let cliCommandStdoutRegex = JSRegex("<local-command-stdout>", caseInsensitive: true)

private func getMetaSentFrom(_ meta: JSONValue?) -> String? {
    meta?.objectValue?["sentFrom"]?.stringValue
}

private func hasCliOutputTags(_ text: String) -> Bool {
    cliTagRegex.test(text)
}

private func hasCommandNameTag(_ text: String) -> Bool {
    cliCommandNameRegex.test(text)
}

private func hasLocalCommandStdoutTag(_ text: String) -> Bool {
    cliCommandStdoutRegex.test(text)
}

/// Port of `isCliOutputText`.
func isCliOutputText(_ text: String, meta: JSONValue?) -> Bool {
    getMetaSentFrom(meta) == "cli" && hasCliOutputTags(text)
}

/// Port of `mergeCliOutputBlocks`: a `<command-name>` block absorbs its
/// `<local-command-stdout>` follow-up (same source), preferring the command
/// block's metadata.
func mergeCliOutputBlocks(_ blocks: [BlockBox]) -> [BlockBox] {
    var merged: [BlockBox] = []

    for box in blocks {
        guard case .cliOutput(let block) = box.block else {
            merged.append(box)
            continue
        }

        if let prevBox = merged.last,
           case .cliOutput(let prev) = prevBox.block,
           prev.source == block.source,
           hasCommandNameTag(prev.text),
           !hasLocalCommandStdoutTag(prev.text),
           hasLocalCommandStdoutTag(block.text) {
            let separator = (prev.text.hasSuffix("\n") || block.text.hasPrefix("\n")) ? "" : "\n"
            var next = prev
            next.text = prev.text + separator + block.text
            next.invokedAt = prev.invokedAt ?? block.invokedAt
            next.durationMs = prev.durationMs ?? block.durationMs
            next.usage = prev.usage ?? block.usage
            next.model = prev.model ?? block.model
            prevBox.block = .cliOutput(next)
            continue
        }

        merged.append(box)
    }

    return merged
}
