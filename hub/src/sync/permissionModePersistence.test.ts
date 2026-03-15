import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { SyncEngine } from './syncEngine'

function createEngine(store?: Store): SyncEngine {
    const engine = new SyncEngine(
        store ?? new Store(':memory:'),
        {
            of: () => ({
                to: () => ({
                    emit: () => {}
                })
            })
        } as never,
        {} as never,
        {
            broadcast: () => {}
        } as never
    )
    engine.stop()
    return engine
}

describe('permission mode persistence', () => {
    it('restores saved permission mode after reloading sessions from the store', () => {
        const store = new Store(':memory:')
        const engine = createEngine(store)

        const session = engine.getOrCreateSession(
            'permission-mode-persist',
            { path: '/tmp/project', host: 'localhost' },
            { requests: {}, completedRequests: {} },
            'default'
        )

        engine.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
            permissionMode: 'yolo'
        })

        const reloadedEngine = createEngine(store)
        const reloadedSession = reloadedEngine.getSession(session.id)

        expect(reloadedSession?.metadata?.preferredPermissionMode).toBe('yolo')
        expect(reloadedSession?.permissionMode).toBe('yolo')
    })

    it('reapplies the previous permission mode when resuming an archived session', async () => {
        const engine = createEngine()

        const machine = engine.getOrCreateMachine(
            'machine-1',
            { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
            null,
            'default'
        )
        engine.handleMachineAlive({ machineId: machine.id, time: Date.now() })

        const session = engine.getOrCreateSession(
            'resume-permission-mode',
            {
                path: '/tmp/project',
                host: 'localhost',
                machineId: machine.id,
                flavor: 'codex',
                codexSessionId: 'resume-token',
                preferredPermissionMode: 'yolo'
            },
            { requests: {}, completedRequests: {} },
            'default'
        )

        const calls: Array<{ type: 'spawn' } | { type: 'config'; sessionId: string; permissionMode?: string }> = []
        const spawnSession = async () => {
            calls.push({ type: 'spawn' })
            return { type: 'success' as const, sessionId: session.id }
        }
        const requestSessionConfig = async (sessionId: string, config: { permissionMode?: string }) => {
            calls.push({ type: 'config', sessionId, permissionMode: config.permissionMode })
            return { applied: { permissionMode: config.permissionMode } }
        }

        ;(engine as any).rpcGateway = {
            spawnSession,
            requestSessionConfig
        }
        ;(engine as any).waitForSessionActive = async () => true

        const result = await engine.resumeSession(session.id, 'default')

        expect(result).toEqual({ type: 'success', sessionId: session.id })
        expect(calls).toContainEqual({ type: 'spawn' })
        expect(calls).toContainEqual({ type: 'config', sessionId: session.id, permissionMode: 'yolo' })
    })
})
