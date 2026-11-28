import { describe, expect, it, spyOn } from 'bun:test'
import { MACHINE_CAPABILITIES } from '@hapi/protocol'
import { RpcRegistry } from '../socket/rpcRegistry'
import { Store } from '../store'
import type { RpcGateway } from './rpcGateway'
import { SyncEngine } from './syncEngine'

function createEngine(capabilities: string[], {
    machineOnline = true,
    sessionMachineId = 'machine-1',
}: { machineOnline?: boolean; sessionMachineId?: string | null } = {}) {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const session = engine.getOrCreateSession(
        'workspace-write',
        {
            path: '/workspace/project',
            host: 'runner-host',
            machineId: sessionMachineId ?? undefined,
            flavor: 'claude',
        },
        null,
        'default'
    )
    engine.getOrCreateMachine(
        'machine-1',
        { host: 'runner-host', platform: 'linux', happyCliVersion: 'test', capabilities } as never,
        { status: 'running' },
        'default'
    )
    if (machineOnline) {
        engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })
    }
    const gateway = (engine as unknown as { rpcGateway: RpcGateway }).rpcGateway
    return { engine, sessionId: session.id, gateway }
}

describe('SyncEngine workspace upload/delete', () => {
    it('routes uploads and deletes to the session runner with the session workspace as cwd', async () => {
        const { engine, sessionId, gateway } = createEngine([MACHINE_CAPABILITIES.WorkspaceFileWrite])
        const write = spyOn(gateway, 'writeWorkspaceFile').mockResolvedValue({ success: true, size: 1 })
        const remove = spyOn(gateway, 'deleteWorkspacePath').mockResolvedValue({ success: true })

        await engine.writeWorkspaceFile(sessionId, { dir: 'src', name: 'a.txt', uploadId: 'upload-0001', offset: 0, content: 'YQ==' })
        expect(write).toHaveBeenCalledWith('machine-1', {
            dir: 'src', name: 'a.txt', uploadId: 'upload-0001', offset: 0, content: 'YQ==', cwd: '/workspace/project',
        })

        await engine.deleteWorkspacePath(sessionId, { path: 'src/a.txt', kind: 'file' })
        expect(remove).toHaveBeenCalledWith('machine-1', { cwd: '/workspace/project', path: 'src/a.txt', kind: 'file' })
        engine.stop()
    })

    it.each([MACHINE_CAPABILITIES.WorkspaceFileAccess, 'workspace-file-write'])('refuses runners with only %s', async (capability) => {
        const { engine, sessionId, gateway } = createEngine([capability])
        const remove = spyOn(gateway, 'deleteWorkspacePath')

        const result = await engine.deleteWorkspacePath(sessionId, { path: 'src/a.txt', kind: 'file' })
        expect(result).toMatchObject({ success: false, code: 'runner_outdated' })
        expect(remove).not.toHaveBeenCalled()
        engine.stop()
    })

    it('reports an offline runner', async () => {
        const { engine, sessionId } = createEngine([MACHINE_CAPABILITIES.WorkspaceFileWrite], { machineOnline: false })
        const result = await engine.writeWorkspaceFile(sessionId, { dir: '', name: 'a.txt', uploadId: 'upload-0001', offset: 0 })
        expect(result).toMatchObject({ success: false, code: 'workspace_unavailable' })
        engine.stop()
    })

    it.each([null, 'another-machine'])('refuses a same-host runner when the recorded machine ID is %s', async (sessionMachineId) => {
        const { engine, sessionId, gateway } = createEngine([MACHINE_CAPABILITIES.WorkspaceFileWrite], { sessionMachineId })
        const write = spyOn(gateway, 'writeWorkspaceFile')
        const remove = spyOn(gateway, 'deleteWorkspacePath')
        const unavailable = { success: false, code: 'workspace_unavailable' }

        expect(await engine.writeWorkspaceFile(sessionId, { dir: '', name: 'a.txt', uploadId: 'upload-0001', offset: 0 }))
            .toMatchObject(unavailable)
        expect(await engine.deleteWorkspacePath(sessionId, { path: 'a.txt', kind: 'file' })).toMatchObject(unavailable)
        expect(write).not.toHaveBeenCalled()
        expect(remove).not.toHaveBeenCalled()
        engine.stop()
    })
})
