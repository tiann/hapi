/**
 * Resume-if-inactive + wait-active + POST /api/sessions/:id/messages,
 * plus read-only inspectPeer (GET session + messages, never resume)
 * and setPeerPermissionMode (POST /api/sessions/:id/permission-mode).
 *
 * Shared by `hapi ping-peer` / `hapi inspect-peer` / `hapi set-mode` and MCP
 * `ping_peer` / `inspect_peer`. Uses the same hub JWT flow as the web app
 * (`POST /api/auth` with CLI_API_TOKEN), scoped to the token's namespace.
 * Callers must not invent parallel auth or arbitrary hosts.
 */

import { randomUUID } from 'node:crypto'
import axios, { type AxiosInstance } from 'axios'
import {
    extractAssistantPlainText,
    getPermissionModesForFlavor,
    isObject,
    isSteeringSupportedForSession,
    type MessageDeliveryMode,
} from '@hapi/protocol'
import { normalizeSessionIdPrefix } from '@hapi/protocol/sessionCitation'
import { configuration } from '@/configuration'
import { isPeerToolsDisabled } from '@/modules/common/peerTools'
import { getAuthToken } from '@/api/auth'
import { buildHubRequestHeaders } from '@/api/hubExtraHeaders'
import { PeerDeliveryModeSchema, type PeerDeliveryMode } from './deliveryMode'

export type PingPeerErrorCode =
    | 'bad_args'
    | 'disabled'
    | 'auth_failed'
    | 'not_found'
    | 'ambiguous'
    | 'resume_failed'
    | 'timeout'
    | 'send_failed'
    | 'apply_failed'

export class PingPeerError extends Error {
    readonly code: PingPeerErrorCode

    constructor(code: PingPeerErrorCode, message: string) {
        super(message)
        this.name = 'PingPeerError'
        this.code = code
    }
}

/**
 * Defense-in-depth gate for HAPI_DISABLE_PEER_TOOLS: the MCP server and CLI
 * surface refuse earlier, but any other caller (stale --tools bridge, shell
 * `hapi ping-peer` from a wrapped agent) lands here and fails loudly.
 */
function assertPeerToolsEnabled(): void {
    if (isPeerToolsDisabled()) {
        throw new PingPeerError(
            'disabled',
            'peer session tools are disabled on this machine (HAPI_DISABLE_PEER_TOOLS is set)'
        )
    }
}

export type PingPeerSessionSummary = {
    id: string
    active: boolean
    thinking?: boolean
    agentState?: { steeringActive?: boolean; controlledByUser?: boolean } | null
    updatedAt?: number
    metadata?: {
        name?: string
        flavor?: string | null
        path?: string | null
        lifecycleState?: string | null
        piSessionId?: string
        cursorSessionId?: string | null
        cursorSessionProtocol?: 'acp' | 'stream-json' | null
        summary?: { text?: string } | null
        capabilities?: { concurrentClients?: boolean } | null
    } | null
}

export type PingPeerOptions = {
    sessionIdPrefix: string
    message: string
    deliveryMode?: PeerDeliveryMode
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
    name: string
    resumed: boolean
    delivery: 'accepted' | 'steered' | 'invoked'
    /**
     * Known client submit identity for the peer row (`ping-peer-` prefix).
     * The recipient runtime's consumption ACK is the only delivery proof;
     * HTTP success below means hub-accepted, which may race that ACK.
     */
    localId: string
    flavor?: string | null
}

/**
 * localId prefix for peer submissions. The recipient hub exempts these rows
 * from the session-end synthetic sweep, preserving unconsumed peer messages
 * for replay and keeping invocation timestamps tied to consumption ACKs.
 */
export const PEER_MESSAGE_LOCAL_ID_PREFIX = 'ping-peer-'

export function createPeerMessageLocalId(): string {
    return `${PEER_MESSAGE_LOCAL_ID_PREFIX}${randomUUID()}`
}

export type ListPeerSessionsOptions = {
    apiUrl?: string
    accessToken?: string
    http?: AxiosInstance
    limit?: number
    /** Hub sort before limit truncation. Peer discovery defaults to newest updatedAt. */
    order?: 'updatedAt'
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
    '`list_peers` / `ping_peer` / `inspect_peer`, which use the session CLI credentials.'

export function resolveApiUrl(apiUrl?: string): string {
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

export function resolveAccessToken(accessToken?: string): string {
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

export async function exchangeJwt(
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

export function authHeaders(jwt: string): Record<string, string> {
    return buildHubRequestHeaders({
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json'
    })
}

export function resolveSessionByPrefix(
    sessions: PingPeerSessionSummary[],
    prefix: string
): PingPeerSessionSummary {
    const trimmed = prefix.trim()
    if (!trimmed) {
        throw new PingPeerError('bad_args', 'session id prefix is required')
    }

    const exact = sessions.filter((session) => session.id === trimmed)
    if (exact.length === 1) {
        return exact[0]!
    }

    const matches = sessions.filter((session) => session.id.startsWith(trimmed))
    if (matches.length === 0) {
        throw new PingPeerError('not_found', `no session matching prefix '${trimmed}'`)
    }
    if (matches.length > 1) {
        const sample = matches.slice(0, 5).map((session) => session.id.slice(0, 8)).join(', ')
        throw new PingPeerError(
            'ambiguous',
            `prefix '${trimmed}' matches ${matches.length} sessions (${sample}${matches.length > 5 ? ', ...' : ''}); use a longer prefix`
        )
    }
    return matches[0]!
}

async function listSessions(
    apiUrl: string,
    jwt: string,
    http: AxiosInstance,
    options: { limit?: number; order?: 'updatedAt' } = {}
): Promise<PingPeerSessionSummary[]> {
    const params: Record<string, string | number> = {}
    if (options.limit !== undefined) {
        params.limit = options.limit
    }
    if (options.order !== undefined) {
        params.order = options.order
    }
    const response = await http.get(
        `${apiUrl}/api/sessions`,
        {
            headers: authHeaders(jwt),
            // Omit params when unbounded so ping/inspect keep full-namespace resolution.
            ...(Object.keys(params).length > 0 ? { params } : {}),
            timeout: 15_000,
            validateStatus: () => true
        }
    )
    if (response.status < 200 || response.status >= 300) {
        const detail = typeof response.data?.error === 'string'
            ? response.data.error
            : `HTTP ${response.status}`
        throw new PingPeerError(
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
        throw new PingPeerError('auth_failed', 'failed to list sessions (unexpected response)')
    }
    return sessions as PingPeerSessionSummary[]
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

function unconfirmedSendError(localId: string, detail: string): PingPeerError {
    return new PingPeerError(
        'send_failed',
        `Send not confirmed (localId=${localId}): ${detail}. ` +
        'The message may have been accepted; inspect the target before retrying. Do not resend automatically.'
    )
}

async function sendMessage(
    apiUrl: string,
    jwt: string,
    sessionId: string,
    message: string,
    localId: string,
    http: AxiosInstance,
    deliveryMode: MessageDeliveryMode
): Promise<PingPeerResult['delivery']> {
    // The existing queued-message steer action accepts localId as well as id.
    // Both modes retain the peer identity so only runtime ACKs prove delivery.
    const response = await http.post(
        `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`,
        { text: message, localId },
        {
            headers: authHeaders(jwt),
            timeout: 30_000,
            validateStatus: () => true
        }
    ).catch((error: unknown) => {
        if (deliveryMode !== 'steer') throw error
        const detail = error instanceof Error ? error.message : String(error)
        throw unconfirmedSendError(localId, detail)
    })
    if (response.status >= 200 && response.status < 300 && response.data?.ok === true) {
        // HTTP success means hub-accepted, not proof the row is still queued:
        // the recipient runtime's consumption ACK may race this response.
        if (deliveryMode === 'queue') return 'accepted'
        try {
            const steer = await http.post(
                `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(localId)}/steer`,
                {},
                { headers: authHeaders(jwt), timeout: 30_000, validateStatus: () => true }
            )
            if (steer.status >= 200 && steer.status < 300) {
                if (steer.data?.status === 'steered') return 'steered'
                // The target consumed the message before the steer request.
                // Do not claim it was inserted into the active turn.
                if (steer.data?.status === 'invoked') return 'invoked'
            }
            throw new Error(typeof steer.data?.error === 'string' ? steer.data.error : `HTTP ${steer.status}`)
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            throw new PingPeerError(
                'send_failed',
                `Message accepted (localId=${localId}), but steer was not confirmed: ${detail}. ` +
                'It may remain queued or already be consumed; inspect the target before retrying. Do not resend automatically.'
            )
        }
    }
    const detail = typeof response.data?.error === 'string'
        ? response.data.error
        : typeof response.data?.code === 'string'
            ? response.data.code
            : `HTTP ${response.status}`
    if (deliveryMode === 'steer') {
        throw unconfirmedSendError(localId, detail)
    }
    throw new PingPeerError('send_failed', `send failed: ${detail}`)
}

export async function listPeerSessions(
    options: ListPeerSessionsOptions = {}
): Promise<PingPeerSessionSummary[]> {
    assertPeerToolsEnabled()
    const apiUrl = resolveApiUrl(options.apiUrl)
    const accessToken = resolveAccessToken(options.accessToken)
    const http = options.http ?? axios
    const jwt = await exchangeJwt(apiUrl, accessToken, http)
    return listSessions(apiUrl, jwt, http, {
        limit: options.limit ?? 200,
        order: options.order ?? 'updatedAt'
    })
}

export type FormatPeerSessionsListOptions = {
    /** Max rows to print (default 30). */
    maxRows?: number
    /** Omit this session id (the caller) from the shortlist. */
    excludeSessionId?: string
    /**
     * When the fetch was intentionally bounded, signal overflow without claiming
     * an exact omitted count from the sample.
     */
    hasMore?: boolean
}

const MAX_PEER_LABEL_CHARS = 255

/**
 * Hub fetch size for peer discovery: enough rows for the requested page, plus
 * padding for caller exclusion and an overflow probe. Caps at hub max (500).
 */
export function peerListFetchLimit(requestedLimit: number, options?: { excludeCaller?: boolean }): number {
    const limit = Math.max(1, Math.floor(requestedLimit))
    const pad = options?.excludeCaller ? 2 : 1
    return Math.min(500, limit + pad)
}

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

/**
 * Human/agent-readable shortlist for MCP `list_peers` and `hapi ping-peer --list`.
 * Newest `updatedAt` first. Same hub/namespace as the caller credentials.
 */
export function formatPeerSessionsList(
    sessions: PingPeerSessionSummary[],
    options: FormatPeerSessionsListOptions = {}
): string {
    const maxRows = options.maxRows ?? 30
    const excludeId = options.excludeSessionId?.trim() ?? ''
    const filtered = excludeId
        ? sessions.filter((session) => session.id !== excludeId)
        : sessions
    if (filtered.length === 0) {
        return 'No peer sessions found on this hub/namespace.'
    }
    const sorted = [...filtered].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    const rows = sorted.slice(0, Math.max(1, maxRows)).map((session) => {
        const flavor = session.metadata?.flavor ?? '?'
        const name = resolvePeerSessionLabel(session)
        return `  ${session.id}  active=${session.active}  flavor=${flavor}  ${name}`
    })
    const omitted = sorted.length - rows.length
    if (options.hasMore) {
        rows.push('  … more sessions available (narrow with inspect_peer / ping_peer by id)')
    } else if (omitted > 0) {
        rows.push(`  … ${omitted} more (narrow with inspect_peer / ping_peer by id)`)
    }
    return rows.join('\n')
}

function getSteeringUnavailableReason(session: PingPeerSessionSummary): string | null {
    if (!session.active) {
        return 'Steering requires an active turn; target is inactive, no message sent. Use queue to resume it'
    }
    if (!isSteeringSupportedForSession(session.metadata)) {
        return 'Steering is only supported for Pi, Codex, and Cursor ACP sessions; no message sent'
    }
    if (session.agentState?.controlledByUser && !session.metadata?.capabilities?.concurrentClients) {
        return 'Steering is only available for remote sessions; no message sent'
    }
    const steeringActive = session.metadata?.flavor === 'pi'
        ? session.thinking
        : session.agentState?.steeringActive === true
    if (!steeringActive) {
        return 'Steering requires an active turn; target is idle, no message sent. Use queue to start a turn'
    }
    return null
}

export async function pingPeer(options: PingPeerOptions): Promise<PingPeerResult> {
    assertPeerToolsEnabled()
    const prefix = normalizeSessionIdPrefix(options.sessionIdPrefix ?? '')
    const message = options.message ?? ''
    if (!prefix) {
        throw new PingPeerError('bad_args', 'session id prefix is required')
    }
    if (!message) {
        throw new PingPeerError('bad_args', 'message is required')
    }
    const parsedDeliveryMode = PeerDeliveryModeSchema.safeParse(options.deliveryMode ?? 'auto')
    if (!parsedDeliveryMode.success) {
        throw new PingPeerError('bad_args', 'deliveryMode must be auto, queue or steer')
    }
    const requestedDeliveryMode = parsedDeliveryMode.data

    const waitActiveSecs = options.waitActiveSecs ?? DEFAULT_WAIT_ACTIVE_SECS
    if (!Number.isFinite(waitActiveSecs) || waitActiveSecs <= 0) {
        throw new PingPeerError('bad_args', 'waitActiveSecs must be a positive number')
    }

    const apiUrl = resolveApiUrl(options.apiUrl)
    const accessToken = resolveAccessToken(options.accessToken)
    const http = options.http ?? axios
    const sleep = options.sleep ?? defaultSleep
    const now = options.now ?? Date.now
    const onProgress = options.onProgress

    const jwt = await exchangeJwt(apiUrl, accessToken, http)
    const sessions = await listSessions(apiUrl, jwt, http)
    const matched = resolveSessionByPrefix(sessions, prefix)
    const name = resolvePeerSessionLabel(matched)
    onProgress?.(`resolved ${matched.id}  active=${matched.active}  name="${name}"`)

    let resumed = false
    const ensureActive = async (progressMessage: string): Promise<PingPeerSessionSummary> => {
        const session = await getSession(apiUrl, jwt, matched.id, http)
        if (session.active) {
            return session
        }
        if (requestedDeliveryMode === 'steer') {
            throw new PingPeerError('bad_args', 'Steering requires an active turn; target is inactive, no message sent. Use queue to resume it')
        }
        onProgress?.(progressMessage)
        await resumeSession(apiUrl, jwt, matched.id, http)
        resumed = true
        await waitUntilActive(apiUrl, jwt, matched.id, waitActiveSecs, http, sleep, now, onProgress)
        onProgress?.('session active')
        return getSession(apiUrl, jwt, matched.id, http)
    }

    // Prefer the list snapshot for the first resume decision, then re-check before
    // send so a flip to inactive between list and POST cannot 409 (#1195).
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

    // Use the live snapshot, not the discovery list. Auto initially steers only
    // Codex targets; other flavors retain queue unless steer is explicit.
    const steeringError = getSteeringUnavailableReason(live)
    const deliveryMode: MessageDeliveryMode = requestedDeliveryMode === 'auto'
        ? (live.metadata?.flavor === 'codex' && steeringError === null ? 'steer' : 'queue')
        : requestedDeliveryMode
    if (deliveryMode === 'steer' && steeringError !== null) {
        throw new PingPeerError('bad_args', steeringError)
    }

    onProgress?.(`sending message (${message.length} chars, ${deliveryMode}${requestedDeliveryMode === 'auto' ? ' via auto' : ''})...`)
    const localId = createPeerMessageLocalId()
    const delivery = await sendMessage(apiUrl, jwt, matched.id, message, localId, http, deliveryMode)

    return {
        sessionId: matched.id,
        name,
        resumed,
        localId,
        delivery,
        flavor: live.metadata?.flavor ?? null
    }
}

export function exitCodeForPingPeerError(error: PingPeerError): number {
    switch (error.code) {
        case 'bad_args':
        case 'disabled':
        case 'auth_failed':
        case 'not_found':
        case 'ambiguous':
            return 2
        case 'resume_failed':
            return 3
        case 'timeout':
        case 'send_failed':
        case 'apply_failed':
            return 4
        default:
            return 1
    }
}

// ── inspect_peer (read twin; no resume) ─────────────────────────────────────

export type InspectPeerOptions = {
    sessionIdPrefix: string
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
    localId?: string
    seq?: number
    invokedAt?: number | null
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
export function extractInspectMessageSnippet(content: unknown, full = false): InspectPeerMessage | null {
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
    if (!text?.trim()) return null
    const trimmed = full ? text.trim() : text.replace(/\s+/g, ' ').trim()
    const snippet = !full && trimmed.length > MAX_SNIPPET_CHARS
        ? `${trimmed.slice(0, MAX_SNIPPET_CHARS)}…`
        : trimmed
    return {
        id: typeof content.id === 'string' ? content.id : '',
        role,
        text: snippet,
        createdAt: null
    }
}

/** Launchers post `{ type: 'event', data: { type: 'ready' } }` when a turn ends and their queue is empty. */
function isReadyEvent(content: unknown): boolean {
    return isObject(content) && isObject(content.content) && content.content.type === 'event'
        && isObject(content.content.data) && content.content.data.type === 'ready'
}

async function fetchSessionMessages(
    apiUrl: string,
    jwt: string,
    sessionId: string,
    limit: number,
    http: AxiosInstance,
    watch = false,
    after?: { at: number; seq: number }
): Promise<{ messages: InspectPeerMessage[]; next: { at: number; seq: number } | null }> {
    const response = await http.get(
        `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
            headers: authHeaders(jwt),
            params: after ? { limit, afterAt: after.at, afterSeq: after.seq } : { limit },
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
        // A future scheduled message is not part of the turn being watched.
        if (watch && row.invokedAt == null && typeof row.scheduledAt === 'number') continue
        const isUser = isObject(row.content) && row.content.role === 'user'
        const snippet = watch && isReadyEvent(row.content)
            ? { id: '', role: 'ready', text: '', createdAt: null }
            // A text-less user row still bounds the watched turn.
            : extractInspectMessageSnippet(row.content, watch) ?? (watch && isUser ? { id: '', role: 'user', text: '', createdAt: null } : null)
        if (!snippet) continue
        out.push({
            ...snippet,
            id: typeof row.id === 'string' ? row.id : snippet.id,
            createdAt: typeof row.createdAt === 'number' ? row.createdAt : null,
            ...(watch ? {
                seq: typeof row.seq === 'number' ? row.seq : undefined,
                invokedAt: typeof row.invokedAt === 'number' ? row.invokedAt : null
            } : {}),
            ...(typeof row.localId === 'string' ? { localId: row.localId } : {})
        })
    }
    const page = response.data?.page
    const next = after && page?.hasMore === true && typeof page.nextAfterAt === 'number' && typeof page.nextAfterSeq === 'number'
        ? { at: page.nextAfterAt, seq: page.nextAfterSeq }
        : null
    return { messages: out, next }
}

/**
 * Resolve a peer by id/prefix and return metadata + recent text messages.
 * Read-only: never resumes inactive sessions (unlike `pingPeer`).
 */
export async function inspectPeer(options: InspectPeerOptions): Promise<InspectPeerResult> {
    assertPeerToolsEnabled()
    const prefix = normalizeSessionIdPrefix(options.sessionIdPrefix ?? '')
    if (!prefix) {
        throw new PingPeerError('bad_args', 'session id prefix is required')
    }
    const messageLimit = clampInspectMessageLimit(options.messageLimit)

    const apiUrl = resolveApiUrl(options.apiUrl)
    const accessToken = resolveAccessToken(options.accessToken)
    const http = options.http ?? axios

    const jwt = await exchangeJwt(apiUrl, accessToken, http)
    const sessions = await listSessions(apiUrl, jwt, http)
    const matched = resolveSessionByPrefix(sessions, prefix)
    const live = await getSession(apiUrl, jwt, matched.id, http)
    const meta = live.metadata ?? matched.metadata ?? null
    const { messages } = await fetchSessionMessages(apiUrl, jwt, matched.id, messageLimit, http)

    return {
        sessionId: matched.id,
        name: resolvePeerSessionLabel({ ...matched, metadata: meta ?? matched.metadata ?? null }),
        active: live.active,
        thinking: Boolean(live.thinking),
        flavor: typeof meta?.flavor === 'string' ? meta.flavor : null,
        path: typeof meta?.path === 'string' ? meta.path : null,
        lifecycleState: typeof meta?.lifecycleState === 'string' ? meta.lifecycleState : null,
        updatedAt: typeof live.updatedAt === 'number'
            ? live.updatedAt
            : typeof matched.updatedAt === 'number'
                ? matched.updatedAt
                : null,
        messages
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

// ── set-mode (permission mode of an existing session) ──────────────────────

export type SetPeerPermissionModeOptions = {
    sessionIdPrefix: string
    mode: string
    apiUrl?: string
    accessToken?: string
    http?: AxiosInstance
}

export type SetPeerPermissionModeResult = {
    sessionId: string
    name: string
    flavor: string
    mode: string
    active: boolean
}

/**
 * Same route the web permission picker uses. Active sessions apply it live;
 * inactive ones keep it for the next resume (hub SyncEngine.applySessionConfig).
 */
export async function setPeerPermissionMode(options: SetPeerPermissionModeOptions): Promise<SetPeerPermissionModeResult> {
    const prefix = normalizeSessionIdPrefix(options.sessionIdPrefix ?? '')
    const mode = (options.mode ?? '').trim()
    if (!prefix) {
        throw new PingPeerError('bad_args', 'session id prefix is required')
    }
    if (!mode) {
        throw new PingPeerError('bad_args', 'mode is required')
    }

    const apiUrl = resolveApiUrl(options.apiUrl)
    const accessToken = resolveAccessToken(options.accessToken)
    const http = options.http ?? axios

    const jwt = await exchangeJwt(apiUrl, accessToken, http)
    const sessions = await listSessions(apiUrl, jwt, http)
    const matched = resolveSessionByPrefix(sessions, prefix)
    const live = await getSession(apiUrl, jwt, matched.id, http)
    // Hub treats a missing flavor as claude; mirror it so the allowed list matches.
    const flavor = live.metadata?.flavor ?? matched.metadata?.flavor ?? 'claude'
    const allowed: readonly string[] = getPermissionModesForFlavor(flavor)
    if (allowed.length === 0) {
        throw new PingPeerError('bad_args', `${flavor} sessions do not support permission modes`)
    }
    if (!allowed.includes(mode)) {
        throw new PingPeerError(
            'bad_args',
            `invalid mode '${mode}' for ${flavor}; allowed: ${allowed.join(', ')}`
        )
    }

    const response = await http.post(
        `${apiUrl}/api/sessions/${encodeURIComponent(matched.id)}/permission-mode`,
        { mode },
        {
            headers: authHeaders(jwt),
            timeout: 30_000,
            validateStatus: () => true
        }
    )
    if (response.status < 200 || response.status >= 300 || response.data?.ok !== true) {
        const detail = typeof response.data?.error === 'string'
            ? response.data.error
            : `HTTP ${response.status}`
        throw new PingPeerError('apply_failed', `set-mode failed: ${detail}`)
    }

    return {
        sessionId: matched.id,
        name: resolvePeerSessionLabel({ ...matched, metadata: live.metadata ?? matched.metadata ?? null }),
        flavor,
        mode,
        active: live.active
    }
}

// ── spawn_peer + reply forwarding ───────────────────────────────────────────

const REPLY_POLL_MS = 10_000
const REPLY_TIMEOUT_MS = 6 * 60 * 60 * 1000
// ponytail: fallback for a dropped `ready` event (sent droppable while the peer's socket is down).
const IDLE_FALLBACK_POLLS = 60
const SEND_ATTEMPTS = 3

/** Flavors whose remote launchers post a `ready` event at turn end; Pi does not. */
const PEER_REPLY_FLAVORS = new Set(['claude', 'codex', 'cursor', 'opencode', 'copilot', 'kimi', 'grok', 'dsh', 'agy'])

export function supportsPeerReply(flavor: string | null | undefined): boolean {
    return PEER_REPLY_FLAVORS.has(flavor ?? 'claude')
}

export type SpawnPeerOptions = {
    machineId: string
    directory: string
    agent?: string
    message: string
    apiUrl?: string
    accessToken?: string
    http?: AxiosInstance
}

async function fetchTaskState(
    apiUrl: string,
    jwt: string,
    sessionId: string,
    localId: string,
    http: AxiosInstance
): Promise<{ state: 'invoked'; invokedAt: number } | { state: 'queued' | 'gone' }> {
    const response = await http.post(
        `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages/queued-state`,
        { localIds: [localId] },
        { headers: authHeaders(jwt), timeout: 20_000, validateStatus: () => true }
    )
    if (response.status < 200 || response.status >= 300) {
        throw new PingPeerError('not_found', `failed to load task state for ${sessionId} (HTTP ${response.status})`)
    }
    const list = (key: string): unknown[] => Array.isArray(response.data?.[key]) ? response.data[key] : []
    const invoked = list('invokedLocalMessages').find((entry: any) => entry?.localId === localId) as { invokedAt?: unknown } | undefined
    if (typeof invoked?.invokedAt === 'number') return { state: 'invoked', invokedAt: invoked.invokedAt }
    return [...list('queuedLocalIds'), ...list('indeterminateLocalIds')].includes(localId) ? { state: 'queued' } : { state: 'gone' }
}

const ROWS_PAGE = 200

/** An after-cursor that includes every row positioned at `at` (the hub requires afterSeq >= 1). */
function cursorBefore(at: number): { at: number; seq: number } {
    return { at: at - 1, seq: Number.MAX_SAFE_INTEGER }
}

async function fetchRowsAfter(
    apiUrl: string,
    jwt: string,
    sessionId: string,
    after: { at: number; seq: number },
    http: AxiosInstance
): Promise<InspectPeerMessage[]> {
    const rows: InspectPeerMessage[] = []
    for (let cursor: typeof after | null = after; cursor;) {
        const page = await fetchSessionMessages(apiUrl, jwt, sessionId, ROWS_PAGE, http, true, cursor)
        rows.push(...page.messages)
        cursor = page.next
    }
    return rows
}

/** Start a fresh session on the caller's machine, then deliver its first message via `pingPeer`. */
export async function spawnPeer(options: SpawnPeerOptions): Promise<PingPeerResult> {
    assertPeerToolsEnabled()
    if (!supportsPeerReply(options.agent)) {
        throw new PingPeerError('bad_args', `${options.agent} sessions do not report turn ends, so their replies cannot be forwarded`)
    }
    const apiUrl = resolveApiUrl(options.apiUrl)
    const accessToken = resolveAccessToken(options.accessToken)
    const http = options.http ?? axios
    const jwt = await exchangeJwt(apiUrl, accessToken, http)
    const response = await http.post(
        `${apiUrl}/api/machines/${encodeURIComponent(options.machineId)}/spawn`,
        { directory: options.directory, agent: options.agent },
        { headers: authHeaders(jwt), timeout: 120_000, validateStatus: () => true }
    )
    const sessionId = response.data?.type === 'success' ? response.data.sessionId : null
    if (typeof sessionId !== 'string') {
        const detail = response.data?.message ?? response.data?.error ?? `HTTP ${response.status}`
        throw new PingPeerError('send_failed', `spawn failed: ${detail}`)
    }
    return pingPeer({ sessionIdPrefix: sessionId, message: options.message, apiUrl, accessToken, http })
}

export type ForwardPeerReplyOptions = {
    peerSessionId: string
    /** `PingPeerResult.localId` of the task whose reply is awaited. */
    taskLocalId: string
    callerSessionId: string
    apiUrl?: string
    accessToken?: string
    http?: AxiosInstance
    sleep?: (ms: number) => Promise<void>
    now?: () => number
}

/**
 * Wait for the peer to finish its turn, then post its latest reply into the
 * caller session. The caller wakes with the answer instead of polling.
 * ponytail: polls from this CLI process; if it exits first, the reply stays only in the peer session.
 */
export async function forwardPeerReply(options: ForwardPeerReplyOptions): Promise<void> {
    const apiUrl = resolveApiUrl(options.apiUrl)
    const accessToken = resolveAccessToken(options.accessToken)
    const http = options.http ?? axios
    const sleep = options.sleep ?? defaultSleep
    const now = options.now ?? Date.now
    const deadline = now() + REPLY_TIMEOUT_MS
    let name = options.peerSessionId.slice(0, 8)
    let reply: InspectPeerMessage | undefined
    let latest: InspectPeerMessage | undefined
    let laterPrompts = 0
    // Confirm on two polls in a row: a `ready` left by the previous turn can trail the task row.
    let endedPolls = 0
    let idlePolls = 0
    let canceled = false
    let consumed = false
    let anchor: { at: number; seq: number } | undefined
    const finished = () => endedPolls >= 2 || idlePolls >= IDLE_FALLBACK_POLLS
    while (!canceled && !finished() && now() < deadline) {
        await sleep(REPLY_POLL_MS)
        try {
            const jwt = await exchangeJwt(apiUrl, accessToken, http)
            const session = await getSession(apiUrl, jwt, options.peerSessionId, http)
            name = resolvePeerSessionLabel(session)
            // Anchor once on the task row, then page forward from it. Queued rows are always on the latest
            // page; a consumed row sits at its invokedAt.
            if (!anchor) {
                const { messages: latest } = await fetchSessionMessages(apiUrl, jwt, options.peerSessionId, 50, http, true)
                const row = latest.find((m) => m.localId === options.taskLocalId)
                if (row?.createdAt != null) anchor = cursorBefore(row.createdAt)
            }
            let rows = anchor ? await fetchRowsAfter(apiUrl, jwt, options.peerSessionId, anchor, http) : []
            let task = rows.find((m) => m.localId === options.taskLocalId)
            if (!task) {
                const state = await fetchTaskState(apiUrl, jwt, options.peerSessionId, options.taskLocalId, http)
                // The hub deletes canceled rows.
                canceled = state.state === 'gone'
                if (state.state !== 'invoked') throw new PingPeerError('not_found', 'task row not found')
                anchor = cursorBefore(state.invokedAt)
                rows = await fetchRowsAfter(apiUrl, jwt, options.peerSessionId, anchor, http)
                task = rows.find((m) => m.localId === options.taskLocalId)
                if (!task) throw new PingPeerError('not_found', 'task row not found')
            }
            consumed = task.invokedAt != null
            const after = rows.slice(rows.indexOf(task) + 1)
            const last = after.filter((m) => m.role !== 'user').at(-1)
            // Rows are ordered by consumption, so the answer ends at the next prompt the peer took on its own;
            // prompts consumed together with the task share its turn. The hub does not persist whether that
            // prompt steered this turn or started a new one, so the latest reply is reported alongside.
            const isText = (m: InspectPeerMessage) => m.role !== 'user' && m.role !== 'ready'
            const isLaterPrompt = (m: InspectPeerMessage) => m.role === 'user' && m.invokedAt != null && m.invokedAt !== task!.invokedAt
            const next = after.findIndex(isLaterPrompt)
            reply = consumed ? (next === -1 ? after : after.slice(0, next)).filter(isText).at(-1) : undefined
            latest = consumed && next !== -1 ? after.slice(next).filter(isText).at(-1) : undefined
            laterPrompts = after.filter(isLaterPrompt).length
            const ended = consumed && !session.thinking && last?.role === 'ready'
            endedPolls = ended || !session.active ? endedPolls + 1 : 0
            idlePolls = consumed && !session.thinking ? idlePolls + 1 : 0
        } catch {
            endedPolls = 0
            idlePolls = 0
        }
    }
    const link = `[${name}](/sessions/${options.peerSessionId})`
    const text = canceled
        ? `The task sent to peer ${link} was canceled before it ran.`
        : !finished()
        ? `Peer ${link} has not finished after ${REPLY_TIMEOUT_MS / 3_600_000}h; check it with inspect_peer.`
        : latest
            ? `Reply from peer ${link}:\n\n${reply?.text ?? '(nothing before its next message)'}\n\n`
                + `The peer then took ${laterPrompts} more message(s), a steer or a later task, before its turn ended. Its latest reply:\n\n${latest.text}`
        : reply
            ? `Reply from peer ${link}:\n\n${reply.text}`
            : consumed
                ? `Peer ${link} stopped without replying.`
                : `Peer ${link} stopped before it read the task.`
    // One localId across retries so a resend after a lost response is not stored twice.
    const localId = createPeerMessageLocalId()
    for (let attempt = 1; ; attempt++) {
        try {
            const jwt = await exchangeJwt(apiUrl, accessToken, http)
            await sendMessage(apiUrl, jwt, options.callerSessionId, text, localId, http, 'queue')
            return
        } catch (error) {
            if (attempt >= SEND_ATTEMPTS) throw error
            await sleep(REPLY_POLL_MS)
        }
    }
}
