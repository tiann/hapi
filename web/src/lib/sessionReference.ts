import type { SessionSummary } from '@/types/api'
import { normalizeSearch, prepareSidebarSessions, sessionMatchesQuery } from '@/components/SessionList'
import { truncateGraphemes } from '@/lib/graphemes'
import { getSessionTitle, hasSessionTitleSignal } from '@/lib/sessionTitle'
import { SESSION_REFERENCE_STEER_SUFFIX } from '@hapi/protocol/sessionCitation'

export function buildSessionReferencePath(sessionId: string): string {
    const base = import.meta.env.BASE_URL ?? '/'
    const normalizedBase = base.endsWith('/') ? base : `${base}/`
    return `${normalizedBase}sessions/${encodeURIComponent(sessionId)}`.replace(/\/{2,}/g, '/')
}

function sanitizeSessionReferenceTitle(sessionTitle: string): string {
    return truncateGraphemes(sessionTitle.replace(/\s+/g, ' ').trim(), 120)
}

/** Clipboard text for citing this session in another HAPI chat (not a public share link). */
export function buildSessionReferenceText(sessionTitle: string, sessionId: string): string {
    const path = buildSessionReferencePath(sessionId)
    const title = sanitizeSessionReferenceTitle(sessionTitle)
    const base = title
        ? `See session ${JSON.stringify(title)} (${path}) for context`
        : `See HAPI session ${path} for context`
    return `${base}.${SESSION_REFERENCE_STEER_SUFFIX}`
}

export type MatchSessionsForMentionOptions = {
    excludeId?: string
    limit?: number
    /** Same resolver share/sidebar pass into `sessionMatchesQuery`. */
    resolveMachineLabel?: (machineId: string | null) => string
}

/**
 * Rank score for a session that already passed `sessionMatchesQuery`.
 * Prefer official-title / id hits over summary-or-path-only matches; then active + recency.
 */
function scoreMatchedSession(session: SessionSummary, query: string): number {
    const title = getSessionTitle(session).toLowerCase()
    const id = session.id.toLowerCase()
    const idPrefix = id.slice(0, 8)

    // Matched via summary/path/machine/etc. — keep below id/title tiers.
    let score = 150
    if (title === query) score = 500
    else if (title.startsWith(query)) score = 400
    else if (title.includes(query)) score = 300
    else if (idPrefix.startsWith(query) || id.startsWith(query)) score = 200
    else if (id.includes(query)) score = 100

    if (session.active) score += 50
    if (session.metadata?.lifecycleState === 'archived') score -= 25
    return score * 1e13 + session.updatedAt
}

/**
 * Mention pool is stricter than sidebar visibility (#1506): require a real
 * title signal (`metadata.name` or summary text). Path last-segment fallback
 * and id-only labels are not @-targets — including husks sidebar still shows
 * via flattened `agentSessionId` / `claudeSessionId`.
 */
export function isMentionableSession(session: SessionSummary): boolean {
    return hasSessionTitleSignal(session)
}

/**
 * Rank sessions for composer `@` autocomplete.
 * Pool is sidebar-visible rows (`prepareSidebarSessions`) that also have a
 * real title signal (#1506). Path husks stay out even if sidebar shows them.
 * Match filter then reuses share/sidebar `sessionMatchesQuery`.
 * Empty query → active/recent shortlist (excludes archived + untitled husks).
 */
export function matchSessionsForMention(
    sessions: readonly SessionSummary[],
    query: string,
    options: MatchSessionsForMentionOptions = {}
): SessionSummary[] {
    const limit = options.limit ?? 20
    const excludeId = options.excludeId
    const resolveMachineLabel = options.resolveMachineLabel ?? (() => '')
    const normalized = normalizeSearch(query)
    const candidates = prepareSidebarSessions([...sessions], excludeId)

    const scored: { session: SessionSummary; score: number }[] = []
    for (const session of candidates) {
        if (excludeId && session.id === excludeId) continue
        if (!isMentionableSession(session)) continue

        if (!normalized) {
            // Empty / whitespace query: shortlist only — active first, then recent.
            // Archived stay searchable once the user types (same as share: type to widen).
            if (session.metadata?.lifecycleState === 'archived') continue
            const score = session.active ? 1_000_000_000 + session.updatedAt : session.updatedAt
            scored.push({ session, score })
            continue
        }

        const machineLabel = resolveMachineLabel(session.metadata?.machineId ?? null)
        if (!sessionMatchesQuery(session, normalized, machineLabel)) continue
        scored.push({ session, score: scoreMatchedSession(session, normalized) })
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map((entry) => entry.session)
}

/** Match in-app session paths produced by buildSessionReferencePath (optional BASE_URL). */
const SESSION_PATH_RE = /^(?:\.?\/)?(?:[\w.-]+\/)*sessions\/([^/?#]+)\/?$/

/**
 * Hub session ids are UUIDs (no dots). Reject dotted tails so source paths like
 * `web/src/routes/sessions/chat.tsx` stay available for file-path autolinking.
 */
function isPlausibleSessionId(id: string): boolean {
    return id.length > 0 && !id.includes('.')
}

/** Parse a session id from a relative `/sessions/<id>` (or BASE_URL-prefixed) href. */
export function parseSessionPathHref(href: string): string | null {
    const trimmed = href.trim()
    if (!trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null
    const match = SESSION_PATH_RE.exec(trimmed)
    if (!match) return null
    try {
        const id = decodeURIComponent(match[1] ?? '')
        return isPlausibleSessionId(id) ? id : null
    } catch {
        return null
    }
}

/** Live / fallback fields for composer mention chip hover tooltips. */
export type SessionMentionTooltipSource = {
    id: string
    title: string
    active: boolean
    lifecycleState?: string | null
    path?: string | null
    worktreePath?: string | null
    /** Preformatted relative time (sidebar "ago"), when available. */
    relativeTime?: string | null
    thinking?: boolean
    /** Sidebar attention label (permission / input / unread / …). */
    attentionLabel?: string | null
}

export type SessionMentionTooltipModel = {
    title: string
    lines: string[]
    ariaLabel: string
}

/**
 * Expand a truncated `@chip` into full title + meta for aria-label / fallback tip.
 * Visual hover uses SessionRowSummary when a live SessionSummary is available.
 */
export function formatSessionMentionTooltip(
    session: SessionMentionTooltipSource | null,
    fallbackTitle: string,
    id: string
): SessionMentionTooltipModel {
    const shortId = id.slice(0, 8)
    const rawTitle = (session?.title || fallbackTitle || shortId).replace(/\s+/g, ' ').trim()
    const title = rawTitle || shortId

    let status: string | null = null
    if (session) {
        if (session.lifecycleState === 'archived') status = 'Archived'
        else if (session.thinking) status = 'Thinking'
        else if (session.attentionLabel) status = session.attentionLabel
        else status = session.active ? 'Active' : 'Inactive'
    }

    const path = (session?.worktreePath || session?.path || '').trim() || null
    const lines: string[] = [
        status ? `Session · ${shortId} · ${status}` : `Session · ${shortId}`,
    ]
    const ago = session?.relativeTime?.trim()
    if (ago) lines.push(ago)
    if (path) lines.push(path)

    return {
        title,
        lines,
        ariaLabel: [title, ...lines].join('. '),
    }
}
