import { describe, expect, it, spyOn } from 'bun:test'
import { MACHINE_CAPABILITIES } from '@hapi/protocol'
import { RpcRegistry } from '../socket/rpcRegistry'
import { Store } from '../store'
import { RpcGateway, RpcTargetMissingError } from './rpcGateway'
import { SyncEngine } from './syncEngine'

function createArchivedWorkspaceEngine(): { engine: SyncEngine; sessionId: string; gateway: RpcGateway } {
    const store = new Store(':memory:')
    const engine = new SyncEngine(
        store,
        {} as never,
        new RpcRegistry(),
        { broadcast() {} } as never
    )
    const session = engine.getOrCreateSession(
        'archived-workspace-fallback',
        {
            path: '/workspace/project',
            host: 'runner-host',
            machineId: 'machine-1',
            flavor: 'claude',
            lifecycleState: 'archived',
            archivedBy: 'cli',
            archiveReason: 'User terminated'
        },
        null,
        'default'
    )
    engine.getOrCreateMachine(
        'machine-1',
        {
            host: 'runner-host',
            platform: 'win32',
            happyCliVersion: 'test',
            capabilities: [MACHINE_CAPABILITIES.WorkspaceFileAccess]
        },
        { status: 'running' },
        'default'
    )
    engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

    const gateway = (engine as unknown as { rpcGateway: RpcGateway }).rpcGateway
    return { engine, sessionId: session.id, gateway }
}

function missingTarget(method: string): RpcTargetMissingError {
    return new RpcTargetMissingError(method, 'handler-not-registered')
}

describe('SyncEngine archived workspace fallback', () => {
    it('keeps the session-scoped RPC as the primary path', async () => {
        const { engine, sessionId, gateway } = createArchivedWorkspaceEngine()
        const sessionRead = spyOn(gateway, 'readSessionFile').mockResolvedValue({ success: true, content: 'YQ==' })
        const fallback = spyOn(gateway, 'readWorkspaceFile').mockResolvedValue({ success: true, content: 'Yg==' })

        await expect(engine.readSessionFile(sessionId, 'src/index.ts')).resolves.toEqual({ success: true, content: 'YQ==' })
        expect(sessionRead).toHaveBeenCalledWith(sessionId, 'src/index.ts')
        expect(fallback).not.toHaveBeenCalled()
        engine.stop()
    })

    it('routes all read-only file operations through the online runner', async () => {
        const { engine, sessionId, gateway } = createArchivedWorkspaceEngine()

        spyOn(gateway, 'getGitStatus').mockRejectedValue(missingTarget('session-1:git-status'))
        const gitStatus = spyOn(gateway, 'getWorkspaceGitStatus').mockResolvedValue({ success: true, stdout: 'status' })
        expect(await engine.getGitStatus(sessionId, '/ignored/caller/path')).toEqual({ success: true, stdout: 'status' })
        expect(gitStatus).toHaveBeenCalledWith('machine-1', { cwd: '/workspace/project' })

        spyOn(gateway, 'getGitDiffNumstat').mockRejectedValue(missingTarget('session-1:git-diff-numstat'))
        const gitNumstat = spyOn(gateway, 'getWorkspaceGitDiffNumstat').mockResolvedValue({ success: true, stdout: '1\t2\tsrc/index.ts' })
        await engine.getGitDiffNumstat(sessionId, { cwd: '/ignored/caller/path', staged: true })
        expect(gitNumstat).toHaveBeenCalledWith('machine-1', { cwd: '/workspace/project', staged: true })

        spyOn(gateway, 'getGitDiffFile').mockRejectedValue(missingTarget('session-1:git-diff-file'))
        const gitFile = spyOn(gateway, 'getWorkspaceGitDiffFile').mockResolvedValue({ success: true, stdout: 'diff' })
        await engine.getGitDiffFile(sessionId, { cwd: '/ignored/caller/path', filePath: 'src/index.ts', staged: false })
        expect(gitFile).toHaveBeenCalledWith('machine-1', {
            cwd: '/workspace/project',
            filePath: 'src/index.ts',
            staged: false
        })

        spyOn(gateway, 'readSessionFile').mockRejectedValue(missingTarget('session-1:readFile'))
        const readFile = spyOn(gateway, 'readWorkspaceFile').mockResolvedValue({ success: true, content: 'YQ==' })
        await engine.readSessionFile(sessionId, 'src/index.ts')
        expect(readFile).toHaveBeenCalledWith('machine-1', { cwd: '/workspace/project', path: 'src/index.ts' })

        spyOn(gateway, 'listDirectory').mockRejectedValue(missingTarget('session-1:listDirectory'))
        const listDirectory = spyOn(gateway, 'listWorkspaceDirectory').mockResolvedValue({ success: true, entries: [] })
        await engine.listDirectory(sessionId, 'src')
        expect(listDirectory).toHaveBeenCalledWith('machine-1', { cwd: '/workspace/project', path: 'src' })

        spyOn(gateway, 'statFiles').mockRejectedValue(missingTarget('session-1:statFiles'))
        const statFiles = spyOn(gateway, 'statWorkspaceFiles').mockResolvedValue({ success: true, entries: [] })
        await engine.statFiles(sessionId, ['src/index.ts'])
        expect(statFiles).toHaveBeenCalledWith('machine-1', { cwd: '/workspace/project', paths: ['src/index.ts'] })

        spyOn(gateway, 'runRipgrep').mockRejectedValue(missingTarget('session-1:ripgrep'))
        const ripgrep = spyOn(gateway, 'runWorkspaceRipgrep').mockResolvedValue({ success: true, stdout: 'src/index.ts\n' })
        await engine.runRipgrep(sessionId, ['--files'], '/ignored/caller/path', { query: '*.ts', limit: 20 })
        expect(ripgrep).toHaveBeenCalledWith('machine-1', {
            args: ['--files'],
            cwd: '/workspace/project',
            fileSearch: { query: '*.ts', limit: 20 }
        })

        engine.stop()
    })

    it('does not fallback for non-target errors', async () => {
        const { engine, sessionId, gateway } = createArchivedWorkspaceEngine()
        const error = new Error('RPC timed out')
        spyOn(gateway, 'readSessionFile').mockRejectedValue(error)
        const fallback = spyOn(gateway, 'readWorkspaceFile').mockResolvedValue({ success: true, content: 'YQ==' })

        const thrown = await engine.readSessionFile(sessionId, 'src/index.ts').catch((value: unknown) => value)
        expect(thrown).toBe(error)
        expect(fallback).not.toHaveBeenCalled()
        engine.stop()
    })

    it('does not fallback when the runner lacks workspace capability', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        const session = engine.getOrCreateSession(
            'inactive-running-row',
            {
                path: '/workspace/project',
                host: 'runner-host',
                machineId: 'machine-1',
                flavor: 'claude',
                lifecycleState: 'running'
            },
            null,
            'default'
        )
        engine.getOrCreateMachine(
            'machine-1',
            { host: 'runner-host', platform: 'win32', happyCliVersion: 'test' },
            { status: 'running' },
            'default'
        )
        engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

        const gateway = (engine as unknown as { rpcGateway: RpcGateway }).rpcGateway
        const error = missingTarget(`${session.id}:readFile`)
        spyOn(gateway, 'readSessionFile').mockRejectedValue(error)
        const fallback = spyOn(gateway, 'readWorkspaceFile').mockResolvedValue({ success: true, content: 'YQ==' })

        const thrown = await engine.readSessionFile(session.id, 'src/index.ts').catch((value: unknown) => value)
        expect(thrown).toBe(error)
        expect(fallback).not.toHaveBeenCalled()
        engine.stop()
    })

    it('does not fallback when the recorded machine is offline', async () => {
        const { engine, sessionId, gateway } = createArchivedWorkspaceEngine()
        const machine = engine.getMachine('machine-1')!
        machine.active = false

        const error = missingTarget(`${sessionId}:readFile`)
        spyOn(gateway, 'readSessionFile').mockRejectedValue(error)
        const fallback = spyOn(gateway, 'readWorkspaceFile').mockResolvedValue({ success: true, content: 'YQ==' })

        const thrown = await engine.readSessionFile(sessionId, 'src/index.ts').catch((value: unknown) => value)
        expect(thrown).toBe(error)
        expect(fallback).not.toHaveBeenCalled()

        engine.stop()
    })

    it('does not fallback while the session is still active', async () => {
        const { engine, sessionId, gateway } = createArchivedWorkspaceEngine()
        engine.handleSessionAlive({ sid: sessionId, time: Date.now(), thinking: false })

        const error = missingTarget(`${sessionId}:readFile`)
        spyOn(gateway, 'readSessionFile').mockRejectedValue(error)
        const fallback = spyOn(gateway, 'readWorkspaceFile').mockResolvedValue({ success: true, content: 'YQ==' })

        const thrown = await engine.readSessionFile(sessionId, 'src/index.ts').catch((value: unknown) => value)
        expect(thrown).toBe(error)
        expect(fallback).not.toHaveBeenCalled()
        engine.stop()
    })
})
