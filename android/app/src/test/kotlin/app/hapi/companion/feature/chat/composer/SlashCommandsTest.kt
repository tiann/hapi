package app.hapi.companion.feature.chat.composer

import app.hapi.protocol.wire.SlashCommand
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SlashCommandsTest {

    // ------------------------------------------------------------ queryOf --

    @Test
    fun `queryOf triggers only on a lone slash token`() {
        assertEquals("", SlashCommands.queryOf("/"))
        assertEquals("co", SlashCommands.queryOf("/co"))
        assertEquals("foo:bar-baz_1", SlashCommands.queryOf("/foo:bar-baz_1"))
    }

    @Test
    fun `queryOf rejects plain text and post-token input`() {
        assertNull(SlashCommands.queryOf(""))
        assertNull(SlashCommands.queryOf("hello"))
        assertNull(SlashCommands.queryOf("say /co"))
        // A space or newline after the token closes the menu.
        assertNull(SlashCommands.queryOf("/co "))
        assertNull(SlashCommands.queryOf("/co bar"))
        assertNull(SlashCommands.queryOf("/co\nnext"))
    }

    // -------------------------------------------------------------- merge --

    @Test
    fun `merge dedupes case-insensitively with RPC entries winning`() {
        val merged = SlashCommands.merge(
            metadataNames = listOf("compact", "deploy", "/review"),
            fetched = listOf(
                SlashCommand(name = "Compact", description = "Compact the thread", source = "builtin"),
                SlashCommand(name = "lint", description = null, source = "project"),
            ),
        )
        // "compact" was overridden by the RPC entry (description + position);
        // the leading slash on a metadata name is normalized away.
        assertEquals(listOf("deploy", "review", "Compact", "lint"), merged.map { it.name })
        assertEquals("Compact the thread", merged.first { it.name == "Compact" }.description)
        assertEquals("session", merged.first { it.name == "deploy" }.source)
    }

    @Test
    fun `merge tolerates absent sources and blank names`() {
        assertEquals(emptyList(), SlashCommands.merge(null, null))
        assertEquals(
            listOf("a"),
            SlashCommands.merge(listOf("  ", "/", "a"), null).map { it.name },
        )
        assertEquals(
            listOf("b"),
            SlashCommands.merge(null, listOf(SlashCommand(name = "b", source = "user"))).map { it.name },
        )
    }

    // ------------------------------------------------------------- filter --

    private val commands = listOf(
        SlashCommand(name = "context", source = "builtin"),
        SlashCommand(name = "compact", source = "builtin"),
        SlashCommand(name = "co", source = "project"),
        SlashCommand(name = "recover", source = "user"),
        SlashCommand(name = "status", source = "builtin"),
    )

    @Test
    fun `empty query returns everything in order`() {
        assertEquals(commands, SlashCommands.filter(commands, ""))
    }

    @Test
    fun `filter ranks exact then prefix then contains, stable within rank`() {
        assertEquals(
            listOf("co", "context", "compact", "recover"),
            SlashCommands.filter(commands, "co").map { it.name },
        )
    }

    @Test
    fun `filter is case-insensitive and drops non-matches`() {
        assertEquals(
            listOf("compact"),
            SlashCommands.filter(commands, "COMP").map { it.name },
        )
        assertEquals(emptyList(), SlashCommands.filter(commands, "zzz"))
    }
}
