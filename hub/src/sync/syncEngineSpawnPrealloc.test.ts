import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

/**
 * #1911 Major: fresh machine spawns must preallocate a HAPI row id and pass it
 * to the runner so buildCliArgs can stamp argv before the first webhook.
 */
describe('SyncEngine.spawnSession preallocates HAPI id for fresh machine spawns', () => {
    it('creates a hub row and forwards that id as existingSessionId', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            engine.getOrCreateMachine(
                'machine-prealloc',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-prealloc', time: Date.now() })

            let forwardedExistingId: string | undefined
            ;(engine as unknown as { rpcGateway: { spawnSession: unknown } }).rpcGateway.spawnSession =
                async (
                    _machineId: string,
                    _directory: string,
                    _agent?: string,
                    _model?: string,
                    _modelReasoningEffort?: string,
                    _yolo?: boolean,
                    _sessionType?: string,
                    _worktreeName?: string,
                    _resumeSessionId?: string,
                    _effort?: string,
                    _permissionMode?: string,
                    _serviceTier?: string,
                    existingSessionId?: string
                ) => {
                    forwardedExistingId = existingSessionId
                    return { type: 'success' as const, sessionId: existingSessionId! }
                }

            const result = await engine.spawnSession(
                'machine-prealloc',
                '/tmp/project',
                'claude',
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                'default'
            )

            expect(result.type).toBe('success')
            expect(typeof forwardedExistingId).toBe('string')
            expect(forwardedExistingId!.length).toBeGreaterThan(0)
            if (result.type === 'success') {
                expect(result.sessionId).toBe(forwardedExistingId!)
            }
            const row = store.sessions.getSession(forwardedExistingId!)
            expect(row?.id).toBe(forwardedExistingId)
            const meta = row?.metadata as { flavor?: string; machineId?: string } | null
            expect(meta?.flavor).toBe('claude')
            expect(meta?.machineId).toBe('machine-prealloc')
        } finally {
            engine.stop()
        }
    })

    it('does not mint a second id when existingSessionId is already supplied', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            engine.getOrCreateMachine(
                'machine-reuse',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            const existing = engine.getOrCreateSession(
                'already-reserved',
                { path: '/tmp/project', host: 'localhost', flavor: 'opencode', machineId: 'machine-reuse' },
                null,
                'default',
                undefined,
                undefined,
                undefined,
                'already-reserved-id'
            )

            let forwardedExistingId: string | undefined
            let callCount = 0
            ;(engine as unknown as { rpcGateway: { spawnSession: unknown } }).rpcGateway.spawnSession =
                async (
                    ...args: unknown[]
                ) => {
                    callCount++
                    forwardedExistingId = args[12] as string | undefined
                    return { type: 'success' as const, sessionId: forwardedExistingId! }
                }

            const result = await engine.spawnSession(
                'machine-reuse',
                '/tmp/project',
                'opencode',
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                existing.id,
                undefined,
                undefined,
                undefined,
                'default'
            )

            expect(result).toEqual({ type: 'success', sessionId: 'already-reserved-id' })
            expect(forwardedExistingId).toBe('already-reserved-id')
            expect(callCount).toBe(1)
        } finally {
            engine.stop()
        }
    })

    it('deletes the preallocated stub when runner spawn fails', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            engine.getOrCreateMachine(
                'machine-fail',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )

            let forwardedExistingId: string | undefined
            ;(engine as unknown as { rpcGateway: { spawnSession: unknown; stopRunnerSession: unknown } })
                .rpcGateway.spawnSession = async (
                    ...args: unknown[]
                ) => {
                    forwardedExistingId = args[12] as string | undefined
                    return { type: 'error' as const, message: 'spawn blew up' }
                }
            ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } })
                .rpcGateway.stopRunnerSession = async () => 'already_gone'

            const result = await engine.spawnSession(
                'machine-fail',
                '/tmp/project',
                'claude',
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                'default'
            )

            expect(result.type).toBe('error')
            expect(typeof forwardedExistingId).toBe('string')
            expect(store.sessions.getSession(forwardedExistingId!)).toBeFalsy()
        } finally {
            engine.stop()
        }
    })
})
