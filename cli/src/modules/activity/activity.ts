/**
 * When agents were working, from the hub's GET /api/activity, for
 * `hapi usage`. Other tools (e.g. time trackers) read the `--json` output, so
 * its shape is versioned by `ACTIVITY_REPORT_SCHEMA`.
 */

import axios, { type AxiosInstance } from 'axios'
import type { AgentActivitySession } from '@hapi/protocol/apiTypes'
import { readSettings } from '@/persistence'
import {
    PingPeerError,
    authHeaders,
    exchangeJwt,
    resolveAccessToken,
    resolveApiUrl
} from '@/modules/pingPeer/pingPeer'

/** Bump when the JSON output changes incompatibly. */
export const ACTIVITY_REPORT_SCHEMA = 'hapi.activity.v1'

export type ActivityReport = {
    schema: typeof ACTIVITY_REPORT_SCHEMA
    generatedAt: number
    hubUrl: string
    /** This machine's id, so a reader can tell local sessions from remote ones. */
    localMachineId: string | null
    since: number
    until: number
    sessions: AgentActivitySession[]
}

export type ActivityErrorCode = 'bad_args' | 'auth_failed' | 'hub_too_old' | 'request_failed'

export class ActivityError extends Error {
    readonly code: ActivityErrorCode

    constructor(code: ActivityErrorCode, message: string) {
        super(message)
        this.name = 'ActivityError'
        this.code = code
    }
}

export function exitCodeForActivityError(error: ActivityError): number {
    switch (error.code) {
        case 'bad_args': return 2
        case 'auth_failed': return 3
        case 'hub_too_old': return 4
        default: return 1
    }
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }

/** `30m`, `24h`, `7d` (before `now`), an ISO date, or epoch milliseconds. */
export function parseTimeArg(value: string, now: number): number {
    const trimmed = value.trim()
    const relative = /^(\d+)([mhd])$/.exec(trimmed)
    if (relative) {
        return now - Number(relative[1]) * UNIT_MS[relative[2]!]!
    }
    if (/^\d{10,15}$/.test(trimmed)) {
        return Number(trimmed)
    }
    const parsed = Date.parse(trimmed)
    if (Number.isNaN(parsed)) {
        throw new ActivityError('bad_args', `can't read '${value}' as a time; use 24h, 7d, an ISO date or epoch milliseconds`)
    }
    return parsed
}

export type FetchActivityOptions = {
    since: number
    until: number
    apiUrl?: string
    accessToken?: string
    http?: AxiosInstance
    now?: () => number
}

export async function fetchActivity(options: FetchActivityOptions): Promise<ActivityReport> {
    if (options.since >= options.until) {
        throw new ActivityError('bad_args', '--since must be before --until')
    }
    const http = options.http ?? axios
    let apiUrl: string
    let jwt: string
    try {
        apiUrl = resolveApiUrl(options.apiUrl)
        jwt = await exchangeJwt(apiUrl, resolveAccessToken(options.accessToken), http)
    } catch (error) {
        if (error instanceof PingPeerError) {
            throw new ActivityError(error.code === 'auth_failed' ? 'auth_failed' : 'bad_args', error.message)
        }
        throw error
    }

    let response
    try {
        response = await http.get(`${apiUrl}/api/activity`, {
            params: { since: options.since, until: options.until },
            headers: authHeaders(jwt),
            timeout: 30_000,
            validateStatus: () => true
        })
    } catch (error) {
        throw new ActivityError('request_failed', `could not reach ${apiUrl}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (response.status === 404) {
        throw new ActivityError('hub_too_old', `the hub at ${apiUrl} doesn't report agent activity yet; update it`)
    }
    if (response.status === 401 || response.status === 403) {
        throw new ActivityError('auth_failed', `the hub at ${apiUrl} refused the request (HTTP ${response.status})`)
    }
    const body = response.data as { error?: unknown; sessions?: unknown; since?: unknown; until?: unknown } | undefined
    if (response.status < 200 || response.status >= 300 || !Array.isArray(body?.sessions)) {
        const detail = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`
        throw new ActivityError('request_failed', `the hub at ${apiUrl} could not report activity: ${detail}`)
    }

    const settings = await readSettings()
    return {
        schema: ACTIVITY_REPORT_SCHEMA,
        generatedAt: (options.now ?? Date.now)(),
        hubUrl: apiUrl,
        localMachineId: settings.machineId ?? null,
        since: typeof body.since === 'number' ? body.since : options.since,
        until: typeof body.until === 'number' ? body.until : options.until,
        sessions: body.sessions as AgentActivitySession[]
    }
}

type Interval = { start: number; end: number }

/** Sorted, non-overlapping intervals covering the same time. */
function mergeIntervals(intervals: Interval[]): Interval[] {
    const merged: Interval[] = []
    for (const interval of [...intervals].sort((a, b) => a.start - b.start)) {
        const last = merged[merged.length - 1]
        if (last && interval.start <= last.end) {
            last.end = Math.max(last.end, interval.end)
        } else {
            merged.push({ ...interval })
        }
    }
    return merged
}

/**
 * Time a session's agent spent working within `window`: its turns, minus
 * the time it waited on the user. The hub returns whole turns that overlap
 * the window, so turns and waits are cut to it first; a turn still open
 * runs to the end of the window.
 */
export function workedMs(session: AgentActivitySession, window: { since: number; until: number }): number {
    const clamp = (start: number, end: number | null): Interval | null => {
        const clamped = { start: Math.max(start, window.since), end: Math.min(end ?? window.until, window.until) }
        return clamped.end > clamped.start ? clamped : null
    }
    const turns = mergeIntervals(session.turns.flatMap((turn) => clamp(turn.start, turn.end) ?? []))
    const waits = mergeIntervals(session.waits.flatMap((wait) => clamp(wait.start, wait.end) ?? []))

    let total = 0
    for (const turn of turns) {
        let waited = 0
        for (const wait of waits) {
            const overlap = Math.min(turn.end, wait.end) - Math.max(turn.start, wait.start)
            if (overlap > 0) waited += overlap
        }
        total += turn.end - turn.start - waited
    }
    return total
}

function formatDuration(ms: number): string {
    const minutes = Math.round(ms / 60_000)
    if (minutes < 60) return `${minutes}m`
    return minutes % 60 === 0 ? `${minutes / 60}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** One line per session, busiest first. */
export function formatActivityReport(report: ActivityReport): string {
    if (report.sessions.length === 0) {
        return 'No agent activity in this period.'
    }
    const window = { since: report.since, until: Math.min(report.until, report.generatedAt) }
    const rows = report.sessions
        .map((session) => ({ session, worked: workedMs(session, window) }))
        .sort((a, b) => b.worked - a.worked)
    const total = rows.reduce((sum, row) => sum + row.worked, 0)
    const lines = rows.map(({ session, worked }) => {
        const title = session.title ?? session.path ?? session.id.slice(0, 8)
        const where = session.machineId && session.machineId === report.localMachineId ? 'this machine' : (session.machineName ?? session.host ?? 'unknown machine')
        const live = session.turns.some((turn) => turn.end === null) ? ' (working now)' : ''
        const turns = `${session.turns.length} turn${session.turns.length === 1 ? '' : 's'}`
        return `  ${formatDuration(worked).padStart(7)}  ${title} · ${session.flavor ?? 'agent'} · ${where} · ${turns}${live}`
    })
    return [`Agents worked ${formatDuration(total)} across ${rows.length} session${rows.length === 1 ? '' : 's'}:`, ...lines].join('\n')
}
