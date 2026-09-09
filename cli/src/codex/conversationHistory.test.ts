import { describe, expect, it, vi } from 'vitest'
import { CodexConversationHistory } from './conversationHistory'

function createClient(overrides?: {
    fork?: (params: Record<string, unknown>) => Promise<{ thread: { id: string } }>
    rollback?: (params: { threadId: string; numTurns: number }) => Promise<unknown>
    read?: () => Promise<{ thread: { id: string; turns?: Array<Record<string, unknown>> } }>
}) {
    return {
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

describe('CodexConversationHistory', () => {
    it('only publishes methods confirmed by the app server', async () => {
        const supportsMethod = vi.fn(async (method: string) => method === 'thread/fork')
        const history = new CodexConversationHistory(() => ({
            ...createClient(),
            supportsMethod
        }) as never)
        history.setThreadId('thread-1')
        await history.probeCapabilities()
        expect(history.getCapabilitiesForMetadata()?.conversationHistory).toEqual({
            forkCurrent: true,
            forkAtMessage: true
        })
    })

    it('forks current without a turn boundary', async () => {
        const fork = vi.fn(async (params: Record<string, unknown>) => {
            expect(params.beforeTurnId).toBeUndefined()
            return { thread: { id: 'forked-current' } }
        })
        const history = new CodexConversationHistory(() => createClient({ fork }) as never)
        history.setThreadId('thread-1')
        const result = await history.fork()
        expect(result).toEqual({ nativeSessionId: 'forked-current' })
        expect(fork).toHaveBeenCalledTimes(1)
    })

    it('historical fork passes lastTurnId of the previous turn', async () => {
        const fork = vi.fn(async (params: Record<string, unknown>) => {
            expect(params.lastTurnId).toBe('turn-a')
            expect(params.beforeTurnId).toBeUndefined()
            return { thread: { id: 'forked-hist' } }
        })
        const history = new CodexConversationHistory(() => createClient({ fork }) as never)
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
        const history = new CodexConversationHistory(() => createClient({ fork }) as never)
        history.setThreadId('thread-1')
        const result = await history.fork('local-a')
        expect(result.nativeSessionId).toBe('forked-first')
    })

    it('computes rewind numTurns from selected turn', async () => {
        const rollback = vi.fn(async (params: { threadId: string; numTurns: number }) => {
            expect(params).toEqual({ threadId: 'thread-1', numTurns: 2 })
            return { thread: { id: 'thread-1' } }
        })
        const history = new CodexConversationHistory(() => createClient({ rollback }) as never)
        history.setThreadId('thread-1')
        const result = await history.rewind('local-b')
        expect(result).toEqual({
            success: true,
            truncateFromLocalId: 'local-b',
            messages: []
        })
        expect(rollback).toHaveBeenCalledTimes(1)
    })

    it('returns a safe-Fork code when the selected message starts a steered turn', async () => {
        const rollback = vi.fn(async () => ({}))
        const history = new CodexConversationHistory(() => createClient({
            rollback,
            read: async () => ({
                thread: {
                    id: 'thread-1',
                    turns: [
                        { id: 'turn-a', items: [{ type: 'userMessage', clientId: 'local-a' }] },
                        {
                            id: 'turn-b',
                            items: [
                                { type: 'userMessage', clientId: 'local-b' },
                                { type: 'userMessage', clientId: 'local-steer' }
                            ]
                        }
                    ]
                }
            })
        }) as never)
        history.setThreadId('thread-1')
        await history.probeCapabilities()

        const result = await history.rewind('local-b')

        expect(result).toMatchObject({
            success: false,
            outcome: 'rejected',
            code: 'ambiguous_native_boundary_fork_safe'
        })
        if (result.success) throw new Error('Expected rewind to be rejected')
        expect(result.error).toContain('ambiguous')
        expect(rollback).not.toHaveBeenCalled()
    })

    it('does not offer the Fork fallback when historical fork is unsupported', async () => {
        const rollback = vi.fn(async () => ({}))
        const supportsMethod = vi.fn(async (method: string) => method === 'thread/rollback')
        const history = new CodexConversationHistory(() => ({
            ...createClient({
                rollback,
                read: async () => ({
                    thread: {
                        id: 'thread-1',
                        turns: [
                            { id: 'turn-a', items: [{ type: 'userMessage', clientId: 'local-a' }] },
                            {
                                id: 'turn-b',
                                items: [
                                    { type: 'userMessage', clientId: 'local-b' },
                                    { type: 'userMessage', clientId: 'local-steer' }
                                ]
                            }
                        ]
                    }
                })
            }),
            supportsMethod
        }) as never)
        history.setThreadId('thread-1')
        await history.probeCapabilities()

        const result = await history.rewind('local-b')

        expect(result).toMatchObject({
            success: false,
            outcome: 'rejected',
            code: 'ambiguous_native_boundary'
        })
        expect(history.getCapabilityStates()).toMatchObject({
            forkAtMessage: 'unsupported',
            rewindToMessage: 'supported'
        })
        expect(rollback).not.toHaveBeenCalled()
    })

    it('does not offer the Fork fallback when an earlier user message has no client id', async () => {
        const rollback = vi.fn(async () => ({}))
        const history = new CodexConversationHistory(() => createClient({
            rollback,
            read: async () => ({
                thread: {
                    id: 'thread-1',
                    turns: [
                        { id: 'turn-a', items: [{ type: 'userMessage', clientId: 'local-a' }] },
                        {
                            id: 'turn-b',
                            items: [
                                { type: 'userMessage' },
                                { type: 'userMessage', clientId: 'local-b' }
                            ]
                        }
                    ]
                }
            })
        }) as never)
        history.setThreadId('thread-1')
        await history.probeCapabilities()

        const result = await history.rewind('local-b')

        expect(result).toMatchObject({
            success: false,
            outcome: 'rejected',
            code: 'ambiguous_native_boundary'
        })
        expect(rollback).not.toHaveBeenCalled()
    })

    it('does not offer the Fork fallback for the second message in a steered turn', async () => {
        const rollback = vi.fn(async () => ({}))
        const history = new CodexConversationHistory(() => createClient({
            rollback,
            read: async () => ({
                thread: {
                    id: 'thread-1',
                    turns: [
                        { id: 'turn-a', items: [{ type: 'userMessage', clientId: 'local-a' }] },
                        {
                            id: 'turn-b',
                            items: [
                                { type: 'userMessage', clientId: 'local-b' },
                                { type: 'userMessage', clientId: 'local-steer' }
                            ]
                        }
                    ]
                }
            })
        }) as never)
        history.setThreadId('thread-1')
        history.restoreTurns({ localSteer: 'turn-b' })

        const result = await history.rewind('local-steer')

        expect(result).toMatchObject({
            success: false,
            outcome: 'rejected',
            code: 'ambiguous_native_boundary'
        })
        expect(rollback).not.toHaveBeenCalled()
    })

    it('rejects rewind before native mutation when compaction is present', async () => {
        const rollback = vi.fn(async () => ({}))
        const history = new CodexConversationHistory(() => createClient({
            rollback,
            read: async () => ({
                thread: {
                    id: 'thread-1',
                    turns: [
                        { id: 'turn-a', items: [{ type: 'userMessage', clientId: 'local-a' }] },
                        {
                            id: 'turn-b',
                            items: [
                                { type: 'userMessage', clientId: 'local-b' },
                                { type: 'contextCompaction' }
                            ]
                        }
                    ]
                }
            })
        }) as never)
        history.setThreadId('thread-1')

        const result = await history.rewind('local-b')

        expect(result).toMatchObject({ success: false, outcome: 'rejected' })
        if (result.success) throw new Error('Expected rewind to be rejected')
        expect(result.error).toContain('ambiguous')
        expect(rollback).not.toHaveBeenCalled()
    })

    it('rejects rewind before native mutation when native items are incomplete', async () => {
        const rollback = vi.fn(async () => ({}))
        const history = new CodexConversationHistory(() => createClient({
            rollback,
            read: async () => ({
                thread: {
                    id: 'thread-1',
                    turns: [
                        { id: 'turn-a', items: [{ type: 'userMessage', clientId: 'local-a' }] },
                        { id: 'turn-b' }
                    ]
                }
            })
        }) as never)
        history.setThreadId('thread-1')
        history.restoreTurns({ localB: 'turn-b' })

        const result = await history.rewind('localB')

        expect(result).toMatchObject({ success: false, outcome: 'rejected' })
        if (result.success) throw new Error('Expected rewind to be rejected')
        expect(result.error).toContain('ambiguous')
        expect(rollback).not.toHaveBeenCalled()
    })

    it('rejects rewind before native mutation when a user message has no client id', async () => {
        const rollback = vi.fn(async () => ({}))
        const history = new CodexConversationHistory(() => createClient({
            rollback,
            read: async () => ({
                thread: {
                    id: 'thread-1',
                    turns: [
                        { id: 'turn-a', items: [{ type: 'userMessage', clientId: 'local-a' }] },
                        { id: 'turn-b', items: [{ type: 'userMessage' }] }
                    ]
                }
            })
        }) as never)
        history.setThreadId('thread-1')
        history.restoreTurns({ localB: 'turn-b' })

        const result = await history.rewind('localB')

        expect(result).toMatchObject({ success: false, outcome: 'rejected' })
        if (result.success) throw new Error('Expected rewind to be rejected')
        expect(result.error).toContain('ambiguous')
        expect(rollback).not.toHaveBeenCalled()
    })

    it('rejects rewind before native mutation when a native turn has no id', async () => {
        const rollback = vi.fn(async () => ({}))
        const history = new CodexConversationHistory(() => createClient({
            rollback,
            read: async () => ({
                thread: {
                    id: 'thread-1',
                    turns: [
                        { id: 'turn-a', items: [{ type: 'userMessage', clientId: 'local-a' }] },
                        { items: [{ type: 'assistantMessage' }] },
                        { id: 'turn-c', items: [{ type: 'userMessage', clientId: 'local-c' }] }
                    ]
                }
            })
        }) as never)
        history.setThreadId('thread-1')

        const result = await history.rewind('local-a')

        expect(result).toMatchObject({ success: false, outcome: 'rejected' })
        if (result.success) throw new Error('Expected rewind to be rejected')
        expect(result.error).toContain('ambiguous')
        expect(rollback).not.toHaveBeenCalled()
    })

    it('returns a deterministic rejection when the selected native turn cannot be resolved', async () => {
        const rollback = vi.fn(async () => ({}))
        const history = new CodexConversationHistory(() => createClient({
            rollback,
            read: async () => ({ thread: { id: 'thread-1' } })
        }) as never)
        history.setThreadId('thread-1')
        history.restoreTurns({ localB: 'turn-b' })

        const result = await history.rewind('localB')

        expect(result).toMatchObject({
            success: false,
            code: 'ambiguous_native_boundary',
            outcome: 'rejected'
        })
        if (result.success) throw new Error('Expected rewind to be rejected')
        expect(result.error).toContain('ambiguous')
        expect(rollback).not.toHaveBeenCalled()
    })

    it('rejects rewind before native mutation when a native item is malformed', async () => {
        const rollback = vi.fn(async () => ({}))
        const history = new CodexConversationHistory(() => createClient({
            rollback,
            read: async () => ({
                thread: {
                    id: 'thread-1',
                    turns: [
                        { id: 'turn-a', items: [{ type: 'userMessage', clientId: 'local-a' }] },
                        { id: 'turn-b', items: [{}] }
                    ]
                }
            })
        }) as never)
        history.setThreadId('thread-1')

        const result = await history.rewind('local-a')

        expect(result).toMatchObject({ success: false, outcome: 'rejected' })
        if (result.success) throw new Error('Expected rewind to be rejected')
        expect(result.error).toContain('ambiguous')
        expect(rollback).not.toHaveBeenCalled()
    })

    it('rejects rewind before native mutation when native turn ids are duplicated', async () => {
        const rollback = vi.fn(async () => ({}))
        const history = new CodexConversationHistory(() => createClient({
            rollback,
            read: async () => ({
                thread: {
                    id: 'thread-1',
                    turns: [
                        { id: 'turn-a', items: [{ type: 'userMessage', clientId: 'local-a' }] },
                        { id: 'turn-a', items: [{ type: 'userMessage', clientId: 'local-b' }] }
                    ]
                }
            })
        }) as never)
        history.setThreadId('thread-1')

        const result = await history.rewind('local-a')

        expect(result).toMatchObject({ success: false, outcome: 'rejected' })
        if (result.success) throw new Error('Expected rewind to be rejected')
        expect(result.error).toContain('ambiguous')
        expect(rollback).not.toHaveBeenCalled()
    })

    it('rejects rewind before native mutation when client ids are duplicated', async () => {
        const rollback = vi.fn(async () => ({}))
        const history = new CodexConversationHistory(() => createClient({
            rollback,
            read: async () => ({
                thread: {
                    id: 'thread-1',
                    turns: [
                        { id: 'turn-a', items: [{ type: 'userMessage', clientId: 'local-a' }] },
                        { id: 'turn-b', items: [{ type: 'userMessage', clientId: 'local-a' }] }
                    ]
                }
            })
        }) as never)
        history.setThreadId('thread-1')

        const result = await history.rewind('local-a')

        expect(result).toMatchObject({ success: false, outcome: 'rejected' })
        if (result.success) throw new Error('Expected rewind to be rejected')
        expect(result.error).toContain('ambiguous')
        expect(rollback).not.toHaveBeenCalled()
    })

    it('marks rewind unsupported on method-not-found without affecting fork', async () => {
        const rollback = vi.fn(async () => {
            throw new Error('thread/rollback is unsupported')
        })
        const fork = vi.fn(async () => ({ thread: { id: 'forked-ok' } }))
        const history = new CodexConversationHistory(() => createClient({ rollback, fork }) as never)
        history.setThreadId('thread-1')
        await expect(history.rewind('local-a')).rejects.toThrow(/unsupported/)
        const caps = history.getCapabilitiesForMetadata()?.conversationHistory
        expect(caps?.rewindToMessage).toBeUndefined()
        const forked = await history.fork()
        expect(forked.nativeSessionId).toBe('forked-ok')
    })

    it('does not call native fork when selected turn is missing', async () => {
        const fork = vi.fn(async () => ({ thread: { id: 'x' } }))
        const history = new CodexConversationHistory(() => createClient({
            fork,
            read: async () => ({ thread: { id: 'thread-1', turns: [] } })
        }) as never)
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
        const history = new CodexConversationHistory(() => createClient({
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
        }) as never)
        history.setThreadId('thread-1')
        history.restoreTurns({ 'local-b': 'turn-b' })
        const result = await history.fork('local-b')
        expect(result.nativeSessionId).toBe('forked-restored')
        expect(history.getTurns()['local-b']).toBe('turn-b')
    })
})
