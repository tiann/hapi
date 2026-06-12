// Per-session scrollback buffer for the user (remote) terminal output.
//
// A web client that navigates away and back creates a new xterm.js instance
// with a new terminalId, so the previous output is lost. We keep a rolling
// buffer per session so a fresh subscriber can replay the current terminal
// content immediately instead of showing a black screen until the next
// keystroke or output.
//
// The buffer is keyed by sessionId only (not terminalId) because each
// navigation creates a new terminalId for the same session.

const MAX_BUFFER_BYTES = 256 * 1024

const buffers = new Map<string, string>()

export function appendUserTerminalOutput(sessionId: string, _terminalId: string, data: string): void {
    if (!data) return
    const next = (buffers.get(sessionId) ?? '') + data
    buffers.set(
        sessionId,
        next.length > MAX_BUFFER_BYTES ? next.slice(next.length - MAX_BUFFER_BYTES) : next
    )
}

export function getUserTerminalBuffer(sessionId: string): string {
    return buffers.get(sessionId) ?? ''
}

export function clearUserTerminalBuffer(sessionId: string): void {
    buffers.delete(sessionId)
}
