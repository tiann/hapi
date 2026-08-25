package app.hapi.protocol.chat

import kotlinx.serialization.json.JsonElement

/** Port of `web/src/chat/reducerCliOutput.ts`. */

private val CLI_TAG_REGEX = Regex("<(?:local-command-[a-z-]+|command-(?:name|message|args))>", RegexOption.IGNORE_CASE)
private val CLI_COMMAND_NAME_REGEX = Regex("<command-name>", RegexOption.IGNORE_CASE)
private val CLI_COMMAND_STDOUT_REGEX = Regex("<local-command-stdout>", RegexOption.IGNORE_CASE)

private fun getMetaSentFrom(meta: JsonElement?): String? =
    asObject(meta)?.let { asString(it["sentFrom"]) }

private fun hasCliOutputTags(text: String): Boolean = CLI_TAG_REGEX.containsMatchIn(text)

private fun hasCommandNameTag(text: String): Boolean = CLI_COMMAND_NAME_REGEX.containsMatchIn(text)

private fun hasLocalCommandStdoutTag(text: String): Boolean = CLI_COMMAND_STDOUT_REGEX.containsMatchIn(text)

fun isCliOutputText(text: String, meta: JsonElement?): Boolean =
    getMetaSentFrom(meta) == "cli" && hasCliOutputTags(text)

fun createCliOutputBlock(
    id: String,
    localId: String?,
    createdAt: Long,
    invokedAt: Long?,
    usage: UsageData? = null,
    model: String? = null,
    text: String,
    source: String,
    meta: JsonElement?,
): CliOutputBlock = CliOutputBlock(
    id = id,
    localId = localId,
    createdAt = createdAt,
    invokedAt = invokedAt,
    usage = usage,
    model = model,
    text = text,
    source = source,
    meta = meta,
)

fun mergeCliOutputBlocks(blocks: List<ChatBlock>): MutableList<ChatBlock> {
    val merged = mutableListOf<ChatBlock>()

    for (block in blocks) {
        if (block !is CliOutputBlock) {
            merged.add(block)
            continue
        }

        val prev = merged.lastOrNull()
        if (
            prev is CliOutputBlock
            && prev.source == block.source
            && hasCommandNameTag(prev.text)
            && !hasLocalCommandStdoutTag(prev.text)
            && hasLocalCommandStdoutTag(block.text)
        ) {
            val separator = if (prev.text.endsWith("\n") || block.text.startsWith("\n")) "" else "\n"
            // The command-name block carries the assistant metadata; always
            // prefer prev's values, falling back to block's only when missing.
            merged[merged.size - 1] = CliOutputBlock(
                id = prev.id,
                localId = prev.localId,
                createdAt = prev.createdAt,
                invokedAt = prev.invokedAt ?: block.invokedAt,
                durationMs = prev.durationMs ?: block.durationMs,
                usage = prev.usage ?: block.usage,
                model = prev.model ?: block.model,
                text = "${prev.text}$separator${block.text}",
                source = prev.source,
                meta = prev.meta,
            )
            continue
        }

        merged.add(block)
    }

    return merged
}
