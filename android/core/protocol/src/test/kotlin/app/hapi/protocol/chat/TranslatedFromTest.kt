package app.hapi.protocol.chat

import app.hapi.protocol.wire.DecryptedMessage
import app.hapi.protocol.wire.HapiJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.serialization.json.JsonElement

/**
 * Hub input translation: the stored user message carries the English sent to
 * the agent in `content.text` and what the user typed in `meta.translatedFrom`
 * (web `toThreadMessageLike` reads it only when it is a string).
 */
class TranslatedFromTest {

    private fun userBlock(meta: String?): UserTextBlock {
        val metaJson = meta?.let { ""","meta":$it""" } ?: ""
        val content: JsonElement = HapiJson.parseToJsonElement(
            """{"role":"user","content":{"type":"text","text":"Fix the login bug"}$metaJson}""",
        )
        val normalized = normalizeDecryptedMessage(DecryptedMessage(id = "m1", content = content, createdAt = 1))
        val blocks = reduceChatBlocks(listOfNotNull(normalized), agentState = null, now = { 0 }).blocks
        return blocks.filterIsInstance<UserTextBlock>().single()
    }

    @Test
    fun `translated prompt exposes the original alongside the sent English`() {
        val block = userBlock("""{"sentFrom":"webapp","translatedFrom":"修复登录问题"}""")
        assertEquals("Fix the login bug", block.text)
        assertEquals("修复登录问题", block.translatedFrom)
    }

    @Test
    fun `untranslated or malformed meta yields no original`() {
        assertNull(userBlock(null).translatedFrom)
        assertNull(userBlock("""{"sentFrom":"webapp"}""").translatedFrom)
        assertNull(userBlock("""{"translatedFrom":42}""").translatedFrom)
        assertNull(userBlock("""{"translatedFrom":null}""").translatedFrom)
    }
}
