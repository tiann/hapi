/**
 * Register / update / clear session-attached jobs (tiann/hapi#1404).
 * Same hub JWT flow as ping-peer — works while the agent session is idle.
 */

import axios, { type AxiosInstance } from 'axios'
import type { AttachedJob, AttachedJobPatch, AttachedJobUpsert } from '@hapi/protocol'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { buildHubRequestHeaders } from '@/api/hubExtraHeaders'

export type SessionJobErrorCode =
    | 'bad_args'
    | 'auth_failed'
    | 'not_found'
    | 'ambiguous'
    | 'request_failed'

export class SessionJobError extends Error {
    readonly code: SessionJobErrorCode

    constructor(code: SessionJobErrorCode, message: string) {
        super(message)
        this.name = 'SessionJobError'
        this.code = code
    }
}

const AUTH_RECOVERY_HINT =
    'On a remote runner, set HAPI_API_URL to the runner hub, and set CLI_API_TOKEN ' +
    'or run `hapi auth login`. Prefer `hapi job` over raw JWT+curl.'

function resolveApiUrl(apiUrl?: string): string {
    const raw = (apiUrl ?? configuration.apiUrl).trim().replace(/\/+$/, '')
    if (!raw) {
        throw new SessionJobError('bad_args', `HAPI API URL is empty. ${AUTH_RECOVERY_HINT}`)
    }
    return raw
}

function resolveAccessToken(accessToken?: string): string {
    let token = ''
    try {
        token = (accessToken ?? getAuthToken()).trim()
    } catch {
        token = (accessToken ?? '').trim()
    }
    if (!token) {
        throw new SessionJobError(
            'bad_args',
            `CLI_API_TOKEN is required (run \`hapi auth login\`). ${AUTH_RECOVERY_HINT}`
        )
    }
    return token
}

async function exchangeJwt(
    apiUrl: string,
    accessToken: string,
    http: AxiosInstance
): Promise<string> {
    try {
        const response = await http.post(
            `${apiUrl}/api/auth`,
            { accessToken },
            {
                headers: buildHubRequestHeaders({ 'Content-Type': 'application/json' }),
                timeout: 10_000,
                validateStatus: () => true
            }
        )
        const token = typeof response.data?.token === 'string' ? response.data.token : ''
        if (response.status < 200 || response.status >= 300 || !token) {
            const detail = typeof response.data?.error === 'string'
                ? response.data.error
                : `HTTP ${response.status}`
            throw new SessionJobError(
                'auth_failed',
                `failed to exchange access token for JWT (${detail}). Hub URL: ${apiUrl}. ${AUTH_RECOVERY_HINT}`
            )
        }
        return token
    } catch (error) {
        if (error instanceof SessionJobError) throw error
        throw new SessionJobError(
            'auth_failed',
            `failed to exchange access token for JWT (${error instanceof Error ? error.message : String(error)}). Hub URL: ${apiUrl}. ${AUTH_RECOVERY_HINT}`
        )
    }
}

function authHeaders(jwt: string): Record<string, string> {
    return buildHubRequestHeaders({
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json'
    })
}

type SessionListItem = { id: string }

function resolveSessionByPrefix(sessions: SessionListItem[], prefix: string): SessionListItem {
    const trimmed = prefix.trim()
    if (!trimmed) {
        throw new SessionJobError('bad_args', 'session id prefix is required')
    }
    const exact = sessions.filter((session) => session.id === trimmed)
    if (exact.length === 1) return exact[0]!
    const matches = sessions.filter((session) => session.id.startsWith(trimmed))
    if (matches.length === 0) {
        throw new SessionJobError('not_found', `no session matching prefix '${trimmed}'`)
    }
    if (matches.length > 1) {
        const sample = matches.slice(0, 5).map((session) => session.id.slice(0, 8)).join(', ')
        throw new SessionJobError(
            'ambiguous',
            `prefix '${trimmed}' matches ${matches.length} sessions (${sample}${matches.length > 5 ? ', ...' : ''}); use a longer prefix`
        )
    }
    return matches[0]!
}

async function resolveSessionId(
    apiUrl: string,
    jwt: string,
    http: AxiosInstance,
    sessionIdPrefix: string
): Promise<string> {
    const response = await http.get(`${apiUrl}/api/sessions`, {
        headers: authHeaders(jwt),
        params: { limit: 500, order: 'updatedAt' },
        timeout: 15_000,
        validateStatus: () => true
    })
    if (response.status < 200 || response.status >= 300) {
        throw new SessionJobError('request_failed', `list sessions failed: HTTP ${response.status}`)
    }
    const sessions = Array.isArray(response.data?.sessions)
        ? (response.data.sessions as SessionListItem[])
        : []
    return resolveSessionByPrefix(sessions, sessionIdPrefix).id
}

export type SessionJobClientOptions = {
    sessionIdPrefix: string
    apiUrl?: string
    accessToken?: string
    http?: AxiosInstance
}

async function withClient<T>(
    options: SessionJobClientOptions,
    fn: (ctx: { apiUrl: string; jwt: string; sessionId: string; http: AxiosInstance }) => Promise<T>
): Promise<T> {
    const http = options.http ?? axios
    const apiUrl = resolveApiUrl(options.apiUrl)
    const accessToken = resolveAccessToken(options.accessToken)
    const jwt = await exchangeJwt(apiUrl, accessToken, http)
    const sessionId = await resolveSessionId(apiUrl, jwt, http, options.sessionIdPrefix)
    return fn({ apiUrl, jwt, sessionId, http })
}

export async function listSessionJobs(
    options: SessionJobClientOptions
): Promise<{ sessionId: string; jobs: AttachedJob[]; primary: AttachedJob | null }> {
    return withClient(options, async ({ apiUrl, jwt, sessionId, http }) => {
        const response = await http.get(`${apiUrl}/api/sessions/${sessionId}/jobs`, {
            headers: authHeaders(jwt),
            timeout: 15_000,
            validateStatus: () => true
        })
        if (response.status < 200 || response.status >= 300) {
            throw new SessionJobError('request_failed', `list jobs failed: HTTP ${response.status}`)
        }
        return {
            sessionId,
            jobs: Array.isArray(response.data?.jobs) ? response.data.jobs : [],
            primary: response.data?.primary ?? null
        }
    })
}

export async function setSessionJob(
    options: SessionJobClientOptions & { jobKey: string; body: AttachedJobUpsert }
): Promise<{ sessionId: string; job: AttachedJob }> {
    return withClient(options, async ({ apiUrl, jwt, sessionId, http }) => {
        const response = await http.put(
            `${apiUrl}/api/sessions/${sessionId}/jobs/${encodeURIComponent(options.jobKey)}`,
            options.body,
            {
                headers: authHeaders(jwt),
                timeout: 15_000,
                validateStatus: () => true
            }
        )
        if (response.status === 404) {
            throw new SessionJobError('not_found', 'session or job not found')
        }
        if (response.status < 200 || response.status >= 300 || !response.data?.job) {
            const detail = typeof response.data?.error === 'string'
                ? response.data.error
                : `HTTP ${response.status}`
            throw new SessionJobError('request_failed', `set job failed: ${detail}`)
        }
        return { sessionId, job: response.data.job as AttachedJob }
    })
}

export async function updateSessionJob(
    options: SessionJobClientOptions & { jobKey: string; body: AttachedJobPatch }
): Promise<{ sessionId: string; job: AttachedJob }> {
    return withClient(options, async ({ apiUrl, jwt, sessionId, http }) => {
        const response = await http.patch(
            `${apiUrl}/api/sessions/${sessionId}/jobs/${encodeURIComponent(options.jobKey)}`,
            options.body,
            {
                headers: authHeaders(jwt),
                timeout: 15_000,
                validateStatus: () => true
            }
        )
        if (response.status === 404) {
            throw new SessionJobError('not_found', 'job not found')
        }
        if (response.status < 200 || response.status >= 300 || !response.data?.job) {
            const detail = typeof response.data?.error === 'string'
                ? response.data.error
                : `HTTP ${response.status}`
            throw new SessionJobError('request_failed', `update job failed: ${detail}`)
        }
        return { sessionId, job: response.data.job as AttachedJob }
    })
}

export async function clearSessionJob(
    options: SessionJobClientOptions & { jobKey: string }
): Promise<{ sessionId: string }> {
    return withClient(options, async ({ apiUrl, jwt, sessionId, http }) => {
        const response = await http.delete(
            `${apiUrl}/api/sessions/${sessionId}/jobs/${encodeURIComponent(options.jobKey)}`,
            {
                headers: authHeaders(jwt),
                timeout: 15_000,
                validateStatus: () => true
            }
        )
        if (response.status === 404) {
            throw new SessionJobError('not_found', 'job not found')
        }
        if (response.status < 200 || response.status >= 300) {
            throw new SessionJobError('request_failed', `clear job failed: HTTP ${response.status}`)
        }
        return { sessionId }
    })
}

export function exitCodeForSessionJobError(error: SessionJobError): number {
    switch (error.code) {
        case 'bad_args':
            return 2
        case 'auth_failed':
            return 3
        case 'not_found':
            return 4
        case 'ambiguous':
            return 5
        default:
            return 1
    }
}
