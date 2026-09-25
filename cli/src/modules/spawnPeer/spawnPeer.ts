/**
 * Spawn a new HAPI session with a required first user message (remit).
 *
 * Machine spawn (`POST /api/machines/:id/spawn`) creates an idle composer.
 * A spawn body with `message`/`prompt`/`text` is HTTP 400
 * (`spawn_remit_not_supported`). This module is the fail-closed path:
 * spawn → optional rename → ping-peer delivery → verify at least one
 * user message. HTTP 200 + sessionId with 0 messages is a failed spawn
 * (tiann/hapi#1509).
 *
 * Shared by `hapi spawn-peer` and MCP `spawn_peer`. Same hub JWT /
 * namespace as ping-peer. Callers must not invent parallel auth.
 */

import { resolve as resolvePath } from 'node:path'
import axios, { type AxiosInstance } from 'axios'
import { isObject, SESSION_NAME_MAX_LENGTH } from '@hapi/protocol'
import {
    CREATABLE_AGENT_FLAVORS,
    getLaunchPermissionModesForFlavor,
    type AgentFlavor,
    type PermissionMode
} from '@hapi/protocol/modes'
import {
    resolvePeerSpawnConfig,
    ResolvedPeerSpawnDefaultsSchema,
    type PeerSpawnDefaults,
    type ResolvedPeerSpawnDefaults
} from '@hapi/protocol/peerSpawnDefaults'
import {
    ParentStampError,
    ensureParentStamp,
    type PeerParentIdentity,
} from '@hapi/protocol/peerParentStamp'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { buildHubRequestHeaders } from '@/api/hubExtraHeaders'
import { readSettings } from '@/persistence'
import {
    PingPeerError,
    extractInspectMessageSnippet,
    pingPeer
} from '@/modules/pingPeer/pingPeer'

export type SpawnPeerErrorCode =
    | 'bad_args'
    | 'auth_failed'
    | 'spawn_failed'
    | 'empty_session'
    | 'verify_failed'
    | 'not_found'
    | 'ambiguous'
    | 'resume_failed'
    | 'timeout'
    | 'send_failed'

export class SpawnPeerError extends Error {
    readonly code: SpawnPeerErrorCode

    constructor(code: SpawnPeerErrorCode, message: string) {
        super(message)
        this.name = 'SpawnPeerError'
        this.code = code
    }
}

export type SpawnPeerOptions = {
    directory: string
    message: string
    name?: string
    agent?: AgentFlavor
    model?: string
    effort?: string
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
    permissionMode?: PermissionMode
    machineId?: string
    waitActiveSecs?: number
    apiUrl?: string
    accessToken?: string
    /** Skip hub settings fetch (tests). */
    hubPeerSpawnDefaults?: PeerSpawnDefaults | null
    /**
     * Base directory for relative `directory` paths (MCP session cwd).
     * Absolute directories are unchanged. Defaults to process.cwd().
     */
    cwd?: string
    /**
     * Orchestrator identity for rename-proof Parent stamp (heavygee/hapi#175).
     * When omitted, falls back to `HAPI_SESSION_ID` / `HAPI_SESSION_NAME` /
     * `HAPI_AGENT_SESSION_ID` env (in-session CLI).
     */
    parent?: PeerParentIdentity | null
    /**
     * MCP / in-session: fail closed when parent id is missing.
     * Outside-session CLI leaves this false and warns instead.
     */
    requireParent?: boolean
    http?: AxiosInstance
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    onProgress?: (message: string) => void
}

export type SpawnPeerResult = {
    sessionId: string
    name: string
}

const DEFAULT_WAIT_ACTIVE_SECS = 60
const POLL_VERIFY_MS = 1_000

const AUTH_RECOVERY_HINT =
    'On a remote runner, set HAPI_API_URL to the runner hub, and set CLI_API_TOKEN ' +
    'or run `hapi auth login` to save the token. Inside a HAPI session prefer MCP ' +
    '`spawn_peer`, which uses the session CLI credentials.'

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Resolve parent identity from in-session env when callers omit `parent`. */
export function parentIdentityFromEnv(
    env: NodeJS.ProcessEnv = process.env
): PeerParentIdentity | null {
    const sessionId = (env.HAPI_SESSION_ID ?? '').trim()
    if (!sessionId) {
        return null
    }
    return {
        sessionId,
        name: (env.HAPI_SESSION_NAME ?? '').trim() || null,
        agentSessionId: (env.HAPI_AGENT_SESSION_ID ?? '').trim() || null,
    }
}

function resolveApiUrl(apiUrl?: string): string {
    const raw = (apiUrl ?? configuration.apiUrl).trim().replace(/\/+$/, '')
    if (!raw) {
        throw new SpawnPeerError(
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
        throw new SpawnPeerError(
            'bad_args',
            `CLI_API_TOKEN is required (run \`hapi auth login\`). ${AUTH_RECOVERY_HINT}`
        )
    }
    return token
}

function authHeaders(jwt: string): Record<string, string> {
    return buildHubRequestHeaders({
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json'
    })
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
            throw new SpawnPeerError(
                'auth_failed',
                `failed to exchange access token for JWT (${detail}). Hub URL: ${apiUrl}. ${AUTH_RECOVERY_HINT}`
            )
        }
        return token
    } catch (error) {
        if (error instanceof SpawnPeerError) {
            throw error
        }
        throw new SpawnPeerError(
            'auth_failed',
            `failed to exchange access token for JWT (${error instanceof Error ? error.message : String(error)}). Hub URL: ${apiUrl}. ${AUTH_RECOVERY_HINT}`
        )
    }
}

async function fetchHubPeerSpawnDefaults(
    apiUrl: string,
    jwt: string,
    http: AxiosInstance
): Promise<ResolvedPeerSpawnDefaults> {
    try {
        const response = await http.get(`${apiUrl}/api/hub-settings`, {
            headers: authHeaders(jwt),
            timeout: 10_000,
            validateStatus: () => true
        })
        if (response.status < 200 || response.status >= 300) {
            throw new SpawnPeerError('spawn_failed', 'Cannot load hub spawn defaults')
        }
        return ResolvedPeerSpawnDefaultsSchema.parse(
            (response.data as { peerSpawnDefaults?: unknown } | undefined)?.peerSpawnDefaults
        )
    } catch (error) {
        if (error instanceof SpawnPeerError) {
            throw error
        }
        throw new SpawnPeerError('spawn_failed', 'Cannot load valid hub spawn defaults')
    }
}

function collapsedRemitNeedle(message: string): string {
    return message.replace(/\s+/g, ' ').trim().slice(0, 800)
}

type RemitVerifyResult = 'found' | 'absent' | 'unavailable'

async function verifySessionRemit(
    apiUrl: string,
    jwt: string,
    sessionId: string,
    message: string,
    http: AxiosInstance
): Promise<RemitVerifyResult> {
    const needle = collapsedRemitNeedle(message)
    if (!needle) {
        return 'absent'
    }
    // Paginate oldest-ward: a busy child can push the remit off the latest
    // 50-row page before verification runs. Cap pages so a broken cursor cannot
    // loop forever (50 × 40 = 2000 messages).
    const pageLimit = 50
    const maxPages = 40
    let beforeAt: number | undefined
    let beforeSeq: number | undefined
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
        let response: {
            status: number
            data?: {
                messages?: unknown
                page?: {
                    hasMore?: unknown
                    nextBeforeAt?: unknown
                    nextBeforeSeq?: unknown
                }
            }
        }
        try {
            response = await http.get(
                `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`,
                {
                    headers: authHeaders(jwt),
                    params: {
                        limit: pageLimit,
                        ...(beforeAt !== undefined && beforeSeq !== undefined
                            ? { beforeAt, beforeSeq }
                            : {})
                    },
                    timeout: 20_000,
                    validateStatus: () => true
                }
            )
        } catch {
            return 'unavailable'
        }
        if (response.status < 200 || response.status >= 300) {
            return 'unavailable'
        }
        const rows = Array.isArray(response.data?.messages) ? response.data.messages : []
        for (const row of rows) {
            if (!isObject(row)) continue
            const snippet = extractInspectMessageSnippet(row.content)
            if (snippet?.role === 'user' && snippet.text.includes(needle)) {
                return 'found'
            }
        }
        const page = response.data?.page
        const hasMore = page?.hasMore === true
        const nextBeforeAt = typeof page?.nextBeforeAt === 'number' ? page.nextBeforeAt : null
        const nextBeforeSeq = typeof page?.nextBeforeSeq === 'number' ? page.nextBeforeSeq : null
        if (!hasMore || nextBeforeAt === null || nextBeforeSeq === null) {
            return 'absent'
        }
        beforeAt = nextBeforeAt
        beforeSeq = nextBeforeSeq
    }
    // Page cap hit while hasMore remained true — remit may still exist older.
    // Do not treat as observed-absent (would archive a live child).
    return 'unavailable'
}

export async function spawnPeer(options: SpawnPeerOptions): Promise<SpawnPeerResult> {
    const rawDirectory = (options.directory ?? '').trim()
    const onProgress = options.onProgress
    if (!rawDirectory) {
        throw new SpawnPeerError('bad_args', 'directory is required')
    }
    // Runner RPC resolves relative paths against the long-lived runner cwd
    // (`hapi runner start`), not the calling CLI/MCP process. Anchor here.
    // MCP callers pass cwd=session workingDirectory so "." is the session tree.
    const directory = options.cwd
        ? resolvePath(options.cwd, rawDirectory)
        : resolvePath(rawDirectory)

    const parent = options.parent !== undefined
        ? options.parent
        : parentIdentityFromEnv()
    // Reject blank remits before Parent stamping. Stamping an empty body would
    // produce a non-empty "## Parent" remit and bypass the idle-session guard.
    const rawMessage = options.message ?? ''
    if (!rawMessage.trim()) {
        throw new SpawnPeerError(
            'bad_args',
            'message is required; empty remit would create an idle session'
        )
    }
    let message: string
    try {
        const stamped = ensureParentStamp(rawMessage, parent, {
            requireParent: options.requireParent === true,
        })
        message = stamped.message
        if (stamped.stamped) {
            onProgress?.(
                `stamped Parent chip /sessions/${(parent?.sessionId ?? '').trim()}`
            )
        } else if (!(parent?.sessionId ?? '').trim()) {
            onProgress?.(
                'WARNING: no parent session id - remit unattributed '
                + '(outside-session OK; in-session set HAPI_SESSION_ID or use MCP spawn_peer)'
            )
        }
    } catch (error) {
        if (error instanceof ParentStampError) {
            throw new SpawnPeerError('bad_args', error.message)
        }
        throw error
    }
    const requestedName = (options.name ?? '').trim()
    if (requestedName.length > SESSION_NAME_MAX_LENGTH) {
        throw new SpawnPeerError(
            'bad_args',
            `name must be at most ${SESSION_NAME_MAX_LENGTH} characters (hub rename max)`
        )
    }

    if (options.agent && !(CREATABLE_AGENT_FLAVORS as readonly string[]).includes(options.agent)) {
        throw new SpawnPeerError('bad_args', `unsupported agent: ${options.agent}`)
    }

    const waitActiveSecs = options.waitActiveSecs ?? DEFAULT_WAIT_ACTIVE_SECS
    if (!Number.isFinite(waitActiveSecs) || waitActiveSecs <= 0) {
        throw new SpawnPeerError('bad_args', 'waitActiveSecs must be a positive number')
    }

    const sessionType = options.sessionType ?? 'simple'
    const apiUrl = resolveApiUrl(options.apiUrl)
    const accessToken = resolveAccessToken(options.accessToken)
    const http = options.http ?? axios
    const sleep = options.sleep ?? defaultSleep
    const now = options.now ?? Date.now

    let machineId = (options.machineId ?? '').trim()
    if (!machineId) {
        const settings = await readSettings()
        machineId = (settings.machineId ?? '').trim()
    }
    if (!machineId) {
        throw new SpawnPeerError(
            'bad_args',
            `machineId is required (run \`hapi auth login\` / start the runner). ${AUTH_RECOVERY_HINT}`
        )
    }

    const jwt = await exchangeJwt(apiUrl, accessToken, http)

    const hubDefaults = options.hubPeerSpawnDefaults !== undefined
        ? options.hubPeerSpawnDefaults
        : await fetchHubPeerSpawnDefaults(apiUrl, jwt, http)
    const resolved = resolvePeerSpawnConfig({
        agent: options.agent,
        permissionMode: options.permissionMode,
        model: options.model,
        effort: options.effort
    }, hubDefaults)

    // Validate explicit permission against the resolved agent (hub default when
    // agent is omitted) — not a Claude preview before settings load.
    if (
        options.permissionMode
        && !getLaunchPermissionModesForFlavor(resolved.agent).includes(options.permissionMode)
    ) {
        throw new SpawnPeerError(
            'bad_args',
            `permission mode ${options.permissionMode} is not supported by ${resolved.agent}`
        )
    }

    const spawnBody: Record<string, unknown> = {
        directory,
        sessionType,
        agent: resolved.agent
    }
    // Pi/DSH have empty launch-permission catalogs — omit permissionMode so the
    // machine route does not 400 invalid_permission_mode on inherited default.
    if (getLaunchPermissionModesForFlavor(resolved.agent).length > 0) {
        spawnBody.permissionMode = resolved.permissionMode
    }
    if (options.worktreeName) {
        spawnBody.worktreeName = options.worktreeName
    }
    if (resolved.model) {
        spawnBody.model = resolved.model
    }
    if (resolved.effort) {
        if (resolved.agent === 'codex' || resolved.agent === 'opencode') {
            spawnBody.modelReasoningEffort = resolved.effort
        } else {
            spawnBody.effort = resolved.effort
        }
    }

    onProgress?.(`spawning agent=${resolved.agent} permission=${resolved.permissionMode} type=${sessionType} dir=${directory}`)
    const spawnResponse = await http.post(
        `${apiUrl}/api/machines/${encodeURIComponent(machineId)}/spawn`,
        spawnBody,
        {
            headers: authHeaders(jwt),
            timeout: 60_000,
            validateStatus: () => true
        }
    )
    const spawnData = spawnResponse.data as { type?: string; sessionId?: string; message?: string; error?: string } | undefined
    const sessionId = typeof spawnData?.sessionId === 'string' ? spawnData.sessionId : ''
    if (
        spawnResponse.status < 200
        || spawnResponse.status >= 300
        || spawnData?.type === 'error'
        || !sessionId
    ) {
        const detail = spawnData?.message
            || spawnData?.error
            || (spawnData?.type === 'success' && !sessionId ? 'spawn returned no sessionId' : `HTTP ${spawnResponse.status}`)
        throw new SpawnPeerError('spawn_failed', `spawn failed: ${detail}`)
    }
    onProgress?.(`spawned ${sessionId}`)

    let renamed = false
    if (requestedName) {
        try {
            const renameResponse = await http.patch(
                `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}`,
                { name: requestedName },
                {
                    headers: authHeaders(jwt),
                    timeout: 10_000,
                    validateStatus: () => true
                }
            )
            if (renameResponse.status >= 200 && renameResponse.status < 300 && renameResponse.data?.ok === true) {
                renamed = true
                onProgress?.(`renamed → ${requestedName}`)
            } else {
                onProgress?.('rename failed (continuing to deliver remit)')
            }
        } catch {
            onProgress?.('rename failed (continuing to deliver remit)')
        }
    }

    onProgress?.(`delivering remit (${message.length} chars) via ping-peer path...`)
    let pingResult: { sessionId: string; name: string } | undefined
    let deliveryError: unknown
    try {
        pingResult = await pingPeer({
            sessionId,
            message,
            waitActiveSecs,
            waitForInitialActive: true,
            apiUrl,
            accessToken,
            http,
            sleep,
            now,
            onProgress
        })
    } catch (error) {
        deliveryError = error
    }

    const deadline = now() + waitActiveSecs * 1000
    // Failure path never auto-archives (remit POST may still land). Poll only
    // to recover a late-visible remit; unread GETs must not look like success.
    // Classify from the *final* verify result: an earlier empty read must not
    // stick as empty_session once later transcript GETs become unavailable.
    let lastVerify: Exclude<RemitVerifyResult, 'found'> | null = null
    while (now() <= deadline) {
        const verify = await verifySessionRemit(apiUrl, jwt, sessionId, message, http)
        if (verify === 'found') {
            return {
                sessionId,
                name: renamed
                    ? requestedName
                    : pingResult?.name || sessionId.slice(0, 8)
            }
        }
        lastVerify = verify
        if (now() >= deadline) {
            break
        }
        await sleep(POLL_VERIFY_MS)
    }

    if (lastVerify !== 'absent') {
        throw new SpawnPeerError(
            'verify_failed',
            `could not verify remit for ${sessionId} (transcript unread); `
            + `left child running - inspect or archive ${sessionId} before retrying spawn-peer`
        )
    }

    // Never auto-archive on the failure path. A timed-out remit POST (or a
    // TOCTOU gap between an empty read and archive) can still land work on
    // the child; killing it would destroy an in-flight peer. Leave the id
    // for the caller to inspect / archive.
    const leaveRunning =
        `left child running - inspect or archive ${sessionId} before retrying spawn-peer`
    if (deliveryError) {
        if (deliveryError instanceof SpawnPeerError) {
            throw new SpawnPeerError(deliveryError.code, `${deliveryError.message}; ${leaveRunning}`)
        }
        if (deliveryError instanceof PingPeerError) {
            throw new SpawnPeerError(deliveryError.code, `${deliveryError.message}; ${leaveRunning}`)
        }
        throw new SpawnPeerError(
            'send_failed',
            `${deliveryError instanceof Error ? deliveryError.message : String(deliveryError)}; ${leaveRunning}`
        )
    }
    throw new SpawnPeerError(
        'empty_session',
        `session ${sessionId} still has no user message after remit delivery (empty shell); ${leaveRunning}`
    )
}

export function exitCodeForSpawnPeerError(error: SpawnPeerError): number {
    switch (error.code) {
        case 'bad_args':
        case 'auth_failed':
        case 'not_found':
        case 'ambiguous':
            return 2
        case 'spawn_failed':
        case 'resume_failed':
            return 3
        case 'timeout':
        case 'send_failed':
        case 'empty_session':
        case 'verify_failed':
            return 4
        default:
            return 1
    }
}
