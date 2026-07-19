import {
    GitInspectRequestSchema,
    HostListDirectoryRequestSchema,
    HostFilePreviewRequestSchema,
    HostFileUploadRequestSchema,
    HostFileWriteRequestSchema,
    HostDownloadChunkRequestSchema,
    HostDownloadPrepareRequestSchema,
    HostOperationGetRequestSchema,
    HostOperationRequestSchema,
    type HostOperationGetResponse,
    type HostOperationStartResponse,
    type HostFilePreviewResponse,
    type HostFileUploadResponse,
    type HostFileWriteResponse,
    type HostDownloadChunkResponse,
    type HostDownloadPrepareResponse
} from '@hapi/protocol'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { FileManager } from './fileManager'
import { DownloadManager } from './downloadManager'
import { HostOperationManager } from './hostOperationManager'
import { RepositoryManager } from './repositoryManager'
import { WorkspaceScope } from './workspaceScope'

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Operation failed'
}

export function registerWorkspaceHandlers(options: {
    rpcHandlerManager: RpcHandlerManager
    workspaceRoots?: string[]
}): void {
    const { rpcHandlerManager } = options
    const operationManager = new HostOperationManager()
    let workspaceModules: Promise<{ files: FileManager; downloads: DownloadManager; repositories: RepositoryManager }> | null = null
    const getWorkspaceModules = () => {
        workspaceModules ??= WorkspaceScope.create(options.workspaceRoots).then((scope) => ({
            files: new FileManager(scope),
            downloads: new DownloadManager(scope),
            repositories: new RepositoryManager(scope)
        }))
        return workspaceModules
    }

    rpcHandlerManager.registerHandler(RPC_METHODS.HostListDirectory, async (raw) => {
        const parsed = HostListDirectoryRequestSchema.safeParse(raw)
        if (!parsed.success) return { success: false, error: 'Invalid directory request' }
        try {
            const modules = await getWorkspaceModules()
            return await modules.files.list(parsed.data.path, parsed.data.includeHidden)
        } catch (error) {
            return { success: false, error: errorMessage(error) }
        }
    })

    rpcHandlerManager.registerHandler<unknown, HostFilePreviewResponse>(RPC_METHODS.HostFilePreview, async (raw) => {
        const parsed = HostFilePreviewRequestSchema.safeParse(raw)
        if (!parsed.success) return { success: false, error: 'Invalid file preview request' }
        try {
            const modules = await getWorkspaceModules()
            return await modules.files.readPreview(parsed.data.path)
        } catch (error) {
            return { success: false, error: errorMessage(error) }
        }
    })

    rpcHandlerManager.registerHandler<unknown, HostFileWriteResponse>(RPC_METHODS.HostFileWrite, async (raw) => {
        const parsed = HostFileWriteRequestSchema.safeParse(raw)
        if (!parsed.success) return { success: false, error: 'Invalid file write request' }
        try {
            const modules = await getWorkspaceModules()
            return await modules.files.writeText(parsed.data)
        } catch (error) {
            return { success: false, error: errorMessage(error) }
        }
    })

    rpcHandlerManager.registerHandler<unknown, HostFileUploadResponse>(RPC_METHODS.HostFileUpload, async (raw) => {
        const parsed = HostFileUploadRequestSchema.safeParse(raw)
        if (!parsed.success) return { success: false, error: 'Invalid file upload request' }
        try {
            const modules = await getWorkspaceModules()
            return await modules.files.upload(parsed.data)
        } catch (error) {
            return { success: false, error: errorMessage(error) }
        }
    })

    rpcHandlerManager.registerHandler<unknown, HostDownloadPrepareResponse>(RPC_METHODS.HostDownloadPrepare, async (raw) => {
        const parsed = HostDownloadPrepareRequestSchema.safeParse(raw)
        if (!parsed.success) return { success: false, error: 'Invalid download request' }
        try {
            const modules = await getWorkspaceModules()
            return { success: true, download: await modules.downloads.prepare(parsed.data.path) }
        } catch (error) {
            return { success: false, error: errorMessage(error) }
        }
    })

    rpcHandlerManager.registerHandler<unknown, HostDownloadChunkResponse>(RPC_METHODS.HostDownloadReadChunk, async (raw) => {
        const parsed = HostDownloadChunkRequestSchema.safeParse(raw)
        if (!parsed.success) return { success: false, error: 'Invalid download chunk request' }
        try {
            const modules = await getWorkspaceModules()
            return await modules.downloads.readChunk(parsed.data.id, parsed.data.offset)
        } catch (error) {
            return { success: false, error: errorMessage(error) }
        }
    })

    rpcHandlerManager.registerHandler(RPC_METHODS.HostDownloadRelease, async (raw) => {
        const parsed = HostDownloadChunkRequestSchema.pick({ id: true }).safeParse(raw)
        if (!parsed.success) return { success: false, error: 'Invalid download release request' }
        try {
            const modules = await getWorkspaceModules()
            await modules.downloads.release(parsed.data.id)
            return { success: true }
        } catch (error) {
            return { success: false, error: errorMessage(error) }
        }
    })

    rpcHandlerManager.registerHandler(RPC_METHODS.HostGitInspect, async (raw) => {
        const parsed = GitInspectRequestSchema.safeParse(raw)
        if (!parsed.success) return { success: false, error: 'Invalid Git request' }
        try {
            const modules = await getWorkspaceModules()
            return { success: true, repository: await modules.repositories.inspect(parsed.data.path) }
        } catch (error) {
            return { success: false, error: errorMessage(error) }
        }
    })

    rpcHandlerManager.registerHandler<unknown, HostOperationStartResponse>(RPC_METHODS.HostOperationStart, async (raw) => {
        const parsed = HostOperationRequestSchema.safeParse(raw)
        if (!parsed.success) return { success: false, error: 'Invalid host operation' }
        try {
            const modules = await getWorkspaceModules()
            const request = parsed.data
            const operation = request.domain === 'file'
                ? operationManager.start({
                    domain: 'file',
                    kind: request.operation.kind,
                    lockKeys: await modules.files.lockKeys(request.operation),
                    run: async (context) => await modules.files.execute(request.operation, context)
                })
                : operationManager.start({
                    domain: 'git',
                    kind: request.operation.kind,
                    lockKeys: await modules.repositories.lockKeys(request.operation),
                    run: async (context) => await modules.repositories.execute(request.operation, context)
                })
            return { success: true, operation }
        } catch (error) {
            return { success: false, error: errorMessage(error) }
        }
    })

    rpcHandlerManager.registerHandler<unknown, HostOperationGetResponse>(RPC_METHODS.HostOperationGet, async (raw) => {
        const parsed = HostOperationGetRequestSchema.safeParse(raw)
        if (!parsed.success) return { success: false, error: 'Invalid operation id' }
        const operation = operationManager.get(parsed.data.id)
        return operation ? { success: true, operation } : { success: false, error: 'Operation not found' }
    })

    rpcHandlerManager.registerHandler<unknown, HostOperationGetResponse>(RPC_METHODS.HostOperationCancel, async (raw) => {
        const parsed = HostOperationGetRequestSchema.safeParse(raw)
        if (!parsed.success) return { success: false, error: 'Invalid operation id' }
        const operation = operationManager.cancel(parsed.data.id)
        return operation ? { success: true, operation } : { success: false, error: 'Operation not found' }
    })
}
