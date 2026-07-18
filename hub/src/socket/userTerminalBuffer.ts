// Per-terminal scrollback buffer for the user (remote) terminal output.
//
// A web client whose socket drops and reconnects re-subscribes with the SAME
// terminalId (held in a ref across transient reconnects), so we keep a rolling
// buffer per terminal to replay the current content immediately instead of
// showing a black screen until the next keystroke or output.
//
// The buffer is keyed by sessionId + terminalId (not sessionId alone): a session
// may have several independent terminals open at once (each a separate shell
// PTY, up to maxTerminalsPerSession), so keying by session alone would mix one
// shell's output into another and replay it into a terminal that never ran it.

const MAX_BUFFER_BYTES = 256 * 1024

const buffers = new Map<string, string>()

const keyFor = (sessionId: string, terminalId: string): string => `${sessionId}:${terminalId}`

export function appendUserTerminalOutput(sessionId: string, terminalId: string, data: string): void {
    if (!data) return
    const key = keyFor(sessionId, terminalId)
    const next = (buffers.get(key) ?? '') + data
    buffers.set(
        key,
        next.length > MAX_BUFFER_BYTES ? next.slice(next.length - MAX_BUFFER_BYTES) : next
    )
}

export function getUserTerminalBuffer(sessionId: string, terminalId: string): string {
    return buffers.get(keyFor(sessionId, terminalId)) ?? ''
}

export function clearUserTerminalBuffer(sessionId: string, terminalId: string): void {
    buffers.delete(keyFor(sessionId, terminalId))
}
