import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

describe('SyncEngine codex import orchestration', () => {
    it('returns the existing hapi session when the external codex session is already imported', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'import-existing',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-1'
                },
                null,
                'default'
            )

            const result = await engine.importExternalCodexSession('codex-thread-1', 'default')

            expect(result).toEqual({
                type: 'success',
                sessionId: session.id
            })
        } finally {
            engine.stop()
        }
    })

    it('imports a codex session by resuming the external session id on an online machine', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const machine = engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: machine.id, time: Date.now() })

            let capturedSpawnArgs: unknown[] | null = null
            ;(engine as any).rpcGateway.listImportableSessions = async (_machineId: string, request: { agent: string }) => {
                expect(request).toEqual({ agent: 'codex' })
                return {
                    sessions: [
                        {
                            agent: 'codex',
                            externalSessionId: 'codex-thread-1',
                            cwd: '/tmp/project',
                            timestamp: 123,
                            transcriptPath: '/tmp/project/.codex/sessions/codex-thread-1.jsonl',
                            previewTitle: 'Imported title',
                            previewPrompt: 'Imported prompt'
                        }
                    ]
                }
            }
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                capturedSpawnArgs = args
                return { type: 'success', sessionId: 'spawned-session' }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.importExternalCodexSession('codex-thread-1', 'default')

            expect(result).toEqual({
                type: 'success',
                sessionId: 'spawned-session'
            })
            if (capturedSpawnArgs === null) {
                throw new Error('spawn args were not captured')
            }
            const importSpawnArgs = capturedSpawnArgs as unknown[]
            if (importSpawnArgs.length !== 10) {
                throw new Error(`unexpected spawn args length: ${importSpawnArgs.length}`)
            }
            if (importSpawnArgs[0] !== 'machine-1') {
                throw new Error(`unexpected spawn target: ${String(importSpawnArgs[0])}`)
            }
            if (importSpawnArgs[1] !== '/tmp/project') {
                throw new Error(`unexpected spawn directory: ${String(importSpawnArgs[1])}`)
            }
            if (importSpawnArgs[2] !== 'codex') {
                throw new Error(`unexpected spawn agent: ${String(importSpawnArgs[2])}`)
            }
            if (importSpawnArgs[8] !== 'codex-thread-1') {
                throw new Error(`unexpected resume session id: ${String(importSpawnArgs[8])}`)
            }
        } finally {
            engine.stop()
        }
    })

    it('preserves the Codex preview title in imported session metadata', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const machine = engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: machine.id, time: Date.now() })

            ;(engine as any).rpcGateway.listImportableSessions = async () => ({
                sessions: [
                    {
                        agent: 'codex',
                        externalSessionId: 'codex-thread-1',
                        cwd: '/tmp/project',
                        timestamp: 123,
                        transcriptPath: '/tmp/project/.codex/sessions/codex-thread-1.jsonl',
                        previewTitle: 'Useful imported title',
                        previewPrompt: 'Fallback prompt'
                    }
                ]
            })
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                const imported = engine.getOrCreateSession(
                    'spawned-import-session',
                    {
                        path: '/tmp/project',
                        host: 'localhost',
                        machineId: 'machine-1',
                        flavor: 'codex',
                        codexSessionId: 'codex-thread-1'
                    },
                    null,
                    'default'
                )
                return { type: 'success', sessionId: imported.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.importExternalCodexSession('codex-thread-1', 'default')

            expect(result.type).toBe('success')
            if (result.type !== 'success') {
                throw new Error(result.message)
            }
            const imported = engine.getSession(result.sessionId)
            expect(imported?.metadata?.name).toBe('Useful imported title')
        } finally {
            engine.stop()
        }
    })

    it('removes a spawned session when import fails to become active', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const machine = engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: machine.id, time: Date.now() })

            ;(engine as any).rpcGateway.listImportableSessions = async () => ({
                sessions: [
                    {
                        agent: 'codex',
                        externalSessionId: 'codex-thread-1',
                        cwd: '/tmp/project',
                        timestamp: 123,
                        transcriptPath: '/tmp/project/.codex/sessions/codex-thread-1.jsonl',
                        previewTitle: 'Imported title',
                        previewPrompt: 'Imported prompt'
                    }
                ]
            })
            ;(engine as any).rpcGateway.spawnSession = async () => {
                const spawned = engine.getOrCreateSession(
                    'spawned-import-session',
                    {
                        path: '/tmp/project',
                        host: 'localhost',
                        machineId: 'machine-1',
                        flavor: 'codex',
                        codexSessionId: 'codex-thread-1'
                    },
                    null,
                    'default'
                )
                return { type: 'success', sessionId: spawned.id }
            }
            ;(engine as any).waitForSessionActive = async () => false

            const result = await engine.importExternalCodexSession('codex-thread-1', 'default')

            expect(result).toEqual({
                type: 'error',
                message: 'Session failed to become active',
                code: 'import_failed'
            })
            expect(engine.findSessionByExternalCodexSessionId('default', 'codex-thread-1')).toBeNull()
            expect(engine.getSessionsByNamespace('default')).toHaveLength(0)
        } finally {
            engine.stop()
        }
    })

    it('returns session_not_found when the requested external codex session is missing', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const machine = engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: machine.id, time: Date.now() })

            ;(engine as any).rpcGateway.listImportableSessions = async () => ({ sessions: [] })

            const result = await engine.importExternalCodexSession('missing-codex-thread', 'default')

            expect(result).toEqual({
                type: 'error',
                message: 'Importable Codex session not found',
                code: 'session_not_found'
            })
        } finally {
            engine.stop()
        }
    })

    it('refreshes an imported codex session in place', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const machine = engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: machine.id, time: Date.now() })

            const imported = engine.getOrCreateSession(
                'imported-codex-session',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-1'
                },
                null,
                'default'
            )

            let capturedSpawnArgs: unknown[] | null = null
            let capturedMergeArgs: unknown[] | null = null
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                capturedSpawnArgs = args
                return { type: 'success', sessionId: 'spawned-codex-session' }
            }
            ;(engine as any).waitForSessionActive = async () => true
            ;(engine as any).sessionCache.mergeSessions = async (...args: unknown[]) => {
                capturedMergeArgs = args
            }

            const result = await engine.refreshExternalCodexSession('codex-thread-1', 'default')

            expect(result).toEqual({
                type: 'success',
                sessionId: imported.id
            })
            if (capturedSpawnArgs === null) {
                throw new Error('spawn args were not captured')
            }
            const refreshSpawnArgs = capturedSpawnArgs as unknown[]
            if (refreshSpawnArgs.length !== 10) {
                throw new Error(`unexpected spawn args length: ${refreshSpawnArgs.length}`)
            }
            if (refreshSpawnArgs[0] !== 'machine-1') {
                throw new Error(`unexpected spawn target: ${String(refreshSpawnArgs[0])}`)
            }
            if (refreshSpawnArgs[1] !== '/tmp/project') {
                throw new Error(`unexpected spawn directory: ${String(refreshSpawnArgs[1])}`)
            }
            if (refreshSpawnArgs[2] !== 'codex') {
                throw new Error(`unexpected spawn agent: ${String(refreshSpawnArgs[2])}`)
            }
            if (refreshSpawnArgs[8] !== 'codex-thread-1') {
                throw new Error(`unexpected resume session id: ${String(refreshSpawnArgs[8])}`)
            }
            if (capturedMergeArgs === null) {
                throw new Error('merge args were not captured')
            }
            const refreshMergeArgs = capturedMergeArgs as unknown[]
            if (refreshMergeArgs.length !== 3) {
                throw new Error(`unexpected merge args length: ${refreshMergeArgs.length}`)
            }
            if (refreshMergeArgs[0] !== 'spawned-codex-session') {
                throw new Error(`unexpected merge old session id: ${String(refreshMergeArgs[0])}`)
            }
            if (refreshMergeArgs[1] !== imported.id) {
                throw new Error(`unexpected merge new session id: ${String(refreshMergeArgs[1])}`)
            }
            if (refreshMergeArgs[2] !== 'default') {
                throw new Error(`unexpected merge namespace: ${String(refreshMergeArgs[2])}`)
            }
            expect(engine.findSessionByExternalCodexSessionId('default', 'codex-thread-1')).toEqual({
                sessionId: imported.id
            })
            expect(engine.getSession(imported.id)).toBeDefined()
        } finally {
            engine.stop()
        }
    })

    it('falls back to the Codex preview prompt when refreshing imported session metadata', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const machine = engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: machine.id, time: Date.now() })

            const imported = engine.getOrCreateSession(
                'imported-codex-session',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-1'
                },
                null,
                'default'
            )

            ;(engine as any).rpcGateway.listImportableSessions = async () => ({
                sessions: [
                    {
                        agent: 'codex',
                        externalSessionId: 'codex-thread-1',
                        cwd: '/tmp/project',
                        timestamp: 123,
                        transcriptPath: '/tmp/project/.codex/sessions/codex-thread-1.jsonl',
                        previewTitle: null,
                        previewPrompt: 'Prompt fallback title'
                    }
                ]
            })
            ;(engine as any).rpcGateway.spawnSession = async () => {
                const spawned = engine.getOrCreateSession(
                    'spawned-codex-session',
                    {
                        path: '/tmp/project',
                        host: 'localhost',
                        machineId: 'machine-1',
                        flavor: 'codex',
                        codexSessionId: 'codex-thread-1'
                    },
                    null,
                    'default'
                )
                return { type: 'success', sessionId: spawned.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.refreshExternalCodexSession('codex-thread-1', 'default')

            expect(result).toEqual({
                type: 'success',
                sessionId: imported.id
            })
            expect(engine.getSession(imported.id)?.metadata?.name).toBe('Prompt fallback title')
        } finally {
            engine.stop()
        }
    })

    it('keeps the existing imported mapping when refresh merge fails', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const machine = engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: machine.id, time: Date.now() })

            const imported = engine.getOrCreateSession(
                'imported-codex-session',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-1'
                },
                null,
                'default'
            )

            ;(engine as any).rpcGateway.spawnSession = async () => {
                const spawned = engine.getOrCreateSession(
                    'spawned-codex-session',
                    {
                        path: '/tmp/project',
                        host: 'localhost',
                        machineId: 'machine-1',
                        flavor: 'codex',
                        codexSessionId: 'codex-thread-1'
                    },
                    null,
                    'default'
                )
                return { type: 'success', sessionId: spawned.id }
            }
            ;(engine as any).waitForSessionActive = async () => true
            ;(engine as any).sessionCache.mergeSessions = async () => {
                throw new Error('merge failed')
            }

            const result = await engine.refreshExternalCodexSession('codex-thread-1', 'default')

            expect(result).toEqual({
                type: 'error',
                message: 'merge failed',
                code: 'refresh_failed'
            })
            expect(engine.findSessionByExternalCodexSessionId('default', 'codex-thread-1')).toEqual({
                sessionId: imported.id
            })
            expect(engine.getSessionsByNamespace('default')).toHaveLength(1)
        } finally {
            engine.stop()
        }
    })

    it('rolls back partial merge work when refresh merge fails mid-transaction', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const machine = engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: machine.id, time: Date.now() })

            const imported = engine.getOrCreateSession(
                'imported-codex-session',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-1'
                },
                null,
                'default',
                'gpt-5.4'
            )
            store.messages.addMessage(imported.id, { text: 'existing message' })

            const originalDeleteSession = store.sessions.deleteSession.bind(store.sessions)
            ;(engine as any).rpcGateway.spawnSession = async () => {
                const spawned = engine.getOrCreateSession(
                    'spawned-codex-session',
                    {
                        path: '/tmp/project',
                        host: 'localhost',
                        machineId: 'machine-1',
                        flavor: 'codex',
                        codexSessionId: 'codex-thread-1'
                    },
                    null,
                    'default'
                )
                store.messages.addMessage(spawned.id, { text: 'new message' })
                return { type: 'success', sessionId: spawned.id }
            }
            ;(engine as any).waitForSessionActive = async () => true
            store.sessions.deleteSession = () => false

            const result = await engine.refreshExternalCodexSession('codex-thread-1', 'default')

            expect(result).toEqual({
                type: 'error',
                message: 'Failed to delete old session during merge',
                code: 'refresh_failed'
            })
            expect(engine.getMessagesPage(imported.id, { limit: 10, beforeSeq: null }).messages).toHaveLength(1)

            store.sessions.deleteSession = originalDeleteSession
        } finally {
            engine.stop()
        }
    })
})
