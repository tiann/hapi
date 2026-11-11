package app.hapi.companion.feature.terminal

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Port-verification of the web input logic (terminal.tsx command send +
 * QuickKeys modifier state machine) — golden cases mirror the web behavior.
 */
class TerminalInputTest {

    // ---------------------------------------------- buildTerminalCommandSequence --

    @Test
    fun plainCommandGetsTrailingCarriageReturn() {
        assertEquals("ls -la\r", buildTerminalCommandSequence("ls -la"))
    }

    @Test
    fun multilineDraftTurnsEveryNewlineIntoCr() {
        assertEquals("echo a\recho b\r", buildTerminalCommandSequence("echo a\necho b"))
    }

    @Test
    fun crlfCollapsesToSingleCr() {
        assertEquals("echo a\r", buildTerminalCommandSequence("echo a\r\n"))
    }

    @Test
    fun alreadyTerminatedCommandIsNotDoubleTerminated() {
        assertEquals("cd /\r", buildTerminalCommandSequence("cd /\r"))
    }

    @Test
    fun trailingSpaceSurvivesVerbatim() {
        assertEquals("cd \r", buildTerminalCommandSequence("cd "))
    }

    @Test
    fun emptyDraftStillSubmitsOneCr() {
        assertEquals("\r", buildTerminalCommandSequence(""))
    }

    // -------------------------------------------------------- applyModifierState --

    @Test
    fun noModifiersPassSequenceThrough() {
        assertEquals("x", applyModifierState("x", ModifierState()))
    }

    @Test
    fun ctrlMapsSingleLetterToControlCode() {
        // 'c' (99) − 64 = ETX (3): asserted by code, not a literal escape.
        assertEquals(3, applyModifierState("c", ModifierState(ctrl = true))[0].code)
    }

    @Test
    fun ctrlIsCaseInsensitive() {
        val upper = applyModifierState("C", ModifierState(ctrl = true))
        val lower = applyModifierState("c", ModifierState(ctrl = true))
        assertEquals(upper, lower)
        assertEquals(3, upper[0].code)
    }

    @Test
    fun altPrefixesEscape() {
        assertEquals(27, applyModifierState("x", ModifierState(alt = true))[0].code)
        assertEquals("x", applyModifierState("x", ModifierState(alt = true)).substring(1))
    }

    @Test
    fun ctrlAltTogetherOnlyAppliesAlt() {
        // Web parity: the ctrl branch checks modified.length AFTER the alt
        // prefix, so a ctrl+alt combination sends ESC+letter, not ESC+C0.
        val modified = applyModifierState("c", ModifierState(ctrl = true, alt = true))
        assertEquals(listOf(27, 99), modified.map { it.code })
    }

    @Test
    fun ctrlDoesNotApplyToMultiCharSequences() {
        // Arrow keys under sticky Ctrl pass through unmodified (web behavior).
        val arrow = DIRECT_KEY_PAGES.getValue("navigation").first { it.label == "→" }.sequence!!
        assertEquals(arrow, applyModifierState(arrow, ModifierState(ctrl = true)))
    }

    @Test
    fun ctrlIgnoresNonLetters() {
        assertEquals("1", applyModifierState("1", ModifierState(ctrl = true)))
    }

    // ------------------------------------------------------ shouldResetModifiers --

    @Test
    fun modifiersResetAfterRealSequence() {
        assertTrue(shouldResetModifiers("x", ModifierState(ctrl = true)))
        assertTrue(shouldResetModifiers("x", ModifierState(alt = true)))
    }

    @Test
    fun noModifiersMeansNothingToReset() {
        assertFalse(shouldResetModifiers("x", ModifierState()))
    }

    @Test
    fun emptySequenceKeepsStickyModifiers() {
        assertFalse(shouldResetModifiers("", ModifierState(ctrl = true)))
    }

    // ---------------------------------------------------------------- tables --

    @Test
    fun controlPageSequencesAreTheDocumentedEscapeBytes() {
        val control = DIRECT_KEY_PAGES.getValue("control")
        // Codes asserted numerically: the wire contract is bytes, not glyphs.
        assertEquals(27, control.first { it.label == "Esc" }.sequence!![0].code)
        assertEquals(3, control.first { it.label == "Ctrl+C" }.sequence!![0].code)
        assertEquals(4, control.first { it.label == "Ctrl+D" }.sequence!![0].code)
        assertEquals(26, control.first { it.label == "Ctrl+Z" }.sequence!![0].code)
        assertEquals(12, control.first { it.label == "Ctrl+L" }.sequence!![0].code)
        assertEquals(24, control.first { it.label == "Ctrl+X" }.sequence!![0].code)
        assertEquals(19, control.first { it.label == "Ctrl+S" }.sequence!![0].code)
        assertEquals(13, control.first { it.label == "Enter" }.sequence!![0].code)
    }

    @Test
    fun navigationPageSendsCsiSequences() {
        val navigation = DIRECT_KEY_PAGES.getValue("navigation")
        // Arrow up = ESC [ A; Del = ESC [ 3 ~; ⌫ = DEL (127).
        val up = navigation.first { it.label == "↑" }.sequence!!
        assertEquals(listOf(27, 91, 65), up.map { it.code })
        val delete = navigation.first { it.label == "Del" }.sequence!!
        assertEquals(listOf(27, 91, 51, 126), delete.map { it.code })
        assertEquals(127, navigation.first { it.label == "⌫" }.sequence!![0].code)
    }

    @Test
    fun controlPageSendsShiftTabAndTab() {
        val control = DIRECT_KEY_PAGES.getValue("control")
        // ⇧Tab lives on the control page (web table): ESC [ Z.
        val shiftTab = control.first { it.label == "⇧Tab" }.sequence!!
        assertEquals(listOf(27, 91, 90), shiftTab.map { it.code })
        assertEquals(9, control.first { it.label == "Tab" }.sequence!![0].code)
    }

    @Test
    fun modifierTogglesCarryNoSequence() {
        val control = DIRECT_KEY_PAGES.getValue("control")
        val ctrl = control.first { it.modifier == MODIFIER_CTRL }
        val alt = control.first { it.modifier == MODIFIER_ALT }
        assertEquals(null, ctrl.sequence)
        assertEquals(null, alt.sequence)
    }

    @Test
    fun pageOrderMatchesWeb() {
        assertEquals(listOf("control", "navigation", "shell", "symbols"), DIRECT_KEY_PAGE_IDS)
    }

    // ------------------------------------------------- hardware key mapping --

    @Test
    fun enterMapsToCrAndCtrlEnterToLf() {
        assertEquals("\r", hardwareKeySequence(TerminalKeyEvent(TerminalKeyCodes.ENTER)))
        assertEquals("\n", hardwareKeySequence(TerminalKeyEvent(TerminalKeyCodes.ENTER, ctrl = true)))
    }

    @Test
    fun backspaceMapsToDelAndForwardDelToCsi3() {
        assertEquals(listOf(127), hardwareKeySequence(TerminalKeyEvent(TerminalKeyCodes.DEL))!!.map { it.code })
        val forwardDel = hardwareKeySequence(TerminalKeyEvent(TerminalKeyCodes.FORWARD_DEL))!!
        assertEquals(listOf(27, 91, 51, 126), forwardDel.map { it.code })
    }

    @Test
    fun tabMapsToTabAndShiftTabToEscZ() {
        assertEquals("\t", hardwareKeySequence(TerminalKeyEvent(TerminalKeyCodes.TAB)))
        val shiftTab = hardwareKeySequence(TerminalKeyEvent(TerminalKeyCodes.TAB, shift = true))!!
        assertEquals(listOf(27, 91, 90), shiftTab.map { it.code })
    }

    @Test
    fun escapeAndCtrlSpaceMapToControlBytes() {
        assertEquals(27, hardwareKeySequence(TerminalKeyEvent(TerminalKeyCodes.ESCAPE))!![0].code)
        assertEquals(0, hardwareKeySequence(TerminalKeyEvent(TerminalKeyCodes.SPACE, ctrl = true))!![0].code)
        assertEquals(" ", hardwareKeySequence(TerminalKeyEvent(TerminalKeyCodes.SPACE)))
    }

    @Test
    fun dpadKeysMapToCsiArrowsMatchingTheQuickKeys() {
        val navigation = DIRECT_KEY_PAGES.getValue("navigation")
        assertEquals(
            navigation.first { it.label == "↑" }.sequence,
            hardwareKeySequence(TerminalKeyEvent(TerminalKeyCodes.DPAD_UP)),
        )
        assertEquals(
            navigation.first { it.label == "↓" }.sequence,
            hardwareKeySequence(TerminalKeyEvent(TerminalKeyCodes.DPAD_DOWN)),
        )
        assertEquals(
            navigation.first { it.label == "←" }.sequence,
            hardwareKeySequence(TerminalKeyEvent(TerminalKeyCodes.DPAD_LEFT)),
        )
        assertEquals(
            navigation.first { it.label == "→" }.sequence,
            hardwareKeySequence(TerminalKeyEvent(TerminalKeyCodes.DPAD_RIGHT)),
        )
    }

    @Test
    fun homeEndAndPageKeysMatchTheQuickKeySequences() {
        val navigation = DIRECT_KEY_PAGES.getValue("navigation")
        assertEquals(
            navigation.first { it.label == "Home" }.sequence,
            hardwareKeySequence(TerminalKeyEvent(TerminalKeyCodes.MOVE_HOME)),
        )
        assertEquals(
            navigation.first { it.label == "End" }.sequence,
            hardwareKeySequence(TerminalKeyEvent(TerminalKeyCodes.MOVE_END)),
        )
        assertEquals(
            navigation.first { it.label == "PgUp" }.sequence,
            hardwareKeySequence(TerminalKeyEvent(TerminalKeyCodes.PAGE_UP)),
        )
        assertEquals(
            navigation.first { it.label == "PgDn" }.sequence,
            hardwareKeySequence(TerminalKeyEvent(TerminalKeyCodes.PAGE_DOWN)),
        )
    }

    @Test
    fun ctrlLetterMapsToControlCodeAndAltLetterPrefixesEscape() {
        val ctrlC = TerminalKeyEvent(TerminalKeyCodes.LETTER_FIRST + 2, ctrl = true) // KEYCODE_C
        assertEquals(3, hardwareKeySequence(ctrlC)!![0].code)
        val altX = TerminalKeyEvent(TerminalKeyCodes.LETTER_FIRST + 23, alt = true) // KEYCODE_X
        assertEquals(listOf(27, 'x'.code), hardwareKeySequence(altX)!!.map { it.code })
        val ctrlAltC = TerminalKeyEvent(TerminalKeyCodes.LETTER_FIRST + 2, ctrl = true, alt = true)
        assertEquals(listOf(27, 99), hardwareKeySequence(ctrlAltC)!!.map { it.code })
    }

    @Test
    fun plainAndUnknownKeysFallThroughToTheTextPipeline() {
        assertEquals(null, hardwareKeySequence(TerminalKeyEvent(TerminalKeyCodes.LETTER_FIRST + 2)))
        assertEquals(null, hardwareKeySequence(TerminalKeyEvent(TerminalKeyCodes.LETTER_FIRST + 2, shift = true)))
        assertEquals(null, hardwareKeySequence(TerminalKeyEvent(keyCode = 0)))
        assertEquals(null, hardwareKeySequence(TerminalKeyEvent(keyCode = -1, ctrl = true)))
    }
}
