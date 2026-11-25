import { describe, expect, it, spyOn } from 'bun:test'
import { MACHINE_CAPABILITIES } from '@hapi/protocol'
import { RpcRegistry } from '../socket/rpcRegistry'
import { Store } from '../store'
import type { RpcGateway } from './rpcGateway'
import { SyncEngine } from './syncEngine'

function createEngine(capabilities: string[], options?: { machineOnline?: boolean }) {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const session = engine.getOrCreateSession(
        'workspace-write',
        { path: '/workspace/project', host: 'runner-host', machineId: 'machine-1', flavor: 'claude' },
        null,
        'default'
    )
    engine.getOrCreateMachine(
        'machine-1',
        { host: 'runner-host', platform: 'linux', happyCliVersion: 'test', capabilities } as never,
        { status: 'running' },
        'default'
    )
    if (options?.machineOnline !== false) {
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

        await engine.deleteWorkspacePath(sessionId, 'src/a.txt')
        expect(remove).toHaveBeenCalledWith('machine-1', { cwd: '/workspace/project', path: 'src/a.txt' })
        engine.stop()
    })

    it('explains when the runner is too old instead of calling it', async () => {
        const { engine, sessionId, gateway } = createEngine([MACHINE_CAPABILITIES.WorkspaceFileAccess])
        const remove = spyOn(gateway, 'deleteWorkspacePath')

        const result = await engine.deleteWorkspacePath(sessionId, 'src/a.txt')
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
})
