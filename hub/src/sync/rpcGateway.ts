import type { AgentFlavor, CodexCollaborationMode, PermissionMode } from '@hapi/protocol/types'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type {
    CodexModelSummary,
    CodexModelsResponse,
    CommandResponse,
    CursorModelSummary,
    CursorModelsResponse,
    DeleteUploadResponse,
    DirectoryEntry,
    FileReadResponse,
    GeneratedImageResponse,
    ListDirectoryResponse,
    OpencodeModelsResponse,
    OpencodeModelSummary,
    PathExistsResponse,
    PiCommandsResponse,
    PiMessagesResponse,
    PiQueueModeResponse,
    PiSteerResponse,
    PiFollowUpResponse,
    PiCompactResponse,
    PiSetAutoCompactionResponse,
    PiForkResponse,
    PiForkMessagesResponse,
    PiCloneResponse,
    PiSwitchSessionResponse,
    PiSessionStatsResponse,
    PiExportHtmlResponse,
    SlashCommandsResponse,
    UploadFileResponse
} from '@hapi/protocol/apiTypes'
import type { Server } from 'socket.io'
import type { RpcRegistry } from '../socket/rpcRegistry'

const DEFAULT_RPC_TIMEOUT_MS = 30_000
const MODEL_LIST_RPC_TIMEOUT_MS = 120_000

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
export type RpcCursorModel = CursorModelSummary
export type RpcListCursorModelsResponse = CursorModelsResponse
export type RpcOpencodeModel = OpencodeModelSummary
export type RpcListOpencodeModelsResponse = OpencodeModelsResponse
export type RpcListPiModelsResponse = import('@hapi/protocol/apiTypes').ListPiModelsResponse
export type RpcListPiCommandsResponse = PiCommandsResponse
export type RpcPiSteerResponse = PiSteerResponse
export type RpcPiFollowUpResponse = PiFollowUpResponse
export type RpcPiQueueModeResponse = PiQueueModeResponse
export type RpcPiMessagesResponse = PiMessagesResponse
export type RpcPiCompactResponse = PiCompactResponse
export type RpcPiSetAutoCompactionResponse = PiSetAutoCompactionResponse
export type RpcPiForkResponse = PiForkResponse
export type RpcPiForkMessagesResponse = PiForkMessagesResponse
export type RpcPiCloneResponse = PiCloneResponse
export type RpcPiSwitchSessionResponse = PiSwitchSessionResponse
export type RpcPiSessionStatsResponse = PiSessionStatsResponse
export type RpcPiExportHtmlResponse = PiExportHtmlResponse

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
            model?: string | null
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
        permissionMode?: PermissionMode
    ): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }> {
        try {
            const result = await this.machineRpc(
                machineId,
                RPC_METHODS.SpawnHappySession,
                { type: 'spawn-in-directory', directory, agent, model, modelReasoningEffort, yolo, sessionType, worktreeName, resumeSessionId, effort, permissionMode }
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

    async listPiModelsForSession(sessionId: string): Promise<RpcListPiModelsResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ListPiModels, {}, MODEL_LIST_RPC_TIMEOUT_MS) as RpcListPiModelsResponse
    }

    async renamePiSession(sessionId: string, name: string): Promise<{ success: boolean }> {
        return await this.sessionRpc(sessionId, RPC_METHODS.RenamePiSession, { name }) as { success: boolean }
    }

    async listPiCommandsForSession(sessionId: string): Promise<RpcListPiCommandsResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ListPiCommands, {}, MODEL_LIST_RPC_TIMEOUT_MS) as RpcListPiCommandsResponse
    }

    async steerPiSession(sessionId: string, message: string): Promise<RpcPiSteerResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.PiSteer, { message }) as RpcPiSteerResponse
    }

    async followUpPiSession(sessionId: string, message: string): Promise<RpcPiFollowUpResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.PiFollowUp, { message }) as RpcPiFollowUpResponse
    }

    async setPiSteeringMode(sessionId: string, mode: 'all' | 'one-at-a-time'): Promise<RpcPiQueueModeResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.PiSetSteeringMode, { mode }) as RpcPiQueueModeResponse
    }

    async setPiFollowUpMode(sessionId: string, mode: 'all' | 'one-at-a-time'): Promise<RpcPiQueueModeResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.PiSetFollowUpMode, { mode }) as RpcPiQueueModeResponse
    }

    async getPiMessages(sessionId: string): Promise<RpcPiMessagesResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.PiGetMessages, {}, MODEL_LIST_RPC_TIMEOUT_MS) as RpcPiMessagesResponse
    }

    // P3: Compact
    async compactPiSession(sessionId: string, customInstructions?: string): Promise<RpcPiCompactResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.PiCompact, { customInstructions }, 60_000) as RpcPiCompactResponse
    }

    // P3: Set auto compaction
    async setPiAutoCompaction(sessionId: string, enabled: boolean): Promise<RpcPiSetAutoCompactionResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.PiSetAutoCompaction, { enabled }) as RpcPiSetAutoCompactionResponse
    }

    // P3: Fork
    async forkPiSession(sessionId: string, entryId: string): Promise<RpcPiForkResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.PiFork, { entryId }) as RpcPiForkResponse
    }

    // P3: Get fork messages
    async getPiForkMessages(sessionId: string): Promise<RpcPiForkMessagesResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.PiGetForkMessages, {}, MODEL_LIST_RPC_TIMEOUT_MS) as RpcPiForkMessagesResponse
    }

    // P3: Clone
    async clonePiSession(sessionId: string): Promise<RpcPiCloneResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.PiClone, {}) as RpcPiCloneResponse
    }

    // P3: Switch session
    async switchPiSession(sessionId: string, sessionPath: string): Promise<RpcPiSwitchSessionResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.PiSwitchSession, { sessionPath }) as RpcPiSwitchSessionResponse
    }

    // P3: Get session stats
    async getPiSessionStats(sessionId: string): Promise<RpcPiSessionStatsResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.PiGetSessionStats, {}) as RpcPiSessionStatsResponse
    }

    // P3: Export HTML
    async exportPiSessionHtml(sessionId: string, outputPath?: string): Promise<RpcPiExportHtmlResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.PiExportHtml, { outputPath }, 30_000) as RpcPiExportHtmlResponse
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
            throw new Error(`RPC handler not registered: ${method}`)
        }

        const socket = this.io.of('/cli').sockets.get(socketId)
        if (!socket) {
            throw new Error(`RPC socket disconnected: ${method}`)
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
