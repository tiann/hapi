/**
 * Session citation helpers shared by web Copy-reference, MCP tool descriptions,
 * and flavor system prompts (tiann/hapi#1370).
 *
 * Two paste forms agents must recognize:
 * 1. Copy reference prose: `See session "…" (/sessions/<id>) for context`
 * 2. Markdown composer chips: `[title](/sessions/<id>)`
 *
 * `/sessions/<id>` is a HAPI hub path - not a local filesystem path.
 */

/** Appended to Copy-reference clipboard text so cold pastes steer agents. */
export const SESSION_REFERENCE_STEER_SUFFIX =
    ' HAPI hub peer - call inspect_peer with that session id; do not Grep/Glob/Read /sessions/ as a local file.'

/**
 * MCP `inspect_peer` tool description. Written for the model (firing predicate +
 * negative constraint), not for humans.
 */
export const INSPECT_PEER_TOOL_DESCRIPTION =
    'Read another HAPI session (metadata + recent message text) on the same hub/namespace. ' +
    'Fires when the user cites a peer via markdown [title](/sessions/<id>), Copy-reference prose ' +
    'See session "…" (/sessions/<id>) for context, or a bare /sessions/<id>. ' +
    'Extract <id> and pass it as sessionIdPrefix. /sessions/<id> is a hub path - do NOT Grep, Glob, or Read it as a local filesystem path. ' +
    'Read-only: does not resume. Prefer this (or `hapi inspect-peer`) over JWT+curl.'

/** MCP `ping_peer` tool description (same citation forms as inspect_peer). */
export const PING_PEER_TOOL_DESCRIPTION =
    'Send a message to another HAPI session (peer handoff / nudge). Resolves by session id prefix, resumes if inactive, then POSTs on the same hub/namespace. ' +
    'When the user cites a peer via [title](/sessions/<id>), Copy-reference prose See session "…" (/sessions/<id>) for context, or a bare /sessions/<id>, ' +
    'extract <id> and pass it as sessionIdPrefix. /sessions/<id> is a hub path - do NOT search the local filesystem for it. ' +
    'Prefer this (or `hapi ping-peer`) over reinventing JWT+curl. Targets another session - not the current chat.'

/** Zod `.describe` for sessionIdPrefix on inspect_peer / ping_peer. */
export const SESSION_ID_PREFIX_PARAM_DESCRIPTION =
    'Target HAPI session id or unique id prefix (another session - not this chat). ' +
    'Prefer the full UUID from [title](/sessions/<id>) or Copy-reference See session "…" (/sessions/<id>) for context.'

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
 * True when `match` consumed the whole citation paste (optional steer suffix only).
 * Prevents `See session "A" (/sessions/a) for context and [B](/sessions/b)` from
 * short-circuiting to `a` and skipping the multi-id fail-closed path.
 */
function hasCanonicalCopyTail(match: RegExpExecArray, input: string): boolean {
    const tail = input.slice(match[0].length)
    return tail === '' || tail === `.${SESSION_REFERENCE_STEER_SUFFIX}`
}

/**
 * If `raw` is a pasted citation blob containing exactly one `/sessions/<id>`,
 * return that id. Bare prefixes/ids (no `/sessions/`) pass through trimmed.
 * Ambiguous or empty citation blobs fail closed as `""` so callers refuse
 * rather than silently picking the first peer (inspect + ping share this path).
 *
 * Copy-reference prose prefers the parenthesized path so a session title that
 * itself contains `/sessions/<other>` cannot shadow the real target - but only
 * when the paste is a canonical Copy-reference (optional steer suffix), not a
 * multi-citation blob.
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

export type SessionCitationSteerTools = {
    /** Flavor-specific inspect tool name, e.g. `mcp__hapi__inspect_peer`. */
    inspectTool: string
    /** Flavor-specific ping tool name, e.g. `mcp__hapi__ping_peer`. */
    pingTool: string
    /** Flavor-specific discovery tool when no citation is available. */
    listPeersTool?: string
}

/**
 * Always-on system-prompt line: both citation forms + hub-not-FS + tool names.
 */
export function buildSessionCitationSteerInstruction(tools: SessionCitationSteerTools): string {
    let text =
        `When the user cites another HAPI session as [title](/sessions/<id>), ` +
        `Copy-reference prose See session "…" (/sessions/<id>) for context, ` +
        `or a bare /sessions/<id>, extract that <id>. ` +
        `/sessions/<id> is a HAPI hub path, not a local filesystem path - do not Grep, Glob, or Read it as a file. ` +
        `Call "${tools.inspectTool}" with sessionIdPrefix=<id> to read metadata and recent messages; ` +
        `call "${tools.pingTool}" with sessionIdPrefix=<id> and a message to nudge or hand off. ` +
        `Prefer these over JWT+curl. Shell fallbacks: hapi inspect-peer <id> / hapi ping-peer <id> <message>.`
    if (tools.listPeersTool) {
        text +=
            ` To discover peers without a citation, call "${tools.listPeersTool}" ` +
            `(same hub/namespace; works from runner-spawned sessions). ` +
            `Shell fallback: hapi ping-peer --list.`
    }
    return text
}
