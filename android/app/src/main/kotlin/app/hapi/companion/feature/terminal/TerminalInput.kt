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

/** Sticky modifier ids used by [QuickInput.modifier]. */
const val MODIFIER_CTRL = "ctrl"
const val MODIFIER_ALT = "alt"

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
