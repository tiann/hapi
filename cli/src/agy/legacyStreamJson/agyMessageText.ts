// Isolates the typed request from a USER_INPUT `content` field. agy wraps every
// submitted message in a <USER_REQUEST> block and appends its own sections
// (<ADDITIONAL_METADATA>, <USER_SETTINGS_CHANGE>, ...), so the raw content field
// is never equal to what we sent. Returns null when the block is absent.
// (Moved out of agySessionScanner.ts, which was removed with the PTY transport.)
export function extractUserRequest(content: string): string | null {
    const open = '<USER_REQUEST>'
    const close = '</USER_REQUEST>'
    const start = content.indexOf(open)
    if (start === -1) return null
    const contentStart = start + open.length
    const end = content.indexOf(close, contentStart)
    if (end === -1) return null
    let request = content.slice(contentStart, end)
    if (request.startsWith('\n')) request = request.slice(1)
    if (request.endsWith('\n')) request = request.slice(0, -1)
    return request
}
