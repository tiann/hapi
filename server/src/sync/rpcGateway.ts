import type { ModelMode, PermissionMode } from '@hapi/protocol/types'
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

export type RpcPathExistsResponse = {
    exists: Record<string, boolean>
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
        await this.sessionRpc(sessionId, 'abort', { reason: 'User aborted via Telegram Bot' })
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

    /**
     * Attempt to resume a session by reconnecting to an existing CLI process via RPC.
     *
     * **Session ID Context:**
     * The `sessionId` parameter is the **hapi session ID** (not the Claude session ID).
     * This method checks if a CLI process is still running and registered for this hapi session.
     *
     * If the CLI process is still alive, it will respond to this RPC call and the session
     * will be marked as active again without spawning a new process.
     *
     * If the CLI process has exited, this method will throw an error, which triggers
     * the fallback to spawning a new process with Claude's --resume flag.
     *
     * @param sessionId - The hapi session ID to resume
     * @throws {Error} If RPC handler not registered or socket disconnected
     */
    async resumeSession(sessionId: string): Promise<void> {
        // Check if session has an active RPC connection before attempting resume
        const method = `${sessionId}:resumeSession`
        const socketId = this.rpcRegistry.getSocketIdForMethod(method)

        if (!socketId) {
            throw new Error('RPC handler not registered: Session is not currently running')
        }

        const socket = this.io.of('/cli').sockets.get(socketId)
        if (!socket) {
            throw new Error('RPC socket disconnected: Session connection lost')
        }

        await this.sessionRpc(sessionId, 'resumeSession', {})
    }

    /**
     * Spawn a new CLI process with --resume flag to continue an existing session.
     *
     * **Critical Session ID Distinction:**
     *
     * This method accepts BOTH session IDs because they serve different purposes:
     *
     * 1. `hapiSessionId`: The hapi session ID (stays constant)
     *    - Tells the new CLI process which hapi session to join
     *    - Used for RPC method registration: `{hapiSessionId}:methodName`
     *    - Shown to user in UI and database
     *
     * 2. `claudeSessionIdToResume`: The Claude session ID (may change)
     *    - Passed to Claude CLI as `--resume {claudeSessionIdToResume}`
     *    - Used by Claude to load conversation history
     *    - May result in Claude creating a NEW session ID
     *
     * **Flow:**
     * 1. Server calls this method with both IDs
     * 2. Runner spawns: `hapi claude --hapi-session-id {hapiSessionId} --resume-claude-session {claudeSessionIdToResume}`
     * 3. CLI joins hapi session {hapiSessionId} and runs `claude --resume {claudeSessionIdToResume}`
     * 4. Claude may create new session ID, which gets stored in `metadata.claudeSessionId`
     * 5. User continues in same hapi session (no redirect needed)
     *
     * @param hapiSessionId - The hapi session ID to join (stays constant)
     * @param machineId - The machine to spawn the process on
     * @param directory - The working directory for the session
     * @param claudeSessionIdToResume - The Claude session ID to resume from (may change)
     * @param agent - The agent type (claude, codex, or gemini)
     * @throws {Error} If spawn fails or returns an error
     */
    async spawnResumedSession(
        hapiSessionId: string,
        machineId: string,
        directory: string,
        sessionIdToResume: string,
        agent: 'claude' | 'codex' | 'gemini' = 'claude',
        fork: boolean = false
    ): Promise<void> {
        console.log('[RpcGateway.spawnResumedSession] Calling machineRpc:', {
            hapiSessionId,
            machineId,
            directory,
            sessionIdToResume,
            agent,
            fork
        })

        const result = await this.machineRpc(
            machineId,
            'spawn-resumed-session',
            {
                hapiSessionId,
                directory,
                agent,
                sessionIdToResume,
                fork
            }
        )

        console.log('[RpcGateway.spawnResumedSession] machineRpc result:', {
            result,
            hapiSessionId
        })

        if (result && typeof result === 'object') {
            const obj = result as Record<string, unknown>

            // Check for domain-specific error format
            if (obj.type === 'error' && typeof obj.errorMessage === 'string') {
                console.log('[RpcGateway.spawnResumedSession] Error from machineRpc:', {
                    errorMessage: obj.errorMessage,
                    hapiSessionId
                })
                throw new Error(obj.errorMessage)
            }

            // Check for generic RPC error format (from RpcHandlerManager exception handling)
            if (obj.error && typeof obj.error === 'string') {
                console.log('[RpcGateway.spawnResumedSession] RPC handler error:', {
                    error: obj.error,
                    hapiSessionId
                })
                throw new Error(obj.error)
            }
        }

        console.log('[RpcGateway.spawnResumedSession] Completed successfully:', { hapiSessionId })
    }

    async terminateSessionProcess(sessionId: string, machineId: string, force: boolean = false): Promise<void> {
        try {
            await this.machineRpc(
                machineId,
                'terminate-session',
                { sessionId, force }
            )
        } catch (error) {
            // Process might already be dead, log but don't throw
            console.log('[RpcGateway.terminateSessionProcess] Failed to terminate:', {
                sessionId,
                error: error instanceof Error ? error.message : String(error)
            })
        }
    }

    async spawnSession(
        machineId: string,
        directory: string,
        agent: 'claude' | 'codex' | 'gemini' = 'claude',
        model?: string,
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string
    ): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }> {
        try {
            const result = await this.machineRpc(
                machineId,
                'spawn-happy-session',
                { type: 'spawn-in-directory', directory, agent, model, yolo, sessionType, worktreeName }
            )
            if (result && typeof result === 'object') {
                const obj = result as Record<string, unknown>
                if (obj.type === 'success' && typeof obj.sessionId === 'string') {
                    return { type: 'success', sessionId: obj.sessionId }
                }
                if (obj.type === 'error' && typeof obj.errorMessage === 'string') {
                    return { type: 'error', message: obj.errorMessage }
                }
            }
            return { type: 'error', message: 'Unexpected spawn result' }
        } catch (error) {
            return { type: 'error', message: error instanceof Error ? error.message : String(error) }
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

    async listDirectories(machineId: string, path: string): Promise<string[]> {
        const result = await this.machineRpc(machineId, 'list-directories', { path }) as { directories: string[]; error?: string } | unknown
        if (!result || typeof result !== 'object') {
            throw new Error('Unexpected list-directories result')
        }

        const response = result as { directories: string[]; error?: string }

        // Check for error response from CLI
        if (response.error) {
            throw new Error(response.error)
        }

        if (!Array.isArray(response.directories)) {
            throw new Error('Unexpected list-directories result')
        }

        return response.directories
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
        commands?: Array<{ name: string; description?: string; source: 'builtin' | 'user' }>
        error?: string
    }> {
        return await this.sessionRpc(sessionId, 'listSlashCommands', { agent }) as {
            success: boolean
            commands?: Array<{ name: string; description?: string; source: 'builtin' | 'user' }>
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
