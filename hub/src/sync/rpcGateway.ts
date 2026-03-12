import type { ModelMode, PermissionMode } from '@zs/protocol/types'
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

export class RpcGateway {
    constructor(
        private readonly io: Server,
        private readonly rpcRegistry: RpcRegistry
    ) {
    }

    private logSpawnEvent(
        level: 'log' | 'error',
        stage: string,
        outcome: 'start' | 'success' | 'error' | 'duplicate' | 'retry',
        details: Record<string, unknown>
    ): void {
        const message = `[SyncEngine] spawn stage=${stage} outcome=${outcome}`
        if (level === 'error') {
            console.error(message, details)
            return
        }
        console.log(message, details)
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        mode?: PermissionMode,
        allowTools?: string[],
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
        answers?: Record<string, string[]> | Record<string, { answers: string[] }>
    ): Promise<void> {
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
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    ): Promise<void> {
        await this.sessionRpc(sessionId, 'permission', {
            id: requestId,
            approved: false,
            decision
        })
    }

    async abortSession(sessionId: string): Promise<void> {
        await this.sessionRpc(sessionId, 'abort', { reason: 'User aborted via web app' })
    }

    async switchSession(sessionId: string, to: 'remote' | 'local'): Promise<void> {
        await this.sessionRpc(sessionId, 'switch', { to })
    }

    async requestSessionConfig(
        sessionId: string,
        config: {
            permissionMode?: PermissionMode
            modelMode?: ModelMode
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
        agent: 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode' = 'claude',
        model?: string,
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string,
        resumeSessionId?: string
    ): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }> {
        this.logSpawnEvent('log', 'request', 'start', {
            machineId,
            directory,
            agent,
            model,
            yolo: yolo === true,
            sessionType: sessionType ?? 'simple',
            worktreeName: worktreeName ?? null,
            resumeSessionId: resumeSessionId ?? null
        })

        try {
            const result = await this.machineRpc(
                machineId,
                'spawn-happy-session',
                { type: 'spawn-in-directory', directory, agent, model, yolo, sessionType, worktreeName, resumeSessionId }
            )
            if (result && typeof result === 'object') {
                const obj = result as Record<string, unknown>
                if (obj.type === 'success' && typeof obj.sessionId === 'string') {
                    this.logSpawnEvent('log', 'rpc.result', 'success', {
                        machineId,
                        directory,
                        agent,
                        sessionId: obj.sessionId,
                        sessionType: sessionType ?? 'simple',
                        resumeSessionId: resumeSessionId ?? null
                    })
                    return { type: 'success', sessionId: obj.sessionId }
                }
                if (obj.type === 'error' && typeof obj.errorMessage === 'string') {
                    this.logSpawnEvent('error', 'rpc.result', 'error', {
                        machineId,
                        directory,
                        agent,
                        cause: 'spawn_rpc_error',
                        message: obj.errorMessage,
                        sessionType: sessionType ?? 'simple',
                        resumeSessionId: resumeSessionId ?? null
                    })
                    return { type: 'error', message: obj.errorMessage }
                }
                if (obj.type === 'requestToApproveDirectoryCreation' && typeof obj.directory === 'string') {
                    this.logSpawnEvent('error', 'rpc.result', 'error', {
                        machineId,
                        directory,
                        agent,
                        cause: 'directory_creation_requires_approval',
                        requestedDirectory: obj.directory,
                        sessionType: sessionType ?? 'simple',
                        resumeSessionId: resumeSessionId ?? null
                    })
                    return { type: 'error', message: `Directory creation requires approval: ${obj.directory}` }
                }
                if (typeof obj.error === 'string') {
                    this.logSpawnEvent('error', 'rpc.result', 'error', {
                        machineId,
                        directory,
                        agent,
                        cause: 'spawn_rpc_error',
                        message: obj.error,
                        sessionType: sessionType ?? 'simple',
                        resumeSessionId: resumeSessionId ?? null
                    })
                    return { type: 'error', message: obj.error }
                }
                if (obj.type !== 'success' && typeof obj.message === 'string') {
                    this.logSpawnEvent('error', 'rpc.result', 'error', {
                        machineId,
                        directory,
                        agent,
                        cause: 'spawn_rpc_message_error',
                        message: obj.message,
                        rawType: obj.type ?? null,
                        sessionType: sessionType ?? 'simple',
                        resumeSessionId: resumeSessionId ?? null
                    })
                    return { type: 'error', message: obj.message }
                }
            }
            const details = typeof result === 'string'
                ? result
                : (() => {
                    try {
                        return JSON.stringify(result)
                    } catch {
                        return String(result)
                    }
                })()
            this.logSpawnEvent('error', 'rpc.result', 'error', {
                machineId,
                directory,
                agent,
                cause: 'unexpected_spawn_result',
                details,
                sessionType: sessionType ?? 'simple',
                resumeSessionId: resumeSessionId ?? null
            })
            return { type: 'error', message: `Unexpected spawn result: ${details}` }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const cause = message.startsWith('RPC handler not registered:')
                ? 'rpc_handler_missing'
                : message.startsWith('RPC socket disconnected:')
                    ? 'rpc_socket_disconnected'
                    : 'spawn_rpc_exception'
            this.logSpawnEvent('error', 'rpc.call', 'error', {
                machineId,
                directory,
                agent,
                cause,
                message,
                sessionType: sessionType ?? 'simple',
                worktreeName: worktreeName ?? null,
                resumeSessionId: resumeSessionId ?? null
            })
            return { type: 'error', message }
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

    async listSkills(sessionId: string): Promise<{
        success: boolean
        skills?: Array<{ name: string; description?: string }>
        error?: string
    }> {
        return await this.sessionRpc(sessionId, 'listSkills', {}) as {
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
