package app.hapi.companion.feature.terminal

/**
 * Terminal input helpers ported from the web client so the Android quick-key
 * rows behave identically:
 *
 * - [buildTerminalCommandSequence] — `web/src/routes/sessions/terminal.tsx`
 * - [applyModifierState]/[shouldResetModifiers]/[ModifierState] —
 *   `web/src/components/QuickKeys/QuickKeys.tsx` (sticky Ctrl/Alt)
 * - [BASIC_COMMANDS], [DIRECT_KEY_PAGES], [COMMAND_MODE_KEYS] — the compact
 *   (touch) input tables from the same terminal route.
 *
 * Pure Kotlin, no Android imports — unit-tested in TerminalInputTest.
 */

/**
 * Normalizes a command draft into the byte sequence a PTY expects: newlines
 * become CR, and exactly one trailing CR submits the line. `cd ` (with its
 * trailing space) survives verbatim.
 */
fun buildTerminalCommandSequence(command: String): String {
    val normalized = command.replace(Regex("\r\n|\n"), "\r")
    return if (normalized.endsWith("\r")) normalized else "$normalized\r"
}

/** Sticky quick-key modifiers (web `ModifierState`). */
data class ModifierState(
    val ctrl: Boolean = false,
    val alt: Boolean = false,
)

/**
 * Applies the sticky Ctrl/Alt modifiers to a raw sequence: Alt prefixes ESC,
 * Ctrl maps a single printable letter to its C0 control code. Multi-char
 * sequences (arrows, paste) only receive the Alt prefix — Ctrl is meaningless
 * there (web `applyModifierState`).
 */
fun applyModifierState(sequence: String, state: ModifierState): String {
    var modified = sequence
    if (state.alt) {
        modified = "\u001b$modified"
    }
    if (state.ctrl && modified.length == 1) {
        val code = modified.uppercase().codePointAt(0)
        if (code in 64..95) {
            modified = String(Character.toChars(code - 64))
        }
    }
    return modified
}

/** A sticky modifier is consumed once a real (non-empty) sequence is sent. */
fun shouldResetModifiers(sequence: String, state: ModifierState): Boolean {
    if (sequence.isEmpty()) return false
    return state.ctrl || state.alt
}

/** One quick-input key: raw sequence, sticky modifier toggle, or both. */
data class QuickInput(
    val label: String,
    /** Bytes sent on tap; null for modifier toggles. */
    val sequence: String? = null,
    /** Content description / accessibility label. */
    val description: String,
    /** Present ⇒ the key toggles a sticky modifier instead of sending. */
    val modifier: String? = null,
)

/**
 * Key codes the Direct input target maps to terminal bytes. Values are
 * android.view.KeyEvent's, restated here so the mapping stays pure Kotlin and
 * JVM-testable without the framework (the screen layer passes
 * `nativeKeyEvent.keyCode` through).
 */
object TerminalKeyCodes {
    const val DPAD_UP = 19
    const val DPAD_DOWN = 20
    const val DPAD_LEFT = 21
    const val DPAD_RIGHT = 22
    const val TAB = 61
    const val SPACE = 62
    const val ENTER = 66
    /** Backspace. */
    const val DEL = 67
    const val PAGE_UP = 92
    const val PAGE_DOWN = 93
    const val ESCAPE = 111
    const val FORWARD_DEL = 112
    const val MOVE_HOME = 122
    const val MOVE_END = 123
    const val LETTER_FIRST = 29 // KEYCODE_A
    const val LETTER_LAST = 54 // KEYCODE_Z
}

/** One hardware/IME key press at the Direct input target. */
data class TerminalKeyEvent(
    val keyCode: Int,
    val ctrl: Boolean = false,
    val alt: Boolean = false,
    val shift: Boolean = false,
)

/**
 * Terminal bytes for one hardware key, or null when the key is not ours to
 * intercept (plain printable letters reach the PTY through the field's text
 * pipeline; unknown keys fall through to normal input). Intercepted keys
 * reuse the sticky-modifier rules: Alt prefixes ESC, Ctrl maps a letter to
 * its C0 code.
 */
fun hardwareKeySequence(event: TerminalKeyEvent): String? {
    val base: String = when (event.keyCode) {
        TerminalKeyCodes.DPAD_UP -> "\u001b[A"
        TerminalKeyCodes.DPAD_DOWN -> "\u001b[B"
        TerminalKeyCodes.DPAD_LEFT -> "\u001b[D"
        TerminalKeyCodes.DPAD_RIGHT -> "\u001b[C"
        TerminalKeyCodes.ENTER -> if (event.ctrl) "\n" else "\r"
        TerminalKeyCodes.DEL -> "\u007f"
        TerminalKeyCodes.FORWARD_DEL -> "\u001b[3~"
        TerminalKeyCodes.TAB -> if (event.shift) "\u001b[Z" else "\t"
        TerminalKeyCodes.ESCAPE -> "\u001b"
        TerminalKeyCodes.SPACE -> if (event.ctrl) "\u0000" else " "
        TerminalKeyCodes.PAGE_UP -> "\u001b[5~"
        TerminalKeyCodes.PAGE_DOWN -> "\u001b[6~"
        TerminalKeyCodes.MOVE_HOME -> "\u001b[H"
        TerminalKeyCodes.MOVE_END -> "\u001b[F"
        in TerminalKeyCodes.LETTER_FIRST..TerminalKeyCodes.LETTER_LAST ->
            // Modifierless letters flow through the text pipeline; only
            // Ctrl/Alt combos need interception (IMEs never deliver those
            // as text).
            if (!event.ctrl && !event.alt) return null
            else ('a' + (event.keyCode - TerminalKeyCodes.LETTER_FIRST)).toString()
        else -> return null
    }
    return applyModifierState(base, ModifierState(ctrl = event.ctrl, alt = event.alt))
}

/** Sticky modifier ids used by [QuickInput.modifier]. */
const val MODIFIER_CTRL = "ctrl"
const val MODIFIER_ALT = "alt"

/**
 * Bytes a typing field should send when its text changes from [previous] to
 * [fresh]: the field never holds text (it resets after every send — the
 * terminal echoes), so this is the IME-inserted delta with newlines normalized
 * to CR, or null when the change carries nothing (an IME backspace on the
 * always-empty field, or a no-op recomposition).
 */
fun directTypeInserted(previous: String, fresh: String): String? {
    if (fresh == previous) return null
    // Append-only in practice (the field resets after every send); an IME
    // replace sends whatever the field now holds.
    val inserted = if (fresh.startsWith(previous)) fresh.removePrefix(previous) else fresh
    if (inserted.isEmpty()) return null
    return inserted.replace("\n", "\r")
}

/**
 * Command-mode command templates (web `BASIC_COMMANDS`); tapping fills the
 * command box — it does not send.
 */
val BASIC_COMMANDS: List<QuickInput> = listOf(
    QuickInput("ls", "ls", "List files"),
    QuickInput("ls -la", "ls -la", "List all files"),
    QuickInput("pwd", "pwd", "Print working directory"),
    QuickInput("cd", "cd ", "Change directory"),
    QuickInput("git status", "git status", "Git status"),
    QuickInput("git diff", "git diff", "Git diff"),
    QuickInput("clear", "clear", "Clear screen"),
    QuickInput("top", "top", "Running processes"),
)

/**
 * Command-mode quick keys (web `COMPACT_COMMAND_INPUTS`), plus an Android-only
 * explicit-newline key: phone IMEs have no shift-Enter, so a second line in the
 * command box needs its own affordance ([buildTerminalCommandSequence] turns
 * the embedded `\n` into a CR when the command finally sends).
 */
val COMMAND_MODE_KEYS: List<QuickInput> = listOf(
    QuickInput("Ctrl+C", "\u0003", "Interrupt process"),
    QuickInput("Esc", "\u001b", "Escape"),
    QuickInput("⏎", "\n", "Newline in command"),
)

/** Direct-mode key pages (web `COMPACT_DIRECT_INPUTS`, page order included). */
val DIRECT_KEY_PAGES: Map<String, List<QuickInput>> = linkedMapOf(
    "control" to listOf(
        QuickInput("Esc", "\u001b", "Escape"),
        QuickInput("Tab", "\t", "Tab"),
        QuickInput("⇧Tab", "\u001b[Z", "Shift Tab"),
        QuickInput("Ctrl", description = "Control", modifier = MODIFIER_CTRL),
        QuickInput("Alt", description = "Alternate", modifier = MODIFIER_ALT),
        QuickInput("Space", " ", "Space"),
        QuickInput("Enter", "\r", "Enter"),
        QuickInput("Ctrl+C", "\u0003", "Interrupt process"),
        QuickInput("Ctrl+D", "\u0004", "End of input"),
        QuickInput("Ctrl+Z", "\u001a", "Suspend process"),
        QuickInput("Ctrl+L", "\u000c", "Clear screen"),
        // Dedicated: sticky Ctrl + softkey is flaky on touch IMEs
        // (web comment: Jed save = C-x C-s).
        QuickInput("Ctrl+X", "\u0018", "Cancel / prefix (C-x)"),
        QuickInput("Ctrl+S", "\u0013", "XOFF / search / save (C-s)"),
    ),
    "navigation" to listOf(
        QuickInput("←", "\u001b[D", "Arrow left"),
        QuickInput("↑", "\u001b[A", "Arrow up"),
        QuickInput("↓", "\u001b[B", "Arrow down"),
        QuickInput("→", "\u001b[C", "Arrow right"),
        QuickInput("Home", "\u001b[H", "Home"),
        QuickInput("End", "\u001b[F", "End"),
        QuickInput("PgUp", "\u001b[5~", "Page up"),
        QuickInput("PgDn", "\u001b[6~", "Page down"),
        QuickInput("⌫", "\u007f", "Backspace"),
        QuickInput("Del", "\u001b[3~", "Delete"),
        QuickInput("Ctrl+A", "\u0001", "Line start"),
        QuickInput("Ctrl+E", "\u0005", "Line end"),
    ),
    "shell" to listOf(
        QuickInput("/", "/", "Forward slash"),
        QuickInput("-", "-", "Hyphen"),
        QuickInput("|", "|", "Pipe"),
        QuickInput("~", "~", "Tilde"),
        QuickInput("$", "$", "Dollar sign"),
        QuickInput(".", ".", "Period"),
        QuickInput("..", "..", "Parent directory"),
        QuickInput("\\", "\\", "Backslash"),
        QuickInput("&", "&", "Ampersand"),
        QuickInput(";", ";", "Semicolon"),
        QuickInput(">", ">", "Redirect output"),
        QuickInput(">>", ">>", "Append output"),
    ),
    "symbols" to listOf(
        QuickInput("_", "_", "Underscore"),
        QuickInput("\"", "\"", "Double quote"),
        QuickInput("'", "'", "Single quote"),
        QuickInput("`", "`", "Backtick"),
        QuickInput("(", "(", "Left parenthesis"),
        QuickInput(")", ")", "Right parenthesis"),
        QuickInput("[", "[", "Left bracket"),
        QuickInput("]", "]", "Right bracket"),
        QuickInput("{", "{", "Left brace"),
        QuickInput("}", "}", "Right brace"),
        QuickInput("=", "=", "Equals"),
        QuickInput(":", ":", "Colon"),
    ),
)

/** Page ids in display order (web `DIRECT_KEY_PAGE_IDS`). */
val DIRECT_KEY_PAGE_IDS: List<String> = DIRECT_KEY_PAGES.keys.toList()
