import { describe, expect, it, vi } from 'vitest'
import { CodexConversationHistory } from './conversationHistory'

function createClient(overrides?: {
    fork?: (
        params: Record<string, unknown>,
        options?: { signal?: AbortSignal }
    ) => Promise<{ thread: { id: string } }>
    rollback?: (params: { threadId: string; numTurns: number }) => Promise<unknown>
    read?: (
        params?: Record<string, unknown>,
        options?: { signal?: AbortSignal }
    ) => Promise<{ thread: { id: string; turns: Array<Record<string, unknown>> } }>
}) {
    return {
        connect: async () => {},
        initialize: async () => ({ protocolVersion: 1 }),
        disconnect: async () => {},
        supportsMethod: async () => true,
        forkThread: overrides?.fork ?? (async () => ({ thread: { id: 'forked-1' } })),
        rollbackThread: overrides?.rollback ?? (async () => ({ thread: { id: 'thread-1' } })),
        readThread: overrides?.read ?? (async () => ({
            thread: {
                id: 'thread-1',
                turns: [
                    { id: 'turn-a', items: [{ type: 'userMessage', clientId: 'local-a' }] },
                    { id: 'turn-b', items: [{ type: 'userMessage', clientId: 'local-b' }] },
                    { id: 'turn-c', items: [{ type: 'userMessage', clientId: 'local-c' }] }
                ]
            }
        }))
    }
}

function createHistory(getClient: () => unknown): CodexConversationHistory {
    return new CodexConversationHistory(getClient as never, () => getClient() as never)
}

describe('CodexConversationHistory', () => {
    it('only publishes methods confirmed by the app server', async () => {
        const supportsMethod = vi.fn(async (method: string) => method === 'thread/fork')
        const history = createHistory(() => ({
            ...createClient(),
            supportsMethod
        }))
        history.setThreadId('thread-1')
        await history.probeCapabilities()
        expect(history.getCapabilitiesForMetadata()?.conversationHistory).toEqual({
            forkCurrent: true,
            forkAtMessage: true
        })
    })

    it('coalesces concurrent capability probes', async () => {
        let firstCall = true
        let finishFirstProbe!: (supported: boolean) => void
        const supportsMethod = vi.fn(() => {
            if (firstCall) {
                firstCall = false
                return new Promise<boolean>((resolve) => {
                    finishFirstProbe = resolve
                })
            }
            return Promise.resolve(true)
        })
        const history = createHistory(() => ({
            ...createClient(),
            supportsMethod
        }))
        history.setThreadId('thread-1')
        const firstProbe = history.probeCapabilities()
        await vi.waitFor(() => expect(supportsMethod).toHaveBeenCalledOnce())

        const secondProbe = history.probeCapabilities()
        const reusedPromise = secondProbe === firstProbe
        finishFirstProbe(true)
        await Promise.all([firstProbe, secondProbe])

        expect(reusedPromise).toBe(true)
        expect(supportsMethod).toHaveBeenCalledTimes(2)
    })

    it('waits for a pending capability probe and prevents client access after shutdown', async () => {
        let finishFirstProbe!: (supported: boolean) => void
        const supportsMethod = vi.fn((method: string) => {
            if (method === 'thread/fork') {
                return new Promise<boolean>((resolve) => {
                    finishFirstProbe = resolve
                })
            }
            return Promise.resolve(true)
        })
        const client = {
            ...createClient(),
            supportsMethod
        }
        const getClient = vi.fn(() => client)
        const publishCapabilities = vi.fn(async () => {})
        const history = createHistory(getClient)
        history.setPublishCapabilities(publishCapabilities)
        history.setThreadId('thread-1')
        const probe = history.probeCapabilities()
        await vi.waitFor(() => expect(supportsMethod).toHaveBeenCalledOnce())

        let cleanupSettled = false
        const cleanup = history.cleanup().finally(() => {
            cleanupSettled = true
        })
        await new Promise<void>((resolve) => setImmediate(resolve))
        const cleanupSettledWhileProbePending = cleanupSettled

        finishFirstProbe(true)
        await Promise.all([probe, cleanup])
        expect(cleanupSettledWhileProbePending).toBe(false)
        expect(supportsMethod).toHaveBeenCalledOnce()
        expect(publishCapabilities).not.toHaveBeenCalled()

        getClient.mockClear()
        await history.probeCapabilities()
        expect(getClient).not.toHaveBeenCalled()
        expect(publishCapabilities).not.toHaveBeenCalled()
    })

    it('does not mutate rewind capability after shutdown starts during its probe', async () => {
        let finishRollbackProbe!: (supported: boolean) => void
        const supportsMethod = vi.fn((method: string) => {
            if (method === 'thread/fork') return Promise.resolve(true)
            if (method === 'thread/rollback') {
                return new Promise<boolean>((resolve) => {
                    finishRollbackProbe = resolve
                })
            }
            throw new Error(`Unexpected capability probe: ${method}`)
        })
        const client = {
            ...createClient(),
            supportsMethod
        }
        const getClient = vi.fn(() => client)
        const publishCapabilities = vi.fn(async () => {})
        const history = createHistory(getClient)
        history.setPublishCapabilities(publishCapabilities)
        history.setThreadId('thread-1')
        const probe = history.probeCapabilities()
        await vi.waitFor(() => {
            expect(supportsMethod).toHaveBeenNthCalledWith(2, 'thread/rollback')
        })

        let cleanupSettled = false
        const cleanup = history.cleanup().finally(() => {
            cleanupSettled = true
        })
        await new Promise<void>((resolve) => setImmediate(resolve))
        const cleanupSettledWhileProbePending = cleanupSettled

        finishRollbackProbe(true)
        await Promise.all([probe, cleanup])
        expect(cleanupSettledWhileProbePending).toBe(false)
        expect(history.getCapabilityStates().rewindToMessage).toBe('unknown')
        expect(supportsMethod).toHaveBeenCalledTimes(2)
        expect(publishCapabilities).not.toHaveBeenCalled()

        getClient.mockClear()
        await history.probeCapabilities()
        expect(getClient).not.toHaveBeenCalled()
        expect(supportsMethod).toHaveBeenCalledTimes(2)
        expect(publishCapabilities).not.toHaveBeenCalled()
    })

    it('forks current without a turn boundary', async () => {
        const fork = vi.fn(async (params: Record<string, unknown>) => {
            expect(params.beforeTurnId).toBeUndefined()
            return { thread: { id: 'forked-current' } }
        })
        const history = createHistory(() => createClient({ fork }))
        history.setThreadId('thread-1')
        const result = await history.fork()
        expect(result).toEqual({ nativeSessionId: 'forked-current' })
        expect(fork).toHaveBeenCalledTimes(1)
    })

    it('rejects history mutations while the source lease is active', async () => {
        const rollback = vi.fn(async () => ({ thread: { id: 'thread-1' } }))
        const createForkClient = vi.fn(() => createClient())
        const history = new CodexConversationHistory(
            () => createClient({ rollback }) as never,
            createForkClient as never
        )
        history.setThreadId('thread-1')
        const release = await history.acquireSourceLease()

        try {
            await expect(history.fork()).rejects.toThrow('Session is busy')
            await expect(history.rewind('local-b')).rejects.toThrow('Session is busy')
            expect(createForkClient).not.toHaveBeenCalled()
            expect(rollback).not.toHaveBeenCalled()
        } finally {
            release()
        }
    })

    it('forks through a disconnected temporary app server', async () => {
        const activeFork = vi.fn(async () => ({ thread: { id: 'forked-active' } }))
        const activeClient = createClient({ fork: activeFork })
        const calls: string[] = []
        let finishDisconnect: (() => void) | undefined
        const temporaryClient = {
            connect: vi.fn(async () => {
                calls.push('connect')
            }),
            initialize: vi.fn(async (params: Record<string, unknown>) => {
                calls.push('initialize')
                expect(params).toMatchObject({ capabilities: { experimentalApi: true } })
                return { protocolVersion: 1 }
            }),
            forkThread: vi.fn(async (params: Record<string, unknown>) => {
                calls.push('fork')
                expect(params).toEqual({ threadId: 'thread-1' })
                return { thread: { id: 'forked-temporary' } }
            }),
            disconnect: vi.fn(() => new Promise<void>((resolve) => {
                calls.push('disconnect')
                finishDisconnect = resolve
            }))
        }
        const history = new CodexConversationHistory(
            () => activeClient as never,
            () => temporaryClient as never
        )
        history.setThreadId('thread-1')

        const fork = history.fork()
        await vi.waitFor(() => expect(temporaryClient.disconnect).toHaveBeenCalledOnce())
        expect(activeFork).not.toHaveBeenCalled()

        let settled = false
        void fork.then(() => {
            settled = true
        })
        await Promise.resolve()
        expect(settled).toBe(false)
        expect(finishDisconnect).toBeDefined()
        finishDisconnect!()

        await expect(fork).resolves.toEqual({ nativeSessionId: 'forked-temporary' })
        expect(calls).toEqual(['connect', 'initialize', 'fork', 'disconnect'])
    })

    it('rejects fork when temporary app-server disconnect fails', async () => {
        const disconnectError = new Error('temporary app-server teardown failed')
        const activeFork = vi.fn(async () => ({ thread: { id: 'forked-active' } }))
        const temporaryFork = vi.fn(async () => ({ thread: { id: 'forked-temporary' } }))
        const temporaryClient = {
            ...createClient({ fork: temporaryFork }),
            disconnect: vi.fn(async () => {
                throw disconnectError
            })
        }
        const history = new CodexConversationHistory(
            () => createClient({ fork: activeFork }) as never,
            () => temporaryClient as never
        )
        history.setThreadId('thread-1')

        await expect(history.fork()).rejects.toBe(disconnectError)
        expect(temporaryFork).toHaveBeenCalledWith(
            { threadId: 'thread-1' },
            expect.objectContaining({ signal: expect.any(AbortSignal) })
        )
        expect(activeFork).not.toHaveBeenCalled()
    })

    it('retries failed temporary cleanup before starting another fork client', async () => {
        const cleanupError = new Error('temporary app-server teardown failed')
        const firstClient = {
            ...createClient(),
            disconnect: vi.fn(async () => {
                throw cleanupError
            })
        }
        const secondClient = {
            ...createClient(),
            connect: vi.fn(async () => {})
        }
        const createForkClient = vi.fn()
            .mockReturnValueOnce(firstClient)
            .mockReturnValueOnce(secondClient)
        const history = new CodexConversationHistory(
            () => createClient() as never,
            createForkClient as never
        )
        history.setThreadId('thread-1')

        await expect(history.fork()).rejects.toBe(cleanupError)
        await expect(history.fork()).rejects.toBe(cleanupError)

        expect(firstClient.disconnect).toHaveBeenCalledTimes(2)
        expect(createForkClient).toHaveBeenCalledOnce()
        expect(secondClient.connect).not.toHaveBeenCalled()
    })

    it('retries failed temporary cleanup before dispatching rewind', async () => {
        const cleanupError = new Error('temporary app-server teardown failed')
        let finishCleanup!: () => void
        const cleanupGate = new Promise<void>((resolve) => {
            finishCleanup = resolve
        })
        const rollback = vi.fn(async () => ({ thread: { id: 'thread-1' } }))
        const sourceClient = createClient({ rollback })
        const temporaryClient = {
            ...createClient(),
            disconnect: vi.fn()
                .mockRejectedValueOnce(cleanupError)
                .mockImplementationOnce(() => cleanupGate)
        }
        const history = new CodexConversationHistory(
            () => sourceClient as never,
            () => temporaryClient as never
        )
        history.setThreadId('thread-1')

        await expect(history.fork()).rejects.toBe(cleanupError)
        const rewind = history.rewind('local-b')
        await vi.waitFor(() => expect(temporaryClient.disconnect).toHaveBeenCalledTimes(2))
        expect(rollback).not.toHaveBeenCalled()

        finishCleanup()
        await expect(rewind).resolves.toEqual({
            success: true,
            truncateFromLocalId: 'local-b',
            messages: []
        })
        expect(rollback).toHaveBeenCalledOnce()
    })

    it('retries failed temporary cleanup during history shutdown', async () => {
        const cleanupError = new Error('temporary app-server teardown failed')
        const temporaryClient = {
            ...createClient(),
            disconnect: vi.fn()
                .mockRejectedValueOnce(cleanupError)
                .mockResolvedValueOnce(undefined)
        }
        const history = new CodexConversationHistory(
            () => createClient() as never,
            () => temporaryClient as never
        )
        history.setThreadId('thread-1')

        await expect(history.fork()).rejects.toBe(cleanupError)
        await history.cleanup()

        expect(temporaryClient.disconnect).toHaveBeenCalledTimes(2)
    })

    it('disconnects an active temporary client when shutdown races a pending fork', async () => {
        const interrupted = new Error('temporary client disconnected')
        let forkSignal: AbortSignal | undefined
        let rejectFork!: (error: Error) => void
        const pendingFork = vi.fn((_params: Record<string, unknown>, options?: { signal?: AbortSignal }) => new Promise<{ thread: { id: string } }>((_resolve, reject) => {
            forkSignal = options?.signal
            rejectFork = reject
        }))
        const temporaryClient = {
            ...createClient({ fork: pendingFork }),
            disconnect: vi.fn(async () => {
                rejectFork(interrupted)
            })
        }
        const activeClient = createClient()
        const readThread = vi.spyOn(activeClient, 'readThread')
        const history = new CodexConversationHistory(
            () => activeClient as never,
            () => temporaryClient as never
        )
        history.setThreadId('thread-1')
        const fork = history.fork().catch((error) => error)
        await vi.waitFor(() => expect(pendingFork).toHaveBeenCalledOnce())

        const cleanup = history.cleanup()
        try {
            await Promise.resolve()
            expect(forkSignal?.aborted).toBe(true)
            expect(temporaryClient.disconnect).toHaveBeenCalled()
            await cleanup
        } finally {
            rejectFork(interrupted)
            await fork
        }

        await expect(fork).resolves.toBe(interrupted)
        await expect(history.fork()).rejects.toThrow('shutting down')
        await expect(history.rewind('local-a')).rejects.toThrow('shutting down')
        await expect(history.acquireSourceLease()).rejects.toThrow('shutting down')
        expect(readThread).not.toHaveBeenCalled()
    })

    it('disconnects an active temporary client before waiting for a pending probe', async () => {
        let finishProbe!: (supported: boolean) => void
        const supportsMethod = vi.fn(() => new Promise<boolean>((resolve) => {
            finishProbe = resolve
        }))
        const activeClient = {
            ...createClient(),
            supportsMethod
        }
        const interrupted = new Error('temporary client disconnected')
        let rejectFork!: (error: Error) => void
        const pendingFork = vi.fn(() => new Promise<{ thread: { id: string } }>((_resolve, reject) => {
            rejectFork = reject
        }))
        const temporaryClient = {
            ...createClient({ fork: pendingFork }),
            disconnect: vi.fn(async () => {
                rejectFork(interrupted)
            })
        }
        const history = new CodexConversationHistory(
            () => activeClient as never,
            () => temporaryClient as never
        )
        history.setThreadId('thread-1')
        const probe = history.probeCapabilities()
        await vi.waitFor(() => expect(supportsMethod).toHaveBeenCalledOnce())
        const fork = history.fork().catch((error) => error)
        await vi.waitFor(() => expect(pendingFork).toHaveBeenCalledOnce())

        const cleanup = history.cleanup()
        await Promise.resolve()
        const disconnectStartedWhileProbePending = temporaryClient.disconnect.mock.calls.length > 0

        finishProbe(true)
        await Promise.all([probe, fork, cleanup])
        expect(disconnectStartedWhileProbePending).toBe(true)
    })

    it('does not initialize or reconnect when shutdown follows temporary connect', async () => {
        let finishConnect: (() => void) | undefined
        let connected = false
        const connect = vi.fn(() => {
            if (connect.mock.calls.length === 1) {
                return new Promise<void>((resolve) => {
                    finishConnect = () => {
                        connected = true
                        resolve()
                    }
                })
            }
            connected = true
            return Promise.resolve()
        })
        const initialize = vi.fn(async () => {
            if (!connected) await connect()
            return { protocolVersion: 1 }
        })
        const nativeFork = vi.fn(async () => ({ thread: { id: 'forked-temporary' } }))
        const temporaryClient = {
            ...createClient({ fork: nativeFork }),
            connect,
            initialize,
            disconnect: vi.fn(async () => {
                connected = false
            })
        }
        const history = new CodexConversationHistory(
            () => createClient() as never,
            () => temporaryClient as never
        )
        history.setThreadId('thread-1')
        const fork = history.fork().catch((error) => error)
        await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce())

        finishConnect!()
        const cleanup = history.cleanup()
        const [forkError] = await Promise.all([fork, cleanup])

        expect(forkError).toEqual(new Error('Codex conversation history is shutting down'))
        expect(connect).toHaveBeenCalledOnce()
        expect(initialize).not.toHaveBeenCalled()
        expect(nativeFork).not.toHaveBeenCalled()
    })

    it('rejects rewind while a fork mutation is in progress', async () => {
        const interrupted = new Error('fork interrupted')
        let rejectFork: ((error: Error) => void) | undefined
        const pendingFork = vi.fn(() => new Promise<{ thread: { id: string } }>((_resolve, reject) => {
            rejectFork = reject
        }))
        const history = new CodexConversationHistory(
            () => createClient() as never,
            () => createClient({ fork: pendingFork }) as never
        )
        history.setThreadId('thread-1')
        const fork = history.fork().catch((error) => error)
        await vi.waitFor(() => expect(pendingFork).toHaveBeenCalledOnce())

        try {
            await expect(history.rewind('local-a')).rejects.toThrow('mutation is already in progress')
        } finally {
            rejectFork!(interrupted)
            await fork
        }
    })

    it('requires verified temporary process identity before native fork', async () => {
        const identityError = new Error('temporary process identity could not be verified')
        const fork = vi.fn(async () => ({ thread: { id: 'forked-temporary' } }))
        const temporaryClient = {
            ...createClient({ fork }),
            connect: vi.fn(async (options?: { requireVerifiedProcessIdentity?: boolean }) => {
                if (options?.requireVerifiedProcessIdentity) throw identityError
            })
        }
        const history = new CodexConversationHistory(
            () => createClient() as never,
            () => temporaryClient as never
        )
        history.setThreadId('thread-1')

        await expect(history.fork()).rejects.toBe(identityError)
        expect(temporaryClient.connect).toHaveBeenCalledWith({
            requireVerifiedProcessIdentity: true
        })
        expect(fork).not.toHaveBeenCalled()
    })

    it('preserves the fork error when temporary cleanup also fails', async () => {
        const forkError = new Error('thread/fork is unsupported')
        const cleanupError = new Error('temporary cleanup failed')
        const temporaryClient = {
            ...createClient({
                fork: async () => {
                    throw forkError
                }
            }),
            disconnect: vi.fn(async () => {
                throw cleanupError
            })
        }
        const history = new CodexConversationHistory(
            () => createClient() as never,
            () => temporaryClient as never
        )
        history.setThreadId('thread-1')

        const error = await history.fork().catch((caught) => caught)
        expect(error).toBeInstanceOf(AggregateError)
        expect(error.errors).toEqual([forkError, cleanupError])
        expect(error.message).toContain(forkError.message)
        expect(history.getCapabilityStates().forkCurrent).toBe('unsupported')
    })

    it('preserves the direct fork error when capability publishing and cleanup fail', async () => {
        const forkError = new Error('thread/fork is unsupported')
        const publishError = new Error('capability publish failed')
        const cleanupError = new Error('temporary cleanup failed')
        const temporaryClient = {
            ...createClient({
                fork: async () => {
                    throw forkError
                }
            }),
            disconnect: vi.fn(async () => {
                throw cleanupError
            })
        }
        const history = new CodexConversationHistory(
            () => createClient() as never,
            () => temporaryClient as never
        )
        const publishCapabilities = vi.fn(async () => {
            throw publishError
        })
        history.setPublishCapabilities(publishCapabilities)
        history.setThreadId('thread-1')

        const error = await history.fork().catch((caught) => caught)
        expect(error).toBeInstanceOf(AggregateError)
        expect(error.errors).toEqual([forkError, cleanupError])
        expect(history.getCapabilityStates().forkCurrent).toBe('unsupported')
        expect(publishCapabilities).toHaveBeenCalledOnce()
    })

    it('does not publish fork capability after shutdown begins during temporary cleanup', async () => {
        const forkError = new Error('thread/fork method not found')
        let finishDisconnect!: () => void
        const pendingDisconnect = new Promise<void>((resolve) => {
            finishDisconnect = resolve
        })
        const temporaryClient = {
            ...createClient({
                fork: async () => {
                    throw forkError
                }
            }),
            disconnect: vi.fn(() => pendingDisconnect)
        }
        const publishCapabilities = vi.fn(async () => {})
        const history = new CodexConversationHistory(
            () => createClient() as never,
            () => temporaryClient as never
        )
        history.setPublishCapabilities(publishCapabilities)
        history.setThreadId('thread-1')
        const fork = history.fork().catch((error) => error)
        await vi.waitFor(() => expect(temporaryClient.disconnect).toHaveBeenCalledOnce())

        const cleanup = history.cleanup()
        await vi.waitFor(() => expect(temporaryClient.disconnect).toHaveBeenCalledTimes(2))
        finishDisconnect()
        const [result] = await Promise.all([fork, cleanup])

        expect(result).toBe(forkError)
        expect(history.getCapabilityStates().forkCurrent).toBe('unsupported')
        expect(publishCapabilities).not.toHaveBeenCalled()
    })

    it('does not mark fork unsupported when only cleanup reports unsupported', async () => {
        const temporaryClient = {
            ...createClient({
                fork: async () => {
                    throw new Error('fork request failed')
                }
            }),
            disconnect: vi.fn(async () => {
                throw new Error('temporary cleanup is unsupported')
            })
        }
        const history = new CodexConversationHistory(
            () => createClient() as never,
            () => temporaryClient as never
        )
        history.setThreadId('thread-1')

        await expect(history.fork()).rejects.toBeInstanceOf(AggregateError)
        expect(history.getCapabilityStates().forkCurrent).toBe('unknown')
    })

    it('does not mark fork unsupported when successful fork cleanup reports unsupported', async () => {
        const cleanupError = new Error('temporary cleanup is unsupported')
        const temporaryClient = {
            ...createClient({
                fork: async () => ({ thread: { id: 'forked-temporary' } })
            }),
            disconnect: vi.fn(async () => {
                throw cleanupError
            })
        }
        const history = new CodexConversationHistory(
            () => createClient() as never,
            () => temporaryClient as never
        )
        history.setThreadId('thread-1')

        await expect(history.fork()).rejects.toBe(cleanupError)
        expect(history.getCapabilityStates().forkCurrent).toBe('unknown')
    })

    it('does not mark fork unsupported when initialize reports unsupported', async () => {
        const initializeError = new Error('experimental API is unsupported')
        const fork = vi.fn(async () => ({ thread: { id: 'forked-temporary' } }))
        const temporaryClient = {
            ...createClient({ fork }),
            initialize: vi.fn(async () => {
                throw initializeError
            })
        }
        const history = new CodexConversationHistory(
            () => createClient() as never,
            () => temporaryClient as never
        )
        history.setThreadId('thread-1')

        await expect(history.fork()).rejects.toBe(initializeError)
        expect(history.getCapabilityStates().forkCurrent).toBe('unknown')
        expect(fork).not.toHaveBeenCalled()
    })

    it('reserves cleanup time when the temporary fork stalls', async () => {
        vi.useFakeTimers()
        let forkSignal: AbortSignal | undefined
        const temporaryClient = {
            ...createClient({
                fork: (_params, options) => new Promise((_resolve, reject) => {
                    forkSignal = options?.signal
                    forkSignal?.addEventListener('abort', () => {
                        reject(new Error('fork aborted'))
                    }, { once: true })
                })
            }),
            disconnect: vi.fn(async () => {})
        }
        const history = new CodexConversationHistory(
            () => createClient() as never,
            () => temporaryClient as never
        )
        history.setThreadId('thread-1')
        const fork = history.fork()
        const outcome = fork.then(
            (value) => ({ type: 'resolved' as const, value }),
            (error: unknown) => ({ type: 'rejected' as const, error })
        )

        try {
            await vi.advanceTimersByTimeAsync(79_999)
            expect(temporaryClient.disconnect).not.toHaveBeenCalled()
            expect(forkSignal?.aborted).toBe(false)
            await vi.advanceTimersByTimeAsync(1)
            expect(forkSignal?.aborted).toBe(true)
            expect(temporaryClient.disconnect).toHaveBeenCalledOnce()
            const result = await outcome
            expect(result.type).toBe('rejected')
            if (result.type === 'rejected') {
                expect(result.error).toEqual(new Error('Codex fork timed out after 80000ms'))
            }
        } finally {
            vi.useRealTimers()
        }
    })

    it('reports a stalled fork and cleanup failure together', async () => {
        vi.useFakeTimers()
        let finishFork: ((value: { thread: { id: string } }) => void) | undefined
        const cleanupError = new Error('temporary cleanup failed')
        const temporaryClient = {
            ...createClient({
                fork: () => new Promise((resolve) => {
                    finishFork = resolve
                })
            }),
            disconnect: vi.fn(async () => {
                throw cleanupError
            })
        }
        const history = new CodexConversationHistory(
            () => createClient() as never,
            () => temporaryClient as never
        )
        history.setThreadId('thread-1')
        const outcome = history.fork().catch((error) => error)

        try {
            await vi.advanceTimersByTimeAsync(80_000)
            const error = await outcome
            expect(error).toBeInstanceOf(AggregateError)
            expect(error.errors).toEqual([
                new Error('Codex fork timed out after 80000ms'),
                cleanupError
            ])
        } finally {
            finishFork?.({ thread: { id: 'forked-late' } })
            await Promise.resolve()
            vi.useRealTimers()
        }
    })

    it('applies the total fork deadline to stalled cleanup', async () => {
        vi.useFakeTimers()
        const temporaryClient = {
            ...createClient({
                fork: async () => ({ thread: { id: 'forked-temporary' } })
            }),
            disconnect: vi.fn(() => new Promise<void>(() => {}))
        }
        const history = new CodexConversationHistory(
            () => createClient() as never,
            () => temporaryClient as never
        )
        history.setThreadId('thread-1')
        const outcome = history.fork().catch((error) => error)

        try {
            await vi.advanceTimersByTimeAsync(89_999)
            expect(temporaryClient.disconnect).toHaveBeenCalledOnce()
            await vi.advanceTimersByTimeAsync(1)
            await expect(outcome).resolves.toEqual(
                new Error('Codex fork cleanup timed out after 90000ms total')
            )
        } finally {
            vi.useRealTimers()
        }
    })

    it('rejects a successful fork when cleanup crosses the total deadline', async () => {
        vi.useFakeTimers()
        const startedAt = Date.now()
        const temporaryClient = {
            ...createClient({
                fork: async () => ({ thread: { id: 'forked-too-late' } })
            }),
            disconnect: vi.fn(async () => {
                vi.setSystemTime(startedAt + 90_001)
            })
        }
        const history = new CodexConversationHistory(
            () => createClient() as never,
            () => temporaryClient as never
        )
        history.setThreadId('thread-1')

        try {
            await expect(history.fork()).rejects.toEqual(
                new Error('Codex fork cleanup timed out after 90000ms total')
            )
        } finally {
            vi.useRealTimers()
        }
    })

    it('reports the deadline when failed cleanup crosses the total deadline', async () => {
        vi.useFakeTimers()
        const startedAt = Date.now()
        const cleanupError = new Error('temporary cleanup failed too late')
        const temporaryClient = {
            ...createClient({
                fork: async () => ({ thread: { id: 'forked-too-late' } })
            }),
            disconnect: vi.fn(async () => {
                vi.setSystemTime(startedAt + 90_001)
                throw cleanupError
            })
        }
        const history = new CodexConversationHistory(
            () => createClient() as never,
            () => temporaryClient as never
        )
        history.setThreadId('thread-1')

        try {
            await expect(history.fork()).rejects.toEqual(
                new Error('Codex fork cleanup timed out after 90000ms total')
            )
        } finally {
            vi.useRealTimers()
        }
    })

    it('reserves cleanup time while historical turn reads stall', async () => {
        vi.useFakeTimers()
        let readSignal: AbortSignal | undefined
        let finishRead: ((value: { thread: { id: string; turns: Array<Record<string, unknown>> } }) => void) | undefined
        const activeClient = createClient({
            read: (_params, options) => new Promise((resolve) => {
                readSignal = options?.signal
                finishRead = resolve
            })
        })
        const createTemporaryClient = vi.fn(() => createClient())
        const history = new CodexConversationHistory(
            () => activeClient as never,
            () => createTemporaryClient() as never
        )
        history.setThreadId('thread-1')
        const outcome = history.fork('local-a').catch((error) => error)

        try {
            await vi.advanceTimersByTimeAsync(80_000)
            expect(readSignal?.aborted).toBe(true)
            await expect(outcome).resolves.toEqual(
                new Error('Codex fork timed out after 80000ms')
            )
            expect(createTemporaryClient).not.toHaveBeenCalled()
        } finally {
            finishRead?.({ thread: { id: 'thread-1', turns: [] } })
            await Promise.resolve()
            vi.useRealTimers()
        }
    })

    it('does not connect a temporary client after a historical read exhausts the operation deadline', async () => {
        vi.useFakeTimers()
        const startedAt = Date.now()
        const activeClient = createClient({
            read: async () => {
                vi.setSystemTime(startedAt + 81_000)
                return {
                    thread: {
                        id: 'thread-1',
                        turns: [
                            { id: 'turn-a', items: [{ type: 'userMessage', clientId: 'local-a' }] }
                        ]
                    }
                }
            }
        })
        const temporaryClient = {
            ...createClient(),
            connect: vi.fn(async () => {})
        }
        const history = new CodexConversationHistory(
            () => activeClient as never,
            () => temporaryClient as never
        )
        history.setThreadId('thread-1')

        try {
            await expect(history.fork('local-a')).rejects.toEqual(
                new Error('Codex fork timed out after 80000ms')
            )
            expect(temporaryClient.connect).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })

    it('does not start capability publishing after the total fork deadline expires', async () => {
        vi.useFakeTimers()
        const startedAt = Date.now()
        const forkError = new Error('thread/fork method not found')
        const publishCapabilities = vi.fn(async () => {})
        const temporaryClient = {
            ...createClient({
                fork: async () => {
                    throw forkError
                }
            }),
            disconnect: vi.fn(async () => {
                vi.setSystemTime(startedAt + 90_001)
            })
        }
        const history = new CodexConversationHistory(
            () => createClient() as never,
            () => temporaryClient as never
        )
        history.setPublishCapabilities(publishCapabilities)
        history.setThreadId('thread-1')

        try {
            const error = await history.fork().catch((caught) => caught)
            expect(error).toBeInstanceOf(AggregateError)
            expect(error.errors).toEqual([
                forkError,
                new Error('Codex fork cleanup timed out after 90000ms total')
            ])
            expect(publishCapabilities).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })

    it('applies the total fork deadline to capability publishing', async () => {
        vi.useFakeTimers()
        let finishPublish: (() => void) | undefined
        const history = createHistory(() => createClient())
        history.setPublishCapabilities(() => new Promise<void>((resolve) => {
            finishPublish = resolve
        }))
        history.setThreadId('thread-1')
        let settled = false
        const outcome = history.fork().then(
            (value) => ({ type: 'resolved' as const, value }),
            (error: unknown) => ({ type: 'rejected' as const, error })
        ).finally(() => {
            settled = true
        })

        try {
            await vi.advanceTimersByTimeAsync(90_000)
            expect(settled).toBe(true)
            await expect(outcome).resolves.toEqual({
                type: 'rejected',
                error: new Error('Codex fork timed out after 90000ms total')
            })
        } finally {
            finishPublish?.()
            await Promise.resolve()
            vi.useRealTimers()
        }
    })

    it('marks only historical fork unsupported on direct method-not-found', async () => {
        const forkError = new Error('thread/fork method not found')
        const history = createHistory(() => createClient({
            fork: async () => {
                throw forkError
            }
        }))
        history.setThreadId('thread-1')

        await expect(history.fork('local-b')).rejects.toBe(forkError)
        expect(history.getCapabilityStates().forkAtMessage).toBe('unsupported')
        expect(history.getCapabilityStates().forkCurrent).toBe('unknown')
    })

    it('historical fork passes lastTurnId of the previous turn', async () => {
        const fork = vi.fn(async (params: Record<string, unknown>) => {
            expect(params.lastTurnId).toBe('turn-a')
            expect(params.beforeTurnId).toBeUndefined()
            return { thread: { id: 'forked-hist' } }
        })
        const history = createHistory(() => createClient({ fork }))
        history.setThreadId('thread-1')
        const result = await history.fork('local-b')
        expect(result.nativeSessionId).toBe('forked-hist')
    })

    it('historical fork of the first turn uses beforeTurnId', async () => {
        const fork = vi.fn(async (params: Record<string, unknown>) => {
            expect(params.beforeTurnId).toBe('turn-a')
            expect(params.lastTurnId).toBeUndefined()
            return { thread: { id: 'forked-first' } }
        })
        const history = createHistory(() => createClient({ fork }))
        history.setThreadId('thread-1')
        const result = await history.fork('local-a')
        expect(result.nativeSessionId).toBe('forked-first')
    })

    it('computes rewind numTurns from selected turn', async () => {
        const rollback = vi.fn(async (params: { threadId: string; numTurns: number }) => {
            expect(params).toEqual({ threadId: 'thread-1', numTurns: 2 })
            return { thread: { id: 'thread-1' } }
        })
        const history = createHistory(() => createClient({ rollback }))
        history.setThreadId('thread-1')
        const result = await history.rewind('local-b')
        expect(result).toEqual({
            success: true,
            truncateFromLocalId: 'local-b',
            messages: []
        })
        expect(rollback).toHaveBeenCalledTimes(1)
    })

    it('does not classify an unsupported capability publish error as rollback failure', async () => {
        const publishError = new Error('capability publishing is unsupported')
        const rollback = vi.fn(async () => ({ thread: { id: 'thread-1' } }))
        const publishCapabilities = vi.fn(async () => {
            throw publishError
        })
        const history = createHistory(() => createClient({ rollback }))
        history.setPublishCapabilities(publishCapabilities)
        history.setThreadId('thread-1')

        await expect(history.rewind('local-b')).rejects.toBe(publishError)
        expect(history.getCapabilityStates().rewindToMessage).toBe('supported')
        expect(publishCapabilities).toHaveBeenCalledOnce()
    })

    it('aborts a timed-out rewind read and never rolls back when it resolves late', async () => {
        vi.useFakeTimers()
        let readSignal: AbortSignal | undefined
        let finishRead: ((value: { thread: { id: string; turns: Array<Record<string, unknown>> } }) => void) | undefined
        const read = vi.fn((_params?: Record<string, unknown>, options?: { signal?: AbortSignal }) => new Promise<{ thread: { id: string; turns: Array<Record<string, unknown>> } }>((resolve) => {
            readSignal = options?.signal
            finishRead = resolve
        }))
        const rollback = vi.fn(async () => ({ thread: { id: 'thread-1' } }))
        const history = createHistory(() => createClient({ read, rollback }))
        history.setThreadId('thread-1')
        const outcome = history.rewind('local-b').catch((error) => error)

        try {
            await vi.advanceTimersByTimeAsync(90_000)
            finishRead!({
                thread: {
                    id: 'thread-1',
                    turns: [
                        { id: 'turn-a', items: [{ type: 'userMessage', clientId: 'local-a' }] },
                        { id: 'turn-b', items: [{ type: 'userMessage', clientId: 'local-b' }] }
                    ]
                }
            })
            await expect(outcome).resolves.toEqual(
                new Error('Codex rewind timed out after 90000ms total')
            )
            expect(readSignal?.aborted).toBe(true)
            expect(rollback).not.toHaveBeenCalled()
        } finally {
            finishRead?.({ thread: { id: 'thread-1', turns: [] } })
            await outcome
            vi.useRealTimers()
        }
    })

    it('does not roll back when the session becomes busy during the turn read', async () => {
        let finishRead: ((value: { thread: { id: string; turns: Array<Record<string, unknown>> } }) => void) | undefined
        const read = vi.fn(() => new Promise<{ thread: { id: string; turns: Array<Record<string, unknown>> } }>((resolve) => {
            finishRead = resolve
        }))
        const rollback = vi.fn(async () => ({ thread: { id: 'thread-1' } }))
        const history = createHistory(() => createClient({ read, rollback }))
        history.setThreadId('thread-1')
        const rewind = history.rewind('local-b')
        await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())

        history.setBusy(true)
        finishRead!({
            thread: {
                id: 'thread-1',
                turns: [
                    { id: 'turn-a', items: [{ type: 'userMessage', clientId: 'local-a' }] },
                    { id: 'turn-b', items: [{ type: 'userMessage', clientId: 'local-b' }] }
                ]
            }
        })

        await expect(rewind).rejects.toThrow('Session is busy')
        expect(rollback).not.toHaveBeenCalled()
    })

    it('retains a timed-out rollback as an active mutation until it settles', async () => {
        vi.useFakeTimers()
        let rejectRollback: ((error: Error) => void) | undefined
        let settled = false
        const rollback = vi.fn()
            .mockImplementationOnce(() => new Promise<{ thread: { id: string } }>((_resolve, reject) => {
                rejectRollback = reject
            }))
            .mockResolvedValue({ thread: { id: 'thread-1' } })
        const publishCapabilities = vi.fn(async () => {})
        const history = createHistory(() => createClient({ rollback }))
        history.setPublishCapabilities(publishCapabilities)
        history.setThreadId('thread-1')
        const outcome = history.rewind('local-b').then(
            (value) => ({ type: 'resolved' as const, value }),
            (error: unknown) => ({ type: 'rejected' as const, error })
        ).finally(() => {
            settled = true
        })
        let cleanup: Promise<void> | undefined

        try {
            await vi.advanceTimersByTimeAsync(90_000)
            expect(settled).toBe(true)
            await expect(outcome).resolves.toEqual({
                type: 'rejected',
                error: new Error('Codex rewind timed out after 90000ms total')
            })
            expect(publishCapabilities).not.toHaveBeenCalled()

            await expect(history.fork()).rejects.toThrow('mutation is already in progress')
            await expect(history.rewind('local-b')).rejects.toThrow('mutation is already in progress')

            let cleanupSettled = false
            cleanup = history.cleanup().finally(() => {
                cleanupSettled = true
            })
            await vi.advanceTimersByTimeAsync(0)
            expect(cleanupSettled).toBe(false)
        } finally {
            rejectRollback?.(new Error('rollback settled late'))
            await outcome
            await cleanup
            vi.useRealTimers()
        }
    })

    it('keeps source work queued until a timed-out rollback settles', async () => {
        vi.useFakeTimers()
        let rejectRollback!: (error: Error) => void
        const rollback = vi.fn(() => new Promise<{ thread: { id: string } }>((_resolve, reject) => {
            rejectRollback = reject
        }))
        const history = createHistory(() => createClient({ rollback }))
        history.setThreadId('thread-1')
        const rewind = history.rewind('local-b').catch((error) => error)

        try {
            await vi.advanceTimersByTimeAsync(90_000)
            await expect(rewind).resolves.toEqual(
                new Error('Codex rewind timed out after 90000ms total')
            )

            let sourceLeaseAcquired = false
            const sourceLease = history.acquireSourceLease().then((release) => {
                sourceLeaseAcquired = true
                return release
            })
            await vi.advanceTimersByTimeAsync(0)
            expect(sourceLeaseAcquired).toBe(false)

            rejectRollback(new Error('rollback settled late'))
            const release = await sourceLease
            expect(sourceLeaseAcquired).toBe(true)
            release()
        } finally {
            vi.useRealTimers()
        }
    })

    it('applies the total rewind deadline to capability publishing', async () => {
        vi.useFakeTimers()
        let finishPublish: (() => void) | undefined
        let settled = false
        const history = createHistory(() => createClient())
        history.setPublishCapabilities(() => new Promise<void>((resolve) => {
            finishPublish = resolve
        }))
        history.setThreadId('thread-1')
        const outcome = history.rewind('local-b').then(
            (value) => ({ type: 'resolved' as const, value }),
            (error: unknown) => ({ type: 'rejected' as const, error })
        ).finally(() => {
            settled = true
        })

        try {
            await vi.advanceTimersByTimeAsync(90_000)
            expect(settled).toBe(true)
            await expect(outcome).resolves.toEqual({
                type: 'rejected',
                error: new Error('Codex rewind timed out after 90000ms total')
            })
        } finally {
            finishPublish?.()
            await outcome
            vi.useRealTimers()
        }
    })

    it('does not start rollback when shutdown follows the turn read', async () => {
        let finishRead: ((value: { thread: { id: string; turns: Array<Record<string, unknown>> } }) => void) | undefined
        const read = vi.fn(() => new Promise<{ thread: { id: string; turns: Array<Record<string, unknown>> } }>((resolve) => {
            finishRead = resolve
        }))
        const rollback = vi.fn(async () => ({ thread: { id: 'thread-1' } }))
        const history = createHistory(() => createClient({ read, rollback }))
        history.setThreadId('thread-1')
        const rewind = history.rewind('local-b').catch((error) => error)
        await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())

        finishRead!({
            thread: {
                id: 'thread-1',
                turns: [
                    { id: 'turn-a', items: [{ type: 'userMessage', clientId: 'local-a' }] },
                    { id: 'turn-b', items: [{ type: 'userMessage', clientId: 'local-b' }] }
                ]
            }
        })
        const cleanup = history.cleanup()
        const [rewindError] = await Promise.all([rewind, cleanup])

        expect(rewindError).toEqual(new Error('Codex conversation history is shutting down'))
        expect(rollback).not.toHaveBeenCalled()
    })

    it('waits for an active rollback during shutdown', async () => {
        let finishRollback: (() => void) | undefined
        const rollback = vi.fn(() => new Promise<{ thread: { id: string } }>((resolve) => {
            finishRollback = () => resolve({ thread: { id: 'thread-1' } })
        }))
        const history = createHistory(() => createClient({ rollback }))
        history.setThreadId('thread-1')
        const rewind = history.rewind('local-b').catch((error) => error)
        await vi.waitFor(() => expect(rollback).toHaveBeenCalledOnce())

        let cleanupSettled = false
        const cleanup = history.cleanup().finally(() => {
            cleanupSettled = true
        })
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(cleanupSettled).toBe(false)

        finishRollback!()
        const [rewindError] = await Promise.all([rewind, cleanup])
        expect(rewindError).toEqual(new Error('Codex conversation history is shutting down'))
    })

    it('rejects fork while a rewind mutation is in progress', async () => {
        let finishRollback: (() => void) | undefined
        const rollback = vi.fn(() => new Promise<{ thread: { id: string } }>((resolve) => {
            finishRollback = () => resolve({ thread: { id: 'thread-1' } })
        }))
        const history = createHistory(() => createClient({ rollback }))
        history.setThreadId('thread-1')
        const rewind = history.rewind('local-b')
        await vi.waitFor(() => expect(rollback).toHaveBeenCalledOnce())

        try {
            await expect(history.fork()).rejects.toThrow('mutation is already in progress')
        } finally {
            finishRollback!()
            await rewind
        }
    })

    it('marks rewind unsupported on method-not-found without affecting fork', async () => {
        const rollback = vi.fn(async () => {
            throw new Error('thread/rollback is unsupported')
        })
        const fork = vi.fn(async () => ({ thread: { id: 'forked-ok' } }))
        const history = createHistory(() => createClient({ rollback, fork }))
        history.setThreadId('thread-1')
        await expect(history.rewind('local-a')).rejects.toThrow(/unsupported/)
        const caps = history.getCapabilitiesForMetadata()?.conversationHistory
        expect(caps?.rewindToMessage).toBeUndefined()
        const forked = await history.fork()
        expect(forked.nativeSessionId).toBe('forked-ok')
    })

    it('does not call native fork when selected turn is missing', async () => {
        const fork = vi.fn(async () => ({ thread: { id: 'x' } }))
        const history = createHistory(() => createClient({
            fork,
            read: async () => ({ thread: { id: 'thread-1', turns: [] } })
        }))
        history.setThreadId('thread-1')
        await expect(history.fork('missing-local')).rejects.toThrow(/No native history point/)
        expect(fork).not.toHaveBeenCalled()
    })

    it('restores durable localId→turnId locators across relaunches', async () => {
        const fork = vi.fn(async (params: Record<string, unknown>) => {
            expect(params.lastTurnId).toBe('turn-a')
            expect(params.beforeTurnId).toBeUndefined()
            return { thread: { id: 'forked-restored' } }
        })
        const history = createHistory(() => createClient({
            fork,
            // Simulate a relaunch where thread/read no longer exposes clientIds.
            read: async () => ({
                thread: {
                    id: 'thread-1',
                    turns: [
                        { id: 'turn-a', items: [] },
                        { id: 'turn-b', items: [] }
                    ]
                }
            })
        }))
        history.setThreadId('thread-1')
        history.restoreTurns({ 'local-b': 'turn-b' })
        const result = await history.fork('local-b')
        expect(result.nativeSessionId).toBe('forked-restored')
        expect(history.getTurns()['local-b']).toBe('turn-b')
    })
})
