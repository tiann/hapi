import type { CodexCollaborationMode, PermissionMode } from '@hapi/protocol/types'
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
    AgentHistoryImportResponse,
    RunnerSpawnOptionsPreviewRequest,
    RunnerSpawnOptionsPreviewResponse,
    SlashCommandsResponse,
    UploadFileResponse
} from '@hapi/protocol/apiTypes'
import { AgentHistoryImportResponseSchema, RunnerSpawnOptionsPreviewResponseSchema } from '@hapi/protocol/apiTypes'
import type { Server } from 'socket.io'
import {
    PluginDeleteResultSchema,
    PluginDetailResponseSchema,
    PluginInstallResultSchema,
    PluginLocalDirectoryListResponseSchema,
    PluginReloadResultSchema,
    RunnerPluginInventorySchema,
    RunnerPluginActionInvokeResponseSchema,
    RunnerPluginUnsupportedInstallResultSchema,
    type PluginDeleteResult,
    type PluginDetailResponse,
    type PluginInstallLocalRequest,
    type PluginInstallPackageRequest,
    type PluginInstallResult,
    type PluginLocalDirectoryListResponse,
    type PluginReloadResult,
    type RunnerPluginInventory,
    type RunnerPluginActionInvokeResponse,
    type RunnerPluginUnsupportedInstallResult
} from '@hapi/protocol/plugins/admin'
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
        agent: string = 'claude',
        model?: string,
        modelReasoningEffort?: string,
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string,
        resumeSessionId?: string,
        effort?: string,
        permissionMode?: PermissionMode,
        pluginFields?: Record<string, unknown>,
        manualFields?: string[]
    ): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }> {
        try {
            const result = await this.machineRpc(
                machineId,
                RPC_METHODS.SpawnHappySession,
                { type: 'spawn-in-directory', directory, agent, model, modelReasoningEffort, yolo, sessionType, worktreeName, resumeSessionId, effort, permissionMode, pluginFields, manualFields }
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

    async listRunnerPlugins(machineId: string): Promise<RunnerPluginInventory> {
        const result = await this.machineRpc(machineId, RPC_METHODS.RunnerPluginsList, {})
        return RunnerPluginInventorySchema.parse(result)
    }

    async inspectRunnerPlugin(machineId: string, pluginId: string): Promise<PluginDetailResponse> {
        const result = await this.machineRpc(machineId, RPC_METHODS.RunnerPluginsInspect, { pluginId })
        return PluginDetailResponseSchema.parse(result)
    }

    async enableRunnerPlugin(machineId: string, pluginId: string, config?: Record<string, unknown>, reload = true): Promise<PluginReloadResult> {
        const result = await this.machineRpc(machineId, RPC_METHODS.RunnerPluginsEnable, { pluginId, ...(config ? { config } : {}), reload })
        return PluginReloadResultSchema.parse(result)
    }

    async disableRunnerPlugin(machineId: string, pluginId: string, reload = true): Promise<PluginReloadResult> {
        const result = await this.machineRpc(machineId, RPC_METHODS.RunnerPluginsDisable, { pluginId, reload })
        return PluginReloadResultSchema.parse(result)
    }

    async updateRunnerPluginConfig(machineId: string, pluginId: string, config: Record<string, unknown>): Promise<PluginReloadResult> {
        const result = await this.machineRpc(machineId, RPC_METHODS.RunnerPluginsConfigUpdate, { pluginId, config })
        return PluginReloadResultSchema.parse(result)
    }

    async reloadRunnerPlugins(machineId: string, pluginId?: string): Promise<PluginReloadResult> {
        const result = await this.machineRpc(machineId, RPC_METHODS.RunnerPluginsReload, { ...(pluginId ? { pluginId } : {}) })
        return PluginReloadResultSchema.parse(result)
    }

    async prepareRunnerPluginInstall(machineId: string, payload: unknown = {}): Promise<RunnerPluginUnsupportedInstallResult> {
        const result = await this.machineRpc(machineId, RPC_METHODS.RunnerPluginsInstallPrepare, payload)
        return RunnerPluginUnsupportedInstallResultSchema.parse(result)
    }

    async commitRunnerPluginInstall(machineId: string, payload: unknown = {}): Promise<RunnerPluginUnsupportedInstallResult> {
        const result = await this.machineRpc(machineId, RPC_METHODS.RunnerPluginsInstallCommit, payload)
        return RunnerPluginUnsupportedInstallResultSchema.parse(result)
    }

    async listRunnerPluginDirectory(machineId: string, path?: string): Promise<PluginLocalDirectoryListResponse> {
        const result = await this.machineRpc(machineId, RPC_METHODS.RunnerPluginsLocalDirectory, { ...(path ? { path } : {}) })
        return PluginLocalDirectoryListResponseSchema.parse(result)
    }

    async installRunnerPluginLocal(machineId: string, payload: PluginInstallLocalRequest): Promise<PluginInstallResult> {
        const result = await this.machineRpc(machineId, RPC_METHODS.RunnerPluginsInstallLocal, payload, MODEL_LIST_RPC_TIMEOUT_MS)
        return PluginInstallResultSchema.parse(result)
    }

    async installRunnerPluginPackage(machineId: string, payload: PluginInstallPackageRequest): Promise<PluginInstallResult> {
        const result = await this.machineRpc(machineId, RPC_METHODS.RunnerPluginsInstallPackage, payload, MODEL_LIST_RPC_TIMEOUT_MS)
        return PluginInstallResultSchema.parse(result)
    }

    async deleteRunnerPlugin(machineId: string, pluginId: string, reload = true): Promise<PluginDeleteResult> {
        const result = await this.machineRpc(machineId, RPC_METHODS.RunnerPluginsDelete, { pluginId, reload })
        return PluginDeleteResultSchema.parse(result)
    }

    async invokeRunnerPluginAction(
        machineId: string,
        payload: {
            pluginId: string
            capabilityId?: string
            actionId: string
            namespace: string
            sessionId?: string
            cwd?: string
            payload?: unknown
        }
    ): Promise<RunnerPluginActionInvokeResponse> {
        const result = await this.machineRpc(machineId, RPC_METHODS.RunnerPluginActionInvoke, payload)
        return RunnerPluginActionInvokeResponseSchema.parse(result)
    }

    async previewRunnerSpawnOptions(machineId: string, payload: RunnerSpawnOptionsPreviewRequest): Promise<RunnerSpawnOptionsPreviewResponse> {
        const result = await this.machineRpc(machineId, RPC_METHODS.RunnerSpawnOptionsPreview, payload)
        return RunnerSpawnOptionsPreviewResponseSchema.parse(result)
    }

    async importRunnerAgentHistory(
        machineId: string,
        payload: { agentId: string; nativeSessionId: string; providerId?: string }
    ): Promise<AgentHistoryImportResponse> {
        const result = await this.machineRpc(machineId, RPC_METHODS.RunnerAgentHistoryImport, payload, MODEL_LIST_RPC_TIMEOUT_MS)
        return AgentHistoryImportResponseSchema.parse(result)
    }

    async listOpencodeModelsForSession(sessionId: string): Promise<RpcListOpencodeModelsResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ListOpencodeModels, {}) as RpcListOpencodeModelsResponse
    }

    async listOpencodeModelsForCwd(machineId: string, cwd: string): Promise<RpcListOpencodeModelsResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.ListOpencodeModelsForCwd, { cwd }) as RpcListOpencodeModelsResponse
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
