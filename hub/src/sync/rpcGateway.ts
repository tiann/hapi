import type { AgentFlavor, CodexCollaborationMode, PermissionMode } from '@hapi/protocol/types'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import {
    ArchiveCodexSessionRpcResponseSchema,
    CursorChatStoreStatusSchema,
    ListCodexSessionsRpcResponseSchema
} from '@hapi/protocol/apiTypes'
import type {
    CodexModelSummary,
    CodexModelsResponse,
    CommandResponse,
    CursorModelSummary,
    CursorModelsResponse,
    CursorChatStoreStatus,
    DeleteUploadResponse,
    DirectoryEntry,
    FileReadResponse,
    GeneratedImageResponse,
    GrokModelsResponse,
    GrokReasoningEffortResponse,
    ListDirectoryResponse,
    ListCodexSessionsRpcResponse,
    ArchiveCodexSessionRpcResponse,
    OpencodeModelsResponse,
    OpencodeModelSummary,
    OpencodeReasoningEffortResponse,
    PathExistsResponse,
    SlashCommandsResponse,
    UploadFileResponse
} from '@hapi/protocol/apiTypes'
import type { Server } from 'socket.io'
import type { RpcRegistry } from '../socket/rpcRegistry'

const DEFAULT_RPC_TIMEOUT_MS = 30_000
const MODEL_LIST_RPC_TIMEOUT_MS = 120_000

/**
 * tiann/hapi#916: thrown by {@link RpcGateway.rpcCall} when the target CLI is
 * unreachable (handler not registered or socket disconnected). Callers can
 * narrow on this to treat "CLI gone" as a benign condition (e.g. archive
 * still succeeds at the hub level) without swallowing real RPC errors like
 * timeouts or protocol failures.
 */
export class RpcTargetMissingError extends Error {
    readonly code: 'handler-not-registered' | 'socket-disconnected'
    readonly method: string

    constructor(method: string, reason: 'handler-not-registered' | 'socket-disconnected') {
        super(reason === 'handler-not-registered'
            ? `RPC handler not registered: ${method}`
            : `RPC socket disconnected: ${method}`)
        this.name = 'RpcTargetMissingError'
        this.code = reason
        this.method = method
    }
}

export type RpcCommandResponse = CommandResponse
export type RpcReadFileResponse = FileReadResponse
export type RpcGeneratedImageResponse = GeneratedImageResponse
export type RpcUploadFileResponse = UploadFileResponse
export type RpcDeleteUploadResponse = DeleteUploadResponse
export type RpcDirectoryEntry = DirectoryEntry
export type RpcListDirectoryResponse = ListDirectoryResponse
export type RpcPathExistsResponse = PathExistsResponse
export type RpcCodexModel = CodexModelSummary
export type RpcListCodexModelsResponse = CodexModelsResponse
export type RpcListCodexSessionsResponse = ListCodexSessionsRpcResponse
export type RpcArchiveCodexSessionResponse = ArchiveCodexSessionRpcResponse
export type RpcCursorModel = CursorModelSummary
export type RpcListCursorModelsResponse = CursorModelsResponse
export type RpcCursorChatStoreStatus = CursorChatStoreStatus
export type RpcOpencodeModel = OpencodeModelSummary
export type RpcListOpencodeModelsResponse = OpencodeModelsResponse
export type RpcListGrokModelsResponse = GrokModelsResponse
export type RpcListGrokReasoningEffortOptionsResponse = GrokReasoningEffortResponse
export type RpcListOpencodeReasoningEffortOptionsResponse = OpencodeReasoningEffortResponse

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
        await this.sessionRpc(sessionId, RPC_METHODS.Permission, {
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
        await this.sessionRpc(sessionId, RPC_METHODS.Permission, {
            id: requestId,
            approved: false,
            decision
        })
    }

    async abortSession(sessionId: string): Promise<void> {
        await this.sessionRpc(sessionId, RPC_METHODS.Abort, { reason: 'User aborted via Telegram Bot' })
    }

    async switchSession(sessionId: string, to: 'remote' | 'local'): Promise<void> {
        await this.sessionRpc(sessionId, RPC_METHODS.Switch, { to })
    }

    async requestSessionConfig(
        sessionId: string,
        config: {
            permissionMode?: PermissionMode
            model?: { provider: string; modelId: string } | string | null
            modelReasoningEffort?: string | null
            effort?: string | null
            collaborationMode?: CodexCollaborationMode
        }
    ): Promise<unknown> {
        return await this.sessionRpc(sessionId, RPC_METHODS.SetSessionConfig, config)
    }

    async killSession(sessionId: string): Promise<void> {
        await this.sessionRpc(sessionId, RPC_METHODS.KillSession, {})
    }

    async handoffSessionToLocal(sessionId: string): Promise<void> {
        await this.sessionRpc(sessionId, RPC_METHODS.HandoffLocal, {})
    }

    async spawnSession(
        machineId: string,
        directory: string,
        agent: AgentFlavor = 'claude',
        model?: string,
        modelReasoningEffort?: string,
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string,
        resumeSessionId?: string,
        effort?: string,
        permissionMode?: PermissionMode,
        serviceTier?: string,
        existingSessionId?: string
    ): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }> {
        try {
            const result = await this.machineRpc(
                machineId,
                RPC_METHODS.SpawnHappySession,
                { type: 'spawn-in-directory', directory, agent, model, modelReasoningEffort, yolo, sessionType, worktreeName, resumeSessionId, effort, permissionMode, serviceTier, existingSessionId, sessionId: existingSessionId }
            )
            if (result && typeof result === 'object') {
                const obj = result as Record<string, unknown>
                if (obj.type === 'success' && typeof obj.sessionId === 'string') {
                    return { type: 'success', sessionId: obj.sessionId }
                }
                if (obj.type === 'error' && typeof obj.errorMessage === 'string') {
                    return { type: 'error', message: obj.errorMessage }
                }
                if (obj.type === 'requestToApproveDirectoryCreation' && typeof obj.directory === 'string') {
                    return { type: 'error', message: `Directory creation requires approval: ${obj.directory}` }
                }
                if (typeof obj.error === 'string') {
                    return { type: 'error', message: obj.error }
                }
                if (obj.type !== 'success' && typeof obj.message === 'string') {
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
            return { type: 'error', message: `Unexpected spawn result: ${details}` }
        } catch (error) {
            return { type: 'error', message: error instanceof Error ? error.message : String(error) }
        }
    }

    async listMachineDirectory(machineId: string, path: string): Promise<RpcListDirectoryResponse> {
        const result = await this.machineRpc(machineId, RPC_METHODS.ListMachineDirectory, { path }) as RpcListDirectoryResponse | unknown
        if (!result || typeof result !== 'object') {
            return { success: false, error: 'Unexpected list-directory result' }
        }
        return result as RpcListDirectoryResponse
    }

    async checkPathsExist(machineId: string, paths: string[]): Promise<Record<string, boolean>> {
        const result = await this.machineRpc(machineId, RPC_METHODS.PathExists, { paths }) as RpcPathExistsResponse | unknown
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

    async getCursorChatStoreStatus(
        machineId: string,
        workspacePath: string,
        cursorSessionId: string,
        homeDir?: string
    ): Promise<RpcCursorChatStoreStatus> {
        const result = await this.machineRpc(
            machineId,
            RPC_METHODS.CursorChatStoreStatus,
            { workspacePath, cursorSessionId, homeDir }
        )
        return CursorChatStoreStatusSchema.parse(result)
    }

    async getGitStatus(sessionId: string, cwd?: string): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.GitStatus, { cwd }) as RpcCommandResponse
    }

    async getGitDiffNumstat(sessionId: string, options: { cwd?: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.GitDiffNumstat, options) as RpcCommandResponse
    }

    async getGitDiffFile(sessionId: string, options: { cwd?: string; filePath: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.GitDiffFile, options) as RpcCommandResponse
    }

    async readSessionFile(sessionId: string, path: string): Promise<RpcReadFileResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ReadFile, { path }) as RpcReadFileResponse
    }

    async readGeneratedImage(sessionId: string, imageId: string): Promise<RpcGeneratedImageResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ReadGeneratedImage, { id: imageId }) as RpcGeneratedImageResponse
    }

    async listDirectory(sessionId: string, path: string): Promise<RpcListDirectoryResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ListDirectory, { path }) as RpcListDirectoryResponse
    }

    async uploadFile(sessionId: string, filename: string, content: string, mimeType: string): Promise<RpcUploadFileResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.UploadFile, { sessionId, filename, content, mimeType }) as RpcUploadFileResponse
    }

    async deleteUploadFile(sessionId: string, path: string): Promise<RpcDeleteUploadResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.DeleteUpload, { sessionId, path }) as RpcDeleteUploadResponse
    }

    async runRipgrep(sessionId: string, args: string[], cwd?: string): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.Ripgrep, { args, cwd }) as RpcCommandResponse
    }

    async listSlashCommands(sessionId: string, agent: string): Promise<SlashCommandsResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ListSlashCommands, { agent }) as SlashCommandsResponse
    }

    async listSkills(sessionId: string, flavor?: string): Promise<{
        success: boolean
        skills?: Array<{ name: string; description?: string }>
        error?: string
    }> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ListSkills, { flavor }) as {
            success: boolean
            skills?: Array<{ name: string; description?: string }>
            error?: string
        }
    }

    async listCodexModelsForSession(sessionId: string): Promise<RpcListCodexModelsResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ListCodexModels, {}, MODEL_LIST_RPC_TIMEOUT_MS) as RpcListCodexModelsResponse
    }

    async listCodexModelsForMachine(machineId: string): Promise<RpcListCodexModelsResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.ListCodexModels, {}, MODEL_LIST_RPC_TIMEOUT_MS) as RpcListCodexModelsResponse
    }

    async listCodexSessionsForMachine(machineId: string, cwd?: string | null, sessionIds?: string[]): Promise<RpcListCodexSessionsResponse> {
        const result = await this.machineRpc(machineId, RPC_METHODS.ListCodexSessions, { cwd: cwd ?? null, sessionIds }, MODEL_LIST_RPC_TIMEOUT_MS)
        return ListCodexSessionsRpcResponseSchema.parse(result)
    }

    async archiveCodexSessionForMachine(machineId: string, sessionId: string): Promise<RpcArchiveCodexSessionResponse> {
        const result = await this.machineRpc(machineId, RPC_METHODS.ArchiveCodexSession, { sessionId }, MODEL_LIST_RPC_TIMEOUT_MS)
        return ArchiveCodexSessionRpcResponseSchema.parse(result)
    }

    async listCursorModelsForSession(sessionId: string): Promise<RpcListCursorModelsResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ListCursorModels, {}, MODEL_LIST_RPC_TIMEOUT_MS) as RpcListCursorModelsResponse
    }

    async listCursorModelsForMachine(machineId: string): Promise<RpcListCursorModelsResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.ListCursorModels, {}, MODEL_LIST_RPC_TIMEOUT_MS) as RpcListCursorModelsResponse
    }

    async listOpencodeModelsForSession(sessionId: string): Promise<RpcListOpencodeModelsResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ListOpencodeModels, {}) as RpcListOpencodeModelsResponse
    }

    async listOpencodeModelsForCwd(machineId: string, cwd: string): Promise<RpcListOpencodeModelsResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.ListOpencodeModelsForCwd, { cwd }) as RpcListOpencodeModelsResponse
    }

    async listGrokModelsForCwd(machineId: string, cwd: string): Promise<RpcListGrokModelsResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.ListGrokModelsForCwd, { cwd }) as RpcListGrokModelsResponse
    }

    async listGrokModelsForSession(sessionId: string): Promise<RpcListGrokModelsResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ListGrokModels, {}) as RpcListGrokModelsResponse
    }

    async listGrokReasoningEffortOptionsForSession(sessionId: string): Promise<RpcListGrokReasoningEffortOptionsResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ListGrokReasoningEffortOptions, {}) as RpcListGrokReasoningEffortOptionsResponse
    }

    /** Generic Pi RPC call — routes all Pi-specific session RPCs through
     *  a single entry point instead of per-method wrappers. */
    async callPiRpc<T = unknown>(sessionId: string, method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
        return await this.sessionRpc(sessionId, method, params ?? {}, timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS) as T
    }

    async listOpencodeReasoningEffortOptionsForSession(sessionId: string): Promise<RpcListOpencodeReasoningEffortOptionsResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ListOpencodeReasoningEffortOptions, {}) as RpcListOpencodeReasoningEffortOptionsResponse
    }

    private async sessionRpc(
        sessionId: string,
        method: string,
        params: unknown,
        timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS
    ): Promise<unknown> {
        return await this.rpcCall(`${sessionId}:${method}`, params, timeoutMs)
    }

    private async machineRpc(
        machineId: string,
        method: string,
        params: unknown,
        timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS
    ): Promise<unknown> {
        return await this.rpcCall(`${machineId}:${method}`, params, timeoutMs)
    }

    private async rpcCall(method: string, params: unknown, timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS): Promise<unknown> {
        const socketId = this.rpcRegistry.getSocketIdForMethod(method)
        if (!socketId) {
            throw new RpcTargetMissingError(method, 'handler-not-registered')
        }

        const socket = this.io.of('/cli').sockets.get(socketId)
        if (!socket) {
            throw new RpcTargetMissingError(method, 'socket-disconnected')
        }

        const response = await socket.timeout(timeoutMs).emitWithAck('rpc-request', {
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
