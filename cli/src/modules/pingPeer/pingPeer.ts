/**
 * Opt-in resume (wake) + wait-active + POST /api/sessions/:id/messages,
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
    hasActiveSteeringTurn,
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
    | 'inactive'
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
        machineId?: string | null
        lifecycleState?: string | null
        piSessionId?: string
        cursorSessionId?: string | null
        cursorSessionProtocol?: 'acp' | 'stream-json' | null
        summary?: { text?: string } | null
        capabilities?: { concurrentClients?: boolean } | null
    } | null
}

export type PingPeerOptions = {
    sessionIdPrefix?: string
    /** When set, skip list+prefix resolve and load this session directly. */
    sessionId?: string
    message: string
    deliveryMode?: PeerDeliveryMode
    /**
     * Resume an inactive target before sending. Default false: inactive
     * targets are refused so stale/unrelated peers are not relaunched.
     */
    wake?: boolean
    waitActiveSecs?: number
    /**
     * Fresh spawn: poll until active instead of POST /resume on the first
     * inactive snapshot. Machine spawn can return before the hub row is
     * active; resume would launch a second child (no existingSessionId on
     * the original spawn, so runner dedupe does not coalesce).
     */
    waitForInitialActive?: boolean
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
     * Auto only: why an `accepted` receipt did not steer. Distinguishes a steer
     * that was never attempted from one the hub rejected or that stayed
     * unconfirmed. The accepted message itself is never resent.
     */
    steerNote?: string
    /**
     * Known client submit identity for the peer row (`ping-peer-` prefix).
     * The recipient runtime's consumption ACK is the only delivery proof;
     * HTTP success below means hub-accepted, which may race that ACK.
     */
    localId: string
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
    /** Include inactive sessions (default false: hub filters to active before limit). */
    includeInactive?: boolean
}

/** Peer list row: hub session summary plus the resolved machine label. */
export type PeerSessionListEntry = PingPeerSessionSummary & {
    machineLabel?: string
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
    options: { limit?: number; order?: 'updatedAt'; activeOnly?: boolean } = {}
): Promise<PingPeerSessionSummary[]> {
    const params: Record<string, string | number> = {}
    if (options.limit !== undefined) {
        params.limit = options.limit
    }
    if (options.order !== undefined) {
        params.order = options.order
    }
    if (options.activeOnly) {
        params.active = 'true'
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
    deliveryMode: MessageDeliveryMode,
    autoSteerFallback = false,
    onProgress?: (message: string) => void
): Promise<{ delivery: PingPeerResult['delivery']; steerNote?: string }> {
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
        if (deliveryMode === 'queue') return { delivery: 'accepted' }
        let hubRejection: string | null = null
        try {
            const steer = await http.post(
                `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(localId)}/steer`,
                {},
                { headers: authHeaders(jwt), timeout: 30_000, validateStatus: () => true }
            )
            if (steer.status >= 200 && steer.status < 300) {
                if (steer.data?.status === 'steered') return { delivery: 'steered' }
                // The target consumed the message before the steer request.
                // Do not claim it was inserted into the active turn.
                if (steer.data?.status === 'invoked') return { delivery: 'invoked' }
            }
            const rejection: string = typeof steer.data?.error === 'string' ? steer.data.error : `HTTP ${steer.status}`
            // Only a refusal before any native request is dispatched is definitive:
            // an HTTP 4xx, or a Hub 'failed' reply without a localId. A 'failed' reply
            // that carries a localId means the native steer was requested, and its
            // timeout or "being reconciled" outcome leaves delivery unresolved.
            const refusedBeforeDispatch = (steer.status >= 400 && steer.status < 500)
                || (steer.status >= 200 && steer.status < 300
                    && steer.data?.status === 'failed' && steer.data?.localId == null)
            if (refusedBeforeDispatch) hubRejection = rejection
            throw new Error(rejection)
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            // POST acceptance already owns one row; never resend after a failed or uncertain steer.
            // Auto keeps the queued receipt but reports why the steer did not happen.
            if (autoSteerFallback) {
                const steerNote = hubRejection !== null
                    ? `steer rejected by hub: ${detail}`
                    : `steer not confirmed; delivery unresolved: ${detail}`
                onProgress?.(hubRejection !== null
                    ? `${steerNote}; message stays queued as ${localId}`
                    : `${steerNote}; message accepted as ${localId}`)
                return { delivery: 'accepted', steerNote }
            }
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

/**
 * Best-effort machineId → hostname map from GET /api/machines (online
 * machines only). Labels are decoration; failures leave rows unlabeled.
 */
async function fetchMachineLabels(
    apiUrl: string,
    jwt: string,
    http: AxiosInstance
): Promise<Map<string, string>> {
    const labels = new Map<string, string>()
    try {
        const response = await http.get(`${apiUrl}/api/machines`, {
            headers: authHeaders(jwt),
            timeout: 10_000,
            validateStatus: () => true
        })
        if (response.status < 200 || response.status >= 300) {
            return labels
        }
        const machines = Array.isArray(response.data?.machines) ? response.data.machines : []
        for (const machine of machines) {
            if (!isObject(machine) || typeof machine.id !== 'string') continue
            const metadata = isObject(machine.metadata) ? machine.metadata : null
            const label = typeof metadata?.displayName === 'string' && metadata.displayName.trim()
                ? metadata.displayName.trim()
                : typeof metadata?.host === 'string' && metadata.host.trim()
                    ? metadata.host.trim()
                    : null
            if (label) {
                labels.set(machine.id, label)
            }
        }
    } catch {
        // Unlabeled rows still carry the machine id prefix.
    }
    return labels
}

function resolveMachineLabel(machineId: string | null | undefined, labels: Map<string, string>): string | undefined {
    if (!machineId) return undefined
    return labels.get(machineId) ?? machineId.slice(0, 8)
}

export async function listPeerSessions(
    options: ListPeerSessionsOptions = {}
): Promise<PeerSessionListEntry[]> {
    assertPeerToolsEnabled()
    const apiUrl = resolveApiUrl(options.apiUrl)
    const accessToken = resolveAccessToken(options.accessToken)
    const http = options.http ?? axios
    const jwt = await exchangeJwt(apiUrl, accessToken, http)
    const [sessions, machineLabels] = await Promise.all([
        listSessions(apiUrl, jwt, http, {
            limit: options.limit ?? 200,
            order: options.order ?? 'updatedAt',
            activeOnly: !options.includeInactive
        }),
        fetchMachineLabels(apiUrl, jwt, http)
    ])
    return sessions.map((session) => ({
        ...session,
        machineLabel: resolveMachineLabel(session.metadata?.machineId, machineLabels)
    }))
}

export type FormatPeerSessionsListOptions = {
    /** Max rows to print (default 30). */
    maxRows?: number
    /**
     * Omit this session id (the caller) from the shortlist. When the caller
     * row is present, peers on its machine / cwd are marked for conflict triage.
     */
    excludeSessionId?: string
    /** The list was fetched with inactive sessions included. */
    includeInactive?: boolean
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

const PEER_LIST_FOOTER =
    'Directory, not a recipient list: message only peers tied to your task; ' +
    'inspect_peer an unfamiliar peer before messaging it, and never broadcast.'

/**
 * Human/agent-readable shortlist for MCP `list_peers` and `hapi ping-peer --list`.
 * Newest `updatedAt` first. Same hub/namespace as the caller credentials.
 */
export function formatPeerSessionsList(
    sessions: PeerSessionListEntry[],
    options: FormatPeerSessionsListOptions = {}
): string {
    const maxRows = options.maxRows ?? 30
    const excludeId = options.excludeSessionId?.trim() ?? ''
    const caller = excludeId ? sessions.find((session) => session.id === excludeId) : undefined
    const filtered = excludeId
        ? sessions.filter((session) => session.id !== excludeId)
        : sessions
    if (filtered.length === 0) {
        return options.includeInactive
            ? 'No peer sessions found on this hub/namespace.'
            : 'No active peer sessions found on this hub/namespace.'
    }
    const callerMachineId = caller?.metadata?.machineId ?? null
    const callerPath = caller?.metadata?.path ?? null
    const sorted = [...filtered].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    const rows = sorted.slice(0, Math.max(1, maxRows)).map((session) => {
        const meta = session.metadata
        const flavor = meta?.flavor ?? '?'
        const name = resolvePeerSessionLabel(session)
        const state = session.active ? (session.thinking ? 'busy' : 'idle') : 'inactive'
        const sameMachine = Boolean(callerMachineId) && meta?.machineId === callerMachineId
        const machine = session.machineLabel ?? meta?.machineId?.slice(0, 8) ?? '?'
        const sameCwd = sameMachine && Boolean(callerPath) && meta?.path === callerPath
        const marks = [sameMachine ? 'same-machine' : null, sameCwd ? 'same-cwd' : null].filter(Boolean)
        return `  ${session.id}  ${state}  flavor=${flavor}  machine=${machine}  cwd=${meta?.path ?? '?'}`
            + `${marks.length > 0 ? `  [${marks.join(', ')}]` : ''}  ${name}`
    })
    const omitted = sorted.length - rows.length
    if (options.hasMore) {
        rows.push('  … more sessions available (narrow with inspect_peer / ping_peer by id)')
    } else if (omitted > 0) {
        rows.push(`  … ${omitted} more (narrow with inspect_peer / ping_peer by id)`)
    }
    rows.push(PEER_LIST_FOOTER)
    return rows.join('\n')
}

type SteeringIneligibility = 'inactive' | 'unsupported' | 'local' | 'idle'

function getSteeringIneligibility(session: PingPeerSessionSummary): SteeringIneligibility | null {
    if (!session.active) return 'inactive'
    if (!isSteeringSupportedForSession(session.metadata)) return 'unsupported'
    if (session.agentState?.controlledByUser && !session.metadata?.capabilities?.concurrentClients) return 'local'
    if (!hasActiveSteeringTurn(session)) return 'idle'
    return null
}

// Explicit steer refuses before sending, so these texts say no message was sent.
const EXPLICIT_STEER_REFUSAL: Record<SteeringIneligibility, string> = {
    inactive: 'Steering requires an active turn; target is inactive, no message sent. Use queue with wake to resume it',
    unsupported: 'Steering is only supported for Claude, Pi, Codex, OpenCode, and Cursor ACP sessions; no message sent',
    local: 'Steering is only available for remote sessions; no message sent',
    idle: 'Steering requires an active turn; target is idle, no message sent. Use queue to start a turn'
}

// Auto has already accepted the message, so its notes must not claim otherwise.
const AUTO_NOT_ATTEMPTED: Record<SteeringIneligibility, string> = {
    inactive: 'target is inactive',
    unsupported: 'target does not support steering',
    local: 'target is controlled locally',
    idle: 'target is idle'
}

function getSteeringUnavailableReason(session: PingPeerSessionSummary): string | null {
    const ineligibility = getSteeringIneligibility(session)
    return ineligibility === null ? null : EXPLICIT_STEER_REFUSAL[ineligibility]
}

export async function pingPeer(options: PingPeerOptions): Promise<PingPeerResult> {
    assertPeerToolsEnabled()
    const knownSessionId = (options.sessionId ?? '').trim()
    const prefix = knownSessionId ? '' : normalizeSessionIdPrefix(options.sessionIdPrefix ?? '')
    const message = options.message ?? ''
    if (!knownSessionId && !prefix) {
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
    const matched = knownSessionId
        ? await getSession(apiUrl, jwt, knownSessionId, http)
        : resolveSessionByPrefix(await listSessions(apiUrl, jwt, http), prefix)
    const name = resolvePeerSessionLabel(matched)
    onProgress?.(`resolved ${matched.id}  active=${matched.active}  name="${name}"`)

    let resumed = false
    const ensureActive = async (progressMessage: string): Promise<PingPeerSessionSummary> => {
        const session = await getSession(apiUrl, jwt, matched.id, http)
        if (session.active) {
            return session
        }
        if (requestedDeliveryMode === 'steer') {
            throw new PingPeerError('bad_args', 'Steering requires an active turn; target is inactive, no message sent. Use queue with wake to resume it')
        }
        if (!options.wake) {
            throw new PingPeerError(
                'inactive',
                `target ${matched.id} is inactive; no message sent. `
                + 'Do not wake peers for FYI, status, or done notes. '
                + 'Pass wake=true (CLI: --wake) only when the user asked or the handed-off work requires this peer to act.'
            )
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
        if (options.waitForInitialActive) {
            onProgress?.('waiting for newly spawned session to become active...')
            await waitUntilActive(apiUrl, jwt, matched.id, waitActiveSecs, http, sleep, now, onProgress)
            onProgress?.('session active')
        } else {
            await ensureActive('requesting resume...')
        }
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

    // Share supported-provider turn policy. Explicitly awakened/new peers queue
    // their message rather than opportunistically steering the resumed turn.
    const steeringError = getSteeringUnavailableReason(live)
    const ineligibility = getSteeringIneligibility(live)
    const deliveryMode: MessageDeliveryMode = requestedDeliveryMode === 'auto'
        ? (matched.active && !resumed && steeringError === null ? 'steer' : 'queue')
        : requestedDeliveryMode
    if (deliveryMode === 'steer' && steeringError !== null) {
        throw new PingPeerError('bad_args', steeringError)
    }

    onProgress?.(`sending message (${message.length} chars, ${deliveryMode}${requestedDeliveryMode === 'auto' ? ' via auto' : ''})...`)
    const localId = createPeerMessageLocalId()
    const sent = await sendMessage(apiUrl, jwt, matched.id, message, localId, http, deliveryMode, requestedDeliveryMode === 'auto', onProgress)
    // Auto queued without trying: say why, so a caller can tell it from a steer that failed.
    const steerNote = sent.steerNote ?? (requestedDeliveryMode === 'auto' && deliveryMode === 'queue'
        ? `steer not attempted: ${resumed ? 'target was just resumed' : !matched.active ? 'target was not active' : ineligibility ? AUTO_NOT_ATTEMPTED[ineligibility] : 'steering unavailable'}`
        : undefined)
    if (steerNote && sent.steerNote === undefined) onProgress?.(`${steerNote}; message queued`)

    return {
        sessionId: matched.id,
        name,
        resumed,
        localId,
        delivery: sent.delivery,
        ...(steerNote ? { steerNote } : {})
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
        case 'inactive':
            return 5
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
}

export type InspectPeerResult = {
    sessionId: string
    name: string
    active: boolean
    thinking: boolean
    flavor: string | null
    path: string | null
    /** Hostname (or machine id prefix) the peer runs on. */
    machine: string | null
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
    const [messages, machineLabels] = await Promise.all([
        fetchSessionMessages(apiUrl, jwt, matched.id, messageLimit, http),
        fetchMachineLabels(apiUrl, jwt, http)
    ])

    return {
        sessionId: matched.id,
        name: resolvePeerSessionLabel({ ...matched, metadata: meta ?? matched.metadata ?? null }),
        active: live.active,
        thinking: Boolean(live.thinking),
        flavor: typeof meta?.flavor === 'string' ? meta.flavor : null,
        path: typeof meta?.path === 'string' ? meta.path : null,
        machine: resolveMachineLabel(meta?.machineId, machineLabels) ?? null,
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
        `machine: ${result.machine ?? '(unknown)'}`,
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
