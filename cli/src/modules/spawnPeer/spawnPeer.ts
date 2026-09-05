import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import axios, { type AxiosInstance } from 'axios'
import { SESSION_NAME_MAX_LENGTH } from '@hapi/protocol'
import {
    CREATABLE_AGENT_FLAVORS,
    isPermissionModeAllowedForFlavor,
    type AgentFlavor,
    type PermissionMode
} from '@hapi/protocol/modes'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { buildHubRequestHeaders } from '@/api/hubExtraHeaders'
import { readSettings } from '@/persistence'

export type SpawnPeerErrorCode =
    | 'bad_args'
    | 'auth_failed'
    | 'spawn_failed'
    | 'cleanup_failed'

export class SpawnPeerError extends Error {
    readonly code: SpawnPeerErrorCode
    readonly remitId?: string

    constructor(code: SpawnPeerErrorCode, message: string, remitId?: string) {
        super(message)
        this.name = 'SpawnPeerError'
        this.code = code
        this.remitId = remitId
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
    remitId?: string
    apiUrl?: string
    accessToken?: string
    http?: AxiosInstance
    onProgress?: (message: string) => void
}

export type SpawnPeerResult = {
    sessionId: string
    remitId: string
    machineId: string
    agent: AgentFlavor
    directory: string
    name: string
    session: {
        machineId: string
        directory: string
        agent: AgentFlavor
        model: string | null
        modelReasoningEffort: string | null
        effort: string | null
        permissionMode: PermissionMode | null
    }
}

export type MachineTarget = {
    id: string
    active: boolean
    host: string | null
    displayName: string | null
    homeDir: string | null
    workspaceRoots: string[]
}

const AUTH_RECOVERY_HINT =
    'Set HAPI_API_URL and CLI_API_TOKEN, or run `hapi auth login`.'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function resolveApiUrl(apiUrl?: string): string {
    const value = (apiUrl ?? configuration.apiUrl).trim().replace(/\/+$/, '')
    if (!value) throw new SpawnPeerError('bad_args', `HAPI API URL is empty. ${AUTH_RECOVERY_HINT}`)
    return value
}

function resolveAccessToken(accessToken?: string): string {
    let value = ''
    try {
        value = (accessToken ?? getAuthToken()).trim()
    } catch {
        value = (accessToken ?? '').trim()
    }
    if (!value) throw new SpawnPeerError('bad_args', `CLI_API_TOKEN is required. ${AUTH_RECOVERY_HINT}`)
    return value
}

function headers(jwt?: string): Record<string, string> {
    return buildHubRequestHeaders({
        ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
        'Content-Type': 'application/json'
    })
}

async function exchangeJwt(apiUrl: string, accessToken: string, http: AxiosInstance): Promise<string> {
    try {
        const response = await http.post(`${apiUrl}/api/auth`, { accessToken }, {
            headers: headers(),
            timeout: 10_000,
            validateStatus: () => true
        })
        const token = typeof response.data?.token === 'string' ? response.data.token : ''
        if (response.status < 200 || response.status >= 300 || !token) {
            throw new Error(typeof response.data?.error === 'string' ? response.data.error : `HTTP ${response.status}`)
        }
        return token
    } catch (error) {
        throw new SpawnPeerError(
            'auth_failed',
            `Failed to authenticate with ${apiUrl}: ${error instanceof Error ? error.message : String(error)}`
        )
    }
}

export async function spawnPeer(options: SpawnPeerOptions): Promise<SpawnPeerResult> {
    const rawDirectory = (options.directory ?? '').trim()
    const message = options.message ?? ''
    const name = (options.name ?? '').trim()
    if (!rawDirectory) throw new SpawnPeerError('bad_args', 'directory is required')
    if (!message.trim()) throw new SpawnPeerError('bad_args', 'message is required')
    if (name.length > SESSION_NAME_MAX_LENGTH) {
        throw new SpawnPeerError('bad_args', `name must be at most ${SESSION_NAME_MAX_LENGTH} characters`)
    }

    const agent = options.agent ?? 'claude'
    if (!(CREATABLE_AGENT_FLAVORS as readonly string[]).includes(agent)) {
        throw new SpawnPeerError('bad_args', `unsupported agent: ${agent}`)
    }
    if (options.permissionMode && !isPermissionModeAllowedForFlavor(options.permissionMode, agent)) {
        throw new SpawnPeerError('bad_args', `permission mode ${options.permissionMode} is not supported by ${agent}`)
    }
    const usesModelReasoningEffort = agent === 'codex' || agent === 'opencode'
    const usesEffort = agent === 'claude' || agent === 'grok' || agent === 'pi' || agent === 'agy'
    if (options.effort && !usesModelReasoningEffort && !usesEffort) {
        throw new SpawnPeerError('bad_args', `effort is not supported by ${agent}`)
    }
    const waitActiveSecs = options.waitActiveSecs ?? 60
    if (!Number.isFinite(waitActiveSecs) || waitActiveSecs <= 0 || waitActiveSecs > 300) {
        throw new SpawnPeerError('bad_args', 'waitActiveSecs must be between 1 and 300')
    }

    const settings = await readSettings()
    const localMachineId = (settings.machineId ?? '').trim()
    const machineId = (options.machineId ?? localMachineId).trim()
    if (!machineId) throw new SpawnPeerError('bad_args', 'machineId is required; run `hapi auth login`')
    const directory = options.machineId && machineId !== localMachineId
        ? rawDirectory
        : resolvePath(rawDirectory)
    const providedRemitId = options.remitId?.trim()
    if (options.remitId !== undefined && !providedRemitId) {
        throw new SpawnPeerError('bad_args', 'remitId must be an exact UUID')
    }
    const remitId = providedRemitId ?? randomUUID()
    if (!UUID_RE.test(remitId)) throw new SpawnPeerError('bad_args', 'remitId must be an exact UUID')
    const apiUrl = resolveApiUrl(options.apiUrl)
    const http = options.http ?? axios
    const jwt = await exchangeJwt(apiUrl, resolveAccessToken(options.accessToken), http)

    options.onProgress?.(`spawning ${agent} on ${machineId}`)
    const body = {
        directory,
        message,
        remitId,
        agent,
        ...(name ? { name } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort
            ? usesModelReasoningEffort
                ? { modelReasoningEffort: options.effort }
                : { effort: options.effort }
            : {}),
        ...(options.sessionType ? { sessionType: options.sessionType } : {}),
        ...(options.worktreeName ? { worktreeName: options.worktreeName } : {}),
        ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
        waitActiveSecs
    }
    let response
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            response = await http.post(
                `${apiUrl}/api/machines/${encodeURIComponent(machineId)}/spawn-with-remit`,
                body,
                { headers: headers(jwt), timeout: (waitActiveSecs + 30) * 1000, validateStatus: () => true }
            )
            break
        } catch (error) {
            if (attempt === 1) {
                throw new SpawnPeerError(
                    'spawn_failed',
                    error instanceof Error ? error.message : String(error),
                    remitId
                )
            }
            options.onProgress?.('spawn response lost; retrying the same remit')
        }
    }

    if (!response) throw new SpawnPeerError('spawn_failed', 'Hub did not return a spawn response', remitId)
    const data = response.data as {
        type?: string
        sessionId?: string
        remitId?: string
        name?: string
        message?: string
        error?: string
        cleanedUp?: boolean
        childSessionId?: string
        code?: string
        session?: SpawnPeerResult['session']
    } | undefined
    if (response.status < 200 || response.status >= 300 || data?.type !== 'success' || !data.sessionId || !data.session) {
        const detail = data?.message || data?.error || `HTTP ${response.status}`
        if (data?.childSessionId && data.cleanedUp !== true) {
            throw new SpawnPeerError(
                'cleanup_failed',
                `${detail}; child ${data.childSessionId} may still be running`,
                data.remitId ?? remitId
            )
        }
        throw new SpawnPeerError('spawn_failed', detail)
    }
    if (data.remitId !== remitId) {
        throw new SpawnPeerError('spawn_failed', 'Hub returned a mismatched remit id')
    }

    return {
        sessionId: data.sessionId,
        remitId,
        machineId,
        agent,
        directory: data.session.directory,
        name: data.name || data.sessionId.slice(0, 8),
        session: data.session
    }
}

export async function listMachineTargets(options: {
    machineId?: string
    apiUrl?: string
    accessToken?: string
    http?: AxiosInstance
} = {}): Promise<MachineTarget[]> {
    const apiUrl = resolveApiUrl(options.apiUrl)
    const http = options.http ?? axios
    const jwt = await exchangeJwt(apiUrl, resolveAccessToken(options.accessToken), http)
    const response = await http.get(`${apiUrl}/api/machines`, {
        headers: headers(jwt),
        timeout: 15_000,
        validateStatus: () => true
    })
    if (response.status < 200 || response.status >= 300 || !Array.isArray(response.data?.machines)) {
        throw new SpawnPeerError('spawn_failed', typeof response.data?.error === 'string' ? response.data.error : `HTTP ${response.status}`)
    }
    const rawMachines = response.data.machines as unknown[]
    const machines: MachineTarget[] = rawMachines.flatMap((value): MachineTarget[] => {
        if (!value || typeof value !== 'object') return []
        const machine = value as Record<string, unknown>
        const metadata = machine.metadata && typeof machine.metadata === 'object'
            ? machine.metadata as Record<string, unknown>
            : {}
        if (typeof machine.id !== 'string') return []
        return [{
            id: machine.id,
            active: machine.active === true,
            host: typeof metadata.host === 'string' ? metadata.host : null,
            displayName: typeof metadata.displayName === 'string' ? metadata.displayName : null,
            homeDir: typeof metadata.homeDir === 'string' ? metadata.homeDir : null,
            workspaceRoots: Array.isArray(metadata.workspaceRoots)
                ? metadata.workspaceRoots.filter((path): path is string => typeof path === 'string')
                : []
        }]
    })
    if (!options.machineId) return machines
    const exact = machines.find((machine) => machine.id === options.machineId)
    if (!exact) throw new SpawnPeerError('bad_args', `machine not found: ${options.machineId}`)
    return [exact]
}

export function exitCodeForSpawnPeerError(error: SpawnPeerError): number {
    if (error.code === 'bad_args' || error.code === 'auth_failed') return 2
    if (error.code === 'cleanup_failed') return 5
    return 3
}
