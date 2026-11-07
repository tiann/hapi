package app.hapi.companion.feature.chat

import app.hapi.companion.feature.settings.SessionHeaderMetadata
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * [gatedHeaderSubtitle]: the chat-header subtitle segments behind the P2
 * Display "session metadata" switches (web `SessionHeader` parity — its
 * session-list rows consume nothing).
 */
class ChatHeaderSubtitleTest {
    private val flavor = "Claude"
    private val machine = "Beef box"
    private val worktree = "231"

    @Test
    fun `defaults keep all three segments`() {
        assertEquals(
            "Claude · Beef box · 231",
            gatedHeaderSubtitle(flavor, machine, worktree, SessionHeaderMetadata()),
        )
    }

    @Test
    fun `agent off drops the flavor segment`() {
        assertEquals(
            "Beef box · 231",
            gatedHeaderSubtitle(flavor, machine, worktree, SessionHeaderMetadata(agent = false)),
        )
    }

    @Test
    fun `machine off drops the machine segment`() {
        assertEquals(
            "Claude · 231",
            gatedHeaderSubtitle(flavor, machine, worktree, SessionHeaderMetadata(machine = false)),
        )
    }

    @Test
    fun `worktree off drops the worktree segment`() {
        assertEquals(
            "Claude · Beef box",
            gatedHeaderSubtitle(flavor, machine, worktree, SessionHeaderMetadata(worktree = false)),
        )
    }

    @Test
    fun `all three off leaves no subtitle`() {
        assertNull(
            gatedHeaderSubtitle(
                flavor,
                machine,
                worktree,
                SessionHeaderMetadata(agent = false, machine = false, worktree = false),
            ),
        )
    }

    @Test
    fun `absent segments stay absent regardless of the switches`() {
        // Machine unknown even with the switch on; worktree known but gated off.
        assertEquals(
            "Claude",
            gatedHeaderSubtitle(flavor, null, worktree, SessionHeaderMetadata(worktree = false)),
        )
        // Only a gated-off segment existed — nothing renders.
        assertNull(gatedHeaderSubtitle(null, null, worktree, SessionHeaderMetadata(worktree = false)))
    }
}
