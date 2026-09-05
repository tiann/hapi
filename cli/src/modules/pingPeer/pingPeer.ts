/**
 * Exact-id message, wait, inspect, stop, and archive operations.
 *
 * Shared by `hapi ping-peer` / `hapi inspect-peer` and MCP `ping_peer` /
 * `inspect_peer`. Uses the same hub JWT flow as the web app
 * (`POST /api/auth` with CLI_API_TOKEN), scoped to the token's namespace.
 * Callers must not invent parallel auth or arbitrary hosts.
 */

import axios, { type AxiosInstance, type AxiosResponse } from 'axios'
import { randomUUID } from 'node:crypto'
import { extractAssistantPlainText, isObject } from '@hapi/protocol'
import { normalizeSessionIdPrefix } from '@hapi/protocol/sessionCitation'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { buildHubRequestHeaders } from '@/api/hubExtraHeaders'

export type PingPeerErrorCode =
    | 'bad_args'
    | 'auth_failed'
    | 'not_found'
    | 'resume_failed'
    | 'remit_conflict'
    | 'timeout'
    | 'send_failed'
    | 'session_ended'
    | 'lifecycle_failed'

export class PingPeerError extends Error {
    readonly code: PingPeerErrorCode
    readonly remitId?: string

    constructor(code: PingPeerErrorCode, message: string, remitId?: string) {
        super(message)
        this.name = 'PingPeerError'
        this.code = code
        this.remitId = remitId
    }
}

export type PingPeerSessionSummary = {
    id: string
    active: boolean
    thinking?: boolean
    updatedAt?: number
    metadata?: {
        name?: string
        flavor?: string | null
        path?: string | null
        lifecycleState?: string | null
        piSessionId?: string
        summary?: { text?: string } | null
    } | null
}

export type PingPeerOptions = {
    sessionId: string
    message: string
    remitId?: string
    waitActiveSecs?: number
    apiUrl?: string
    accessToken?: string
    http?: AxiosInstance
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    onProgress?: (message: string) => void
}

export type PingPeerResult = {
    sessionId: string
    remitId: string
    name: string
    resumed: boolean
}

const EXACT_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function requireExactSessionId(raw: string): string {
    const id = normalizeSessionIdPrefix(raw ?? '')
    if (!EXACT_SESSION_ID_RE.test(id)) {
        throw new PingPeerError('bad_args', 'an exact HAPI session UUID is required')
    }
    return id
}

const DEFAULT_WAIT_ACTIVE_SECS = 60
const POLL_ACTIVE_MS = 2_000
const POLL_PI_READY_MS = 1_000

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

const AUTH_RECOVERY_HINT =
    'On a remote runner, set HAPI_API_URL to the runner hub, and set CLI_API_TOKEN ' +
    'or run `hapi auth login` to save the token. Inside a HAPI session prefer MCP ' +
    'peer tools, which use the session CLI credentials.'

function resolveApiUrl(apiUrl?: string): string {
    const raw = (apiUrl ?? configuration.apiUrl).trim().replace(/\/+$/, '')
    if (!raw) {
        throw new PingPeerError(
            'bad_args',
            `HAPI API URL is empty. ${AUTH_RECOVERY_HINT}`
        )
    }
    // Peer messaging only targets the configured hub - never accept host overrides
    // from MCP tool args (security: same hub/token/namespace only).
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
        throw new PingPeerError(
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
            throw new PingPeerError('auth_failed', authFailedMessage(apiUrl, detail))
        }
        return token
    } catch (error) {
        if (error instanceof PingPeerError) {
            throw error
        }
        throw new PingPeerError(
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

async function getSession(
    apiUrl: string,
    jwt: string,
    sessionId: string,
    http: AxiosInstance
): Promise<PingPeerSessionSummary> {
    const response = await http.get(
        `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}`,
        {
            headers: authHeaders(jwt),
            timeout: 10_000,
            validateStatus: () => true
        }
    )
    if (response.status < 200 || response.status >= 300 || !response.data?.session) {
        const detail = typeof response.data?.error === 'string'
            ? response.data.error
            : `HTTP ${response.status}`
        throw new PingPeerError('not_found', `failed to load session ${sessionId} (${detail})`)
    }
    return response.data.session as PingPeerSessionSummary
}

async function resumeSession(
    apiUrl: string,
    jwt: string,
    sessionId: string,
    http: AxiosInstance
): Promise<void> {
    const response = await http.post(
        `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/resume`,
        {},
        {
            headers: authHeaders(jwt),
            timeout: 30_000,
            validateStatus: () => true
        }
    )
    if (response.data?.type === 'success') {
        return
    }
    const detail = typeof response.data?.message === 'string'
        ? response.data.message
        : typeof response.data?.error === 'string'
            ? response.data.error
            : typeof response.data?.code === 'string'
                ? response.data.code
                : `HTTP ${response.status}`
    throw new PingPeerError('resume_failed', `resume failed: ${detail}`)
}

async function waitUntilActive(
    apiUrl: string,
    jwt: string,
    sessionId: string,
    waitActiveSecs: number,
    http: AxiosInstance,
    sleep: (ms: number) => Promise<void>,
    now: () => number,
    onProgress?: (message: string) => void
): Promise<void> {
    const deadline = now() + waitActiveSecs * 1000
    onProgress?.(`waiting up to ${waitActiveSecs}s for active state...`)
    while (now() < deadline) {
        const session = await getSession(apiUrl, jwt, sessionId, http)
        if (session.active) {
            return
        }
        await sleep(POLL_ACTIVE_MS)
    }
    throw new PingPeerError(
        'timeout',
        `session did not become active within ${waitActiveSecs}s; runner may have failed to spawn`
    )
}

async function waitForPiReady(
    apiUrl: string,
    jwt: string,
    sessionId: string,
    waitActiveSecs: number,
    http: AxiosInstance,
    sleep: (ms: number) => Promise<void>,
    now: () => number,
    onProgress?: (message: string) => void
): Promise<void> {
    // active can precede piSessionId (tiann/hapi#1143). Instant /messages before
    // get_state settles wedges (Prompt accepted / agent_start / silence).
    onProgress?.(`flavor=pi - waiting up to ${waitActiveSecs}s for metadata.piSessionId...`)
    const deadline = now() + waitActiveSecs * 1000
    while (now() < deadline) {
        const session = await getSession(apiUrl, jwt, sessionId, http)
        const piSessionId = session.metadata?.piSessionId
        if (typeof piSessionId === 'string' && piSessionId.length > 0) {
            onProgress?.(`piSessionId=${piSessionId}`)
            return
        }
        await sleep(POLL_PI_READY_MS)
    }
    throw new PingPeerError(
        'timeout',
        `piSessionId never appeared within ${waitActiveSecs}s; refusing to send (would likely wedge - see #1143)`
    )
}

async function sendMessage(
    apiUrl: string,
    jwt: string,
    sessionId: string,
    message: string,
    remitId: string,
    http: AxiosInstance
): Promise<void> {
    let response: AxiosResponse
    try {
        response = await http.post(
            `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`,
            { text: message, localId: remitId },
            {
                headers: authHeaders(jwt),
                timeout: 30_000,
                validateStatus: () => true
            }
        )
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new PingPeerError('send_failed', `send failed: ${detail}`, remitId)
    }
    if (response.status >= 200 && response.status < 300 && response.data?.ok === true) {
        return
    }
    const detail = typeof response.data?.error === 'string'
        ? response.data.error
        : typeof response.data?.code === 'string'
            ? response.data.code
            : `HTTP ${response.status}`
    if (response.status === 409 && response.data?.code === 'local_id_conflict') {
        throw new PingPeerError('remit_conflict', `send failed: ${detail}`, remitId)
    }
    throw new PingPeerError('send_failed', `send failed: ${detail}`, remitId)
}

const MAX_PEER_LABEL_CHARS = 255

/**
 * Web-parity title for peer shortlists: name → summary.text → basename(path) → id prefix.
 * Collapses whitespace so agent-readable rows stay one line each.
 */
export function resolvePeerSessionLabel(session: PingPeerSessionSummary): string {
    const meta = session.metadata
    const pathLabel = meta?.path?.split(/[\\/]/).filter(Boolean).pop()?.trim()
    const raw = meta?.name?.trim()
        || meta?.summary?.text?.trim()
        || pathLabel
        || session.id.slice(0, 8)
    const collapsed = raw.replace(/\s+/g, ' ').trim()
    if (!collapsed) {
        return session.id.slice(0, 8)
    }
    return collapsed.length > MAX_PEER_LABEL_CHARS
        ? collapsed.slice(0, MAX_PEER_LABEL_CHARS)
        : collapsed
}

export async function pingPeer(options: PingPeerOptions): Promise<PingPeerResult> {
    const sessionId = requireExactSessionId(options.sessionId)
    const message = options.message ?? ''
    if (!message) {
        throw new PingPeerError('bad_args', 'message is required')
    }

    const waitActiveSecs = options.waitActiveSecs ?? DEFAULT_WAIT_ACTIVE_SECS
    if (!Number.isFinite(waitActiveSecs) || waitActiveSecs <= 0 || waitActiveSecs > 300) {
        throw new PingPeerError('bad_args', 'waitActiveSecs must be between 1 and 300')
    }
    const providedRemitId = options.remitId?.trim()
    if (options.remitId !== undefined && !providedRemitId) {
        throw new PingPeerError('bad_args', 'an exact remit UUID is required')
    }
    const remitId = providedRemitId ?? randomUUID()
    if (!EXACT_SESSION_ID_RE.test(remitId)) {
        throw new PingPeerError('bad_args', 'an exact remit UUID is required')
    }

    const apiUrl = resolveApiUrl(options.apiUrl)
    const accessToken = resolveAccessToken(options.accessToken)
    const http = options.http ?? axios
    const sleep = options.sleep ?? defaultSleep
    const now = options.now ?? Date.now
    const onProgress = options.onProgress

    const jwt = await exchangeJwt(apiUrl, accessToken, http)
    const matched = await getSession(apiUrl, jwt, sessionId, http)
    const name = resolvePeerSessionLabel(matched)
    onProgress?.(`resolved ${matched.id}  active=${matched.active}  name="${name}"`)

    let resumed = false
    const ensureActive = async (progressMessage: string): Promise<PingPeerSessionSummary> => {
        const session = await getSession(apiUrl, jwt, matched.id, http)
        if (session.active) {
            return session
        }
        onProgress?.(progressMessage)
        await resumeSession(apiUrl, jwt, matched.id, http)
        resumed = true
        await waitUntilActive(apiUrl, jwt, matched.id, waitActiveSecs, http, sleep, now, onProgress)
        onProgress?.('session active')
        return getSession(apiUrl, jwt, matched.id, http)
    }

    // Re-check before send so a flip to inactive cannot 409 (#1195).
    if (!matched.active) {
        await ensureActive('requesting resume...')
    }

    let live = await ensureActive('session went inactive before send; requesting resume...')
    if (live.metadata?.flavor === 'pi') {
        await waitForPiReady(apiUrl, jwt, matched.id, waitActiveSecs, http, sleep, now, onProgress)
        const beforePiResume = resumed
        live = await ensureActive('session went inactive before send; requesting resume...')
        if (resumed && !beforePiResume && live.metadata?.flavor === 'pi') {
            // Fresh agent after mid-wait resume: wait for piSessionId again (#1143).
            await waitForPiReady(apiUrl, jwt, matched.id, waitActiveSecs, http, sleep, now, onProgress)
            live = await ensureActive('session went inactive before send; requesting resume...')
        }
    }

    onProgress?.(`sending message (${message.length} chars)...`)
    await sendMessage(apiUrl, jwt, matched.id, message, remitId, http)

    return {
        sessionId: matched.id,
        remitId,
        name,
        resumed
    }
}

export function exitCodeForPingPeerError(error: PingPeerError): number {
    switch (error.code) {
        case 'bad_args':
        case 'auth_failed':
        case 'not_found':
        case 'remit_conflict':
            return 2
        case 'resume_failed':
            return 3
        case 'timeout':
        case 'send_failed':
        case 'session_ended':
        case 'lifecycle_failed':
            return 4
        default:
            return 1
    }
}

// ── inspect_peer (read twin; no resume) ─────────────────────────────────────

export type InspectPeerOptions = {
    sessionId: string
    /** Recent message page size (default 30, clamped 1..100). */
    messageLimit?: number
    apiUrl?: string
    accessToken?: string
    http?: AxiosInstance
}

export type InspectPeerMessage = {
    id: string
    role: string
    text: string
    createdAt: number | null
}

export type InspectPeerResult = {
    sessionId: string
    name: string
    active: boolean
    thinking: boolean
    flavor: string | null
    path: string | null
    lifecycleState: string | null
    updatedAt: number | null
    messages: InspectPeerMessage[]
}

const DEFAULT_INSPECT_MESSAGE_LIMIT = 30
const MAX_INSPECT_MESSAGE_LIMIT = 100
const MAX_SNIPPET_CHARS = 1_200

function clampInspectMessageLimit(raw: number | undefined): number {
    const n = raw ?? DEFAULT_INSPECT_MESSAGE_LIMIT
    if (!Number.isFinite(n)) {
        throw new PingPeerError('bad_args', 'messageLimit must be a number')
    }
    return Math.min(MAX_INSPECT_MESSAGE_LIMIT, Math.max(1, Math.floor(n)))
}

function extractUserPlainText(inner: unknown): string | null {
    if (typeof inner === 'string' && inner.trim()) return inner
    if (!isObject(inner)) return null
    if (typeof inner.text === 'string' && inner.text.trim()) return inner.text
    if (isObject(inner.content) && typeof inner.content.text === 'string' && inner.content.text.trim()) {
        return inner.content.text
    }
    return null
}

/** Best-effort text from a hub message row; skip tool-call / empty noise. */
export function extractInspectMessageSnippet(content: unknown): InspectPeerMessage | null {
    if (!isObject(content)) return null
    const role = typeof content.role === 'string' ? content.role : 'unknown'
    const inner = content.content
    let text: string | null = null
    if (role === 'user') {
        text = extractUserPlainText(inner)
    } else {
        text = extractAssistantPlainText(inner)
        if (!text) text = extractUserPlainText(inner)
    }
    if (!text) return null
    const trimmed = text.replace(/\s+/g, ' ').trim()
    if (!trimmed) return null
    const snippet = trimmed.length > MAX_SNIPPET_CHARS
        ? `${trimmed.slice(0, MAX_SNIPPET_CHARS)}…`
        : trimmed
    return {
        id: typeof content.id === 'string' ? content.id : '',
        role,
        text: snippet,
        createdAt: null
    }
}

async function fetchSessionMessages(
    apiUrl: string,
    jwt: string,
    sessionId: string,
    limit: number,
    http: AxiosInstance
): Promise<InspectPeerMessage[]> {
    const response = await http.get(
        `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
            headers: authHeaders(jwt),
            params: { limit },
            timeout: 20_000,
            validateStatus: () => true
        }
    )
    if (response.status < 200 || response.status >= 300) {
        const detail = typeof response.data?.error === 'string'
            ? response.data.error
            : `HTTP ${response.status}`
        throw new PingPeerError('not_found', `failed to load messages for ${sessionId} (${detail})`)
    }
    const rows = Array.isArray(response.data?.messages) ? response.data.messages : []
    const out: InspectPeerMessage[] = []
    for (const row of rows) {
        if (!isObject(row)) continue
        const snippet = extractInspectMessageSnippet(row.content)
        if (!snippet) continue
        out.push({
            ...snippet,
            id: typeof row.id === 'string' ? row.id : snippet.id,
            createdAt: typeof row.createdAt === 'number' ? row.createdAt : null
        })
    }
    return out
}

/**
 * Resolve a peer by exact id and return metadata + recent text messages.
 * Read-only: never resumes inactive sessions (unlike `pingPeer`).
 */
export async function inspectPeer(options: InspectPeerOptions): Promise<InspectPeerResult> {
    const sessionId = requireExactSessionId(options.sessionId)
    const messageLimit = clampInspectMessageLimit(options.messageLimit)

    const apiUrl = resolveApiUrl(options.apiUrl)
    const accessToken = resolveAccessToken(options.accessToken)
    const http = options.http ?? axios

    const jwt = await exchangeJwt(apiUrl, accessToken, http)
    const live = await getSession(apiUrl, jwt, sessionId, http)
    const meta = live.metadata ?? null
    const messages = await fetchSessionMessages(apiUrl, jwt, sessionId, messageLimit, http)

    return {
        sessionId,
        name: resolvePeerSessionLabel(live),
        active: live.active,
        thinking: Boolean(live.thinking),
        flavor: typeof meta?.flavor === 'string' ? meta.flavor : null,
        path: typeof meta?.path === 'string' ? meta.path : null,
        lifecycleState: typeof meta?.lifecycleState === 'string' ? meta.lifecycleState : null,
        updatedAt: typeof live.updatedAt === 'number'
            ? live.updatedAt
            : null,
        messages
    }
}

export type WaitPeerOptions = {
    sessionId: string
    remitId: string
    timeoutSecs?: number
    apiUrl?: string
    accessToken?: string
    http?: AxiosInstance
    sleep?: (ms: number) => Promise<void>
    now?: () => number
}

export type WaitPeerResult = {
    sessionId: string
    remitId: string
    status: 'completed'
    active: boolean
    text: string
    messages: InspectPeerMessage[]
}

function extractResultMessages(rows: unknown[], remitIndex: number): {
    messages: InspectPeerMessage[]
    boundaryReached: boolean
} {
    const result: InspectPeerMessage[] = []
    let boundaryReached = false
    for (const row of rows.slice(remitIndex + 1)) {
        if (!isObject(row)) continue
        if (!isObject(row.content)) continue
        const role = typeof row.content.role === 'string' ? row.content.role : ''
        if (role === 'user') {
            if (typeof row.invokedAt === 'number') {
                boundaryReached = true
                break
            }
            continue
        }
        if (role !== 'agent' && role !== 'assistant') continue
        const text = extractAssistantPlainText(row.content.content)
        if (!text?.trim()) continue
        result.push({
            id: typeof row.id === 'string' ? row.id : '',
            role,
            text: text.trim(),
            createdAt: typeof row.createdAt === 'number' ? row.createdAt : null
        })
    }
    return { messages: result, boundaryReached }
}

async function getMessagesFromRemit(
    apiUrl: string,
    jwt: string,
    sessionId: string,
    remitId: string,
    http: AxiosInstance
): Promise<{ found: boolean; invoked: boolean; rows: unknown[] }> {
    let before: { at: number; seq: number } | null = null
    const newerPages: unknown[][] = []
    while (true) {
        const response: AxiosResponse<unknown> = await http.get(`${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
            headers: authHeaders(jwt),
            params: {
                limit: 200,
                ...(before ? { beforeAt: before.at, beforeSeq: before.seq } : {})
            },
            timeout: 20_000,
            validateStatus: () => true
        })
        if (response.status < 200 || response.status >= 300) {
            throw new PingPeerError('not_found', `failed to load messages for ${sessionId}`)
        }
        const data = isObject(response.data) ? response.data : null
        const rows = Array.isArray(data?.messages) ? data.messages as unknown[] : []
        const remitIndex = rows.findIndex((row) => isObject(row) && row.localId === remitId)
        if (remitIndex >= 0) {
            const remit = rows[remitIndex]
            return {
                found: true,
                invoked: isObject(remit) && typeof remit.invokedAt === 'number',
                rows: [...rows.slice(remitIndex + 1), ...newerPages.reverse().flat()]
            }
        }

        const page = isObject(data?.page) ? data.page : null
        const nextBeforeAt = page?.nextBeforeAt
        const nextBeforeSeq = page?.nextBeforeSeq
        if (page?.hasMore !== true || typeof nextBeforeAt !== 'number' || typeof nextBeforeSeq !== 'number') {
            return { found: false, invoked: false, rows: [] }
        }
        newerPages.push(rows)
        before = { at: nextBeforeAt, seq: nextBeforeSeq }
    }
}

export async function waitPeer(options: WaitPeerOptions): Promise<WaitPeerResult> {
    const sessionId = requireExactSessionId(options.sessionId)
    const remitId = options.remitId.trim()
    if (!EXACT_SESSION_ID_RE.test(remitId)) throw new PingPeerError('bad_args', 'an exact remit UUID is required')
    const timeoutSecs = options.timeoutSecs ?? 600
    if (!Number.isFinite(timeoutSecs) || timeoutSecs <= 0 || timeoutSecs > 86_400) {
        throw new PingPeerError('bad_args', 'timeoutSecs must be between 1 and 86400')
    }

    const apiUrl = resolveApiUrl(options.apiUrl)
    const http = options.http ?? axios
    const jwt = await exchangeJwt(apiUrl, resolveAccessToken(options.accessToken), http)
    const sleep = options.sleep ?? defaultSleep
    const now = options.now ?? Date.now
    const deadline = now() + timeoutSecs * 1000

    while (now() <= deadline) {
        const live = await getSession(apiUrl, jwt, sessionId, http)
        const result = await getMessagesFromRemit(apiUrl, jwt, sessionId, remitId, http)
        if (result.found) {
            const { messages, boundaryReached } = extractResultMessages(result.rows, -1)
            if (result.invoked && messages.length > 0 && (boundaryReached || !live.thinking)) {
                return {
                    sessionId,
                    remitId,
                    status: 'completed',
                    active: live.active,
                    text: messages.map((message) => message.text).join('\n\n'),
                    messages
                }
            }
            if (result.invoked && !live.active) {
                throw new PingPeerError('session_ended', `session ${sessionId} ended before producing a result`)
            }
        } else if (!live.active) {
            throw new PingPeerError('session_ended', `session ${sessionId} ended before accepting remit ${remitId}`)
        }
        if (now() >= deadline) break
        await sleep(1_000)
    }
    throw new PingPeerError('timeout', `timed out waiting for remit ${remitId}`)
}

export async function controlPeer(options: {
    sessionId: string
    action: 'abort' | 'stop' | 'archive' | 'delete'
    apiUrl?: string
    accessToken?: string
    http?: AxiosInstance
}): Promise<{ sessionId: string; action: 'abort' | 'stop' | 'archive' | 'delete'; alreadyStopped?: boolean; alreadyArchived?: boolean }> {
    const sessionId = requireExactSessionId(options.sessionId)
    const apiUrl = resolveApiUrl(options.apiUrl)
    const http = options.http ?? axios
    const jwt = await exchangeJwt(apiUrl, resolveAccessToken(options.accessToken), http)
    const config = { headers: authHeaders(jwt), timeout: 30_000, validateStatus: () => true }
    const base = `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}`
    const response = options.action === 'delete'
        ? await http.delete(base, config)
        : await http.post(`${base}/${options.action}`, {}, config)
    if (response.status < 200 || response.status >= 300 || response.data?.ok !== true) {
        const detail = typeof response.data?.error === 'string' ? response.data.error : `HTTP ${response.status}`
        throw new PingPeerError('lifecycle_failed', `${options.action} failed: ${detail}`)
    }
    return {
        sessionId,
        action: options.action,
        ...(response.data?.alreadyStopped === true ? { alreadyStopped: true } : {}),
        ...(response.data?.alreadyArchived === true ? { alreadyArchived: true } : {})
    }
}

/** Human/agent-readable report for MCP tool results and CLI stdout. */
export function formatInspectPeerReport(result: InspectPeerResult): string {
    const lines: string[] = [
        `sessionId: ${result.sessionId}`,
        `path: /sessions/${result.sessionId}`,
        `name: ${result.name}`,
        `flavor: ${result.flavor ?? '(unknown)'}`,
        `active: ${result.active}`,
        `thinking: ${result.thinking}`,
        `lifecycle: ${result.lifecycleState ?? '(none)'}`,
        `cwd: ${result.path ?? '(unknown)'}`,
        `updatedAt: ${result.updatedAt ?? '(unknown)'}`,
        `messages (text snippets, newest page): ${result.messages.length}`
    ]
    if (result.messages.length === 0) {
        lines.push('(no extractable user/assistant text in this page)')
    } else {
        for (const message of result.messages) {
            lines.push(`[${message.role}] ${message.text}`)
        }
    }
    return lines.join('\n')
}
