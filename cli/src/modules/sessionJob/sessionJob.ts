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
    | 'run_mismatch'
    | 'request_failed'

export class SessionJobError extends Error {
    readonly code: SessionJobErrorCode

    constructor(code: SessionJobErrorCode, message: string) {
        super(message)
        this.name = 'SessionJobError'
        this.code = code
    }
}

/** Exact Shell recipe agents should run instead of MCP set or update-before-create. */
export const SESSION_JOB_RUN_RECIPE =
    'hapi job run "$HAPI_SESSION_ID" <job-key> --label "<label>" [--done N --total M|--remaining N] [--unit …] -- <cmd>…'

export function formatSessionJobNotFoundHint(action: 'update' | 'clear'): string {
    return [
        `job not found on this session (${action} requires an existing meter).`,
        'Create one with Shell (MCP action=set is refused):',
        SESSION_JOB_RUN_RECIPE,
        'Wrap the real long-running command — not a sleep stub while work runs elsewhere.',
    ].join(' ')
}

/** True when hub/CLI reports a missing session job (incl. duplicate-class instanceof misses). */
export function isSessionJobNotFoundError(error: unknown): boolean {
    if (error instanceof SessionJobError && error.code === 'not_found') {
        return true
    }
    if (typeof error === 'object' && error !== null) {
        const candidate = error as { name?: string; code?: string }
        if (candidate.code === 'not_found' && candidate.name === 'SessionJobError') {
            return true
        }
    }
    // MCP server bundles can load two SessionJobError identities; message still matches.
    if (error instanceof Error && /\bjob not found\b/i.test(error.message)) {
        return true
    }
    return false
}

/** Shown after update when progress reads done but status is still running. */
export const SESSION_JOB_REMAINING_ZERO_HINT =
    'remaining is 0 but status is still running — pass --status completed when work is finished, or hapi job clear to drop the meter.'

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

export function resolveSessionByPrefix(sessions: SessionListItem[], prefix: string): SessionListItem {
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

const FULL_SESSION_UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolve a session id for job CLI calls. Prefer list match; if the prefix is
 * a full UUID missing from the list (deleted merge source), pass it through so
 * hub job routes can follow jobsAcceptedFromSessionIds.
 */
export function resolveSessionIdForJobCli(
    sessions: SessionListItem[],
    sessionIdPrefix: string
): string {
    try {
        return resolveSessionByPrefix(sessions, sessionIdPrefix).id
    } catch (error) {
        if (
            error instanceof SessionJobError
            && error.code === 'not_found'
            && FULL_SESSION_UUID.test(sessionIdPrefix.trim())
        ) {
            return sessionIdPrefix.trim()
        }
        throw error
    }
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
    return resolveSessionIdForJobCli(sessions, sessionIdPrefix)
}

/**
 * Mutable client handle for supervised runs.
 * Cache `sessionId` for the life of the process (list is expensive); refresh
 * `jwt` proactively before hub's 4h expiry and on 401.
 */
export type SessionJobResolvedClient = {
    apiUrl: string
    jwt: string
    sessionId: string
    jwtIssuedAtMs: number
}

export type SessionJobClientOptions = {
    sessionIdPrefix: string
    apiUrl?: string
    accessToken?: string
    http?: AxiosInstance
    /**
     * When set (e.g. after {@link resolveSessionJobClient}), skip session-list
     * resolve. JWT is still refreshed in-place for days-long `job run`.
     */
    resolved?: SessionJobResolvedClient
}

/** Hub JWT expires at 4h — refresh a bit early so heartbeats never 401. */
export const SESSION_JOB_JWT_REFRESH_AFTER_MS = 3 * 60 * 60 * 1000

/** Resolve session id once; JWT may be refreshed later via the same object. */
export async function resolveSessionJobClient(
    options: SessionJobClientOptions
): Promise<SessionJobResolvedClient> {
    if (options.resolved) {
        return options.resolved
    }
    const http = options.http ?? axios
    const apiUrl = resolveApiUrl(options.apiUrl)
    const accessToken = resolveAccessToken(options.accessToken)
    const jwt = await exchangeJwt(apiUrl, accessToken, http)
    const sessionId = await resolveSessionId(apiUrl, jwt, http, options.sessionIdPrefix)
    return { apiUrl, jwt, sessionId, jwtIssuedAtMs: Date.now() }
}

async function refreshSessionJobJwt(
    resolved: SessionJobResolvedClient,
    options: SessionJobClientOptions
): Promise<void> {
    const http = options.http ?? axios
    const accessToken = resolveAccessToken(options.accessToken)
    resolved.jwt = await exchangeJwt(resolved.apiUrl, accessToken, http)
    resolved.jwtIssuedAtMs = Date.now()
}

async function ensureFreshJwt(
    resolved: SessionJobResolvedClient,
    options: SessionJobClientOptions,
    force = false
): Promise<void> {
    const age = Date.now() - resolved.jwtIssuedAtMs
    if (force || age >= SESSION_JOB_JWT_REFRESH_AFTER_MS) {
        await refreshSessionJobJwt(resolved, options)
    }
}

type AuthedResponse = { status: number; data?: unknown }

function httpStatusError(
    action: string,
    response: AuthedResponse,
    errorDetail?: string
): SessionJobError {
    const detail = typeof errorDetail === 'string' && errorDetail.length > 0
        ? errorDetail
        : `HTTP ${response.status}`
    if (response.status === 401) {
        return new SessionJobError('auth_failed', `${action} failed: ${detail}`)
    }
    return new SessionJobError('request_failed', `${action} failed: ${detail}`)
}

/**
 * Run an authed request; on 401 re-exchange JWT (keep cached sessionId) and retry once.
 */
async function withAuthedRequest<T>(
    options: SessionJobClientOptions,
    request: (ctx: { apiUrl: string; jwt: string; sessionId: string; http: AxiosInstance }) => Promise<AuthedResponse>,
    handle: (response: AuthedResponse, sessionId: string) => T
): Promise<T> {
    const http = options.http ?? axios
    const resolved = await resolveSessionJobClient(options)
    await ensureFreshJwt(resolved, options)

    const run = async () => request({
        apiUrl: resolved.apiUrl,
        jwt: resolved.jwt,
        sessionId: resolved.sessionId,
        http
    })

    let response = await run()
    if (response.status === 401) {
        await ensureFreshJwt(resolved, options, true)
        response = await run()
    }
    return handle(response, resolved.sessionId)
}

export async function listSessionJobs(
    options: SessionJobClientOptions
): Promise<{ sessionId: string; jobs: AttachedJob[]; primary: AttachedJob | null }> {
    return withAuthedRequest(
        options,
        ({ apiUrl, jwt, sessionId, http }) => http.get(`${apiUrl}/api/sessions/${sessionId}/jobs`, {
            headers: authHeaders(jwt),
            timeout: 15_000,
            validateStatus: () => true
        }),
        (response, sessionId) => {
            if (response.status < 200 || response.status >= 300) {
                throw httpStatusError('list jobs', response)
            }
            const data = response.data as { jobs?: AttachedJob[]; primary?: AttachedJob | null } | undefined
            return {
                sessionId,
                jobs: Array.isArray(data?.jobs) ? data.jobs : [],
                primary: data?.primary ?? null
            }
        }
    )
}

export async function setSessionJob(
    options: SessionJobClientOptions & { jobKey: string; body: AttachedJobUpsert }
): Promise<{ sessionId: string; job: AttachedJob }> {
    return withAuthedRequest(
        options,
        ({ apiUrl, jwt, sessionId, http }) => http.put(
            `${apiUrl}/api/sessions/${sessionId}/jobs/${encodeURIComponent(options.jobKey)}`,
            options.body,
            {
                headers: authHeaders(jwt),
                timeout: 15_000,
                validateStatus: () => true
            }
        ),
        (response, sessionId) => {
            if (response.status === 404) {
                throw new SessionJobError('not_found', 'session or job not found')
            }
            const data = response.data as { job?: AttachedJob; error?: string } | undefined
            if (response.status < 200 || response.status >= 300 || !data?.job) {
                throw httpStatusError('set job', response, data?.error)
            }
            return { sessionId, job: data.job }
        }
    )
}

export async function updateSessionJob(
    options: SessionJobClientOptions & { jobKey: string; body: AttachedJobPatch }
): Promise<{ sessionId: string; job: AttachedJob }> {
    return withAuthedRequest(
        options,
        ({ apiUrl, jwt, sessionId, http }) => http.patch(
            `${apiUrl}/api/sessions/${sessionId}/jobs/${encodeURIComponent(options.jobKey)}`,
            options.body,
            {
                headers: authHeaders(jwt),
                timeout: 15_000,
                validateStatus: () => true
            }
        ),
        (response, sessionId) => {
            if (response.status === 404) {
                throw new SessionJobError('not_found', 'job not found')
            }
            if (response.status === 409) {
                const data = response.data as { error?: string } | undefined
                throw new SessionJobError(
                    'run_mismatch',
                    data?.error
                        ?? 'job run mismatch (expectedRunId); another run reused this key'
                )
            }
            const data = response.data as { job?: AttachedJob; error?: string } | undefined
            if (response.status < 200 || response.status >= 300 || !data?.job) {
                throw httpStatusError('update job', response, data?.error)
            }
            return { sessionId, job: data.job }
        }
    )
}

export async function clearSessionJob(
    options: SessionJobClientOptions & { jobKey: string; expectedRunId?: string }
): Promise<{ sessionId: string }> {
    return withAuthedRequest(
        options,
        ({ apiUrl, jwt, sessionId, http }) => {
            const qs = options.expectedRunId
                ? `?expectedRunId=${encodeURIComponent(options.expectedRunId)}`
                : ''
            return http.delete(
                `${apiUrl}/api/sessions/${sessionId}/jobs/${encodeURIComponent(options.jobKey)}${qs}`,
                {
                    headers: authHeaders(jwt),
                    timeout: 15_000,
                    validateStatus: () => true
                }
            )
        },
        (response, sessionId) => {
            if (response.status === 404) {
                throw new SessionJobError('not_found', 'job not found')
            }
            if (response.status === 409) {
                const detail = (response.data as { error?: string } | undefined)?.error
                throw new SessionJobError(
                    'run_mismatch',
                    detail
                        ?? 'job run mismatch (expectedRunId); another run reused this key'
                )
            }
            if (response.status < 200 || response.status >= 300) {
                throw httpStatusError('clear job', response)
            }
            return { sessionId }
        }
    )
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
        case 'run_mismatch':
            return 6
        default:
            return 1
    }
}
