import type { SessionSummary } from '@/types/api'
import { normalizeSearch, sessionMatchesQuery } from '@/components/SessionList'
import { getSessionTitle } from '@/lib/sessionTitle'

export function buildSessionReferencePath(sessionId: string): string {
    const base = import.meta.env.BASE_URL ?? '/'
    const normalizedBase = base.endsWith('/') ? base : `${base}/`
    return `${normalizedBase}sessions/${encodeURIComponent(sessionId)}`.replace(/\/{2,}/g, '/')
}

function sanitizeSessionReferenceTitle(sessionTitle: string): string {
    return sessionTitle.replace(/\s+/g, ' ').trim().slice(0, 120)
}

/** Clipboard text for citing this session in another HAPI chat (not a public share link). */
export function buildSessionReferenceText(sessionTitle: string, sessionId: string): string {
    const path = buildSessionReferencePath(sessionId)
    const title = sanitizeSessionReferenceTitle(sessionTitle)
    if (title) {
        return `See session ${JSON.stringify(title)} (${path}) for context`
    }
    return `See HAPI session ${path} for context`
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
 * Rank sessions for composer `@` autocomplete.
 * Match filter is the same code path as share/sidebar search (`sessionMatchesQuery`).
 * Display/insert still use `getSessionTitle` (name before summary).
 * Empty query → active/recent shortlist (excludes archived).
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

    const scored: { session: SessionSummary; score: number }[] = []
    for (const session of sessions) {
        if (excludeId && session.id === excludeId) continue

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
