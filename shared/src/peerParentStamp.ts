/**
 * Rename-proof parent identity for peer spawn/ping remits (heavygee/hapi#175).
 *
 * Display names are decoration. Hub session UUIDs (and agentSessionId across
 * hub-row churn) are identity. Orchestrated remits must stamp a durable
 * `[title](/sessions/<uuid>)` Parent chip so children never invent nicknames
 * like `upstream` when a parent is renamed mid-flight.
 */

import { extractSessionCitationIds } from './sessionCitation'

export type PeerParentIdentity = {
    sessionId: string
    name?: string | null
    agentSessionId?: string | null
}

export type EnsureParentStampOptions = {
    /**
     * When true (MCP / in-session spawn), missing parent id fails closed.
     * Outside-session CLI may omit this and allow unattributed remits with a
     * warning at the call site.
     */
    requireParent?: boolean
}

export type EnsureParentStampResult = {
    message: string
    stamped: boolean
    alreadyPresent: boolean
}

export class ParentStampError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ParentStampError'
    }
}

/** Escape markdown link label so brackets in titles do not break the chip. */
function escapeChipTitle(title: string): string {
    return title.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
}

/**
 * Build a composer-compatible session chip. Title is decorative; UUID is identity.
 */
export function formatSessionChip(identity: PeerParentIdentity): string {
    const sessionId = identity.sessionId.trim()
    const rawTitle = (identity.name ?? '').trim() || sessionId.slice(0, 8)
    return `[${escapeChipTitle(rawTitle)}](/sessions/${sessionId})`
}

/**
 * Canonical Parent block prepended to orchestrated spawn remits.
 */
export function formatParentStampBlock(identity: PeerParentIdentity): string {
    const sessionId = identity.sessionId.trim()
    const lines = [
        '## Parent',
        `- Orchestrator chip (mandatory): ${formatSessionChip({ ...identity, sessionId })}`,
        '  Title is decoration and may change mid-flight - address parent by UUID only; never invent nicknames.',
    ]
    const agentSessionId = (identity.agentSessionId ?? '').trim()
    if (agentSessionId) {
        lines.push(`- agentSessionId: \`${agentSessionId}\``)
    }
    return lines.join('\n')
}

export function remitCitesSessionId(message: string, sessionId: string): boolean {
    const id = sessionId.trim()
    if (!id) return false
    return extractSessionCitationIds(message).includes(id)
}

/** Slice the `## Parent` section body (through the next `##` heading), or null. */
function extractParentSection(message: string): string | null {
    if (!message) return null
    const parentHeader = /^##\s*Parent\b/im.exec(message)
    if (!parentHeader || parentHeader.index === undefined) return null
    const fromParent = message.slice(parentHeader.index)
    const afterHeader = fromParent.slice(parentHeader[0].length)
    const nextHeading = /\n##\s/.exec(afterHeader)
    return nextHeading
        ? fromParent.slice(0, parentHeader[0].length + (nextHeading.index ?? 0))
        : fromParent
}

/**
 * True when the Parent section contains a markdown chip
 * `[title](/sessions/<sessionId>)` (not a bare path).
 */
export function parentSectionHasSessionChip(
    message: string,
    sessionId: string
): boolean {
    const id = sessionId.trim()
    if (!id) return false
    const section = extractParentSection(message)
    if (!section) return false
    // Chip form only - bare /sessions/<id> does not render as the Parent sender chip.
    // Labels may contain escaped brackets (`\]` / `\[`) from escapeChipTitle.
    // Exclude `\` from the single-char class so `\\.` is the only escape parse
    // (avoids exponential backtracking on long nonmatching backslash runs).
    const chipRe =
        /\[(?:\\.|[^\\\]])*\]\((?:[^)\s]*\/)?sessions\/([^/?#)\s]+)\)/g
    for (const match of section.matchAll(chipRe)) {
        const raw = match[1]
        if (!raw) continue
        try {
            if (decodeURIComponent(raw) === id) return true
        } catch {
            if (raw === id) return true
        }
    }
    return false
}

/**
 * Prefer the first `/sessions/<id>` under a `## Parent` heading when present;
 * otherwise the first citation in the remit (handoff UUID).
 */
export function extractParentSessionIdFromRemit(message: string): string | null {
    if (!message) return null
    const section = extractParentSection(message)
    if (section) {
        const ids = extractSessionCitationIds(section)
        if (ids[0]) return ids[0]!
    }
    return extractSessionCitationIds(message)[0] ?? null
}

/**
 * Ensure an orchestrated remit cites the parent under a `## Parent` chip block.
 * Idempotent when a `## Parent` section already has a markdown chip for this
 * UUID. Bare citations (or an empty Parent heading) do not suppress the stamp.
 */
export function ensureParentStamp(
    message: string,
    identity: PeerParentIdentity | null | undefined,
    options: EnsureParentStampOptions = {}
): EnsureParentStampResult {
    const requireParent = options.requireParent === true
    const sessionId = (identity?.sessionId ?? '').trim()

    if (!sessionId) {
        if (requireParent) {
            throw new ParentStampError(
                'in-session spawn requires a parent session id '
                + '(HAPI_SESSION_ID / MCP client session). '
                + 'Refusing unattributed remit for an orchestrated child.'
            )
        }
        return { message, stamped: false, alreadyPresent: false }
    }

    if (parentSectionHasSessionChip(message, sessionId)) {
        return { message, stamped: false, alreadyPresent: true }
    }

    const block = formatParentStampBlock({
        sessionId,
        name: identity?.name,
        agentSessionId: identity?.agentSessionId,
    })
    const stampedMessage = message.trim().length > 0
        ? `${block}\n\n${message}`
        : block

    return { message: stampedMessage, stamped: true, alreadyPresent: false }
}
