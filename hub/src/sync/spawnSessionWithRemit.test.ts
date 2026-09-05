import { describe, expect, it, mock } from 'bun:test'
import { createHash } from 'node:crypto'
import type { SpawnSessionWithRemitRequest } from '@hapi/protocol/apiTypes'
import type { SpawnRemitOperation } from '@hapi/protocol/schemas'
import { SyncEngine } from './syncEngine'
import { RpcTargetMissingError } from './rpcGateway'

const SESSION_ID = '05d9f0f2-9273-4137-933c-07459a1146a2'
const EXISTING_ID = '6acb2b8a-1334-4955-b0c6-86f5a22656d2'
const REQUEST: SpawnSessionWithRemitRequest = {
    directory: '/tmp/project',
    message: 'implement issue',
    agent: 'codex',
    remitId: '7ee03698-0fe7-4f76-b8a8-d84f4eddbf5c',
    name: 'Worker'
}

function callSpawn(harness: Record<string, unknown>, request: SpawnSessionWithRemitRequest = REQUEST) {
    const requestHash = hashRequest(request)
    const reserved = {
        id: SESSION_ID,
        namespace: 'default',
        active: false,
        metadata: {
            machineId: 'machine-1',
            path: '/tmp/project',
            flavor: 'codex',
            spawnRemitOperation: {
                remitId: request.remitId,
                requestHash,
                machineId: 'machine-1',
                state: 'pending',
                updatedAt: 1
            }
        },
        model: null,
        modelReasoningEffort: null,
        effort: null,
        permissionMode: undefined
    }
    return SyncEngine.prototype.spawnSessionWithRemit.call({
        spawnRemitTails: new Map(),
        spawnSessionWithRemitOnce: (SyncEngine.prototype as unknown as {
            spawnSessionWithRemitOnce: SyncEngine['spawnSessionWithRemit']
        }).spawnSessionWithRemitOnce,
        getOrCreateSession: () => reserved,
        getQueuedState: () => ({ queuedLocalIds: [], invokedLocalMessages: [] }),
        persistSpawnRemitOperation: () => true,
        isSpawnRemitStored: (SyncEngine.prototype as unknown as {
            isSpawnRemitStored: (sessionId: string, remitId: string) => boolean
        }).isSpawnRemitStored,
        finishSpawnRemitCleanup: (SyncEngine.prototype as unknown as {
            finishSpawnRemitCleanup: SyncEngine['spawnSessionWithRemit']
        }).finishSpawnRemitCleanup,
        buildSpawnRemitSuccess: (SyncEngine.prototype as unknown as {
            buildSpawnRemitSuccess: SyncEngine['spawnSessionWithRemit']
        }).buildSpawnRemitSuccess,
        ...harness
    } as unknown as SyncEngine, 'machine-1', 'default', request)
}

function hashRequest(request: SpawnSessionWithRemitRequest): string {
    return createHash('sha256')
        .update(JSON.stringify(['machine-1', ...Object.entries(request).sort(([a], [b]) => a.localeCompare(b))]))
        .digest('hex')
}

async function callReconcile(operation: SpawnRemitOperation, harness: Record<string, unknown>): Promise<Map<string, unknown>> {
    const reconcile = (SyncEngine.prototype as unknown as {
        reconcileSpawnRemitCleanups: () => Promise<void>
    }).reconcileSpawnRemitCleanups
    const taskMap = new Map<string, unknown>()
    await reconcile.call({
        sessionCache: {
            getSessions: () => [{
                id: SESSION_ID,
                namespace: 'default',
                metadata: { spawnRemitOperation: operation }
            }]
        },
        getMachineByNamespace: () => ({ active: true }),
        spawnRemitTails: taskMap,
        isSpawnRemitStored: (SyncEngine.prototype as unknown as {
            isSpawnRemitStored: (sessionId: string, remitId: string) => boolean
        }).isSpawnRemitStored,
        finishSpawnRemitCleanup: (SyncEngine.prototype as unknown as {
            finishSpawnRemitCleanup: (
                sessionId: string,
                namespace: string,
                operation: SpawnRemitOperation
            ) => Promise<unknown>
        }).finishSpawnRemitCleanup,
        ...harness
    } as unknown as SyncEngine)
    return taskMap
}

describe('spawnSessionWithRemit', () => {
    it('coalesces concurrent retries for the same remit', async () => {
        let finish!: (result: { type: 'error'; code: string; message: string }) => void
        const resultPromise = new Promise<{ type: 'error'; code: string; message: string }>((resolve) => { finish = resolve })
        const spawnSessionWithRemitOnce = mock(async () => await resultPromise)
        const harness = { spawnRemitTails: new Map(), spawnSessionWithRemitOnce } as unknown as SyncEngine

        const first = SyncEngine.prototype.spawnSessionWithRemit.call(harness, 'machine-1', 'default', REQUEST)
        const conflict = await SyncEngine.prototype.spawnSessionWithRemit.call(
            harness,
            'machine-1',
            'default',
            { ...REQUEST, message: 'different work' }
        )
        const retry = SyncEngine.prototype.spawnSessionWithRemit.call(harness, 'machine-1', 'default', REQUEST)
        finish({ type: 'error', code: 'spawn_timeout', message: 'timeout' })

        expect(conflict).toMatchObject({ type: 'error', code: 'remit_conflict' })
        await expect(Promise.all([first, retry])).resolves.toEqual([
            { type: 'error', code: 'spawn_timeout', message: 'timeout' },
            { type: 'error', code: 'spawn_timeout', message: 'timeout' }
        ])
        expect(spawnSessionWithRemitOnce).toHaveBeenCalledTimes(1)
    })

    it('never waits for, cleans up, or messages an unexpected returned id', async () => {
        const waitForSessionActive = mock(async () => true)
        const waitForSessionReady = mock(async () => 'ready' as const)
        const cleanupSpawnedSession = mock(async () => true)
        const sendMessage = mock(async () => {})
        const result = await callSpawn({
            spawnSession: async () => ({ type: 'success', sessionId: EXISTING_ID }),
            waitForSessionActive,
            waitForSessionReady,
            cleanupSpawnedSession,
            sendMessage
        })

        expect(result).toEqual({
            type: 'error',
            code: 'spawn_not_fresh',
            message: 'Runner returned an unexpected session id; it was not stopped',
            childSessionId: EXISTING_ID,
            cleanedUp: false
        })
        expect(waitForSessionActive).not.toHaveBeenCalled()
        expect(waitForSessionReady).not.toHaveBeenCalled()
        expect(cleanupSpawnedSession).toHaveBeenCalledWith('machine-1', 'default', SESSION_ID)
        expect(cleanupSpawnedSession).not.toHaveBeenCalledWith('machine-1', 'default', EXISTING_ID)
        expect(sendMessage).not.toHaveBeenCalled()
    })

    it('returns the original preflight error after archiving a no-child reservation', async () => {
        const requestHash = hashRequest(REQUEST)
        const child = {
            id: SESSION_ID,
            namespace: 'default',
            active: false,
            metadata: {
                machineId: 'machine-1',
                path: '/tmp/project',
                flavor: 'codex',
                spawnRemitOperation: {
                    remitId: REQUEST.remitId,
                    requestHash,
                    machineId: 'machine-1',
                    state: 'pending' as const,
                    updatedAt: 1
                }
            },
            model: null,
            modelReasoningEffort: null,
            effort: null,
            permissionMode: undefined
        }
        const stopRunnerSession = mock(async () => 'already_gone' as const)
        const markSessionArchivedFromHub = mock(() => {})

        const result = await callSpawn({
            getOrCreateSession: () => child,
            getSessionByNamespace: () => child,
            spawnSession: async () => ({
                type: 'error',
                code: 'agent_unavailable',
                message: 'Codex is unavailable'
            }),
            cleanupSpawnedSession: (SyncEngine.prototype as unknown as {
                cleanupSpawnedSession: (machineId: string, namespace: string, sessionId: string) => Promise<boolean>
            }).cleanupSpawnedSession,
            rpcGateway: { stopRunnerSession },
            handleSessionEnd: mock(() => {}),
            sessionCache: { markSessionArchivedFromHub }
        })

        expect(result).toEqual({
            type: 'error',
            code: 'agent_unavailable',
            message: 'Codex is unavailable',
            childSessionId: SESSION_ID,
            cleanedUp: true
        })
        expect(stopRunnerSession).toHaveBeenCalledWith('machine-1', SESSION_ID)
        expect(markSessionArchivedFromHub).toHaveBeenCalledWith(SESSION_ID, 'Failed atomic spawn-with-remit')
    })

    it('returns the same child without spawning or redelivering after a lost success response', async () => {
        const spawnSession = mock(async () => ({ type: 'success' as const, sessionId: SESSION_ID }))
        const sendMessage = mock(async () => {})
        const requestHash = hashRequest(REQUEST)
        const result = await callSpawn({
            getOrCreateSession: () => ({
                id: SESSION_ID,
                namespace: 'default',
                active: true,
                metadata: {
                    machineId: 'machine-1',
                    path: '/tmp/project',
                    flavor: 'codex',
                    name: 'Worker',
                    spawnRemitOperation: {
                        remitId: REQUEST.remitId,
                        requestHash,
                        machineId: 'machine-1',
                        state: 'completed',
                        updatedAt: 2
                    }
                },
                model: null,
                modelReasoningEffort: null,
                effort: null,
                permissionMode: undefined
            }),
            spawnSession,
            sendMessage
        })

        expect(result).toMatchObject({ type: 'success', sessionId: SESSION_ID, remitId: REQUEST.remitId })
        expect(spawnSession).not.toHaveBeenCalled()
        expect(sendMessage).not.toHaveBeenCalled()
    })

    it.each([
        ['cursor', { cursorSessionId: 'cursor-native', cursorSessionProtocol: 'acp' }],
        ['pi', { piSessionId: 'pi-native' }]
    ] as const)('recovers a pending ready %s child after a Hub restart', async (agent, nativeMetadata) => {
        const request = { ...REQUEST, agent, waitActiveSecs: 0.001 }
        let delivered = false
        const cleanupSpawnedSession = mock(async () => true)
        const child = {
            id: SESSION_ID,
            namespace: 'default',
            active: true,
            metadata: {
                machineId: 'machine-1',
                path: '/tmp/project',
                flavor: agent,
                ...nativeMetadata,
                spawnRemitOperation: {
                    remitId: request.remitId,
                    requestHash: hashRequest(request),
                    machineId: 'machine-1',
                    state: 'pending',
                    updatedAt: 1
                }
            },
            model: null,
            modelReasoningEffort: null,
            effort: null,
            permissionMode: undefined
        }

        const result = await callSpawn({
            getOrCreateSession: () => child,
            getSession: () => child,
            getSessionByNamespace: () => child,
            sessionReadyIds: new Set(),
            waitForSessionActive: async () => true,
            waitForSessionReady: SyncEngine.prototype.waitForSessionReady,
            renameSession: async () => {},
            sendMessage: async () => { delivered = true },
            getQueuedState: () => ({ queuedLocalIds: delivered ? [request.remitId] : [], invokedLocalMessages: [] }),
            cleanupSpawnedSession
        }, request)

        expect(result).toMatchObject({ type: 'success', sessionId: SESSION_ID })
        expect(cleanupSpawnedSession).not.toHaveBeenCalled()
    })

    it('reconciles persisted cleanup after a Hub restart', async () => {
        const operation = {
            remitId: REQUEST.remitId,
            requestHash: hashRequest(REQUEST),
            machineId: 'machine-1',
            state: 'cleanup-needed' as const,
            updatedAt: 1,
            code: 'remit_delivery_failed',
            error: 'delivery failed',
            cleanedUp: false
        }
        const cleanupSpawnedSession = mock(async () => true)
        const persistSpawnRemitOperation = mock(() => true)
        const taskMap = await callReconcile(operation, {
            cleanupSpawnedSession,
            persistSpawnRemitOperation
        })

        expect(cleanupSpawnedSession).toHaveBeenCalledWith('machine-1', 'default', SESSION_ID)
        expect(persistSpawnRemitOperation).toHaveBeenCalledWith(
            SESSION_ID,
            'default',
            operation,
            expect.objectContaining({ state: 'failed', cleanedUp: true })
        )
        expect(taskMap.size).toBe(0)
    })

    it('marks a pending spawn completed after restart when its remit is stored', async () => {
        const operation: SpawnRemitOperation = {
            remitId: REQUEST.remitId,
            requestHash: hashRequest(REQUEST),
            machineId: 'machine-1',
            state: 'pending',
            updatedAt: 1
        }
        const cleanupSpawnedSession = mock(async () => true)
        const persistSpawnRemitOperation = mock(() => true)

        await callReconcile(operation, {
            getQueuedState: () => ({ queuedLocalIds: [REQUEST.remitId], invokedLocalMessages: [] }),
            cleanupSpawnedSession,
            persistSpawnRemitOperation
        })

        expect(persistSpawnRemitOperation).toHaveBeenCalledWith(
            SESSION_ID,
            'default',
            operation,
            expect.objectContaining({ state: 'completed' })
        )
        expect(cleanupSpawnedSession).not.toHaveBeenCalled()
    })

    it('cleans up a pending spawn after restart when its remit was not stored', async () => {
        const operation: SpawnRemitOperation = {
            remitId: REQUEST.remitId,
            requestHash: hashRequest(REQUEST),
            machineId: 'machine-1',
            state: 'pending',
            updatedAt: 1
        }
        const cleanupSpawnedSession = mock(async () => true)
        const persistSpawnRemitOperation = mock(() => true)

        await callReconcile(operation, {
            getQueuedState: () => ({ queuedLocalIds: [], invokedLocalMessages: [] }),
            cleanupSpawnedSession,
            persistSpawnRemitOperation
        })

        expect(persistSpawnRemitOperation).toHaveBeenNthCalledWith(
            1,
            SESSION_ID,
            'default',
            operation,
            expect.objectContaining({ state: 'cleanup-needed', code: 'spawn_interrupted' })
        )
        expect(persistSpawnRemitOperation).toHaveBeenNthCalledWith(
            2,
            SESSION_ID,
            'default',
            expect.objectContaining({ state: 'cleanup-needed' }),
            expect.objectContaining({ state: 'failed', cleanedUp: true })
        )
        expect(cleanupSpawnedSession).toHaveBeenCalledWith('machine-1', 'default', SESSION_ID)
    })

    it('renames and delivers the remit only after the fresh child identity matches', async () => {
        const child = {
            id: SESSION_ID,
            namespace: 'default',
            active: true,
            metadata: { machineId: 'machine-1', name: 'Worker', path: '/tmp/project', flavor: 'codex' },
            model: null,
            modelReasoningEffort: null,
            effort: null,
            permissionMode: undefined
        }
        const renameSession = mock(async () => {})
        const waitForSessionReady = mock(async () => 'timeout' as const)
        let delivered = false
        const sendMessage = mock(async () => { delivered = true })
        const result = await callSpawn({
            getSessions: () => [],
            spawnSession: async () => ({ type: 'success', sessionId: SESSION_ID }),
            waitForSessionActive: async () => true,
            waitForSessionReady,
            getSessionByNamespace: () => child,
            renameSession,
            sendMessage,
            getQueuedState: () => ({ queuedLocalIds: delivered ? [REQUEST.remitId] : [], invokedLocalMessages: [] }),
            cleanupSpawnedSession: mock(async () => true)
        })

        expect(result).toEqual({
            type: 'success',
            sessionId: SESSION_ID,
            remitId: REQUEST.remitId,
            name: 'Worker',
            session: {
                machineId: 'machine-1',
                directory: '/tmp/project',
                agent: 'codex',
                model: null,
                modelReasoningEffort: null,
                effort: null,
                permissionMode: null
            }
        })
        expect(renameSession).toHaveBeenCalledWith(SESSION_ID, 'Worker')
        expect(waitForSessionReady).not.toHaveBeenCalled()
        expect(sendMessage).toHaveBeenCalledWith(SESSION_ID, {
            text: 'implement issue',
            localId: REQUEST.remitId,
            sentFrom: 'webapp'
        })
    })

    it('accepts a runner-normalized worktree root and name hint', async () => {
        const request = {
            ...REQUEST,
            directory: '/tmp/project/packages/app',
            sessionType: 'worktree' as const,
            worktreeName: 'Feature X'
        }
        let delivered = false
        const cleanupSpawnedSession = mock(async () => true)
        const child = {
            id: SESSION_ID,
            namespace: 'default',
            active: true,
            metadata: {
                machineId: 'machine-1',
                path: '/tmp/project-worktrees/feature-x-a1b2',
                flavor: 'codex',
                sessionType: 'worktree' as const,
                worktreeName: 'feature-x-a1b2',
                worktree: {
                    basePath: '/tmp/project',
                    branch: 'hapi-feature-x-a1b2',
                    name: 'feature-x-a1b2',
                    worktreePath: '/tmp/project-worktrees/feature-x-a1b2'
                }
            },
            model: null,
            modelReasoningEffort: null,
            effort: null,
            permissionMode: undefined
        }

        const result = await callSpawn({
            getSessions: () => [],
            spawnSession: async () => ({ type: 'success', sessionId: SESSION_ID }),
            waitForSessionActive: async () => true,
            getSessionByNamespace: () => child,
            renameSession: async () => {},
            sendMessage: async () => { delivered = true },
            getQueuedState: () => ({ queuedLocalIds: delivered ? [request.remitId] : [], invokedLocalMessages: [] }),
            cleanupSpawnedSession
        }, request)

        expect(result).toMatchObject({ type: 'success', sessionId: SESSION_ID })
        expect(cleanupSpawnedSession).not.toHaveBeenCalled()
    })

    it('cleans up without delivering when the fresh child ends before ready', async () => {
        const cleanupSpawnedSession = mock(async () => true)
        const sendMessage = mock(async () => {})
        const result = await callSpawn({
            getSessions: () => [],
            spawnSession: async () => ({ type: 'success', sessionId: SESSION_ID }),
            waitForSessionActive: async () => true,
            waitForSessionReady: async () => 'ended' as const,
            cleanupSpawnedSession,
            sendMessage
        }, { ...REQUEST, agent: 'cursor' })

        expect(result).toMatchObject({ type: 'error', code: 'spawn_ended', cleanedUp: true })
        expect(sendMessage).not.toHaveBeenCalled()
        expect(cleanupSpawnedSession).toHaveBeenCalledTimes(1)
    })

    it('compensates and reports cleanup state when remit delivery fails', async () => {
        const cleanupSpawnedSession = mock(async () => true)
        const result = await callSpawn({
            getSessions: () => [],
            spawnSession: async () => ({ type: 'success', sessionId: SESSION_ID }),
            waitForSessionActive: async () => true,
            waitForSessionReady: async () => 'ready' as const,
            getSessionByNamespace: () => ({
                id: SESSION_ID,
                namespace: 'default',
                active: true,
                metadata: { machineId: 'machine-1', path: '/tmp/project', flavor: 'codex' },
                model: null,
                modelReasoningEffort: null,
                effort: null,
                permissionMode: undefined
            }),
            renameSession: async () => {},
            sendMessage: async () => { throw new Error('queue unavailable') },
            cleanupSpawnedSession
        })

        expect(result).toEqual({
            type: 'error',
            code: 'remit_delivery_failed',
            message: 'queue unavailable',
            childSessionId: SESSION_ID,
            cleanedUp: true
        })
        expect(cleanupSpawnedSession).toHaveBeenCalledTimes(1)
    })

    it('cleans up when the correlation id cannot be verified after delivery', async () => {
        const cleanupSpawnedSession = mock(async () => true)
        const result = await callSpawn({
            getSessions: () => [],
            spawnSession: async () => ({ type: 'success', sessionId: SESSION_ID }),
            waitForSessionActive: async () => true,
            waitForSessionReady: async () => 'ready' as const,
            getSessionByNamespace: () => ({
                id: SESSION_ID,
                namespace: 'default',
                active: true,
                metadata: { machineId: 'machine-1', path: '/tmp/project', flavor: 'codex' },
                model: null,
                modelReasoningEffort: null,
                effort: null,
                permissionMode: undefined
            }),
            renameSession: async () => {},
            sendMessage: async () => {},
            getQueuedState: () => ({ queuedLocalIds: [], invokedLocalMessages: [] }),
            cleanupSpawnedSession
        })

        expect(result).toMatchObject({
            type: 'error',
            code: 'remit_delivery_failed',
            cleanedUp: true
        })
        expect(cleanupSpawnedSession).toHaveBeenCalledTimes(1)
    })

    it('cleans up a fresh child whose selected flavor does not match', async () => {
        const cleanupSpawnedSession = mock(async () => true)
        const result = await callSpawn({
            getSessions: () => [],
            spawnSession: async () => ({ type: 'success', sessionId: SESSION_ID }),
            waitForSessionActive: async () => true,
            waitForSessionReady: async () => 'ready' as const,
            getSessionByNamespace: () => ({
                id: SESSION_ID,
                namespace: 'default',
                active: true,
                metadata: { machineId: 'machine-1', path: '/tmp/project', flavor: 'claude' },
                model: null,
                modelReasoningEffort: null,
                effort: null,
                permissionMode: undefined
            }),
            cleanupSpawnedSession
        })

        expect(result).toMatchObject({ type: 'error', code: 'spawn_selection_mismatch', cleanedUp: true })
        expect(cleanupSpawnedSession).toHaveBeenCalledTimes(1)
    })

    it.each([
        ['service tier', { ...REQUEST, serviceTier: 'fast' }, { serviceTier: 'standard' }, {}],
        ['collaboration mode', { ...REQUEST, collaborationMode: 'plan' }, { collaborationMode: 'default' }, {}],
        ['Copilot agent mode', { ...REQUEST, agent: 'copilot', copilotAgentMode: 'autopilot' }, { copilotAgentMode: 'interactive' }, {}],
        ['starting mode', { ...REQUEST, startingMode: 'pty' }, {}, { startingMode: 'remote' }],
        ['session type', { ...REQUEST, sessionType: 'worktree' }, {}, { sessionType: 'simple' }]
    ] as Array<[string, SpawnSessionWithRemitRequest, Record<string, unknown>, Record<string, unknown>]>)('cleans up when the selected %s does not match', async (_name, request, sessionOverrides, metadataOverrides) => {
        const cleanupSpawnedSession = mock(async () => true)
        const result = await callSpawn({
            getSessions: () => [],
            spawnSession: async () => ({ type: 'success', sessionId: SESSION_ID }),
            waitForSessionActive: async () => true,
            waitForSessionReady: async () => 'ready' as const,
            getSessionByNamespace: () => ({
                id: SESSION_ID,
                namespace: 'default',
                active: true,
                metadata: {
                    machineId: 'machine-1',
                    path: '/tmp/project',
                    flavor: request.agent ?? 'claude',
                    startingMode: request.startingMode,
                    sessionType: request.sessionType,
                    worktreeName: request.worktreeName,
                    ...metadataOverrides
                },
                model: null,
                modelReasoningEffort: null,
                effort: null,
                permissionMode: undefined,
                serviceTier: request.serviceTier,
                collaborationMode: request.collaborationMode,
                copilotAgentMode: request.copilotAgentMode,
                ...sessionOverrides
            }),
            cleanupSpawnedSession
        }, request)

        expect(result).toMatchObject({ type: 'error', code: 'spawn_selection_mismatch', cleanedUp: true })
        expect(cleanupSpawnedSession).toHaveBeenCalledTimes(1)
    })

    it('verifies the flavor-specific permission mode implied by yolo', async () => {
        const cleanupSpawnedSession = mock(async () => true)
        const result = await callSpawn({
            getSessions: () => [],
            spawnSession: async () => ({ type: 'success', sessionId: SESSION_ID }),
            waitForSessionActive: async () => true,
            waitForSessionReady: async () => 'ready' as const,
            getSessionByNamespace: () => ({
                id: SESSION_ID,
                namespace: 'default',
                active: true,
                metadata: { machineId: 'machine-1', path: '/tmp/project', flavor: 'codex' },
                model: null,
                modelReasoningEffort: null,
                effort: null,
                permissionMode: 'default'
            }),
            cleanupSpawnedSession
        }, { ...REQUEST, yolo: true })

        expect(result).toMatchObject({ type: 'error', code: 'spawn_selection_mismatch', cleanedUp: true })
        expect(cleanupSpawnedSession).toHaveBeenCalledTimes(1)
    })

    it('cleans up a fresh returned id whose namespace or runner identity does not match', async () => {
        const cleanupSpawnedSession = mock(async () => true)
        const result = await callSpawn({
            getSessions: () => [],
            spawnSession: async () => ({ type: 'success', sessionId: SESSION_ID }),
            waitForSessionActive: async () => true,
            waitForSessionReady: async () => 'ready' as const,
            getSessionByNamespace: () => null,
            cleanupSpawnedSession
        })

        expect(result).toMatchObject({ type: 'error', code: 'spawn_identity_mismatch' })
        expect(cleanupSpawnedSession).toHaveBeenCalledWith('machine-1', 'default', SESSION_ID)
    })

    it('cleanup is safe to repeat after the runner is already gone', async () => {
        const stopRunnerSession = mock(async () => 'already_gone' as const)
        const markSessionArchivedFromHub = mock(() => {})
        const harness = {
            rpcGateway: { stopRunnerSession },
            getSessionByNamespace: () => ({ id: SESSION_ID, active: false }),
            handleSessionEnd: mock(() => {}),
            sessionCache: { markSessionArchivedFromHub }
        }
        const cleanup = (SyncEngine.prototype as unknown as {
            cleanupSpawnedSession: (machineId: string, namespace: string, sessionId: string) => Promise<boolean>
        }).cleanupSpawnedSession

        await expect(cleanup.call(harness, 'machine-1', 'default', SESSION_ID)).resolves.toBe(true)
        await expect(cleanup.call(harness, 'machine-1', 'default', SESSION_ID)).resolves.toBe(true)
        expect(stopRunnerSession).toHaveBeenCalledTimes(2)
        expect(markSessionArchivedFromHub).toHaveBeenCalledTimes(2)
    })
})

describe('stopSession', () => {
    it('is idempotent when the process is already inactive', async () => {
        const killSession = mock(async () => {})
        const result = await SyncEngine.prototype.stopSession.call({
            getSession: () => ({ id: SESSION_ID, active: false }),
            rpcGateway: { stopSessionProcess: killSession }
        } as unknown as SyncEngine, SESSION_ID)

        expect(result).toEqual({ alreadyStopped: true })
        expect(killSession).not.toHaveBeenCalled()
    })

    it('stops a live runner process even when its Hub lease already expired', async () => {
        const stopSessionProcess = mock(async () => {})
        const stopRunnerSession = mock(async () => 'stopped' as const)
        const result = await SyncEngine.prototype.stopSession.call({
            getSession: () => ({
                id: SESSION_ID,
                active: false,
                metadata: { machineId: 'machine-1', startedFromRunner: true }
            }),
            rpcGateway: { stopSessionProcess, stopRunnerSession }
        } as unknown as SyncEngine, SESSION_ID)

        expect(result).toEqual({ alreadyStopped: false })
        expect(stopSessionProcess).not.toHaveBeenCalled()
        expect(stopRunnerSession).toHaveBeenCalledWith('machine-1', SESSION_ID)
    })

    it('reconciles an active row when its process is already gone', async () => {
        const handleSessionEnd = mock(() => {})
        const stopRunnerSession = mock(async () => 'already_gone' as const)
        const result = await SyncEngine.prototype.stopSession.call({
            getSession: () => ({ id: SESSION_ID, active: true, metadata: { machineId: 'machine-1' } }),
            rpcGateway: {
                stopSessionProcess: async () => { throw new RpcTargetMissingError('kill-session', 'handler-not-registered') },
                stopRunnerSession
            },
            handleSessionEnd
        } as unknown as SyncEngine, SESSION_ID)

        expect(result).toEqual({ alreadyStopped: false })
        expect(stopRunnerSession).toHaveBeenCalledWith('machine-1', SESSION_ID)
        expect(handleSessionEnd).toHaveBeenCalledWith(expect.objectContaining({ sid: SESSION_ID, reason: 'error' }))
    })

    it('waits for both CLI session-end and runner-confirmed process exit', async () => {
        const handleSessionEnd = mock(() => {})
        let confirmInactive!: (inactive: boolean) => void
        const waitForSessionInactive = mock(async () => await new Promise<boolean>((resolve) => {
            confirmInactive = resolve
        }))
        const stopRunnerSession = mock(async () => 'already_gone' as const)
        let settled = false
        const resultPromise = SyncEngine.prototype.stopSession.call({
            getSession: () => ({ id: SESSION_ID, active: true, metadata: { machineId: 'machine-1', startedBy: 'runner' } }),
            rpcGateway: {
                stopSessionProcess: async () => {},
                stopRunnerSession
            },
            handleSessionEnd,
            waitForSessionInactive
        } as unknown as SyncEngine, SESSION_ID)
        void resultPromise.then(() => { settled = true })

        await Promise.resolve()
        expect(waitForSessionInactive).toHaveBeenCalledWith(SESSION_ID)
        expect(stopRunnerSession).not.toHaveBeenCalled()
        expect(settled).toBe(false)
        confirmInactive(true)

        await expect(resultPromise).resolves.toEqual({ alreadyStopped: false })
        expect(stopRunnerSession).toHaveBeenCalledWith('machine-1', SESSION_ID)
        expect(handleSessionEnd).not.toHaveBeenCalled()
    })

    it('does not require a runner RPC after a terminal session reports inactive', async () => {
        const stopRunnerSession = mock(async () => { throw new RpcTargetMissingError('stop-session', 'socket-disconnected') })
        const result = await SyncEngine.prototype.stopSession.call({
            getSession: () => ({ id: SESSION_ID, active: true, metadata: { startedBy: 'terminal' } }),
            rpcGateway: {
                stopSessionProcess: async () => {},
                stopRunnerSession
            },
            waitForSessionInactive: async () => true
        } as unknown as SyncEngine, SESSION_ID)

        expect(result).toEqual({ alreadyStopped: false })
        expect(stopRunnerSession).not.toHaveBeenCalled()
    })

    it('fails closed when session-end arrives while the runner still sees a live process', async () => {
        await expect(SyncEngine.prototype.stopSession.call({
            getSession: () => ({ id: SESSION_ID, active: true, metadata: { machineId: 'machine-1', startedFromRunner: true } }),
            rpcGateway: {
                stopSessionProcess: async () => {},
                stopRunnerSession: async () => 'still_alive' as const
            },
            waitForSessionInactive: async () => true
        } as unknown as SyncEngine, SESSION_ID)).rejects.toThrow(/still running/)
    })
})

describe('archiveSession', () => {
    it('persists archive metadata at the Hub even when the CLI accepts the request', async () => {
        const markSessionArchivedFromHub = mock(() => {})
        const handleSessionEnd = mock(() => {})

        await SyncEngine.prototype.archiveSession.call({
            rpcGateway: { killSession: async () => {} },
            sessionCache: { markSessionArchivedFromHub },
            handleSessionEnd
        } as unknown as SyncEngine, SESSION_ID)

        expect(markSessionArchivedFromHub).toHaveBeenCalledWith(SESSION_ID, 'Archived from hub')
        expect(handleSessionEnd).toHaveBeenCalledWith(expect.objectContaining({ sid: SESSION_ID }))
    })
})
