import { describe, expect, it } from 'bun:test'
import { MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

const NAMESPACE = 'default'
const MACHINE_ID = 'reasonix-machine'

function createEngine(): SyncEngine {
    const store = new Store(':memory:')
    const engine = new SyncEngine(
        store,
        {} as never,
        new RpcRegistry(),
        { broadcast() {} } as never
    )
    engine.getOrCreateMachine(
        MACHINE_ID,
        {
            host: 'localhost',
            platform: 'linux',
            happyCliVersion: '0.1.0',
            capabilities: [MACHINE_CAPABILITIES.ReasonixAcp]
        },
        null,
        NAMESPACE
    )
    engine.handleMachineAlive({ machineId: MACHINE_ID, time: Date.now() })
    return engine
}

function createReasonixSession(
    engine: SyncEngine,
    tag: string,
    sessionId: string,
    options?: { model?: string; effort?: string; transcriptPersisted?: boolean }
) {
    return engine.getOrCreateSession(
        tag,
        {
            path: '/tmp/reasonix-project',
            host: 'localhost',
            machineId: MACHINE_ID,
            flavor: 'reasonix',
            reasonixSessionId: `native-${sessionId}`,
            reasonixTranscriptPersisted: options?.transcriptPersisted
        },
        null,
        NAMESPACE,
        options?.model,
        options?.effort,
        undefined,
        sessionId
    )
}

function readyIds(engine: SyncEngine): Set<string> {
    return (engine as unknown as { sessionReadyIds: Set<string> }).sessionReadyIds
}

function currentGeneration(engine: SyncEngine, sessionId: string): string | undefined {
    return (engine as unknown as {
        sessionGenerationById: Map<string, string>
    }).sessionGenerationById.get(sessionId)
}

describe('Reasonix readiness cleanup', () => {
    it('does not apply the Reasonix generation fence to other agent flavors', () => {
        const engine = createEngine()
        const sessionId = 'codex-reconnected-generation'
        try {
            engine.getOrCreateSession(
                'codex-reconnect',
                {
                    path: '/tmp/codex-project',
                    host: 'localhost',
                    machineId: MACHINE_ID,
                    flavor: 'codex'
                },
                null,
                NAMESPACE,
                undefined,
                undefined,
                undefined,
                sessionId
            )
            engine.handleSessionAlive({
                sid: sessionId,
                sessionGeneration: 'generation-old',
                time: Date.now()
            })
            // Hub-side inactivity/error reconciliation has no socket generation.
            engine.handleSessionEnd({ sid: sessionId, time: Date.now() + 1, reason: 'error' })
            engine.handleSessionAlive({
                sid: sessionId,
                sessionGeneration: 'generation-next',
                time: Date.now() + 2
            })

            expect(engine.getSessionByNamespace(sessionId, NAMESPACE)?.active).toBe(true)
        } finally {
            engine.stop()
        }
    })

    it('does not replay the Hub model/effort projection on native resume', async () => {
        const engine = createEngine()
        const sessionId = 'reasonix-native-config'
        try {
            createReasonixSession(engine, 'native-config-reasonix', sessionId, {
                model: 'stale-model',
                effort: 'stale-effort',
                transcriptPersisted: true
            })
            let capturedModel: string | undefined
            let capturedEffort: string | undefined
            let capturedResumeToken: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                capturedModel = args[3] as string | undefined
                capturedResumeToken = args[8] as string | undefined
                capturedEffort = args[9] as string | undefined
                return { type: 'success', sessionId }
            }
            ;(engine as any).waitForSessionActive = async () => true
            ;(engine as any).waitForSessionReady = async () => 'ready'

            const result = await engine.resumeSession(sessionId, NAMESPACE)

            expect(result).toEqual({ type: 'success', sessionId })
            expect(capturedResumeToken).toBe('native-reasonix-native-config')
            expect(capturedModel).toBeUndefined()
            expect(capturedEffort).toBeUndefined()
        } finally {
            engine.stop()
        }
    })

    it('fresh-spawns an unprompted Reasonix row instead of resuming its transient native id', async () => {
        const engine = createEngine()
        const sessionId = 'reasonix-unprompted-fresh-start'
        try {
            createReasonixSession(engine, 'unprompted-reasonix', sessionId, {
                model: 'deepseek/deepseek-v4-flash',
                effort: 'high'
            })

            expect(engine.resolveLocalResumeTarget(sessionId, NAMESPACE)).toMatchObject({
                type: 'success',
                target: { freshStart: true, agentSessionId: 'native-reasonix-unprompted-fresh-start' }
            })

            let capturedResumeToken: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                capturedResumeToken = args[8] as string | undefined
                const generation = args[17] as string
                engine.handleSessionAlive({ sid: sessionId, sessionGeneration: generation, time: Date.now() })
                return { type: 'success', sessionId }
            }
            ;(engine as any).waitForSessionActive = async () => true
            ;(engine as any).waitForSessionReady = async () => 'ready'

            await expect(engine.resumeSession(sessionId, NAMESPACE)).resolves.toEqual({
                type: 'success',
                sessionId
            })
            expect(capturedResumeToken).toBeUndefined()
        } finally {
            engine.stop()
        }
    })

    it('keeps a persisted Reasonix transcript resumable even when HAPI message history is empty', () => {
        const engine = createEngine()
        const sessionId = 'reasonix-persisted-empty-hapi-history'
        try {
            createReasonixSession(engine, 'persisted-reasonix', sessionId, { transcriptPersisted: true })

            expect(engine.resolveLocalResumeTarget(sessionId, NAMESPACE)).toMatchObject({
                type: 'success',
                target: {
                    agentSessionId: 'native-reasonix-persisted-empty-hapi-history'
                }
            })
            expect(engine.resolveLocalResumeTarget(sessionId, NAMESPACE)).not.toMatchObject({
                target: { freshStart: true }
            })
        } finally {
            engine.stop()
        }
    })

    it('does not fresh-start when the HAPI row has a prompt but the persistence bit is false', () => {
        const engine = createEngine()
        const sessionId = 'reasonix-prompt-before-metadata-ack'
        try {
            createReasonixSession(engine, 'prompt-before-metadata-ack', sessionId, {
                transcriptPersisted: false
            })
            ;(engine as unknown as { store: Store }).store.messages.addMessage(sessionId, {
                role: 'user',
                content: { type: 'text', text: 'already submitted' }
            })

            expect(engine.resolveLocalResumeTarget(sessionId, NAMESPACE)).toMatchObject({
                type: 'success',
                target: { agentSessionId: 'native-reasonix-prompt-before-metadata-ack' }
            })
            expect(engine.resolveLocalResumeTarget(sessionId, NAMESPACE)).not.toMatchObject({
                target: { freshStart: true }
            })
        } finally {
            engine.stop()
        }
    })

    it('does not fresh-start an in-flight first Reasonix turn with HAPI message history', () => {
        const engine = createEngine()
        const sessionId = 'reasonix-in-flight-first-turn'
        try {
            createReasonixSession(engine, 'in-flight-reasonix', sessionId, { transcriptPersisted: false })
            ;(engine as unknown as { store: Store }).store.messages.addMessage(sessionId, {
                role: 'user',
                content: { type: 'text', text: 'first prompt' }
            })

            expect(engine.resolveLocalResumeTarget(sessionId, NAMESPACE)).toMatchObject({
                type: 'success',
                target: {
                    agentSessionId: 'native-reasonix-in-flight-first-turn'
                }
            })
            expect(engine.resolveLocalResumeTarget(sessionId, NAMESPACE)).not.toMatchObject({
                target: { freshStart: true }
            })
        } finally {
            engine.stop()
        }
    })

    it('ignores startup status messages when deciding whether a native id is transient', () => {
        const engine = createEngine()
        const sessionId = 'reasonix-status-only-fresh-start'
        try {
            createReasonixSession(engine, 'status-only-reasonix', sessionId, { transcriptPersisted: false })
            ;(engine as unknown as { store: Store }).store.messages.addMessage(sessionId, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: { type: 'event', data: { type: 'message', message: 'ACP starting' } }
                }
            })

            expect(engine.resolveLocalResumeTarget(sessionId, NAMESPACE)).toMatchObject({
                type: 'success',
                target: { freshStart: true }
            })
        } finally {
            engine.stop()
        }
    })

    it('fails closed when a prompt appears after more than 50 startup messages', () => {
        const engine = createEngine()
        const sessionId = 'reasonix-prompt-after-status-history'
        try {
            createReasonixSession(engine, 'prompt-after-status-history', sessionId, {
                transcriptPersisted: false
            })
            const store = (engine as unknown as { store: Store }).store
            for (let index = 0; index < 51; index += 1) {
                store.messages.addMessage(sessionId, {
                    role: 'agent',
                    content: {
                        type: 'event',
                        data: { type: 'message', message: `ACP startup ${index}` }
                    }
                })
            }
            store.messages.addMessage(sessionId, {
                role: 'user',
                content: { type: 'text', text: 'submitted after startup noise' }
            })

            expect(engine.resolveLocalResumeTarget(sessionId, NAMESPACE)).not.toMatchObject({
                target: { freshStart: true }
            })
        } finally {
            engine.stop()
        }
    })

    it('fresh-starts a status-only Reasonix row when its native identity was never acknowledged', async () => {
        const engine = createEngine()
        const sessionId = 'reasonix-status-only-without-native-id'
        try {
            engine.getOrCreateSession(
                'status-only-without-native-id',
                {
                    path: '/tmp/reasonix-project',
                    host: 'localhost',
                    machineId: MACHINE_ID,
                    flavor: 'reasonix'
                },
                null,
                NAMESPACE,
                undefined,
                undefined,
                undefined,
                sessionId
            )
            const store = (engine as unknown as { store: Store }).store
            store.messages.addMessage(sessionId, {
                role: 'agent',
                content: {
                    type: 'event',
                    data: { type: 'message', message: 'ACP startup failed after metadata timeout' }
                }
            })
            expect(engine.resolveLocalResumeTarget(sessionId, NAMESPACE)).toEqual(expect.objectContaining({
                type: 'success',
                target: expect.objectContaining({ flavor: 'reasonix', freshStart: true })
            }))
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                expect(args[8]).toBeUndefined()
                const generation = args[17] as string
                engine.handleSessionAlive({ sid: sessionId, sessionGeneration: generation, time: Date.now() })
                return { type: 'success', sessionId }
            }
            ;(engine as any).waitForSessionActive = async () => true
            ;(engine as any).waitForSessionReady = async () => 'ready'

            await expect(engine.resumeSession(sessionId, NAMESPACE)).resolves.toEqual({
                type: 'success',
                sessionId
            })
        } finally {
            engine.stop()
        }
    })

    it('reconciles a fresh child as inactive when readiness times out and the runner reports it already gone', async () => {
        const engine = createEngine()
        const sessionId = 'reasonix-fresh-already-gone'
        try {
            ;(engine as any).rpcGateway.spawnSession = async () => {
                createReasonixSession(engine, 'fresh-reasonix', sessionId)
                engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
                return { type: 'success', sessionId }
            }
            ;(engine as any).waitForSessionReady = async () => 'timeout'
            ;(engine as any).rpcGateway.stopRunnerSession = async () => 'already_gone'

            const result = await engine.spawnSession(MACHINE_ID, '/tmp/reasonix-project', 'reasonix')

            expect(result).toEqual({ type: 'error', message: 'Reasonix ACP session failed to become ready' })
            expect(engine.getSessionByNamespace(sessionId, NAMESPACE)?.active).toBe(false)
            expect(readyIds(engine).has(sessionId)).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('reconciles a fresh child as inactive when the runner confirms it stopped without a session-end event', async () => {
        const engine = createEngine()
        const sessionId = 'reasonix-fresh-stopped-no-end'
        try {
            ;(engine as any).rpcGateway.spawnSession = async () => {
                createReasonixSession(engine, 'fresh-reasonix-stopped', sessionId)
                engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
                return { type: 'success', sessionId }
            }
            ;(engine as any).waitForSessionReady = async () => 'timeout'
            ;(engine as any).rpcGateway.stopRunnerSession = async () => 'stopped'

            const result = await engine.spawnSession(MACHINE_ID, '/tmp/reasonix-project', 'reasonix')

            expect(result).toEqual({ type: 'error', message: 'Reasonix ACP session failed to become ready' })
            expect(engine.getSessionByNamespace(sessionId, NAMESPACE)?.active).toBe(false)
            expect(readyIds(engine).has(sessionId)).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('fences a late first alive event after an unseen fresh child was stopped', async () => {
        const engine = createEngine()
        const sessionId = 'reasonix-fresh-late-first-alive'
        let stoppedGeneration: string | undefined
        try {
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                stoppedGeneration = args[17] as string
                createReasonixSession(engine, 'fresh-reasonix-late-alive', sessionId)
                return { type: 'success', sessionId }
            }
            ;(engine as any).waitForSessionActive = async () => false
            ;(engine as any).rpcGateway.stopRunnerSession = async () => 'already_gone'

            const result = await engine.spawnSession(MACHINE_ID, '/tmp/reasonix-project', 'reasonix')

            expect(result).toEqual({ type: 'error', message: 'Reasonix session failed to become active' })
            engine.handleSessionAlive({
                sid: sessionId,
                sessionGeneration: stoppedGeneration!,
                time: Date.now()
            })
            engine.handleSessionReady({
                sid: sessionId,
                sessionGeneration: stoppedGeneration!,
                time: Date.now() + 1
            })
            expect(engine.getSessionByNamespace(sessionId, NAMESPACE)?.active).toBe(false)
            expect(readyIds(engine).has(sessionId)).toBe(false)

            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                const retryGeneration = args[17] as string
                engine.handleSessionAlive({
                    sid: sessionId,
                    sessionGeneration: retryGeneration,
                    time: Date.now() + 2
                })
                return { type: 'success', sessionId }
            }
            ;(engine as any).waitForSessionActive = async () => true
            ;(engine as any).waitForSessionReady = async () => 'ready'

            expect(await engine.resumeSession(sessionId, NAMESPACE)).toEqual({
                type: 'success',
                sessionId
            })
            expect(engine.getSessionByNamespace(sessionId, NAMESPACE)?.active).toBe(true)
        } finally {
            engine.stop()
        }
    })

    it('fails closed when a timed-out fresh child is still alive', async () => {
        const engine = createEngine()
        const sessionId = 'reasonix-fresh-still-alive'
        try {
            ;(engine as any).rpcGateway.spawnSession = async () => {
                createReasonixSession(engine, 'fresh-reasonix-live', sessionId)
                engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
                return { type: 'success', sessionId }
            }
            ;(engine as any).waitForSessionReady = async () => 'timeout'
            ;(engine as any).rpcGateway.stopRunnerSession = async () => 'still_alive'

            const result = await engine.spawnSession(MACHINE_ID, '/tmp/reasonix-project', 'reasonix')

            expect(result).toEqual({
                type: 'error',
                message: 'Reasonix ACP session failed to become ready and is still active'
            })
            expect(engine.getSessionByNamespace(sessionId, NAMESPACE)?.active).toBe(true)
            expect(readyIds(engine).has(sessionId)).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('reconciles an in-place resume as inactive when readiness times out and the runner reports it already gone', async () => {
        const engine = createEngine()
        const sessionId = 'reasonix-resume-already-gone'
        try {
            createReasonixSession(engine, 'resume-reasonix', sessionId, { transcriptPersisted: true })
            ;(engine as any).rpcGateway.spawnSession = async () => {
                engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
                return { type: 'success', sessionId }
            }
            ;(engine as any).waitForSessionReady = async () => 'timeout'
            ;(engine as any).rpcGateway.stopRunnerSession = async () => 'already_gone'

            const result = await engine.resumeSession(sessionId, NAMESPACE)

            expect(result).toEqual({
                type: 'error',
                message: 'Reasonix ACP session failed to become ready',
                code: 'resume_failed'
            })
            expect(engine.getSessionByNamespace(sessionId, NAMESPACE)?.active).toBe(false)
            expect(readyIds(engine).has(sessionId)).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('marks a timed-out in-place resume rollback-unsafe while its child is still alive', async () => {
        const engine = createEngine()
        const sessionId = 'reasonix-resume-still-alive'
        try {
            createReasonixSession(engine, 'resume-reasonix-live', sessionId, { transcriptPersisted: true })
            ;(engine as any).rpcGateway.spawnSession = async () => {
                engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
                return { type: 'success', sessionId }
            }
            ;(engine as any).waitForSessionReady = async () => 'timeout'
            ;(engine as any).rpcGateway.stopRunnerSession = async () => 'still_alive'

            const result = await engine.resumeSession(sessionId, NAMESPACE)

            expect(result).toEqual({
                type: 'error',
                message: 'Reasonix ACP resume timed out and the child is still active',
                code: 'resume_failed',
                rollbackSafe: false
            })
            expect(engine.getSessionByNamespace(sessionId, NAMESPACE)?.active).toBe(true)
            expect(readyIds(engine).has(sessionId)).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('rejects a concurrent Reasonix resume before replacing its lifecycle generation', async () => {
        const engine = createEngine()
        const sessionId = 'reasonix-concurrent-resume'
        let firstGeneration: string | undefined
        let signalSpawnStarted!: () => void
        const spawnStarted = new Promise<void>((resolve) => {
            signalSpawnStarted = resolve
        })
        let releaseFirstReady!: () => void
        const firstReadyBlocked = new Promise<void>((resolve) => {
            releaseFirstReady = resolve
        })
        try {
            createReasonixSession(engine, 'concurrent-reasonix', sessionId, { transcriptPersisted: true })
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                firstGeneration = args[17] as string
                signalSpawnStarted()
                return { type: 'success', sessionId }
            }
            ;(engine as any).waitForSessionActive = async () => true
            ;(engine as any).waitForSessionReady = async () => {
                await firstReadyBlocked
                return 'ready'
            }

            const firstResume = engine.resumeSession(sessionId, NAMESPACE)
            await spawnStarted

            await expect(engine.resumeSession(sessionId, NAMESPACE)).resolves.toEqual({
                type: 'error',
                message: 'Reasonix resume is already in progress',
                code: 'resume_failed'
            })
            expect(currentGeneration(engine, sessionId)).toBe(firstGeneration)

            releaseFirstReady()
            await expect(firstResume).resolves.toEqual({ type: 'success', sessionId })
        } finally {
            releaseFirstReady?.()
            engine.stop()
        }
    })

    it('keeps expiry cleanup fenced until the current resume finishes', async () => {
        const engine = createEngine()
        const sessionId = 'reasonix-expiry-cleanup-race'
        let spawnCount = 0
        let releaseExpiredStop!: () => void
        const expiredStopStarted = new Promise<void>((resolve) => {
            releaseExpiredStop = resolve
        })
        let unblockExpiredStop!: () => void
        const expiredStopBlocked = new Promise<void>((resolve) => {
            unblockExpiredStop = resolve
        })
        try {
            createReasonixSession(engine, 'expiry-race-reasonix', sessionId, { transcriptPersisted: true })
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                spawnCount += 1
                const generation = args[17] as string
                engine.handleSessionAlive({ sid: sessionId, sessionGeneration: generation, time: Date.now() })
                return { type: 'success', sessionId }
            }
            ;(engine as any).waitForSessionActive = async () => true
            ;(engine as any).waitForSessionReady = async () => spawnCount === 1 ? 'ended' : 'ready'
            ;(engine as any).rpcGateway.stopRunnerSession = async () => {
                releaseExpiredStop()
                await expiredStopBlocked
                return 'already_gone'
            }

            const expiredResume = engine.resumeSession(sessionId, NAMESPACE)
            await expiredStopStarted

            // Heartbeat expiry made the row look resumable while the first
            // cleanup was still waiting for runner process-death proof.
            engine.handleSessionEnd({ sid: sessionId, time: Date.now(), reason: 'error' })
            await expect(engine.resumeSession(sessionId, NAMESPACE)).resolves.toEqual({
                type: 'error',
                message: 'Reasonix resume is already in progress',
                code: 'resume_failed'
            })
            unblockExpiredStop()
            await expect(expiredResume).resolves.toEqual({
                type: 'error',
                message: 'Reasonix ACP session ended before startup completed',
                code: 'resume_failed'
            })

            expect(engine.getSessionByNamespace(sessionId, NAMESPACE)?.active).toBe(false)
            expect(readyIds(engine).has(sessionId)).toBe(false)

            ;(engine as any).rpcGateway.stopRunnerSession = async () => 'already_gone'
            expect(await engine.resumeSession(sessionId, NAMESPACE)).toEqual({
                type: 'success',
                sessionId
            })
            expect(engine.getSessionByNamespace(sessionId, NAMESPACE)?.active).toBe(true)
        } finally {
            unblockExpiredStop?.()
            engine.stop()
        }
    })

    it('stops an expired Reasonix child before spawning a replacement generation', async () => {
        const engine = createEngine()
        const sessionId = 'reasonix-expired-late-heartbeat'
        const generation = 'expired-generation'
        const calls: string[] = []
        let replacementGeneration: string | undefined
        try {
            createReasonixSession(engine, 'expired-late-heartbeat', sessionId, { transcriptPersisted: true })
            engine.handleSessionAlive({ sid: sessionId, sessionGeneration: generation, time: Date.now() })

            const cache = (engine as unknown as {
                sessionCache: { getSession(id: string): { activeAt: number; active: boolean } | undefined }
                expireInactive(): void
            })
            const cached = cache.sessionCache.getSession(sessionId)
            expect(cached).toBeDefined()
            if (!cached) return
            cached.activeAt = Date.now() - 60_000
            cache.expireInactive()

            expect(cached.active).toBe(false)
            engine.handleSessionAlive({
                sid: sessionId,
                sessionGeneration: generation,
                time: Date.now() + 1
            })
            expect(engine.getSessionByNamespace(sessionId, NAMESPACE)?.active).toBe(false)

            ;(engine as any).rpcGateway.stopRunnerSession = async () => {
                calls.push('stop')
                return 'stopped'
            }
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                calls.push('spawn')
                replacementGeneration = args[17] as string
                engine.handleSessionAlive({
                    sid: sessionId,
                    sessionGeneration: replacementGeneration,
                    time: Date.now() + 2
                })
                return { type: 'success', sessionId }
            }
            ;(engine as any).waitForSessionActive = async () => true
            ;(engine as any).waitForSessionReady = async () => 'ready'

            await expect(engine.resumeSession(sessionId, NAMESPACE)).resolves.toEqual({
                type: 'success',
                sessionId
            })
            expect(calls).toEqual(['stop', 'spawn'])
            expect(currentGeneration(engine, sessionId)).toBe(replacementGeneration)

            engine.handleSessionEnd({
                sid: sessionId,
                sessionGeneration: generation,
                time: Date.now() + 3,
                reason: 'error'
            })
            expect(engine.getSessionByNamespace(sessionId, NAMESPACE)?.active).toBe(true)
        } finally {
            engine.stop()
        }
    })

    it('fails closed when an expired Reasonix child cannot be stopped', async () => {
        const engine = createEngine()
        const sessionId = 'reasonix-expired-child-still-alive'
        const generation = 'expired-generation'
        let spawned = false
        try {
            createReasonixSession(engine, 'expired-child-still-alive', sessionId, { transcriptPersisted: true })
            engine.handleSessionAlive({ sid: sessionId, sessionGeneration: generation, time: Date.now() })

            const cache = (engine as unknown as {
                sessionCache: { getSession(id: string): { activeAt: number } | undefined }
                expireInactive(): void
            })
            const cached = cache.sessionCache.getSession(sessionId)
            expect(cached).toBeDefined()
            if (!cached) return
            cached.activeAt = Date.now() - 60_000
            cache.expireInactive()

            ;(engine as any).rpcGateway.stopRunnerSession = async () => 'still_alive'
            ;(engine as any).rpcGateway.spawnSession = async () => {
                spawned = true
                return { type: 'success', sessionId }
            }

            await expect(engine.resumeSession(sessionId, NAMESPACE)).resolves.toEqual({
                type: 'error',
                message: 'Reasonix resume failed and the expired child is still active',
                code: 'resume_failed',
                rollbackSafe: false
            })
            expect(spawned).toBe(false)
            expect(engine.getSessionByNamespace(sessionId, NAMESPACE)?.active).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('stops an in-place child when the session ends before readiness', async () => {
        const engine = createEngine()
        const sessionId = 'reasonix-resume-ended'
        try {
            createReasonixSession(engine, 'resume-reasonix-ended', sessionId, { transcriptPersisted: true })
            ;(engine as any).rpcGateway.spawnSession = async () => {
                engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
                return { type: 'success', sessionId }
            }
            ;(engine as any).waitForSessionReady = async () => {
                engine.handleSessionEnd({ sid: sessionId, time: Date.now(), reason: 'error' })
                return 'ended'
            }
            let stoppedSessionId: string | undefined
            ;(engine as any).rpcGateway.stopRunnerSession = async (_machineId: string, stoppedId: string) => {
                stoppedSessionId = stoppedId
                return 'already_gone'
            }

            const result = await engine.resumeSession(sessionId, NAMESPACE)

            expect(result).toEqual({
                type: 'error',
                message: 'Reasonix ACP session ended before startup completed',
                code: 'resume_failed'
            })
            expect(stoppedSessionId).toBe(sessionId)
            expect(engine.getSessionByNamespace(sessionId, NAMESPACE)?.active).toBe(false)
            expect(readyIds(engine).has(sessionId)).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('does not accept a ready event delivered after the row became inactive', () => {
        const engine = createEngine()
        const sessionId = 'reasonix-late-ready'
        try {
            createReasonixSession(engine, 'late-ready-reasonix', sessionId)
            engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
            engine.handleSessionEnd({ sid: sessionId, time: Date.now(), reason: 'error' })
            engine.handleSessionReady({ sid: sessionId, time: Date.now() })

            expect(engine.getSessionByNamespace(sessionId, NAMESPACE)?.active).toBe(false)
            expect(readyIds(engine).has(sessionId)).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('fences late lifecycle events from a retired Reasonix generation', () => {
        const engine = createEngine()
        const sessionId = 'reasonix-retired-generation'
        const oldGeneration = 'generation-old'
        try {
            createReasonixSession(engine, 'retired-reasonix', sessionId)
            engine.handleSessionAlive({
                sid: sessionId,
                sessionGeneration: oldGeneration,
                time: Date.now()
            })
            engine.handleSessionEnd({
                sid: sessionId,
                sessionGeneration: oldGeneration,
                time: Date.now(),
                reason: 'error'
            })

            engine.handleSessionAlive({
                sid: sessionId,
                sessionGeneration: oldGeneration,
                time: Date.now() + 1
            })
            engine.handleSessionReady({
                sid: sessionId,
                sessionGeneration: oldGeneration,
                time: Date.now() + 2
            })

            expect(engine.getSessionByNamespace(sessionId, NAMESPACE)?.active).toBe(false)
            expect(readyIds(engine).has(sessionId)).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('ignores old ready/end after a replacement Reasonix generation starts', () => {
        const engine = createEngine()
        const sessionId = 'reasonix-replacement-generation'
        const oldGeneration = 'generation-old'
        const nextGeneration = 'generation-next'
        try {
            createReasonixSession(engine, 'replacement-reasonix', sessionId)
            engine.handleSessionAlive({
                sid: sessionId,
                sessionGeneration: oldGeneration,
                time: Date.now()
            })
            engine.handleSessionEnd({
                sid: sessionId,
                sessionGeneration: oldGeneration,
                time: Date.now(),
                reason: 'error'
            })
            engine.handleSessionAlive({
                sid: sessionId,
                sessionGeneration: nextGeneration,
                time: Date.now() + 1
            })

            engine.handleSessionReady({
                sid: sessionId,
                sessionGeneration: oldGeneration,
                time: Date.now() + 2
            })
            engine.handleSessionEnd({
                sid: sessionId,
                sessionGeneration: oldGeneration,
                time: Date.now() + 3,
                reason: 'error'
            })

            expect(engine.getSessionByNamespace(sessionId, NAMESPACE)?.active).toBe(true)
            expect(readyIds(engine).has(sessionId)).toBe(false)

            engine.handleSessionReady({
                sid: sessionId,
                sessionGeneration: nextGeneration,
                time: Date.now() + 4
            })
            expect(readyIds(engine).has(sessionId)).toBe(true)
        } finally {
            engine.stop()
        }
    })

    it('disconnects the retired Reasonix socket before replacement prompts are broadcast', () => {
        const store = new Store(':memory:')
        const disconnected: Array<{ id: string; close: boolean | undefined }> = []
        const sockets = new Map<string, {
            data: {
                clientType?: 'session-scoped' | 'machine-scoped'
                sessionId?: string
                sessionGeneration?: string
            }
            disconnect: (close?: boolean) => void
        }>()
        const io = {
            of: (namespace: string) => {
                expect(namespace).toBe('/cli')
                return {
                    sockets,
                    to: () => ({ emit: () => {} })
                }
            }
        }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const sessionId = 'reasonix-room-generation'
        const oldGeneration = 'generation-old'
        const nextGeneration = 'generation-next'
        const addSocket = (
            id: string,
            data: {
                clientType?: 'session-scoped' | 'machine-scoped'
                sessionId?: string
                sessionGeneration?: string
            }
        ) => {
            sockets.set(id, {
                data,
                disconnect: (close) => disconnected.push({ id, close })
            })
        }

        try {
            createReasonixSession(engine, 'reasonix-room', sessionId)
            engine.handleSessionAlive({ sid: sessionId, sessionGeneration: oldGeneration, time: Date.now() })
            addSocket('old-owner', {
                clientType: 'session-scoped',
                sessionId,
                sessionGeneration: oldGeneration
            })
            addSocket('next-owner', {
                clientType: 'session-scoped',
                sessionId,
                sessionGeneration: nextGeneration
            })
            addSocket('other-session', {
                clientType: 'session-scoped',
                sessionId: 'another-session',
                sessionGeneration: oldGeneration
            })
            addSocket('machine-owner', {
                clientType: 'machine-scoped',
                sessionId,
                sessionGeneration: oldGeneration
            })

            ;(engine as unknown as {
                bindSessionGeneration: (id: string, generation: string) => void
            }).bindSessionGeneration(sessionId, nextGeneration)

            expect(disconnected).toEqual([{ id: 'old-owner', close: true }])
            expect(sockets.has('next-owner')).toBe(true)
            expect(sockets.has('other-session')).toBe(true)
            expect(sockets.has('machine-owner')).toBe(true)
        } finally {
            engine.stop()
        }
    })

    it('does not let a stale owner validator reclaim a retired generation after a Hub-side end', () => {
        const engine = createEngine()
        const sessionId = 'reasonix-owner-after-end'
        const generation = 'generation-ended'
        try {
            createReasonixSession(engine, 'owner-after-end', sessionId)
            engine.handleSessionAlive({ sid: sessionId, sessionGeneration: generation, time: Date.now() })
            engine.handleSessionEnd({
                sid: sessionId,
                sessionGeneration: generation,
                time: Date.now() + 1,
                reason: 'error'
            })

            expect(engine.acceptSessionSocketOwner(sessionId, generation)).toBe(false)
            expect(engine.getSessionByNamespace(sessionId, NAMESPACE)?.active).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('evicts unknown-generation Reasonix sockets when installing the first generation after restart', () => {
        const store = new Store(':memory:')
        const disconnected: string[] = []
        const sockets = new Map<string, {
            data: { clientType?: 'session-scoped' | 'machine-scoped'; sessionId?: string; sessionGeneration?: string }
            disconnect: (close?: boolean) => void
        }>()
        const io = {
            of: () => ({ sockets })
        }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const sessionId = 'reasonix-restart-room'
        const addSocket = (id: string, data: {
            clientType?: 'session-scoped' | 'machine-scoped'
            sessionId?: string
            sessionGeneration?: string
        }) => sockets.set(id, {
            data,
            disconnect: () => disconnected.push(id)
        })

        try {
            createReasonixSession(engine, 'restart-room', sessionId)
            addSocket('unknown-old-owner', {
                clientType: 'session-scoped',
                sessionId,
                sessionGeneration: 'unknown-old-generation'
            })

            ;(engine as unknown as {
                prepareSessionGeneration: (id: string, generation: string) => void
            }).prepareSessionGeneration(sessionId, 'generation-after-restart')

            expect(disconnected).toEqual(['unknown-old-owner'])
        } finally {
            engine.stop()
        }
    })
})
