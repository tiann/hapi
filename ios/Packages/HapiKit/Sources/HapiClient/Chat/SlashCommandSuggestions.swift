import Foundation
import HapiProtocol

/// Pure logic behind the composer's `/` autocomplete — the Android
/// `SlashCommands` port with the web ranking (`useSlashCommands`): trigger
/// detection, source merging and filtering. Sources are the session's
/// `metadata.slashCommands` names plus the `GET /slash-commands` RPC list;
/// no hand-maintained built-in table, so the CLI stays the source of truth.
public enum SlashCommandSuggestions {
    /// The active query while the composer is one `/`-led token at the start
    /// of the input (`/`, `/co`, `/foo:bar`); whitespace closes the menu.
    public static func query(of text: String) -> String? {
        guard text.hasPrefix("/") else { return nil }
        let token = text.dropFirst()
        guard !token.contains(where: { $0.isWhitespace }) else { return nil }
        return String(token)
    }

    /// Bare metadata names merged with the RPC list (descriptions/sources),
    /// deduped case-insensitively; later entries win and take the later
    /// position (web `mergeSlashCommands`).
    public static func merge(metadataNames: [String]?, fetched: [SlashCommand]?) -> [SlashCommand] {
        var combined: [SlashCommand] = (metadataNames ?? []).compactMap { raw in
            var name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if name.hasPrefix("/") { name.removeFirst() }
            return name.isEmpty ? nil : SlashCommand(name: name, source: "session")
        }
        combined += fetched ?? []
        var order: [String] = []
        var byName: [String: SlashCommand] = [:]
        for command in combined {
            let key = command.name.lowercased()
            if byName[key] != nil {
                order.removeAll { $0 == key }
            }
            order.append(key)
            byName[key] = command
        }
        return order.compactMap { byName[$0] }
    }

    /// Web ranking: exact → prefix → contains → close typo (Levenshtein
    /// within `max(2, n/2)`); stable within a rank. Empty query keeps all.
    public static func filter(_ commands: [SlashCommand], query: String) -> [SlashCommand] {
        let term = query.lowercased()
        guard !term.isEmpty else { return commands }
        let maxDistance = max(2, term.count / 2)
        return commands.enumerated()
            .compactMap { offset, command -> (command: SlashCommand, rank: Int, offset: Int)? in
                let name = command.name.lowercased()
                let rank: Int
                if name == term {
                    rank = 0
                } else if name.hasPrefix(term) {
                    rank = 1
                } else if name.contains(term) {
                    rank = 2
                } else {
                    let distance = levenshtein(term, name)
                    guard distance <= maxDistance else { return nil }
                    rank = 3 + distance
                }
                return (command, rank, offset)
            }
            .sorted { $0.rank != $1.rank ? $0.rank < $1.rank : $0.offset < $1.offset }
            .map(\.command)
    }

    static func levenshtein(_ a: String, _ b: String) -> Int {
        let a = Array(a), b = Array(b)
        if a.isEmpty { return b.count }
        if b.isEmpty { return a.count }
        var previous = Array(0...b.count)
        for i in 1...a.count {
            var current = [i] + Array(repeating: 0, count: b.count)
            for j in 1...b.count {
                current[j] = a[i - 1] == b[j - 1]
                    ? previous[j - 1]
                    : min(previous[j - 1], current[j - 1], previous[j]) + 1
            }
            previous = current
        }
        return previous[b.count]
    }
}
