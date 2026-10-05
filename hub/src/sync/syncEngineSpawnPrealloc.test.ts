import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

/**
 * #1911 Major: fresh machine spawns must preallocate a HAPI row id and pass it
 * to the runner so buildCliArgs can stamp argv before the first webhook.
 */
describe('SyncEngine.spawnSession preallocates HAPI id for fresh machine spawns', () => {
    it('creates a hub row and forwards that id as reservedSessionId', async () => {
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
                    existingSessionId?: string,
                    _collaborationMode?: string,
                    _copilotAgentMode?: string,
                    _startingMode?: string,
                    _forkSession?: boolean,
                    reservedSessionId?: string
                ) => {
                    forwardedExistingId = reservedSessionId ?? existingSessionId
                    return { type: 'success' as const, sessionId: forwardedExistingId! }
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

    it('rejects success when runner reports a different id than the prealloc stub', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            engine.getOrCreateMachine(
                'machine-id-mismatch',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-id-mismatch', time: Date.now() })

            let reserved: string | undefined
            ;(engine as unknown as { rpcGateway: { spawnSession: unknown } }).rpcGateway.spawnSession =
                async (
                    _m: string, _d: string, _a?: string, _mo?: string, _mr?: string, _y?: boolean,
                    _st?: string, _wn?: string, _rs?: string, _e?: string, _pm?: string, _svc?: string,
                    _existing?: string, _cm?: string, _ca?: string, _sm?: string, _fs?: boolean,
                    reservedSessionId?: string
                ) => {
                    reserved = reservedSessionId
                    return { type: 'success' as const, sessionId: 'totally-different-id' }
                }

            const result = await engine.spawnSession(
                'machine-id-mismatch',
                '/tmp/project',
                'claude',
                undefined, undefined, undefined, undefined, undefined, undefined,
                undefined, undefined, undefined, undefined, undefined, undefined,
                undefined, 'default'
            )

            expect(result.type).toBe('error')
            expect(typeof reserved).toBe('string')
            expect(store.sessions.getSession(reserved!)?.tag).toBe(`machine-spawn:${reserved}`)
        } finally {
            engine.stop()
        }
    })

    it('forwards fresh Codex prealloc as reservedSessionId (not existingSessionId)', async () => {
        // #1911 Critical: existingSessionId → reopen → "no Codex thread binding".
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            engine.getOrCreateMachine(
                'machine-codex-prealloc',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-codex-prealloc', time: Date.now() })

            let forwardedExisting: string | undefined
            let forwardedReserved: string | undefined
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
                    existingSessionId?: string,
                    _collaborationMode?: string,
                    _copilotAgentMode?: string,
                    _startingMode?: string,
                    _forkSession?: boolean,
                    reservedSessionId?: string
                ) => {
                    forwardedExisting = existingSessionId
                    forwardedReserved = reservedSessionId
                    return { type: 'success' as const, sessionId: (reservedSessionId ?? existingSessionId)! }
                }

            const result = await engine.spawnSession(
                'machine-codex-prealloc',
                '/tmp/project',
                'codex',
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
            expect(forwardedExisting).toBeUndefined()
            expect(typeof forwardedReserved).toBe('string')
            expect(forwardedReserved!.length).toBeGreaterThan(0)
            const row = store.sessions.getSession(forwardedReserved!)
            expect(row?.tag).toBe(`machine-spawn:${forwardedReserved}`)
            expect((row?.metadata as { flavor?: string } | null)?.flavor).toBe('codex')
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
                    forwardedExistingId = (args[17] ?? args[12]) as string | undefined
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

    it('keeps the preallocated stub on ambiguous spawn failure even if StopSession would say gone', async () => {
        // Critical: never call stop+delete on ambiguous errors — stop kills healthy
        // late-booting children and delete CASCADE-wipes transcripts.
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
            let stopCalls = 0
            ;(engine as unknown as { rpcGateway: { spawnSession: unknown; stopRunnerSession: unknown } })
                .rpcGateway.spawnSession = async (
                    ...args: unknown[]
                ) => {
                    forwardedExistingId = (args[17] ?? args[12]) as string | undefined
                    return { type: 'error' as const, message: 'spawn blew up' }
                }
            ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } })
                .rpcGateway.stopRunnerSession = async () => {
                    stopCalls++
                    return 'already_gone'
                }

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
            expect(stopCalls).toBe(0)
            expect(store.sessions.getSession(forwardedExistingId!)?.id).toBe(forwardedExistingId)
        } finally {
            engine.stop()
        }
    })

    it('keeps the preallocated stub when StopSession cannot confirm the child is gone', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            engine.getOrCreateMachine(
                'machine-fail-alive',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )

            let forwardedExistingId: string | undefined
            let stopCalls = 0
            ;(engine as unknown as { rpcGateway: { spawnSession: unknown; stopRunnerSession: unknown } })
                .rpcGateway.spawnSession = async (
                    ...args: unknown[]
                ) => {
                    forwardedExistingId = (args[17] ?? args[12]) as string | undefined
                    return { type: 'error' as const, message: 'webhook timeout' }
                }
            ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } })
                .rpcGateway.stopRunnerSession = async () => {
                    stopCalls++
                    return 'still_alive'
                }

            const result = await engine.spawnSession(
                'machine-fail-alive',
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
            // Ambiguous spawn: never poke StopSession (would kill a healthy child).
            expect(stopCalls).toBe(0)
            expect(store.sessions.getSession(forwardedExistingId!)?.id).toBe(forwardedExistingId)
        } finally {
            engine.stop()
        }
    })

    it('deletes the stub on pre-exec rejection without StopSession (childStarted:false)', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            engine.getOrCreateMachine(
                'machine-preexec',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )

            let forwardedExistingId: string | undefined
            let stopCalls = 0
            ;(engine as unknown as { rpcGateway: { spawnSession: unknown; stopRunnerSession: unknown } })
                .rpcGateway.spawnSession = async (
                    ...args: unknown[]
                ) => {
                    forwardedExistingId = (args[17] ?? args[12]) as string | undefined
                    return {
                        type: 'error' as const,
                        message: 'claude is not installed',
                        code: 'agent_unavailable' as const,
                        childStarted: false as const,
                    }
                }
            ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } })
                .rpcGateway.stopRunnerSession = async () => {
                    stopCalls++
                    return 'unknown'
                }

            const result = await engine.spawnSession(
                'machine-preexec',
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
            expect(stopCalls).toBe(0)
            expect(store.sessions.getSession(forwardedExistingId!)).toBeFalsy()
        } finally {
            engine.stop()
        }
    })

    it('deletes the stub on directory-approval pre-exec (childStarted:false)', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            engine.getOrCreateMachine(
                'machine-dir-approve',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )

            let forwardedExistingId: string | undefined
            ;(engine as unknown as { rpcGateway: { spawnSession: unknown; stopRunnerSession: unknown } })
                .rpcGateway.spawnSession = async (
                    ...args: unknown[]
                ) => {
                    forwardedExistingId = (args[17] ?? args[12]) as string | undefined
                    return {
                        type: 'error' as const,
                        message: 'Directory creation requires approval: /tmp/new-project',
                        childStarted: false as const,
                    }
                }

            const result = await engine.spawnSession(
                'machine-dir-approve',
                '/tmp/new-project',
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
            expect(store.sessions.getSession(forwardedExistingId!)).toBeFalsy()
        } finally {
            engine.stop()
        }
    })

    it('CLI adopt binds preallocated stub under a new tag (create request path)', async () => {
        // End-to-end of the real machine-spawn path: hub preallocates, then CLI
        // create with adopt=true overwrites tag/metadata without 409.
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            engine.getOrCreateMachine(
                'machine-adopt',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )

            let allocatedId: string | undefined
            ;(engine as unknown as { rpcGateway: { spawnSession: unknown } }).rpcGateway.spawnSession =
                async (...args: unknown[]) => {
                    allocatedId = (args[17] ?? args[12]) as string | undefined
                    // Simulate CLI create/adopt before webhook success
                    const cliTag = crypto.randomUUID()
                    const adopted = engine.adoptPreallocatedSession(
                        allocatedId!,
                        cliTag,
                        {
                            path: '/tmp/project',
                            host: 'localhost',
                            flavor: 'claude',
                            machineId: 'machine-adopt',
                            startedBy: 'runner',
                            startedFromRunner: true,
                            hostPid: 999,
                        },
                        { controlledByUser: false },
                        'default',
                        'claude-sonnet'
                    )
                    expect(adopted.id).toBe(allocatedId!)
                    expect((adopted.metadata as { hostPid?: number } | null)?.hostPid).toBe(999)
                    const stored = store.sessions.getSession(allocatedId!)
                    expect(stored?.tag).toBe(cliTag)
                    return { type: 'success' as const, sessionId: allocatedId! }
                }

            const result = await engine.spawnSession(
                'machine-adopt',
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
            expect(typeof allocatedId).toBe('string')
            const row = store.sessions.getSession(allocatedId!)
            expect(row?.id).toBe(allocatedId)
            expect(row?.tag).not.toMatch(/^machine-spawn:/)
        } finally {
            engine.stop()
        }
    })

    it('keeps the stub on ambiguous spawn error (no childStarted:false) without StopSession or delete', async () => {
        // Critical: RPC timeout / post-dispatch error must not kill a healthy
        // late-booting CLI or CASCADE-delete its transcript (#1911 Overseer).
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            engine.getOrCreateMachine(
                'machine-ambiguous',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )

            let forwardedExistingId: string | undefined
            let stopCalls = 0
            ;(engine as unknown as { rpcGateway: { spawnSession: unknown; stopRunnerSession: unknown } })
                .rpcGateway.spawnSession = async (...args: unknown[]) => {
                    forwardedExistingId = (args[17] ?? args[12]) as string | undefined
                    // Same shape as rpcGateway catch/timeout: error, childStarted unset.
                    return {
                        type: 'error' as const,
                        message: 'RPC call timed out after 30000ms',
                    }
                }
            ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } })
                .rpcGateway.stopRunnerSession = async () => {
                    stopCalls++
                    return 'stopped'
                }

            const result = await engine.spawnSession(
                'machine-ambiguous',
                '/tmp/project',
                'cursor',
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
            expect(stopCalls).toBe(0)
            expect(store.sessions.getSession(forwardedExistingId!)?.id).toBe(forwardedExistingId)
            expect(store.sessions.getSession(forwardedExistingId!)?.tag).toMatch(/^machine-spawn:/)
        } finally {
            engine.stop()
        }
    })

    it('does not delete after StopSession when the row is no longer a prealloc stub', async () => {
        // Even if an older path called stop+delete, live rows must stay.
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            engine.getOrCreateMachine(
                'machine-live-protect',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )

            let allocatedId: string | undefined
            ;(engine as unknown as { rpcGateway: { spawnSession: unknown; stopRunnerSession: unknown } })
                .rpcGateway.spawnSession = async (...args: unknown[]) => {
                    allocatedId = (args[17] ?? args[12]) as string | undefined
                    // Simulate cursor/codex reopen path: metadata update releases stub tag.
                    const row = store.sessions.getSession(allocatedId!)
                    expect(row?.tag).toMatch(/^machine-spawn:/)
                    store.sessions.updateSessionMetadata(
                        allocatedId!,
                        {
                            ...(row!.metadata as object),
                            hostPid: 4242,
                            flavor: 'cursor',
                        },
                        row!.metadataVersion,
                        'default'
                    )
                    const after = store.sessions.getSession(allocatedId!)
                    expect(after?.tag).not.toMatch(/^machine-spawn:/)
                    return {
                        type: 'error' as const,
                        message: 'spawn failed after child started',
                        // childStarted unset = ambiguous
                    }
                }
            ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } })
                .rpcGateway.stopRunnerSession = async () => 'stopped'

            const result = await engine.spawnSession(
                'machine-live-protect',
                '/tmp/project',
                'cursor',
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
            expect(store.sessions.getSession(allocatedId!)?.id).toBe(allocatedId)
        } finally {
            engine.stop()
        }
    })
})
