package app.hapi.companion.feature.chat.composer

import app.hapi.protocol.wire.SlashCommand

/**
 * Pure logic behind the composer's `/` autocomplete (B-M3ce): trigger
 * detection, source merging, and filtering. The UI dropdown lives in
 * `ChatComposer`; `ChatViewModel` drives these over the session's
 * `metadata.slashCommands` + the `GET /slash-commands` RPC result.
 *
 * The skills `$` trigger is deferred (needs the `GET /skills` source and the
 * web's `$`-mention insert semantics) — `/` only for now.
 */
object SlashCommands {
    /**
     * The active slash query: non-null while the composer text is a single
     * `/`-led token at the start of input (`/`, `/co`, `/foo:bar`) — any
     * whitespace closes the menu. Returns the text after `/` (may be empty).
     */
    fun queryOf(text: String): String? {
        if (!text.startsWith("/")) return null
        val token = text.substring(1)
        if (token.any { it.isWhitespace() }) return null
        return token
    }

    /**
     * Merge the session's bare `metadata.slashCommands` names with the
     * RPC-discovered list (which carries descriptions/sources), deduped
     * case-insensitively. Later entries win and take the later position (web
     * `mergeSlashCommands` semantics), so RPC data overrides bare names.
     */
    fun merge(metadataNames: List<String>?, fetched: List<SlashCommand>?): List<SlashCommand> {
        val combined = ArrayList<SlashCommand>()
        metadataNames?.forEach { raw ->
            val name = raw.trim().removePrefix("/")
            if (name.isNotEmpty()) combined += SlashCommand(name = name, source = "session")
        }
        fetched?.let(combined::addAll)
        val byName = LinkedHashMap<String, SlashCommand>()
        for (command in combined) {
            val key = command.name.lowercase()
            byName.remove(key)
            byName[key] = command
        }
        return byName.values.toList()
    }

    /**
     * Case-insensitive filter, ranked exact → prefix → contains, stable
     * within a rank. (The web adds a levenshtein tail; B-M3ce keeps the
     * simple list.) An empty [query] returns everything.
     */
    fun filter(commands: List<SlashCommand>, query: String): List<SlashCommand> {
        if (query.isEmpty()) return commands
        val term = query.lowercase()
        return commands
            .mapNotNull { command ->
                val name = command.name.lowercase()
                val rank = when {
                    name == term -> 0
                    name.startsWith(term) -> 1
                    name.contains(term) -> 2
                    else -> return@mapNotNull null
                }
                command to rank
            }
            .sortedBy { it.second }
            .map { it.first }
    }
}
