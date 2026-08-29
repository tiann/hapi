import { describe, expect, it, vi } from 'vitest'
import type { RecycleBinManager } from '../recycleBin'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { registerRecycleBinHandlers } from './recycleBin'

describe('recycle-bin RPC handlers', () => {
    it('validates requests and forwards all operations to the scoped manager', async () => {
        const manager = {
            moveFile: vi.fn(async () => ({ success: true })),
            list: vi.fn(async () => ({ success: true, entries: [], retentionDays: 30 })),
            read: vi.fn(async () => ({ success: true, content: 'aA==' })),
            restore: vi.fn(async () => ({ success: true, restoredPath: '/workspace/file.txt' })),
            purge: vi.fn(async () => ({ success: true })),
            empty: vi.fn(async () => ({ success: true, deletedCount: 0 })),
        } as unknown as RecycleBinManager
        const rpc = new RpcHandlerManager({ scopePrefix: 'session-test' })
        registerRecycleBinHandlers(rpc, '/workspace', manager)

        const invalidMove = JSON.parse(await rpc.handleRequest({
            method: `${'session-test'}:${RPC_METHODS.MoveFileToRecycleBin}`,
            params: JSON.stringify({}),
        })) as { success: boolean; error?: string }
        expect(invalidMove).toMatchObject({ success: false, error: 'File path is required' })

        await rpc.handleRequest({
            method: `session-test:${RPC_METHODS.MoveFileToRecycleBin}`,
            params: JSON.stringify({ path: 'file.txt' }),
        })
        await rpc.handleRequest({
            method: `session-test:${RPC_METHODS.ListRecycleBin}`,
            params: JSON.stringify({}),
        })
        await rpc.handleRequest({
            method: `session-test:${RPC_METHODS.ReadRecycleBinEntry}`,
            params: JSON.stringify({ entryId: 'entry-1' }),
        })
        await rpc.handleRequest({
            method: `session-test:${RPC_METHODS.RestoreRecycleBinEntry}`,
            params: JSON.stringify({ entryId: 'entry-1', conflict: 'new-name' }),
        })
        await rpc.handleRequest({
            method: `session-test:${RPC_METHODS.PurgeRecycleBinEntry}`,
            params: JSON.stringify({ entryId: 'entry-1' }),
        })
        await rpc.handleRequest({
            method: `session-test:${RPC_METHODS.EmptyRecycleBin}`,
            params: JSON.stringify({ entryIds: ['00000000-0000-4000-8000-000000000001'] }),
        })

        expect(manager.moveFile).toHaveBeenCalledWith('file.txt', '/workspace')
        expect(manager.list).toHaveBeenCalledWith('/workspace')
        expect(manager.read).toHaveBeenCalledWith('entry-1', '/workspace')
        expect(manager.restore).toHaveBeenCalledWith('entry-1', '/workspace', 'new-name')
        expect(manager.purge).toHaveBeenCalledWith('entry-1', '/workspace')
        expect(manager.empty).toHaveBeenCalledWith('/workspace', ['00000000-0000-4000-8000-000000000001'])
    })

    it('defaults restore requests to a preflight conflict check', async () => {
        const restore = vi.fn(async () => ({ success: true }))
        const manager = { restore } as unknown as RecycleBinManager
        const rpc = new RpcHandlerManager({ scopePrefix: 'session-test' })
        registerRecycleBinHandlers(rpc, '/workspace', manager)

        await rpc.handleRequest({
            method: `session-test:${RPC_METHODS.RestoreRecycleBinEntry}`,
            params: JSON.stringify({ entryId: 'entry-1' }),
        })

        expect(restore).toHaveBeenCalledWith('entry-1', '/workspace', 'fail')
    })
})
