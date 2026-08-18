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

// True when two renderings of the SAME agy answer differ only by replacement
// characters.
//
// agy's `text_delta` stream decodes the model output chunk by chunk without
// carrying a partial UTF-8 sequence across the boundary, so a multi-byte
// character split by a chunk boundary arrives as a run of U+FFFD: a 3-byte CJK
// character becomes three replacement chars (one orphan byte left of the split,
// two right of it). The `result` envelope carries the same answer decoded from
// the complete buffer, so it is clean.
//
// Comparing the two with `===` therefore reports "different" for any non-ASCII
// answer that hit a split, and the driver delivers the answer twice (once
// corrupted, once clean). Treat each run of replacement characters as a short
// unknown span so the envelope is still recognised as the same text.
export function isSameAgyResponse(streamed: string, authoritative: string): boolean {
    if (streamed === authoritative) return true
    if (!streamed.includes('�')) return false
    const segments = streamed.split(/�+/)
    // A stream this mangled is not recognisable anyway, and the regex below
    // would get expensive: bail out instead.
    if (segments.length - 1 > MAX_REPLACEMENT_RUNS) return false
    const pattern = segments.map(escapeRegExp).join(`[\\s\\S]{1,${MAX_CHARS_PER_RUN}}`)
    return new RegExp(`^${pattern}$`).test(authoritative)
}

// A replacement run stands for at least one real character; a handful of
// adjacent corrupted characters is the realistic worst case.
const MAX_CHARS_PER_RUN = 8
const MAX_REPLACEMENT_RUNS = 64

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
