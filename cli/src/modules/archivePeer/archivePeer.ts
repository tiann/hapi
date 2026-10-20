/**
 * Soft stand-down for a peer session via POST /api/sessions/:id/archive.
 *
 * Shared by `hapi archive-peer` and MCP `archive_peer`. Uses the same hub JWT
 * flow as ping-peer / inspect-peer (`POST /api/auth` with CLI_API_TOKEN),
 * scoped to the token's namespace. No hand JWT/curl. Archive only — never delete.
 *
 * Authz: same-namespace CLI credentials (orchestrator parent or self-archive
 * on Peer Done). Capability binding beyond namespace is TBD when parent-stamp
 * lands upstream; do not invent a god-mode token path.
 */

import axios, { type AxiosInstance } from 'axios'
import { normalizeSessionIdPrefix } from '@hapi/protocol/sessionCitation'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { buildHubRequestHeaders } from '@/api/hubExtraHeaders'
import {
    PingPeerError,
    resolvePeerSessionLabel,
    resolveSessionByPrefix,
    type PingPeerSessionSummary
} from '@/modules/pingPeer/pingPeer'

export type ArchivePeerErrorCode =
    | 'bad_args'
    | 'auth_failed'
    | 'not_found'
    | 'ambiguous'
    | 'archive_failed'

export class ArchivePeerError extends Error {
    readonly code: ArchivePeerErrorCode

    constructor(code: ArchivePeerErrorCode, message: string) {
        super(message)
        this.name = 'ArchivePeerError'
        this.code = code
    }
}

export type ArchivePeerOptions = {
    sessionIdPrefix: string
    apiUrl?: string
    accessToken?: string
    http?: AxiosInstance
    onProgress?: (message: string) => void
}

export type ArchivePeerResult = {
    sessionId: string
    name: string
    alreadyArchived: boolean
}

const AUTH_RECOVERY_HINT =
    'On a remote runner, set HAPI_API_URL to the runner hub, and set CLI_API_TOKEN ' +
    'or run `hapi auth login` to save the token. Inside a HAPI session prefer MCP ' +
    '`archive_peer`, which uses the session CLI credentials.'

function resolveApiUrl(apiUrl?: string): string {
    const raw = (apiUrl ?? configuration.apiUrl).trim().replace(/\/+$/, '')
    if (!raw) {
        throw new ArchivePeerError(
            'bad_args',
            `HAPI API URL is empty. ${AUTH_RECOVERY_HINT}`
        )
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
        throw new ArchivePeerError(
            'bad_args',
            `CLI_API_TOKEN is required (run \`hapi auth login\`). ${AUTH_RECOVERY_HINT}`
        )
    }
    return token
}

function authFailedMessage(apiUrl: string, detail: string): string {
    return `failed to exchange access token for JWT (${detail}). Hub URL: ${apiUrl}. ${AUTH_RECOVERY_HINT}`
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
            throw new ArchivePeerError('auth_failed', authFailedMessage(apiUrl, detail))
        }
        return token
    } catch (error) {
        if (error instanceof ArchivePeerError) {
            throw error
        }
        throw new ArchivePeerError(
            'auth_failed',
            authFailedMessage(apiUrl, error instanceof Error ? error.message : String(error))
        )
    }
}

function authHeaders(jwt: string): Record<string, string> {
    return buildHubRequestHeaders({
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json'
    })
}

function mapPingPeerResolveError(error: unknown): never {
    if (error instanceof PingPeerError) {
        const code = error.code
        if (code === 'bad_args' || code === 'not_found' || code === 'ambiguous' || code === 'auth_failed') {
            throw new ArchivePeerError(code, error.message)
        }
        throw new ArchivePeerError('archive_failed', error.message)
    }
    throw error
}

async function listSessions(
    apiUrl: string,
    jwt: string,
    http: AxiosInstance
): Promise<PingPeerSessionSummary[]> {
    const response = await http.get(
        `${apiUrl}/api/sessions`,
        {
            headers: authHeaders(jwt),
            timeout: 15_000,
            validateStatus: () => true
        }
    )
    if (response.status < 200 || response.status >= 300) {
        const detail = typeof response.data?.error === 'string'
            ? response.data.error
            : `HTTP ${response.status}`
        throw new ArchivePeerError(
            'auth_failed',
            `failed to list sessions (${detail}). Hub URL: ${apiUrl}. ${AUTH_RECOVERY_HINT}`
        )
    }
    const body = response.data
    const sessions = Array.isArray(body?.sessions)
        ? body.sessions
        : Array.isArray(body)
            ? body
            : null
    if (!sessions) {
        throw new ArchivePeerError('auth_failed', 'failed to list sessions (unexpected response)')
    }
    return sessions as PingPeerSessionSummary[]
}

async function postArchive(
    apiUrl: string,
    jwt: string,
    sessionId: string,
    http: AxiosInstance
): Promise<{ alreadyArchived: boolean }> {
    const response = await http.post(
        `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/archive`,
        {},
        {
            headers: authHeaders(jwt),
            timeout: 60_000,
            validateStatus: () => true
        }
    )
    if (response.status >= 200 && response.status < 300 && response.data?.ok === true) {
        return { alreadyArchived: response.data?.alreadyArchived === true }
    }
    const detail = typeof response.data?.error === 'string'
        ? response.data.error
        : typeof response.data?.code === 'string'
            ? response.data.code
            : `HTTP ${response.status}`
    throw new ArchivePeerError('archive_failed', `archive failed: ${detail}`)
}

/**
 * Resolve a peer by id/prefix and soft-archive it (lifecycle → archived).
 * Never deletes. Prefer this (or MCP archive_peer) over hand JWT+curl.
 */
export async function archivePeer(options: ArchivePeerOptions): Promise<ArchivePeerResult> {
    const prefix = normalizeSessionIdPrefix(options.sessionIdPrefix ?? '')
    if (!prefix) {
        throw new ArchivePeerError('bad_args', 'session id prefix is required')
    }

    const apiUrl = resolveApiUrl(options.apiUrl)
    const accessToken = resolveAccessToken(options.accessToken)
    const http = options.http ?? axios
    const onProgress = options.onProgress

    const jwt = await exchangeJwt(apiUrl, accessToken, http)
    const sessions = await listSessions(apiUrl, jwt, http)
    let matched: PingPeerSessionSummary
    try {
        matched = resolveSessionByPrefix(sessions, prefix)
    } catch (error) {
        mapPingPeerResolveError(error)
    }
    const name = resolvePeerSessionLabel(matched)
    onProgress?.(`resolved ${matched.id}  active=${matched.active}  name="${name}"`)
    onProgress?.('requesting archive...')

    const { alreadyArchived } = await postArchive(apiUrl, jwt, matched.id, http)
    onProgress?.(alreadyArchived ? 'already archived' : 'archived')

    return {
        sessionId: matched.id,
        name,
        alreadyArchived
    }
}

export function exitCodeForArchivePeerError(error: ArchivePeerError): number {
    switch (error.code) {
        case 'bad_args':
        case 'auth_failed':
        case 'not_found':
        case 'ambiguous':
            return 2
        case 'archive_failed':
            return 4
        default:
            return 1
    }
}
