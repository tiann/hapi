import { PROVIDER_READINESS_ISSUE_CODES, type ProviderReadinessIssueCode } from '@hapi/protocol'
import type { CodexCollaborationMode, CodexServiceTier, PermissionMode } from '@hapi/protocol/types'
import { randomUUID } from 'node:crypto'
import type { Server } from 'socket.io'
import type { RpcRegistry } from '../socket/rpcRegistry'

export type RpcCommandResponse = {
    success: boolean
    stdout?: string
    stderr?: string
    exitCode?: number
    error?: string
}

export type RpcReadFileResponse = {
    success: boolean
    content?: string
    error?: string
}

export type RpcUploadFileResponse = {
    success: boolean
    path?: string
    error?: string
}

export type RpcDeleteUploadResponse = {
    success: boolean
    error?: string
}

export type RpcDirectoryEntry = {
    name: string
    type: 'file' | 'directory' | 'other'
    size?: number
    modified?: number
}

export type RpcListDirectoryResponse = {
    success: boolean
    entries?: RpcDirectoryEntry[]
    error?: string
}

export type RpcPathExistsResponse = {
    exists: Record<string, boolean>
}

export type RpcSpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'pending'; spawnRequestId: string }
    | {
        type: 'error'
        message: string
        code?: ProviderReadinessIssueCode
        recoveryCommand?: string
    }

export type RpcQuerySpawnSessionResult = RpcSpawnSessionResult | {
    type: 'not_found'
    spawnRequestId: string
} | {
    type: 'conflict'
    spawnRequestId: string
    message: string
}

export type RpcSpawnSessionLookupOptions = {
    directory: string
    agent?: 'claude' | 'claude-deepseek' | 'claude-ark' | 'cc-api' | 'codex' | 'cursor' | 'agy' | 'grok' | 'opencode' | 'hermes-moa'
    model?: string
    modelReasoningEffort?: string
    yolo?: boolean
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
    resumeSessionId?: string
    effort?: string
    permissionMode?: PermissionMode
    serviceTier?: CodexServiceTier
}

export type PermissionApproveDecision = 'approved' | 'approved_for_session'
export type PermissionDenyDecision = 'denied' | 'abort'

function assertApprovePermissionDecision(decision: unknown): asserts decision is PermissionApproveDecision | undefined {
    if (decision !== undefined && decision !== 'approved' && decision !== 'approved_for_session') {
        throw new Error(`Contradictory approve permission decision: ${String(decision)}`)
    }
}

function assertDenyPermissionDecision(decision: unknown): asserts decision is PermissionDenyDecision | undefined {
    if (decision !== undefined && decision !== 'denied' && decision !== 'abort') {
        throw new Error(`Contradictory deny permission decision: ${String(decision)}`)
    }
}

function parseSpawnSessionResult(result: unknown, spawnRequestId: string): RpcSpawnSessionResult {
    if (result && typeof result === 'object') {
        const obj = result as Record<string, unknown>
        if (obj.type === 'success' && typeof obj.sessionId === 'string') {
            return { type: 'success', sessionId: obj.sessionId }
        }
        if (obj.type === 'pending' && obj.spawnRequestId === spawnRequestId) {
            return { type: 'pending', spawnRequestId: obj.spawnRequestId }
        }
        if (obj.type === 'error' && typeof obj.errorMessage === 'string') {
            const code = typeof obj.code === 'string'
                && (PROVIDER_READINESS_ISSUE_CODES as readonly string[]).includes(obj.code)
                ? obj.code as ProviderReadinessIssueCode
                : undefined
            const recoveryCommand = typeof obj.recoveryCommand === 'string' && obj.recoveryCommand.trim()
                ? obj.recoveryCommand
                : undefined
            return {
                type: 'error',
                message: obj.errorMessage,
                ...(code ? { code } : {}),
                ...(recoveryCommand ? { recoveryCommand } : {})
            }
        }
        if (obj.type === 'requestToApproveDirectoryCreation' && typeof obj.directory === 'string') {
            return { type: 'error', message: `Directory creation requires approval: ${obj.directory}` }
        }
    }
    // Untyped handler errors, malformed responses, and transport ambiguity do
    // not prove that Runner rejected the request. Keep the durable operation
    // queryable under the caller's original id instead of permitting a retry
    // to create a second child.
    return { type: 'pending', spawnRequestId }
}

function parseQuerySpawnSessionResult(result: unknown, spawnRequestId: string): RpcQuerySpawnSessionResult {
    if (result && typeof result === 'object') {
        const obj = result as Record<string, unknown>
        if (obj.type === 'not_found' && obj.spawnRequestId === spawnRequestId) {
            return { type: 'not_found', spawnRequestId }
        }
        if (obj.type === 'conflict' && obj.spawnRequestId === spawnRequestId) {
            return {
                type: 'conflict',
                spawnRequestId,
                message: `Spawn request '${spawnRequestId}' conflicts with its persisted operation identity`
            }
        }
        // Mixed-version compatibility with Runners that returned an untyped
        // terminal error for an authoritative store miss.
        if (
            obj.type === 'error'
            && obj.errorMessage === `Spawn request '${spawnRequestId}' not found`
        ) {
            return { type: 'not_found', spawnRequestId }
        }
        if (
            obj.type === 'error'
            && obj.errorMessage === `spawnRequestId '${spawnRequestId}' was already used with different parameters`
        ) {
            return {
                type: 'conflict',
                spawnRequestId,
                message: `Spawn request '${spawnRequestId}' conflicts with its persisted operation identity`
            }
        }
    }
    return parseSpawnSessionResult(result, spawnRequestId)
}

export class RpcGateway {
    constructor(
        private readonly io: Server,
        private readonly rpcRegistry: RpcRegistry
    ) {
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        mode?: PermissionMode,
        allowTools?: string[],
        decision?: PermissionApproveDecision,
        answers?: Record<string, string[]> | Record<string, { answers: string[] }>
    ): Promise<void> {
        assertApprovePermissionDecision(decision)
        await this.sessionRpc(sessionId, 'permission', {
            id: requestId,
            approved: true,
            mode,
            allowTools,
            decision,
            answers
        })
    }

    async denyPermission(
        sessionId: string,
        requestId: string,
        decision?: PermissionDenyDecision
    ): Promise<void> {
        assertDenyPermissionDecision(decision)
        await this.sessionRpc(sessionId, 'permission', {
            id: requestId,
            approved: false,
            decision
        })
    }

    async abortSession(sessionId: string): Promise<void> {
        const result = await this.sessionRpc(sessionId, 'abort', { reason: 'User aborted via Telegram Bot' })
        if (result && typeof result === 'object' && typeof (result as { error?: unknown }).error === 'string') {
            throw new Error((result as { error: string }).error)
        }
    }

    async switchSession(sessionId: string, to: 'remote' | 'local'): Promise<void> {
        await this.sessionRpc(sessionId, 'switch', { to })
    }

    async requestSessionConfig(
        sessionId: string,
        config: {
            permissionMode?: PermissionMode
            model?: string | null
            modelReasoningEffort?: string | null
            serviceTier?: CodexServiceTier | null
            effort?: string | null
            collaborationMode?: CodexCollaborationMode
        }
    ): Promise<unknown> {
        return await this.sessionRpc(sessionId, 'set-session-config', config)
    }

    async killSession(sessionId: string): Promise<void> {
        await this.sessionRpc(sessionId, 'killSession', {})
    }

    async spawnSession(
        machineId: string,
        directory: string,
        agent: 'claude' | 'claude-deepseek' | 'claude-ark' | 'cc-api' | 'codex' | 'cursor' | 'agy' | 'grok' | 'opencode' | 'hermes-moa' = 'claude',
        model?: string,
        modelReasoningEffort?: string,
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string,
        resumeSessionId?: string,
        effort?: string,
        permissionMode?: PermissionMode,
        serviceTier?: CodexServiceTier,
        spawnRequestId: string = randomUUID()
    ): Promise<RpcSpawnSessionResult> {
        try {
            const result = await this.machineRpc(
                machineId,
                'spawn-happy-session',
                { type: 'spawn-in-directory', spawnRequestId, directory, agent, model, modelReasoningEffort, serviceTier, yolo, sessionType, worktreeName, resumeSessionId, effort, permissionMode }
            )
            return parseSpawnSessionResult(result, spawnRequestId)
        } catch {
            return { type: 'pending', spawnRequestId }
        }
    }

    async querySpawnSession(
        machineId: string,
        spawnRequestId: string,
        expectedOptions?: RpcSpawnSessionLookupOptions
    ): Promise<RpcQuerySpawnSessionResult> {
        try {
            return parseQuerySpawnSessionResult(await this.machineRpc(
                machineId,
                'query-happy-session-spawn',
                { spawnRequestId, ...expectedOptions }
            ), spawnRequestId)
        } catch {
            return { type: 'pending', spawnRequestId }
        }
    }

    async checkPathsExist(machineId: string, paths: string[]): Promise<Record<string, boolean>> {
        const result = await this.machineRpc(machineId, 'path-exists', { paths }) as RpcPathExistsResponse | unknown
        if (!result || typeof result !== 'object') {
            throw new Error('Unexpected path-exists result')
        }

        const existsValue = (result as RpcPathExistsResponse).exists
        if (!existsValue || typeof existsValue !== 'object') {
            throw new Error('Unexpected path-exists result')
        }

        const exists: Record<string, boolean> = {}
        for (const [key, value] of Object.entries(existsValue)) {
            exists[key] = value === true
        }
        return exists
    }

    async getGitStatus(sessionId: string, cwd?: string): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, 'git-status', { cwd }) as RpcCommandResponse
    }

    async getGitDiffNumstat(sessionId: string, options: { cwd?: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, 'git-diff-numstat', options) as RpcCommandResponse
    }

    async getGitDiffFile(sessionId: string, options: { cwd?: string; filePath: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, 'git-diff-file', options) as RpcCommandResponse
    }

    async readSessionFile(sessionId: string, path: string): Promise<RpcReadFileResponse> {
        return await this.sessionRpc(sessionId, 'readFile', { path }) as RpcReadFileResponse
    }

    async listDirectory(sessionId: string, path: string): Promise<RpcListDirectoryResponse> {
        return await this.sessionRpc(sessionId, 'listDirectory', { path }) as RpcListDirectoryResponse
    }

    async uploadFile(sessionId: string, filename: string, content: string, mimeType: string): Promise<RpcUploadFileResponse> {
        return await this.sessionRpc(sessionId, 'uploadFile', { sessionId, filename, content, mimeType }) as RpcUploadFileResponse
    }

    async deleteUploadFile(sessionId: string, path: string): Promise<RpcDeleteUploadResponse> {
        return await this.sessionRpc(sessionId, 'deleteUpload', { sessionId, path }) as RpcDeleteUploadResponse
    }

    async runRipgrep(sessionId: string, args: string[], cwd?: string): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, 'ripgrep', { args, cwd }) as RpcCommandResponse
    }

    async listSlashCommands(sessionId: string, agent: string): Promise<{
        success: boolean
        commands?: Array<{ name: string; description?: string; source: 'builtin' | 'user' | 'plugin' | 'project' }>
        error?: string
    }> {
        return await this.sessionRpc(sessionId, 'listSlashCommands', { agent }) as {
            success: boolean
            commands?: Array<{ name: string; description?: string; source: 'builtin' | 'user' | 'plugin' | 'project' }>
            error?: string
        }
    }


    async listMentions(machineId: string, agent: string): Promise<{
        success: boolean
        mentions?: Array<{
            name: string
            label: string
            insertText: string
            description?: string
            kind: 'app' | 'plugin'
            pluginName: string
        }>
        error?: string
    }> {
        return await this.machineRpc(machineId, 'listMentions', { agent }) as {
            success: boolean
            mentions?: Array<{
                name: string
                label: string
                insertText: string
                description?: string
                kind: 'app' | 'plugin'
                pluginName: string
            }>
            error?: string
        }
    }

    async listSkills(sessionId: string, agent: string): Promise<{
        success: boolean
        skills?: Array<{ name: string; description?: string }>
        error?: string
    }> {
        return await this.sessionRpc(sessionId, 'listSkills', { agent }) as {
            success: boolean
            skills?: Array<{ name: string; description?: string }>
            error?: string
        }
    }

    private async sessionRpc(sessionId: string, method: string, params: unknown): Promise<unknown> {
        return await this.rpcCall(`${sessionId}:${method}`, params)
    }

    private async machineRpc(machineId: string, method: string, params: unknown): Promise<unknown> {
        return await this.rpcCall(`${machineId}:${method}`, params)
    }

    private async rpcCall(method: string, params: unknown): Promise<unknown> {
        const socketId = this.rpcRegistry.getSocketIdForMethod(method)
        if (!socketId) {
            throw new Error(`RPC handler not registered: ${method}`)
        }

        const socket = this.io.of('/cli').sockets.get(socketId)
        if (!socket) {
            throw new Error(`RPC socket disconnected: ${method}`)
        }

        const response = await socket.timeout(30_000).emitWithAck('rpc-request', {
            method,
            params: JSON.stringify(params)
        }) as unknown

        if (typeof response !== 'string') {
            return response
        }

        try {
            return JSON.parse(response) as unknown
        } catch {
            return response
        }
    }
}
