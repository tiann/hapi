import { describe, expect, it, vi } from 'vitest'
import type { Session } from './types'

const socketHarness = vi.hoisted(() => ({
    sockets: [] as Array<{
        connected: boolean
        connectCalls: number
        connectImmediately: boolean
        emitted: Array<{ event: string; args: unknown[] }>
        listeners: Map<string, Array<(...args: any[]) => void>>
        triggerConnect: () => void
        triggerConnectError: () => void
    }>
}))

vi.mock('socket.io-client', () => ({
    io: () => {
        const state = {
            connected: false,
            connectCalls: 0,
            connectImmediately: true,
            emitted: [] as Array<{ event: string; args: unknown[] }>,
            listeners: new Map<string, Array<(...args: any[]) => void>>(),
            triggerConnect: () => {},
            triggerConnectError: () => {}
        }
        const triggerConnect = () => {
            state.connected = true
            for (const listener of state.listeners.get('connect') ?? []) listener()
        }
        state.triggerConnect = triggerConnect
        state.triggerConnectError = () => {
            for (const listener of state.listeners.get('connect_error') ?? []) {
                listener(new Error('connect failed'))
            }
        }
        const socket = {
            get connected() {
                return state.connected
            },
            on: (event: string, listener: (...args: any[]) => void) => {
                const listeners = state.listeners.get(event) ?? []
                listeners.push(listener)
                state.listeners.set(event, listeners)
                return socket
            },
            off: (event: string, listener: (...args: any[]) => void) => {
                const listeners = state.listeners.get(event) ?? []
                state.listeners.set(event, listeners.filter((candidate) => candidate !== listener))
                return socket
            },
            emit: (event: string, ...args: unknown[]) => {
                state.emitted.push({ event, args })
                return socket
            },
            emitWithAck: async () => ({}),
            timeout: () => ({ emitWithAck: async () => ({}) }),
            connect: () => {
                state.connectCalls += 1
                if (state.connectImmediately) {
                    triggerConnect()
                }
                return socket
            },
            disconnect: () => {
                state.connected = false
                return socket
            }
        }
        Object.assign(socket, { volatile: socket })
        socketHarness.sockets.push(state)
        return socket
    }
}))

import { ApiSessionClient, isExternalUserMessage, IncomingMessageFilter } from './apiSession'

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: '11111111-1111-4111-8111-111111111111',
        namespace: 'pending',
        seq: 0,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        agentState: { controlledByUser: false },
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 1,
        todos: [],
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        permissionMode: undefined,
        collaborationMode: undefined,
        ...overrides
    }
}

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve
        reject = promiseReject
    })
    return { promise, resolve, reject }
}

describe('ApiSessionClient lazy materialization', () => {
    it('does not connect or materialize without a real user message', async () => {
        socketHarness.sockets.length = 0
        const materialize = vi.fn(async () => createSession())
        const client = new ApiSessionClient('token', createSession(), { materialize })

        client.updateMetadata(() => ({ path: '/tmp/project', host: 'localhost', codexSessionId: 'codex-thread' }))
        client.sendSessionEvent({ type: 'ready' })
        client.keepAlive(false, 'local')
        await client.flush({ timeoutMs: 100 })

        expect(client.getState()).toBe('pending')
        expect(materialize).not.toHaveBeenCalled()
        expect(socketHarness.sockets[0]?.connectCalls).toBe(0)
        expect(socketHarness.sockets[0]?.emitted).toEqual([])
        client.close()
    })

    it('materializes on the first user message and replays queued events', async () => {
        socketHarness.sockets.length = 0
        const materialize = vi.fn(async (snapshot) => createSession({
            namespace: 'default',
            metadata: snapshot.metadata,
            metadataVersion: 1,
            agentState: snapshot.agentState,
            agentStateVersion: 1
        }))
        const client = new ApiSessionClient('token', createSession(), { materialize })
        client.updateMetadata(() => ({ path: '/tmp/project', host: 'localhost', codexSessionId: 'codex-thread' }))
        client.sendSessionEvent({ type: 'ready' })

        client.sendUserMessage('hello')
        expect(await client.materialize()).toBe(true)

        expect(materialize).toHaveBeenCalledWith({
            metadata: { path: '/tmp/project', host: 'localhost', codexSessionId: 'codex-thread' },
            agentState: { controlledByUser: false }
        }, expect.any(AbortSignal))
        expect(client.getState()).toBe('active')
        expect(socketHarness.sockets[0]?.connectCalls).toBe(1)
        expect(socketHarness.sockets[0]?.emitted.map((entry) => entry.event)).toEqual([
            'message',
            'message',
            'session-alive'
        ])
        client.close()
    })

    it('materializes on non-text user activity and preserves following agent events', async () => {
        socketHarness.sockets.length = 0
        const pendingMaterialization = deferred<Session>()
        const materialize = vi.fn(async () => await pendingMaterialization.promise)
        const client = new ApiSessionClient('token', createSession(), { materialize })

        client.notifyUserActivity()
        client.sendAgentMessage({ type: 'message', message: 'image response' })
        expect(client.getState()).toBe('materializing')

        pendingMaterialization.resolve(createSession({ namespace: 'default' }))
        expect(await client.materialize()).toBe(true)

        expect(materialize).toHaveBeenCalledTimes(1)
        const messages = socketHarness.sockets[0]?.emitted.filter((entry) => entry.event === 'message')
        expect(messages).toHaveLength(1)
        client.close()
    })

    it('preserves all replayed transcript messages while materialization is in flight', async () => {
        socketHarness.sockets.length = 0
        const pendingMaterialization = deferred<Session>()
        const client = new ApiSessionClient('token', createSession(), {
            materialize: async () => await pendingMaterialization.promise
        })
        const expectedMessages: string[] = []

        for (let index = 0; index < 150; index += 1) {
            const userMessage = `user-${index}`
            const agentMessage = `agent-${index}`
            expectedMessages.push(userMessage, agentMessage)
            client.sendUserMessage(userMessage)
            client.sendAgentMessage({ type: 'message', message: agentMessage })
        }

        pendingMaterialization.resolve(createSession({ namespace: 'default' }))
        expect(await client.materialize()).toBe(true)

        const emittedMessages = socketHarness.sockets[0]?.emitted
            .filter((entry) => entry.event === 'message')
            .map((entry) => {
                const payload = entry.args[0] as {
                    message: {
                        role: 'user' | 'agent'
                        content: { text?: string; data?: { message?: string } }
                    }
                }
                return payload.message.role === 'user'
                    ? payload.message.content.text
                    : payload.message.content.data?.message
            })

        expect(emittedMessages).toEqual(expectedMessages)
        client.close()
    })

    it('drains in-flight materialization and initial socket delivery before closing', async () => {
        socketHarness.sockets.length = 0
        const pendingMaterialization = deferred<Session>()
        const client = new ApiSessionClient('token', createSession(), {
            materialize: async () => await pendingMaterialization.promise
        })
        const socket = socketHarness.sockets[0]
        if (!socket) throw new Error('expected socket')
        socket.connectImmediately = false

        client.sendUserMessage('persist me')
        client.sendAgentMessage({ type: 'message', message: 'persist response' })
        client.sendSessionDeath('completed')

        let flushed = false
        const flushTask = client.flush({ timeoutMs: 1_000 }).then(() => {
            flushed = true
        })
        await Promise.resolve()
        expect(flushed).toBe(false)

        pendingMaterialization.resolve(createSession({ namespace: 'default' }))
        await vi.waitFor(() => expect(socket.connectCalls).toBe(1))
        expect(flushed).toBe(false)

        socket.triggerConnectError()
        await Promise.resolve()
        expect(flushed).toBe(false)

        socket.triggerConnect()
        await flushTask

        expect(socket.emitted.map((entry) => entry.event)).toEqual([
            'message',
            'message',
            'session-end',
            'session-alive'
        ])
        client.close()
    })

    it('skips materialization backoff and performs one final attempt during shutdown drain', async () => {
        socketHarness.sockets.length = 0
        const materialize = vi.fn(async () => {
            if (materialize.mock.calls.length === 1) {
                throw Object.assign(new Error('hub unavailable'), { isAxiosError: true })
            }
            return createSession({ namespace: 'default' })
        })
        const client = new ApiSessionClient('token', createSession(), { materialize })

        client.sendUserMessage('hello')
        await vi.waitFor(() => expect(materialize).toHaveBeenCalledTimes(1))
        await Promise.resolve()

        await client.flush({ timeoutMs: 500 })

        expect(materialize).toHaveBeenCalledTimes(2)
        expect(client.getState()).toBe('active')
        expect(socketHarness.sockets[0]?.emitted.some((entry) => entry.event === 'message')).toBe(true)
        client.close()
    })

    it('aborts in-flight materialization when closed', async () => {
        socketHarness.sockets.length = 0
        const observedSignals: AbortSignal[] = []
        const materialize = vi.fn(async (_snapshot, signal: AbortSignal) => {
            observedSignals.push(signal)
            return await new Promise<Session>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            })
        })
        const client = new ApiSessionClient('token', createSession(), { materialize })

        const task = client.materialize()
        await Promise.resolve()
        client.close()

        expect(await task).toBe(false)
        expect(observedSignals[0]?.aborted).toBe(true)
        expect(client.getState()).toBe('closed')
    })

    it('reconnects a disconnected active session during final flush', async () => {
        socketHarness.sockets.length = 0
        const client = new ApiSessionClient('token', createSession({ namespace: 'default' }))
        const socket = socketHarness.sockets[0]
        if (!socket) throw new Error('expected socket')
        socket.connected = false
        socket.connectImmediately = false
        client.sendSessionDeath('completed')

        let flushed = false
        const flushTask = client.flush({ timeoutMs: 500 }).then(() => {
            flushed = true
        })
        await vi.waitFor(() => expect(socket.connectCalls).toBe(2))
        expect(flushed).toBe(false)

        socket.triggerConnect()
        await flushTask

        expect(socket.emitted.some((entry) => entry.event === 'session-end')).toBe(true)
        client.close()
    })
})

describe('isExternalUserMessage', () => {
    const baseUserMsg = {
        type: 'user' as const,
        uuid: 'test-uuid',
        userType: 'external' as const,
        isSidechain: false,
        message: { role: 'user', content: 'hello' },
    }

    it('returns true for a real user text message', () => {
        expect(isExternalUserMessage(baseUserMsg)).toBe(true)
    })

    it('returns false when isMeta is true (skill injections)', () => {
        expect(isExternalUserMessage({ ...baseUserMsg, isMeta: true })).toBe(false)
    })

    it('returns false when isSidechain is true', () => {
        expect(isExternalUserMessage({ ...baseUserMsg, isSidechain: true })).toBe(false)
    })

    it('returns true when content is an array of text blocks', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: [{ type: 'text', text: 'hello array' }] },
            } as never)
        ).toBe(true)
    })

    it('returns false when content is a non-text array (tool results)', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y' }] },
            } as never)
        ).toBe(false)
    })

    it('returns false for assistant messages', () => {
        expect(
            isExternalUserMessage({
                type: 'assistant',
                uuid: 'test-uuid',
                message: { role: 'assistant', content: 'hi' },
            } as never)
        ).toBe(false)
    })

    // System-injected content detection
    it('returns false for <task-notification> messages', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: '<task-notification>\n<task-id>abc123</task-id>\n</task-notification>' },
            })
        ).toBe(false)
    })

    it('returns false for <command-name> messages', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: '<command-name>/clear</command-name>' },
            })
        ).toBe(false)
    })

    it('returns false for <local-command-caveat> messages', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: '<local-command-caveat>Caveat: ...</local-command-caveat>' },
            })
        ).toBe(false)
    })

    it('returns false for <system-reminder> messages', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: '<system-reminder>\nToday is 2026.\n</system-reminder>' },
            })
        ).toBe(false)
    })

    it('returns true for user text that mentions XML-like strings but is not injected', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: 'How do I use the <task-notification> tag?' },
            })
        ).toBe(true)
    })

    it('returns false for <task-notification> with leading whitespace', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: '  \n<task-notification>\n<task-id>x</task-id>\n</task-notification>' },
            })
        ).toBe(false)
    })
})

describe('IncomingMessageFilter (HAPI Bot R3 finding #1)', () => {
    it('accepts a mature scheduled message whose seq is below the latest cursor', () => {
        // schedule seq=10, immediate seq=11 acks first → cursor=11.
        // seq=10 matures: seq-only dedup would drop it; id-based dedup must accept.
        const filter = new IncomingMessageFilter()
        expect(filter.accept({ id: 'msg-imm', seq: 11 })).toBe(true)
        expect(filter.accept({ id: 'msg-sched', seq: 10 })).toBe(true)
    })

    it('rejects an exact id duplicate (re-emit on the next mature tick)', () => {
        const filter = new IncomingMessageFilter()
        expect(filter.accept({ id: 'msg-1', seq: 1 })).toBe(true)
        expect(filter.accept({ id: 'msg-1', seq: 1 })).toBe(false)
    })

    it('falls back to seq-only dedup for messages without an id', () => {
        const filter = new IncomingMessageFilter()
        expect(filter.accept({ seq: 5 })).toBe(true)
        // seq <= cursor and no id → drop (legacy behaviour preserved).
        expect(filter.accept({ seq: 4 })).toBe(false)
        expect(filter.accept({ seq: 5 })).toBe(false)
    })

    it('advances cursorSeq monotonically regardless of arrival order', () => {
        const filter = new IncomingMessageFilter()
        filter.accept({ id: 'a', seq: 11 })
        filter.accept({ id: 'b', seq: 10 })
        expect(filter.cursorSeq()).toBe(11)
    })

    it('bounds the seen-id set to the configured capacity (LRU eviction)', () => {
        const filter = new IncomingMessageFilter(3)
        filter.accept({ id: 'a', seq: 1 })
        filter.accept({ id: 'b', seq: 2 })
        filter.accept({ id: 'c', seq: 3 })
        filter.accept({ id: 'd', seq: 4 })
        // 'a' should have been evicted — re-presenting it is treated as new.
        expect(filter.accept({ id: 'a', seq: 5 })).toBe(true)
        // 'd' is still in the set.
        expect(filter.accept({ id: 'd', seq: 6 })).toBe(false)
    })

    it('refreshes recency on dedup hit so re-emits survive bursts of unrelated ids', () => {
        // Models the documented contract: the hub re-emits the same id every 5 s
        // until the CLI acks.  If the dedup were FIFO (insert-order only), a
        // burst of capacity-many unrelated ids between re-emits would evict the
        // pending id and the next re-emit would double-deliver.
        const filter = new IncomingMessageFilter(3)
        // Pre-fill so 'pending' is not at the head.
        filter.accept({ id: 'a', seq: 1 })
        filter.accept({ id: 'pending', seq: 2 })
        filter.accept({ id: 'b', seq: 3 })
        // Re-emit pending → recency refresh moves it to the tail.
        expect(filter.accept({ id: 'pending', seq: 4 })).toBe(false)
        // Burst that evicts oldest entries.  Without the refresh 'pending' would
        // be at insert position 2 and would be evicted; with the refresh it is
        // now the newest entry and survives.
        filter.accept({ id: 'c', seq: 5 })
        filter.accept({ id: 'd', seq: 6 })
        // 'a' (oldest) and then 'b' should have been evicted; 'pending' must
        // still dedup.
        expect(filter.accept({ id: 'pending', seq: 7 })).toBe(false)
        expect(filter.accept({ id: 'a', seq: 8 })).toBe(true)
        expect(filter.accept({ id: 'b', seq: 9 })).toBe(true)
    })
})
