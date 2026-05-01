import { describe, expect, it } from 'bun:test'
import { RpcGateway } from './rpcGateway'
import type { RpcRegistry } from '../socket/rpcRegistry'

type RpcCall = {
    event: string
    payload: { method: string; params: string }
}

function createGateway(response: unknown) {
    const calls: RpcCall[] = []
    const socket = {
        timeout: (ms: number) => {
            expect(ms).toBe(30_000)
            return {
                emitWithAck: async (event: string, payload: RpcCall['payload']) => {
                    calls.push({ event, payload })
                    return response
                }
            }
        }
    }
    const io = {
        of: (namespace: string) => {
            expect(namespace).toBe('/cli')
            return { sockets: new Map([['socket-1', socket]]) }
        }
    }
    const registry = {
        getSocketIdForMethod: () => 'socket-1'
    } as unknown as RpcRegistry

    return {
        gateway: new RpcGateway(io as never, registry),
        calls
    }
}

describe('RpcGateway editor RPC', () => {
    it('sends editor-list-directory through machine-level RPC', async () => {
        const expected = {
            success: true,
            entries: [{ name: 'src', type: 'directory' as const, gitStatus: 'modified' as const }]
        }
        const { gateway, calls } = createGateway(JSON.stringify(expected))

        const result = await gateway.editorListDirectory('machine-1', '/repo')

        expect(result).toEqual(expected)
        expect(calls).toEqual([
            {
                event: 'rpc-request',
                payload: {
                    method: 'machine-1:editor-list-directory',
                    params: JSON.stringify({ path: '/repo' })
                }
            }
        ])
    })

    it('sends editor-read-file through machine-level RPC', async () => {
        const expected = { success: true, content: 'aGVsbG8=', size: 5 }
        const { gateway, calls } = createGateway(expected)

        const result = await gateway.editorReadFile('machine-1', '/repo/README.md')

        expect(result).toEqual(expected)
        expect(calls[0]).toEqual({
            event: 'rpc-request',
            payload: {
                method: 'machine-1:editor-read-file',
                params: JSON.stringify({ path: '/repo/README.md' })
            }
        })
    })

    it('sends editor-list-projects through machine-level RPC', async () => {
        const expected = {
            success: true,
            projects: [{ path: '/repo', name: 'repo', hasGit: true }]
        }
        const { gateway, calls } = createGateway(expected)

        const result = await gateway.editorListProjects('machine-1')

        expect(result).toEqual(expected)
        expect(calls[0]).toEqual({
            event: 'rpc-request',
            payload: {
                method: 'machine-1:editor-list-projects',
                params: JSON.stringify({})
            }
        })
    })

    it('sends editor-git-status through machine-level RPC', async () => {
        const expected = { success: true, stdout: ' M README.md\n' }
        const { gateway, calls } = createGateway(expected)

        const result = await gateway.editorGitStatus('machine-1', '/repo')

        expect(result).toEqual(expected)
        expect(calls[0]).toEqual({
            event: 'rpc-request',
            payload: {
                method: 'machine-1:editor-git-status',
                params: JSON.stringify({ path: '/repo' })
            }
        })
    })

    it('sends editor-write-file through machine-level RPC', async () => {
        const expected = { success: true, path: '/repo/src/App.tsx', size: 12 }
        const { gateway, calls } = createGateway(expected)

        const result = await gateway.editorWriteFile('machine-1', '/repo/src/App.tsx', 'hello world!')

        expect(result).toEqual(expected)
        expect(calls[0]).toEqual({
            event: 'rpc-request',
            payload: {
                method: 'machine-1:editor-write-file',
                params: JSON.stringify({ path: '/repo/src/App.tsx', content: 'hello world!' })
            }
        })
    })

    it('sends editor-create-file through machine-level RPC', async () => {
        const expected = { success: true, path: '/repo/src/New.tsx', size: 0 }
        const { gateway, calls } = createGateway(expected)

        const result = await gateway.editorCreateFile('machine-1', '/repo/src/New.tsx', '')

        expect(result).toEqual(expected)
        expect(calls[0]).toEqual({
            event: 'rpc-request',
            payload: {
                method: 'machine-1:editor-create-file',
                params: JSON.stringify({ path: '/repo/src/New.tsx', content: '' })
            }
        })
    })

    it('sends editor-delete-file through machine-level RPC', async () => {
        const expected = { success: true, path: '/repo/src/Old.tsx' }
        const { gateway, calls } = createGateway(expected)

        const result = await gateway.editorDeleteFile('machine-1', '/repo/src/Old.tsx')

        expect(result).toEqual(expected)
        expect(calls[0]).toEqual({
            event: 'rpc-request',
            payload: {
                method: 'machine-1:editor-delete-file',
                params: JSON.stringify({ path: '/repo/src/Old.tsx' })
            }
        })
    })

    it('returns an error response for unexpected editor RPC payloads', async () => {
        const { gateway } = createGateway(null)

        await expect(gateway.editorListDirectory('machine-1', '/repo')).resolves.toEqual({
            success: false,
            error: 'Unexpected editor-list-directory result'
        })
        await expect(gateway.editorReadFile('machine-1', '/repo/file.ts')).resolves.toEqual({
            success: false,
            error: 'Unexpected editor-read-file result'
        })
        await expect(gateway.editorListProjects('machine-1')).resolves.toEqual({
            success: false,
            error: 'Unexpected editor-list-projects result'
        })
        await expect(gateway.editorGitStatus('machine-1', '/repo')).resolves.toEqual({
            success: false,
            error: 'Unexpected editor-git-status result'
        })
        await expect(gateway.editorWriteFile('machine-1', '/repo/file.ts', 'content')).resolves.toEqual({
            success: false,
            error: 'Unexpected editor-write-file result'
        })
        await expect(gateway.editorCreateFile('machine-1', '/repo/new.ts', '')).resolves.toEqual({
            success: false,
            error: 'Unexpected editor-create-file result'
        })
        await expect(gateway.editorDeleteFile('machine-1', '/repo/old.ts')).resolves.toEqual({
            success: false,
            error: 'Unexpected editor-delete-file result'
        })
    })
})
