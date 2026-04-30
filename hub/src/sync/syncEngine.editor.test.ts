import { describe, expect, it } from 'bun:test'
import { SyncEngine } from './syncEngine'

type EditorRpcGatewayStub = {
    editorListDirectory: (machineId: string, path: string) => Promise<unknown>
    editorReadFile: (machineId: string, path: string) => Promise<unknown>
    editorListProjects: (machineId: string) => Promise<unknown>
    editorGitStatus: (machineId: string, path: string) => Promise<unknown>
}

type SyncEngineWithEditorRpc = {
    rpcGateway: EditorRpcGatewayStub
    listEditorDirectory(machineId: string, path: string): Promise<unknown>
    readEditorFile(machineId: string, path: string): Promise<unknown>
    listEditorProjects(machineId: string): Promise<unknown>
    getEditorGitStatus(machineId: string, path: string): Promise<unknown>
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
            }
        }
        const engine = Object.create(SyncEngine.prototype) as SyncEngineWithEditorRpc
        engine.rpcGateway = gateway

        await expect(engine.listEditorDirectory('machine-1', '/repo')).resolves.toEqual({ success: true, entries: [] })
        await expect(engine.readEditorFile('machine-1', '/repo/a.ts')).resolves.toEqual({ success: true, content: 'YQ==', size: 1 })
        await expect(engine.listEditorProjects('machine-1')).resolves.toEqual({ success: true, projects: [] })
        await expect(engine.getEditorGitStatus('machine-1', '/repo')).resolves.toEqual({ success: true, stdout: '' })

        expect(calls).toEqual([
            { method: 'editorListDirectory', args: ['machine-1', '/repo'] },
            { method: 'editorReadFile', args: ['machine-1', '/repo/a.ts'] },
            { method: 'editorListProjects', args: ['machine-1'] },
            { method: 'editorGitStatus', args: ['machine-1', '/repo'] }
        ])
    })
})
