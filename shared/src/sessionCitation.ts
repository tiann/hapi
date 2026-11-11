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
    'Read-only: does not resume. Shows machine, cwd, and recent work - call it before messaging a peer you are not already working with. ' +
    'Prefer this (or `hapi inspect-peer`) over JWT+curl. ' +
    'Never invent peer titles; always use the /sessions/<uuid> from the citation.'

/**
 * Hard rule for peer tools: UUID is identity; titles are decoration.
 * Shared across spawn_peer / ping_peer / inspect_peer descriptions.
 */
export const PEER_IDENTITY_UUID_RULE =
    'Never invent peer titles. '
    + 'Copy [title](/sessions/<uuid>) from the handoff or inspect_peer / search_peers - '
    + 'UUID is identity; rename is a non-event.'

/** MCP `spawn_peer` tool description. Remit is required; empty shell is failure. */
export const SPAWN_PEER_TOOL_DESCRIPTION =
    'Spawn a new HAPI session and deliver a required first user message (the remit). ' +
    'Optional machine selects the target runner (UUID or hostname from GET /api/machines); omit to use this host. ' +
    'directory must exist on the target machine (local existence is not required for cross-host spawns). ' +
    'Creates the session, optionally names it, then uses the same delivery path as ping_peer. ' +
    'Returns the new sessionId + name. Fails if the remit does not land (a sessionId with 0 user messages is a failed spawn). ' +
    'Do not call POST /api/machines/.../spawn with a message field - the hub rejects it. Use spawn_peer to create and deliver the remit. ' +
    'Prefer this (or `hapi spawn-peer`) over JWT+curl. Same hub/namespace as this session. ' +
    'Default permissionMode is yolo via hub peerSpawnDefaults / stock - omit the field to keep that default so peers work without approval prompts. ' +
    'Pass permissionMode only to tighten (e.g. default/plan) or when the operator names a mode; do not clone the parent session\'s mode. ' +
    'When agent/model are omitted, resolves from hub peerSpawnDefaults (Settings → General → Agents), then stock (claude + sonnet). ' +
    'In-session calls auto-stamp a durable Parent [title](/sessions/<uuid>) chip for this session onto the remit (fail-closed if parent id is missing). ' +
    PEER_IDENTITY_UUID_RULE

/**
 * Who a peer message may go to. Peers carry other agents' work: an unrelated
 * ping derails that agent, and pinging an inactive peer relaunches it.
 */
export const PEER_CONTACT_RULE =
    'Message only peers tied to your current task: a session the user cited, your Parent, or peers you spawned or were handed off to. ' +
    'Never broadcast to a list of peers - not for status updates, and not to announce exclusive work (simulator, device, port, branch, release). ' +
    'For any other peer, call inspect_peer first to see its machine, cwd, and recent work, and message it only when that work actually conflicts with or depends on yours ' +
    '(e.g. same machine and resource, same checkout). ' +
    'Do not wake inactive peers for FYI, status, or done notes.'

/** Zod `.describe` for ping_peer `wake`. */
export const PEER_WAKE_PARAM_DESCRIPTION =
    'Resume the target if it is inactive. Default false: an inactive target is refused and no message is sent. ' +
    'Set true only when the user asked you to wake that peer or the work you hand off requires it to act; never for FYI, status, or done notes.'

/** Zod `.describe` for ping_peer / spawn_peer `waitForReply`. */
export const PEER_WAIT_FOR_REPLY_PARAM_DESCRIPTION =
    'Post the peer\'s reply into this session when its turn ends (default false). End your turn after calling; do not poll.'

/** Zod `.describe` for list_peers `includeInactive`. */
export const LIST_PEERS_INCLUDE_INACTIVE_PARAM_DESCRIPTION =
    'Also list inactive sessions (default false: active only). Inactive rows are history, not recipients.'

/** MCP `list_peers` tool description. */
export const LIST_PEERS_TOOL_DESCRIPTION =
    'Find a specific peer HAPI session on the same hub/namespace: id, active, busy/idle, flavor, machine, cwd, name. ' +
    'Active sessions only unless includeInactive. Uses this session\'s hub credentials - works from runner-spawned agents without being on the hub host. ' +
    'Prefer this over shelling `hapi ping-peer --list`. This is a directory, not a recipient list: ' +
    PEER_CONTACT_RULE

/** Shared delivery guidance for the peer MCP schemas, descriptions, and prompts. */
export const PEER_DELIVERY_MODE_DESCRIPTION =
    'auto (default): steer an active turn when the target supports steering and is ready; otherwise queue. Inactive peers require explicit wake=true and then receive a queued message. ' +
    'Prefer auto for routine collaboration when queueing is an acceptable fallback. ' +
    'If steering cannot be confirmed after acceptance, auto retains the same single accepted message without resending; accepted does not confirm consumption. ' +
    'queue: explicitly defer non-urgent updates that can wait instead of steering. ' +
    'steer: use for important, time-sensitive findings the peer needs to know now, not after finishing its current turn ' +
    '(e.g. a correction that invalidates its assumptions, a blocker, or a result that changes its next action). ' +
    'State why the finding matters now and what the peer should adjust. ' +
    'Steer requires insertion into an active Claude, Pi, Codex, OpenCode, Antigravity, or Cursor ACP turn; unsupported, idle, or inactive targets are rejected before sending. ' +
    'Steering does not abort the current turn or guarantee an immediate response. ' +
    'If send or steer is unconfirmed after submission, inspect the target before retrying; do not resend automatically.'

/** MCP `ping_peer` tool description (same citation forms as inspect_peer). */
export const PING_PEER_TOOL_DESCRIPTION =
    'Send a message to another HAPI session (peer handoff / nudge). Resolves by session id prefix, then POSTs on the same hub/namespace. ' +
    'Inactive targets are refused unless wake=true. ' +
    'When the user cites a peer via [title](/sessions/<id>), Copy-reference prose See session "…" (/sessions/<id>) for context, or a bare /sessions/<id>, ' +
    'extract <id> and pass it as sessionIdPrefix. /sessions/<id> is a hub path - do NOT search the local filesystem for it. ' +
    'Prefer this (or `hapi ping-peer`) over reinventing JWT+curl. Targets another session - not the current chat. ' +
    PEER_IDENTITY_UUID_RULE + ' ' +
    PEER_CONTACT_RULE + ' ' +
    `Select deliveryMode: ${PEER_DELIVERY_MODE_DESCRIPTION}`

/** Zod `.describe` for sessionIdPrefix on inspect_peer / ping_peer. */
export const SESSION_ID_PREFIX_PARAM_DESCRIPTION =
    'Target HAPI session id or unique prefix (not this chat). ' +
    'Prefer full UUID from [title](/sessions/<id>) or Copy-reference. ' +
    'UUID only - no invented titles.'

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
    /** Flavor-specific spawn-with-remit tool, e.g. `mcp__hapi__spawn_peer`. */
    spawnTool?: string
}

/**
 * System-prompt citation block used when peer tools are hidden by
 * `HAPI_DISABLE_PEER_TOOLS`. Keeps the hub-path-is-not-a-file guard (pasted
 * citations still arrive) but points the agent at the user instead of the
 * disabled peer tools.
 */
export const SESSION_CITATION_DISABLED_STEER =
    'When the user cites another HAPI session as [title](/sessions/<id>), ' +
    'Copy-reference prose See session "…" (/sessions/<id>) for context, ' +
    'or a bare /sessions/<id>, extract that <id>. ' +
    '/sessions/<id> is a HAPI hub path, not a local filesystem path - do not Grep, Glob, or Read it as a file. ' +
    'Peer session tools (inspect_peer / ping_peer / list_peers) are disabled on this machine; ' +
    'ask the user to paste the relevant context from that session instead.'

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
        `${PEER_CONTACT_RULE} ` +
        `An inactive peer is refused unless you pass wake=true; set it only when the user asked or the handed-off work requires that peer to act. ` +
        `Select deliveryMode: ${PEER_DELIVERY_MODE_DESCRIPTION} ` +
        `Prefer these over JWT+curl. Shell fallbacks: hapi inspect-peer <id> / hapi ping-peer <id> <message> --delivery-mode auto [--wake].`
    if (tools.listPeersTool) {
        text +=
            ` To find a specific peer without a citation, call "${tools.listPeersTool}" ` +
            `(active sessions on the same hub/namespace; works from runner-spawned sessions) - it is a directory, not a recipient list. ` +
            `Shell fallback: hapi ping-peer --list.`
    }
    if (tools.spawnTool) {
        text +=
            ` To spawn a new peer with work attached, call "${tools.spawnTool}" ` +
            `with directory and a required message (the remit). ` +
            `Do not POST /api/machines/.../spawn with a message/prompt/text field - ` +
            `the hub rejects it (HTTP 400). Use spawn_peer instead. ` +
            `Shell fallback: hapi spawn-peer --dir PATH --name TITLE --message-file -.`
    }
    return text
}
