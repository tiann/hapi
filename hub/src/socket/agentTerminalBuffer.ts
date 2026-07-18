// Per-session scrollback buffer for the agent (PTY) terminal output.
//
// Claude's interactive TUI only emits output when something changes. A web
// client that subscribes while the TUI is idle therefore receives nothing and
// shows a black screen until the next keystroke forces a redraw. We keep a
// rolling buffer of recent raw output so a fresh subscriber can be replayed the
// current screen immediately.
//
// The buffer is a byte-bounded ring: the oldest bytes are dropped first. The
// most recent full-screen redraw sequence from the TUI is always preserved at
// the tail, so replaying the buffer reconstructs the current screen (older,
// possibly-truncated escape sequences at the head are overwritten by later
// redraws).

const MAX_BUFFER_BYTES = 256 * 1024

const buffers = new Map<string, string>()

export function appendAgentTerminalOutput(sessionId: string, data: string): void {
    if (!data) return
    const next = (buffers.get(sessionId) ?? '') + data
    buffers.set(
        sessionId,
        next.length > MAX_BUFFER_BYTES ? next.slice(next.length - MAX_BUFFER_BYTES) : next
    )
}

// Replay variant: when a full-screen TUI exits (e.g. an archived alt-screen
// session) it emits an alt-screen-exit (`CSI ? 1049 l`) that restores the empty
// normal screen — so a raw replay would render black. If the buffer's LAST
// alt-screen toggle is an exit (the process ended without re-entering), drop it
// and everything after, leaving the final alt-screen frame visible. Live sessions
// stay in the alt screen (no trailing exit), so this is a no-op for them.
const TRAILING_ALT_EXIT = /\x1b\[\?1049l(?:(?!\x1b\[\?1049h)[\s\S])*$/
export function getAgentTerminalReplay(sessionId: string): string {
    const raw = buffers.get(sessionId) ?? ''
    return raw.replace(TRAILING_ALT_EXIT, '')
}

export function clearAgentTerminalBuffer(sessionId: string): void {
    buffers.delete(sessionId)
}
