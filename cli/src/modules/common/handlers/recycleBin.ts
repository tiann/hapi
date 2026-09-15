import type {
    EmptyRecycleBinRequest,
    EmptyRecycleBinResponse,
    MoveFileToRecycleBinResponse,
    ReadRecycleBinEntryResponse,
    RecycleBinListResponse,
    RestoreRecycleBinEntryResponse,
    PurgeRecycleBinEntryResponse,
} from '@hapi/protocol/apiTypes'
import { EmptyRecycleBinRequestSchema } from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import {
    parseRecycleBinRestoreConflict,
    RecycleBinManager,
} from '../recycleBin'

type MoveRequest = { path: string }
type ReadRequest = { entryId: string }
type RestoreRequest = { entryId: string; conflict?: unknown }
type PurgeRequest = { entryId: string }

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null
}

export function registerRecycleBinHandlers(
    rpcHandlerManager: RpcHandlerManager,
    workingDirectory: string,
    manager: RecycleBinManager = new RecycleBinManager(),
): void {
    rpcHandlerManager.registerHandler<unknown, MoveFileToRecycleBinResponse>(
        RPC_METHODS.MoveFileToRecycleBin,
        async (raw) => {
            const data = isObject(raw) ? raw as MoveRequest : null
            const path = requiredString(data?.path)
            if (!path) return { success: false, error: 'File path is required' }
            return await manager.moveFile(path, workingDirectory)
        },
    )

    rpcHandlerManager.registerHandler<unknown, RecycleBinListResponse>(
        RPC_METHODS.ListRecycleBin,
        async () => await manager.list(workingDirectory),
    )

    rpcHandlerManager.registerHandler<unknown, ReadRecycleBinEntryResponse>(
        RPC_METHODS.ReadRecycleBinEntry,
        async (raw) => {
            const data = isObject(raw) ? raw as ReadRequest : null
            const entryId = requiredString(data?.entryId)
            if (!entryId) return { success: false, error: 'Recycle-bin entry id is required' }
            return await manager.read(entryId, workingDirectory)
        },
    )

    rpcHandlerManager.registerHandler<unknown, RestoreRecycleBinEntryResponse>(
        RPC_METHODS.RestoreRecycleBinEntry,
        async (raw) => {
            const data = isObject(raw) ? raw as RestoreRequest : null
            const entryId = requiredString(data?.entryId)
            if (!entryId) return { success: false, code: 'entry_not_found', error: 'Recycle-bin entry id is required' }
            const conflict = parseRecycleBinRestoreConflict(data?.conflict ?? 'fail')
            if (!conflict) return { success: false, error: 'Invalid restore conflict policy' }
            return await manager.restore(entryId, workingDirectory, conflict)
        },
    )

    rpcHandlerManager.registerHandler<unknown, PurgeRecycleBinEntryResponse>(
        RPC_METHODS.PurgeRecycleBinEntry,
        async (raw) => {
            const data = isObject(raw) ? raw as PurgeRequest : null
            const entryId = requiredString(data?.entryId)
            if (!entryId) return { success: false, error: 'Recycle-bin entry id is required' }
            return await manager.purge(entryId, workingDirectory)
        },
    )

    rpcHandlerManager.registerHandler<unknown, EmptyRecycleBinResponse>(
        RPC_METHODS.EmptyRecycleBin,
        async (raw) => {
            const parsed = EmptyRecycleBinRequestSchema.safeParse(raw as EmptyRecycleBinRequest)
            if (!parsed.success) return { success: false, error: 'Recycle-bin entry ids are required' }
            return await manager.empty(workingDirectory, parsed.data.entryIds)
        },
    )
}
