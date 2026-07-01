// Bracketed-paste (DECSET 2004) framing for PTY input.
//
// Interactive TUIs that enable bracketed-paste mode (claude does — its init
// emits ESC[?2004h) treat the bytes between these markers as a single literal
// paste, so embedded newlines are inserted as text instead of being acted on
// as Enter. A multiline message written raw would otherwise submit its first
// line on its own and run the rest as separate prompts/slash-commands. Wrap
// such a message before writing it; a trailing CR (sent separately by the
// caller) is what actually submits the whole block.
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

export function bracketPasteIfMultiline(text: string): string {
    return text.includes('\n') ? `${PASTE_START}${text}${PASTE_END}` : text
}
