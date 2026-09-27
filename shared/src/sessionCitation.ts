/**
 * Session citation helpers shared by web Copy-reference and MCP tool descriptions
 * (tiann/hapi#1370).
 *
 * Two paste forms agents must recognize:
 * 1. Copy reference prose: `See session "…" (/sessions/<id>) for context`
 * 2. Markdown composer chips: `[title](/sessions/<id>)`
 *
 * `/sessions/<id>` is a HAPI hub path - not a local filesystem path.
 */

/**
 * MCP `inspect_peer` tool description. Written for the model (firing predicate +
 * negative constraint), not for humans.
 */
export const INSPECT_PEER_TOOL_DESCRIPTION =
    'Read metadata and recent message text for one exact HAPI session UUID. Read-only.'

/** MCP `spawn_peer` tool description. Remit is required; empty shell is failure. */
export const SPAWN_PEER_TOOL_DESCRIPTION =
    'Create a fresh HAPI session and atomically deliver its required first message.'

/** MCP `ping_peer` tool description (same citation forms as inspect_peer). */
export const PING_PEER_TOOL_DESCRIPTION =
    'Send a message to one exact HAPI session UUID, resuming it if inactive.'

/** Zod `.describe` for sessionId on inspect_peer / ping_peer. */
export const SESSION_ID_PARAM_DESCRIPTION =
    'Exact target HAPI session UUID.'

/**
 * Hub session ids have no dots. Reject dotted tails so source paths like
 * `web/src/routes/sessions/chat.tsx` are not treated as citations.
 */
function isPlausibleSessionId(id: string): boolean {
    return id.length > 0 && !id.includes('.')
}

/**
 * Match `/sessions/<id>` (optional BASE_URL prefix segments) inside free text.
 * Captures the id only; surrounding markdown / prose is ignored.
 */
const SESSION_PATH_IN_TEXT_RE =
    /(?:^|[^A-Za-z0-9_-])(?:\.?\/)?(?:[\w.-]+\/)*sessions\/([^/?#\s)\]"']+)/g

/** Decode a path segment; return null if not a plausible hub session id. */
function decodeSessionIdSegment(raw: string): string | null {
    try {
        // Bare citations in prose often trail `,` / `.` / `!` - strip those only.
        // Internal dots (e.g. `chat.tsx`) stay and fail isPlausibleSessionId.
        const id = decodeURIComponent(raw).replace(/[.,;:!?]+$/u, '')
        return isPlausibleSessionId(id) ? id : null
    } catch {
        return null
    }
}

/**
 * Extract unique session ids from free text containing markdown and/or
 * Copy-reference prose citations. Order is first-seen.
 */
export function extractSessionCitationIds(text: string): string[] {
    if (!text) return []
    const seen = new Set<string>()
    const ids: string[] = []
    SESSION_PATH_IN_TEXT_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = SESSION_PATH_IN_TEXT_RE.exec(text)) !== null) {
        const id = decodeSessionIdSegment(match[1] ?? '')
        if (!id || seen.has(id)) continue
        seen.add(id)
        ids.push(id)
    }
    return ids
}

/**
 * True when `match` consumed the whole citation paste.
 * Prevents `See session "A" (/sessions/a) for context and [B](/sessions/b)` from
 * short-circuiting to `a` and skipping the multi-id fail-closed path.
 */
function hasCanonicalCopyTail(match: RegExpExecArray, input: string): boolean {
    const tail = input.slice(match[0].length)
    return tail === '' || tail === '.'
}

/**
 * If `raw` is a pasted citation blob containing exactly one `/sessions/<id>`,
 * return that id. Bare prefixes/ids (no `/sessions/`) pass through trimmed.
 * Ambiguous or empty citation blobs fail closed as `""` so callers refuse
 * rather than silently picking the first peer (inspect + ping share this path).
 *
 * Copy-reference prose prefers the parenthesized path so a session title that
 * itself contains `/sessions/<other>` cannot shadow the real target - but only
 * when the paste is a canonical Copy-reference, not a multi-citation blob.
 */
export function normalizeSessionIdPrefix(raw: string): string {
    const trimmed = raw.trim()

    const titledCopy = /^See session "(?:\\.|[^"\\])*" \(([^)]+)\) for context/.exec(trimmed)
    if (titledCopy?.[1] && hasCanonicalCopyTail(titledCopy, trimmed)) {
        const ids = extractSessionCitationIds(titledCopy[1])
        return ids.length === 1 ? ids[0]! : ''
    }
    const untitledCopy = /^See HAPI session (\S+) for context/.exec(trimmed)
    if (untitledCopy?.[1] && hasCanonicalCopyTail(untitledCopy, trimmed)) {
        const ids = extractSessionCitationIds(untitledCopy[1])
        return ids.length === 1 ? ids[0]! : ''
    }

    if (!trimmed.includes('/sessions/')) {
        return trimmed
    }
    const ids = extractSessionCitationIds(trimmed)
    return ids.length === 1 ? ids[0]! : ''
}
