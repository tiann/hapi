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
            ;(engine as any).waitForSessionSettled = async () => true

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
            ;(engine as any).waitForSessionSettled = async () => true

            const result = await engine.importExternalCodexSession('codex-thread-1', 'default')

            expect(result.type).toBe('success')
            if (result.type !== 'success') {
                throw new Error('expected success result')
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
            ;(engine as any).waitForSessionSettled = async () => false

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

    it('re-imports an imported codex session into a new HAPI session', async () => {
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
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                capturedSpawnArgs = args
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
            ;(engine as any).waitForSessionSettled = async () => true

            const result = await engine.refreshExternalCodexSession('codex-thread-1', 'default')

            expect(result.type).toBe('success')
            if (result.type !== 'success') {
                throw new Error('expected success result')
            }
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
            expect(engine.findSessionByExternalCodexSessionId('default', 'codex-thread-1')).toEqual({
                sessionId: result.sessionId
            })
            expect(engine.getSession(imported.id)).toBeDefined()
            expect(engine.getSession(imported.id)?.metadata?.codexSessionId).toBeUndefined()
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
            ;(engine as any).waitForSessionSettled = async () => true

            const result = await engine.refreshExternalCodexSession('codex-thread-1', 'default')

            expect(result.type).toBe('success')
            if (result.type !== 'success') {
                throw new Error('expected success result')
            }
            expect(engine.getSession(result.sessionId)?.metadata?.name).toBe('Prompt fallback title')
            expect(engine.getSession(imported.id)?.metadata?.codexSessionId).toBeUndefined()
        } finally {
            engine.stop()
        }
    })

    it('keeps the existing imported mapping when re-import replacement fails', async () => {
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
            ;(engine as any).waitForSessionSettled = async () => true
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
            ;(engine as any).store.sessions.updateSessionMetadata = () => ({ result: 'error' })

            const result = await engine.refreshExternalCodexSession('codex-thread-1', 'default')

            expect(result).toEqual({
                type: 'error',
                message: 'Failed to detach old imported session mapping',
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
})

describe('SyncEngine claude import orchestration', () => {
    it('returns the existing hapi session when the external claude session is already imported', async () => {
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
                    flavor: 'claude',
                    claudeSessionId: 'claude-thread-1'
                },
                null,
                'default'
            )

            const result = await engine.importExternalClaudeSession('claude-thread-1', 'default')

            expect(result).toEqual({
                type: 'success',
                sessionId: session.id
            })
        } finally {
            engine.stop()
        }
    })

    it('imports a claude session by resuming the external session id on an online machine', async () => {
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
                expect(request).toEqual({ agent: 'claude' })
                return {
                    sessions: [
                        {
                            agent: 'claude',
                            externalSessionId: 'claude-thread-1',
                            cwd: '/tmp/project',
                            timestamp: 123,
                            transcriptPath: '/tmp/project/.claude/projects/project/claude-thread-1.jsonl',
                            previewTitle: 'Imported Claude title',
                            previewPrompt: 'Imported Claude prompt'
                        }
                    ]
                }
            }
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                capturedSpawnArgs = args
                const imported = engine.getOrCreateSession(
                    'spawned-claude-session',
                    {
                        path: '/tmp/project',
                        host: 'localhost',
                        machineId: 'machine-1',
                        flavor: 'claude',
                        claudeSessionId: 'claude-thread-1'
                    },
                    null,
                    'default'
                )
                return { type: 'success', sessionId: imported.id }
            }
            ;(engine as any).waitForSessionSettled = async () => true

            const result = await engine.importExternalClaudeSession('claude-thread-1', 'default')

            expect(result.type).toBe('success')
            if (result.type !== 'success') {
                throw new Error('expected success result')
            }
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
            if (importSpawnArgs[2] !== 'claude') {
                throw new Error(`unexpected spawn agent: ${String(importSpawnArgs[2])}`)
            }
            if (importSpawnArgs[8] !== 'claude-thread-1') {
                throw new Error(`unexpected resume session id: ${String(importSpawnArgs[8])}`)
            }
            expect(engine.getSession(result.sessionId)?.metadata?.name).toBe('Imported Claude title')
        } finally {
            engine.stop()
        }
    })

    it('re-imports an imported claude session into a new HAPI session', async () => {
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
                'imported-claude-session',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'claude',
                    claudeSessionId: 'claude-thread-1'
                },
                null,
                'default'
            )

            let capturedSpawnArgs: unknown[] | null = null
            ;(engine as any).rpcGateway.listImportableSessions = async (_machineId: string, request: { agent: string }) => {
                expect(request).toEqual({ agent: 'claude' })
                return {
                    sessions: [
                        {
                            agent: 'claude',
                            externalSessionId: 'claude-thread-1',
                            cwd: '/tmp/project',
                            timestamp: 123,
                            transcriptPath: '/tmp/project/.claude/projects/project/claude-thread-1.jsonl',
                            previewTitle: null,
                            previewPrompt: 'Prompt fallback title'
                        }
                    ]
                }
            }
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                capturedSpawnArgs = args
                const spawned = engine.getOrCreateSession(
                    'spawned-claude-session',
                    {
                        path: '/tmp/project',
                        host: 'localhost',
                        machineId: 'machine-1',
                        flavor: 'claude',
                        claudeSessionId: 'claude-thread-1'
                    },
                    null,
                    'default'
                )
                return { type: 'success', sessionId: spawned.id }
            }
            ;(engine as any).waitForSessionSettled = async () => true

            const result = await engine.refreshExternalClaudeSession('claude-thread-1', 'default')

            expect(result.type).toBe('success')
            if (result.type !== 'success') {
                throw new Error('expected success result')
            }
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
            if (refreshSpawnArgs[2] !== 'claude') {
                throw new Error(`unexpected spawn agent: ${String(refreshSpawnArgs[2])}`)
            }
            if (refreshSpawnArgs[8] !== 'claude-thread-1') {
                throw new Error(`unexpected resume session id: ${String(refreshSpawnArgs[8])}`)
            }
            expect(engine.findSessionByExternalClaudeSessionId('default', 'claude-thread-1')).toEqual({
                sessionId: result.sessionId
            })
            expect(engine.getSession(imported.id)?.metadata?.claudeSessionId).toBeUndefined()
            expect(engine.getSession(result.sessionId)?.metadata?.name).toBe('Prompt fallback title')
        } finally {
            engine.stop()
        }
    })
})
