import { describe, expect, it } from 'bun:test'
import { SyncEngine } from './syncEngine'

type EditorRpcGatewayStub = {
    editorListDirectory: (machineId: string, path: string) => Promise<unknown>
    editorReadFile: (machineId: string, path: string) => Promise<unknown>
    editorListProjects: (machineId: string) => Promise<unknown>
    editorGitStatus: (machineId: string, path: string) => Promise<unknown>
    editorWriteFile: (machineId: string, path: string, content: string) => Promise<unknown>
    editorCreateFile: (machineId: string, path: string, content: string) => Promise<unknown>
    editorDeleteFile: (machineId: string, path: string) => Promise<unknown>
}

type SyncEngineWithEditorRpc = {
    rpcGateway: EditorRpcGatewayStub
    listEditorDirectory(machineId: string, path: string): Promise<unknown>
    readEditorFile(machineId: string, path: string): Promise<unknown>
    listEditorProjects(machineId: string): Promise<unknown>
    getEditorGitStatus(machineId: string, path: string): Promise<unknown>
    writeEditorFile(machineId: string, path: string, content: string): Promise<unknown>
    createEditorFile(machineId: string, path: string, content: string): Promise<unknown>
    deleteEditorFile(machineId: string, path: string): Promise<unknown>
}

describe('SyncEngine editor RPC methods', () => {
    it('delegates editor file operations to RpcGateway without requiring a session', async () => {
        const calls: Array<{ method: string; args: unknown[] }> = []
        const gateway: EditorRpcGatewayStub = {
            editorListDirectory: async (...args) => {
                calls.push({ method: 'editorListDirectory', args })
                return { success: true, entries: [] }
            },
            editorReadFile: async (...args) => {
                calls.push({ method: 'editorReadFile', args })
                return { success: true, content: 'YQ==', size: 1 }
            },
            editorListProjects: async (...args) => {
                calls.push({ method: 'editorListProjects', args })
                return { success: true, projects: [] }
            },
            editorGitStatus: async (...args) => {
                calls.push({ method: 'editorGitStatus', args })
                return { success: true, stdout: '' }
            },
            editorWriteFile: async (...args) => {
                calls.push({ method: 'editorWriteFile', args })
                return { success: true, path: '/repo/a.ts', size: 7 }
            },
            editorCreateFile: async (...args) => {
                calls.push({ method: 'editorCreateFile', args })
                return { success: true, path: '/repo/new.ts', size: 0 }
            },
            editorDeleteFile: async (...args) => {
                calls.push({ method: 'editorDeleteFile', args })
                return { success: true, path: '/repo/old.ts' }
            }
        }
        const engine = Object.create(SyncEngine.prototype) as SyncEngineWithEditorRpc
        engine.rpcGateway = gateway

        await expect(engine.listEditorDirectory('machine-1', '/repo')).resolves.toEqual({ success: true, entries: [] })
        await expect(engine.readEditorFile('machine-1', '/repo/a.ts')).resolves.toEqual({ success: true, content: 'YQ==', size: 1 })
        await expect(engine.listEditorProjects('machine-1')).resolves.toEqual({ success: true, projects: [] })
        await expect(engine.getEditorGitStatus('machine-1', '/repo')).resolves.toEqual({ success: true, stdout: '' })
        await expect(engine.writeEditorFile('machine-1', '/repo/a.ts', 'updated')).resolves.toEqual({ success: true, path: '/repo/a.ts', size: 7 })
        await expect(engine.createEditorFile('machine-1', '/repo/new.ts', '')).resolves.toEqual({ success: true, path: '/repo/new.ts', size: 0 })
        await expect(engine.deleteEditorFile('machine-1', '/repo/old.ts')).resolves.toEqual({ success: true, path: '/repo/old.ts' })

        expect(calls).toEqual([
            { method: 'editorListDirectory', args: ['machine-1', '/repo'] },
            { method: 'editorReadFile', args: ['machine-1', '/repo/a.ts'] },
            { method: 'editorListProjects', args: ['machine-1'] },
            { method: 'editorGitStatus', args: ['machine-1', '/repo'] },
            { method: 'editorWriteFile', args: ['machine-1', '/repo/a.ts', 'updated'] },
            { method: 'editorCreateFile', args: ['machine-1', '/repo/new.ts', ''] },
            { method: 'editorDeleteFile', args: ['machine-1', '/repo/old.ts'] }
        ])
    })
})
