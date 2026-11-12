import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getGeneratedImage } from '@/modules/common/generatedImages'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from './types'

const socketHarness = vi.hoisted(() => ({
    sockets: [] as Array<{
        connected: boolean
        connectCalls: number
        connectImmediately: boolean
        emitted: Array<{ event: string; args: unknown[] }>
        listeners: Map<string, Array<(...args: any[]) => void>>
        trigger: (event: string, ...args: any[]) => void
        triggerConnect: () => void
        triggerConnectError: () => void
        emitWithAckImpl: (event: string, ...args: unknown[]) => Promise<unknown>
    }>
}))

const axiosHarness = vi.hoisted(() => ({
    get: vi.fn()
}))

vi.mock('socket.io-client', () => ({
    io: () => {
        const state: (typeof socketHarness.sockets)[number] = {
            connected: false,
            connectCalls: 0,
            connectImmediately: true,
            emitted: [] as Array<{ event: string; args: unknown[] }>,
            listeners: new Map<string, Array<(...args: any[]) => void>>(),
            trigger: () => {},
            triggerConnect: () => {},
            triggerConnectError: () => {},
            emitWithAckImpl: async (event: string, payload?: any) => {
                if (event === 'update-state') return { result: 'success', version: 1, agentState: payload?.agentState ?? {} }
                if (event === 'update-metadata') return { result: 'success', version: 1, metadata: payload?.metadata ?? {} }
                return {}
            }
        }
        state.trigger = (event: string, ...args: any[]) => {
            for (const listener of state.listeners.get(event) ?? []) {
                listener(...args)
            }
        }
        const triggerConnect = () => {
            state.connected = true
            state.trigger('connect')
        }
        state.triggerConnect = triggerConnect
        state.triggerConnectError = () => {
            state.trigger('connect_error', new Error('connect failed'))
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
            emitWithAck: async (event: string, ...args: unknown[]) => state.emitWithAckImpl(event, ...args),
            timeout: () => ({
                emitWithAck: async (event: string, ...args: unknown[]) => state.emitWithAckImpl(event, ...args)
            }),
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
        Object.assign(socket, {
            volatile: socket,
            io: { opts: { reconnection: true } }
        })
        socketHarness.sockets.push(state)
        return socket
    }
}))

vi.mock('axios', () => ({
    default: {
        get: axiosHarness.get,
        isAxiosError: (error: unknown) => (
            typeof error === 'object'
            && error !== null
            && 'isAxiosError' in error
            && error.isAxiosError === true
        )
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

function triggerIncomingUserMessage(
    socket: (typeof socketHarness.sockets)[number],
    message: {
        id?: string
        seq: number
        text: string
        sentFrom: 'cli' | 'webapp' | 'telegram-bot'
    }
): void {
    socket.trigger('update', {
        body: {
            t: 'new-message',
            message: {
                id: message.id,
                seq: message.seq,
                localId: null,
                content: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: message.text
                    },
                    meta: {
                        sentFrom: message.sentFrom
                    }
                }
            }
        }
    })
}

describe('ApiSessionClient input buffered during initialization', () => {
    function message(text: string, localId: string, seq: number) {
        return {
            id: `message-${seq}`, seq, localId,
            content: { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'webapp' } },
        }
    }

    it.each([false, true])('cancels buffered input before a user-message handler is ready (callback=%s)', async (withCallback) => {
        socketHarness.sockets.length = 0
        const client = new ApiSessionClient('token', createSession({ namespace: 'default' }))
        const socket = socketHarness.sockets[0]!
        const update = socket.listeners.get('update')![0]!
        const cancel = vi.fn(() => false)
        if (withCallback) client.onCancelQueuedMessage(cancel)
        await update({ body: { t: 'new-message', message: message('cancel me', 'local-1', 1) } })
        await update({ body: { t: 'new-message', message: message('keep me', 'local-2', 2) } })
        const ack = vi.fn()

        await update({ body: { t: 'cancel-queued-message', localId: 'local-1' } }, ack)
        expect(ack).toHaveBeenCalledWith({ removed: true, inFlight: false, indeterminate: false, consumed: false })
        expect(cancel).not.toHaveBeenCalled()
        const onMessage = vi.fn()
        client.onUserMessage(onMessage)
        expect(onMessage).toHaveBeenCalledTimes(1)
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ content: { type: 'text', text: 'keep me' } }), 'local-2')
        client.close()
    })

    it.each([false, true])('replaces buffered input on retry without flushing twice (callback=%s)', async (withCallback) => {
        socketHarness.sockets.length = 0
        const client = new ApiSessionClient('token', createSession({ namespace: 'default' }))
        const socket = socketHarness.sockets[0]!
        const update = socket.listeners.get('update')![0]!
        const cancel = vi.fn(() => 'consumed' as const)
        if (withCallback) client.onCancelQueuedMessage(cancel)
        await update({ body: { t: 'new-message', message: message('original', 'local-1', 1) } })
        const ack = vi.fn()
        await update({ body: { t: 'retry-queued-message', localId: 'local-1', message: message('replacement', 'local-1', 1) } }, ack)
        expect(ack).toHaveBeenCalledWith({ removed: false, accepted: true })
        expect(cancel).not.toHaveBeenCalled()
        const onMessage = vi.fn()
        client.onUserMessage(onMessage)
        expect(onMessage).toHaveBeenCalledTimes(1)
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ content: { type: 'text', text: 'replacement' } }), 'local-1')
        client.close()
    })

    it.each(['in-flight', 'consumed', 'indeterminate'] as const)('keeps %s cancellation semantics after input leaves the buffer', async (result) => {
        socketHarness.sockets.length = 0
        const client = new ApiSessionClient('token', createSession({ namespace: 'default' }))
        const update = socketHarness.sockets[0]!.listeners.get('update')![0]!
        const cancel = vi.fn(async () => result)
        client.onCancelQueuedMessage(cancel)
        const ack = vi.fn()
        await update({ body: { t: 'cancel-queued-message', localId: 'local-1' } }, ack)
        expect(cancel).toHaveBeenCalledWith('local-1')
        expect(ack).toHaveBeenCalledWith({
            removed: false, inFlight: result === 'in-flight', indeterminate: result === 'indeterminate', consumed: result === 'consumed',
        })
        client.close()
    })
})

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

    it('keeps an error event when the pending droppable queue overflows during materialization', async () => {
        socketHarness.sockets.length = 0
        const pendingMaterialization = deferred<Session>()
        const client = new ApiSessionClient('token', createSession(), {
            materialize: async () => await pendingMaterialization.promise
        })

        client.notifyUserActivity()
        client.sendSessionEvent({ type: 'error', message: 'Antigravity quota reached' })
        for (let index = 0; index < 300; index += 1) {
            client.sendSessionEvent({ type: 'ready' })
        }

        pendingMaterialization.resolve(createSession({ namespace: 'default' }))
        expect(await client.materialize()).toBe(true)

        const events = socketHarness.sockets[0]?.emitted
            .filter((entry) => entry.event === 'message')
            .map((entry) => (entry.args[0] as { message: { content: { data: { type: string; message?: string } } } }).message.content.data)
        expect(events).toContainEqual({ type: 'error', message: 'Antigravity quota reached' })
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

    it('reports an unconfirmed final flush when the socket cannot reconnect before the deadline', async () => {
        socketHarness.sockets.length = 0
        const client = new ApiSessionClient('token', createSession({ namespace: 'default' }))
        const socket = socketHarness.sockets[0]
        if (!socket) throw new Error('expected socket')
        socket.connected = false
        socket.connectImmediately = false
        client.sendSessionDeath('cleared')

        await expect(client.flush({ timeoutMs: 20 })).resolves.toBe(false)

        expect(socket.connectCalls).toBeGreaterThan(0)
        client.close()
    })

    it('emits hub-archived from update-session metadata (#1910)', async () => {
        socketHarness.sockets.length = 0
        axiosHarness.get.mockResolvedValue({ data: { messages: [] } })
        const session = createSession({
            namespace: 'default',
            metadata: { path: '/tmp', host: 'h', flavor: 'claude' },
            metadataVersion: 1
        })
        const client = new ApiSessionClient('token', session)
        const socket = socketHarness.sockets[0]
        if (!socket) throw new Error('expected socket')

        let archived = false
        client.on('hub-archived', () => { archived = true })

        socket.trigger('update', {
            body: {
                t: 'update-session',
                sid: session.id,
                metadata: {
                    version: 2,
                    value: {
                        path: '/tmp',
                        host: 'h',
                        flavor: 'claude',
                        lifecycleState: 'archived',
                        archivedBy: 'hub',
                        archiveReason: 'Archived from hub (CLI unreachable)'
                    }
                },
                agentState: null
            }
        })

        expect(archived).toBe(true)
        expect(client.getMetadata()?.lifecycleState).toBe('archived')
        client.close()
    })

    it('stops metadata CAS when hub returns archived on version-mismatch (#1911 M1)', async () => {
        socketHarness.sockets.length = 0
        axiosHarness.get.mockResolvedValue({ data: { messages: [] } })
        const session = createSession({
            namespace: 'default',
            metadata: { path: '/tmp', host: 'h', flavor: 'claude', lifecycleState: 'running' },
            metadataVersion: 1
        })
        const client = new ApiSessionClient('token', session)
        const socket = socketHarness.sockets[0]
        if (!socket) throw new Error('expected socket')

        let ackCalls = 0
        let archived = false
        client.on('hub-archived', () => { archived = true })
        socket.emitWithAckImpl = async (event) => {
            if (event !== 'update-metadata') return {}
            ackCalls += 1
            return {
                result: 'version-mismatch',
                version: 2,
                metadata: {
                    path: '/tmp',
                    host: 'h',
                    flavor: 'claude',
                    lifecycleState: 'archived',
                    archivedBy: 'hub',
                    archiveReason: 'Archived from hub'
                }
            }
        }

        client.updateMetadata((meta) => ({ ...meta, lifecycleState: 'running', hostPid: 42 }))

        await vi.waitFor(() => {
            expect(client.getMetadata()?.lifecycleState).toBe('archived')
            expect(archived).toBe(true)
        })
        await new Promise((r) => setTimeout(r, 50))
        expect(ackCalls).toBe(1)
        client.close()
    })

    it('exits via hub-archived on success+merge-preserve ack (#1911 criterion 6)', async () => {
        socketHarness.sockets.length = 0
        axiosHarness.get.mockResolvedValue({ data: { messages: [] } })
        const session = createSession({
            namespace: 'default',
            metadata: { path: '/tmp', host: 'h', flavor: 'claude', lifecycleState: 'running' },
            metadataVersion: 1
        })
        const client = new ApiSessionClient('token', session)
        const socket = socketHarness.sockets[0]
        if (!socket) throw new Error('expected socket')

        let ackCalls = 0
        let archived = false
        client.on('hub-archived', () => { archived = true })
        socket.emitWithAckImpl = async (event) => {
            if (event !== 'update-metadata') return {}
            ackCalls += 1
            // Hub merge-preserved archive fields and returned success.
            return {
                result: 'success',
                version: 2,
                metadata: {
                    path: '/tmp',
                    host: 'h',
                    flavor: 'claude',
                    lifecycleState: 'archived',
                    archivedBy: 'hub',
                    archiveReason: 'Archived from hub',
                    hostPid: 42
                }
            }
        }

        client.updateMetadata((meta) => ({ ...meta, lifecycleState: 'running', hostPid: 42 }))

        await vi.waitFor(() => {
            expect(archived).toBe(true)
            expect(client.getMetadata()?.lifecycleState).toBe('archived')
        })
        await new Promise((r) => setTimeout(r, 50))
        expect(ackCalls).toBe(1)
        client.close()
    })

    it('reconciles hub-archived metadata on reconnect (#1910)', async () => {
        socketHarness.sockets.length = 0
        axiosHarness.get.mockResolvedValue({
            data: {
                session: {
                    metadataVersion: 1,
                    metadata: { path: '/tmp', host: 'h', flavor: 'claude' }
                },
                messages: []
            }
        })

        const client = new ApiSessionClient('token', createSession({
            namespace: 'default',
            metadata: { path: '/tmp', host: 'h', flavor: 'claude' },
            metadataVersion: 1
        }))
        const socket = socketHarness.sockets[0]
        if (!socket) throw new Error('expected socket')

        let archived = false
        client.on('hub-archived', () => { archived = true })

        // Establish first connection so hasConnectedOnce is true.
        socket.triggerConnect()
        await vi.waitFor(() => expect(axiosHarness.get).toHaveBeenCalled())

        axiosHarness.get.mockImplementation(async (url: string) => {
            if (String(url).includes('/messages')) {
                return { data: { messages: [] } }
            }
            return {
                data: {
                    session: {
                        metadataVersion: 5,
                        metadata: {
                            path: '/tmp',
                            host: 'h',
                            flavor: 'claude',
                            lifecycleState: 'archived',
                            archivedBy: 'hub',
                            archiveReason: 'Archived from hub (CLI unreachable)'
                        }
                    }
                }
            }
        })
        socket.connected = false
        socket.trigger('disconnect', 'transport close')
        socket.triggerConnect()

        await vi.waitFor(() => expect(archived).toBe(true))
        expect(client.getMetadata()?.archivedBy).toBe('hub')
        client.close()
    })
})

describe('ApiSessionClient incoming user messages', () => {
    it.each([true, false])('replays explicitly marked native queue input only for shared sessions (%s)', shared => {
        socketHarness.sockets.length = 0
        const client = new ApiSessionClient('token', createSession({
            metadata: { path: '/tmp', host: 'test', capabilities: { concurrentClients: shared } }
        }))
        const socket = socketHarness.sockets[0]
        const received = vi.fn()
        client.onUserMessage(received)
        const message = { id: 'native-queued', seq: 10, localId: 'native-client-id', content: {
            role: 'user', content: { type: 'text', text: 'queued before exit' },
            meta: { sentFrom: 'cli', isNativeQueuedMessage: true }
        } }
        socket.trigger('update', { body: { t: 'new-message', message } })
        socket.trigger('update', { body: { t: 'new-message', message } })
        expect(received).toHaveBeenCalledTimes(shared ? 1 : 0)
        if (shared) expect(received).toHaveBeenCalledWith(expect.objectContaining({
            content: { type: 'text', text: 'queued before exit' }
        }), 'native-client-id')
        client.close()
    })
    it('ignores CLI-originated transcript messages while advancing the incoming cursor', () => {
        socketHarness.sockets.length = 0
        const client = new ApiSessionClient('token', createSession({ namespace: 'default' }))
        const socket = socketHarness.sockets[0]
        if (!socket) throw new Error('expected socket')
        const onUserMessage = vi.fn()
        client.onUserMessage(onUserMessage)

        triggerIncomingUserMessage(socket, {
            id: 'historical-cli-message',
            seq: 10,
            text: 'historical prompt from the local transcript',
            sentFrom: 'cli'
        })
        triggerIncomingUserMessage(socket, {
            seq: 10,
            text: 'legacy duplicate at the filtered cursor',
            sentFrom: 'webapp'
        })
        triggerIncomingUserMessage(socket, {
            id: 'live-web-message',
            seq: 11,
            text: 'new prompt from the phone',
            sentFrom: 'webapp'
        })

        expect(onUserMessage).toHaveBeenCalledTimes(1)
        expect(onUserMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                content: expect.objectContaining({ text: 'new prompt from the phone' })
            }),
            undefined
        )
        client.close()
    })

    it('delivers only remote prompts from a mixed reconnect backfill', async () => {
        socketHarness.sockets.length = 0
        axiosHarness.get.mockReset()
        axiosHarness.get.mockResolvedValue({
            data: {
                messages: [
                    {
                        id: 'backfilled-cli-message',
                        seq: 2,
                        createdAt: 2,
                        localId: null,
                        content: {
                            role: 'user',
                            content: { type: 'text', text: 'historical local prompt' },
                            meta: { sentFrom: 'cli' }
                        }
                    },
                    {
                        id: 'backfilled-web-message',
                        seq: 3,
                        createdAt: 3,
                        localId: null,
                        content: {
                            role: 'user',
                            content: { type: 'text', text: 'remote prompt after reconnect' },
                            meta: { sentFrom: 'webapp' }
                        }
                    }
                ]
            }
        })
        const client = new ApiSessionClient('token', createSession({ namespace: 'default' }))
        const socket = socketHarness.sockets[0]
        if (!socket) throw new Error('expected socket')
        const receivedTexts: string[] = []
        client.onUserMessage((message) => {
            receivedTexts.push(message.content.text)
        })
        triggerIncomingUserMessage(socket, {
            id: 'initial-web-message',
            seq: 1,
            text: 'initial remote prompt',
            sentFrom: 'webapp'
        })

        socket.connected = false
        socket.trigger('disconnect', 'transport close')
        socket.triggerConnect()

        await vi.waitFor(() => expect(axiosHarness.get).toHaveBeenCalledOnce())
        await vi.waitFor(() => expect(receivedTexts).toEqual([
            'initial remote prompt',
            'remote prompt after reconnect'
        ]))
        expect(axiosHarness.get).toHaveBeenCalledWith(
            expect.stringContaining('/cli/sessions/'),
            expect.objectContaining({
                params: { afterSeq: 1, limit: 200 }
            })
        )
        client.close()
    })

    it.each(['webapp', 'telegram-bot'] as const)(
        'delivers %s-originated user messages',
        (sentFrom) => {
            socketHarness.sockets.length = 0
            const client = new ApiSessionClient('token', createSession({ namespace: 'default' }))
            const socket = socketHarness.sockets[0]
            if (!socket) throw new Error('expected socket')
            const onUserMessage = vi.fn()
            client.onUserMessage(onUserMessage)

            triggerIncomingUserMessage(socket, {
                id: `${sentFrom}-message`,
                seq: 1,
                text: `prompt from ${sentFrom}`,
                sentFrom
            })

            expect(onUserMessage).toHaveBeenCalledOnce()
            expect(onUserMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    meta: { sentFrom }
                }),
                undefined
            )
            client.close()
        }
    )
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

describe('explicit title action metadata refresh', () => {
    it('observes user lock changes without rolling back a newer socket metadata version', async () => {
        const client = new ApiSessionClient('test-token', createSession({
            metadataVersion: 10, metadata: { path: '/tmp', host: 'test', name: 'Pinned', titleLocked: true }
        }))
        try {
            axiosHarness.get.mockResolvedValue({ data: { session: {
                metadataVersion: 11, metadata: { path: '/tmp', host: 'test', name: 'Pinned', titleLocked: false }
            } } })
            expect(await client.refreshMetadata()).toBe(true)
            expect(client.getMetadata()?.titleLocked).toBe(false)
            axiosHarness.get.mockResolvedValue({ data: { session: {
                metadataVersion: 9, metadata: { path: '/tmp', host: 'test', name: 'Old', titleLocked: true }
            } } })
            expect(await client.refreshMetadata()).toBe(true)
            expect(client.getMetadata()).toMatchObject({ name: 'Pinned', titleLocked: false })
        } finally { client.close() }
    })

    it('reports an unavailable or malformed Hub response instead of trusting cached lock state', async () => {
        const client = new ApiSessionClient('test-token', createSession())
        try {
            axiosHarness.get.mockRejectedValue(new Error('Offline'))
            expect(await client.refreshMetadata()).toBe(false)
            axiosHarness.get.mockResolvedValue({ data: { session: { metadataVersion: 99, metadata: { titleLocked: true } } } })
            expect(await client.refreshMetadata()).toBe(false)
        } finally { client.close() }
    })
})

describe('ApiSessionClient runtime heartbeat', () => {
    it('replays the latest runtime when the socket connects (#2053)', () => {
        const client = new ApiSessionClient('token', createSession())
        const socket = socketHarness.sockets.at(-1)!
        socket.connected = false
        socket.emitted.length = 0

        client.keepAlive(true, 'remote', { permissionMode: 'bypassPermissions' })
        expect(socket.emitted).toEqual([])

        socket.triggerConnect()
        expect(socket.emitted.filter((entry) => entry.event === 'session-alive').map((entry) => entry.args[0])).toEqual([
            { sid: client.sessionId, time: expect.any(Number), thinking: true, mode: 'remote', permissionMode: 'bypassPermissions' }
        ])
        client.close()
    })
})


describe('ApiSessionClient durable status identity', () => {
    it('preserves an explicit Hub localId independently of the inner event ID', () => {
        socketHarness.sockets.length = 0;
        const client = new ApiSessionClient('token', createSession({ namespace: 'default' }));
        client.sendSessionEvent({ type: 'message', message: 'Compaction started' }, 'event-id', { localId: 'native-apply:started' });
        const sent = socketHarness.sockets[0]!.emitted.find(entry => entry.event === 'message');
        expect(sent?.args[0]).toMatchObject({ localId: 'native-apply:started', message: { content: { id: 'event-id', type: 'event', data: { type: 'message', message: 'Compaction started' } } } });
        client.close();
    });
});


import { BasePermissionHandler, type PermissionCompletion } from '@/modules/common/permission/BasePermissionHandler'
import { RPC_METHODS } from '@hapi/protocol'
import { SharedCodexPermissions } from '@/codex/shared/permissions'
import type { CodexAppServerClient } from '@/codex/codexAppServerClient'

describe('ApiSessionClient attachment links', () => {
    it('flushes link attachments from each assistant ingress in authorized permission modes', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'hapi-session-attachment-'))
        const client = new ApiSessionClient('token', createSession({ permissionMode: 'bypassPermissions', metadata: { path: workspace, host: 'test' } }))
        const socket = socketHarness.sockets.at(-1)!
        socket.emitted.length = 0
        try {
            const files: Record<string, string> = { 'normalized.txt': 'normalized', 'claude.csv': 'name,value', 'agy.md': '# document' }
            for (const [name, text] of Object.entries(files)) await writeFile(join(workspace, name), text)
            const normalized = { type: 'message', message: '[report](normalized.txt)' }
            const claude = { type: 'assistant' as const, uuid: 'assistant-file-link', message: { role: 'assistant', content: [{ type: 'text', text: '[table](claude.csv)' }] } }
            const agy = { type: 'agy_message', content: '[document](agy.md)' }
            client.sendAgentMessage(normalized)
            client.sendClaudeSessionMessage(claude)
            client.sendAgentMessage(agy)
            expect(await client.flush({ timeoutMs: 1000 })).toBe(true)

            const payloads = socket.emitted.filter(entry => entry.event === 'message').map(entry => entry.args[0] as {
                message: { content: { data: Record<string, unknown> } }
            })
            expect(payloads.some(payload => payload.message.content.data === normalized)).toBe(true)
            expect(payloads.some(payload => payload.message.content.data === claude)).toBe(true)
            expect(payloads.some(payload => payload.message.content.data === agy)).toBe(true)
            const media = payloads.map(payload => payload.message.content.data).filter(data => data.type === 'generated-image')
            expect(media.map(data => data.fileName).sort()).toEqual(Object.keys(files).sort())
            for (const item of media) expect(getGeneratedImage(item.imageId as string)?.content.toString()).toBe(files[item.fileName as string])
        } finally {
            client.close()
            await rm(workspace, { recursive: true, force: true })
        }
    })

    it('withholds attachment delivery in restrictive mode (default) and respects denied files', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'hapi-session-restrictive-'))
        const client = new ApiSessionClient('token', createSession({ permissionMode: 'default', metadata: { path: workspace, host: 'test' } }))
        const socket = socketHarness.sockets.at(-1)!
        socket.emitted.length = 0
        try {
            await writeFile(join(workspace, 'report.pdf'), 'confidential')
            client.sendAgentMessage({ type: 'message', message: '[report](report.pdf)' })
            expect(await client.flush({ timeoutMs: 1000 })).toBe(true)

            // Restrictive session without auto-approval must not auto-emit generated-image attachments
            const mediaInDefault = socket.emitted.filter(entry => entry.event === 'message').map(entry => entry.args[0] as {
                message: { content: { data: Record<string, unknown> } }
            }).map(p => p.message.content.data).filter(d => d.type === 'generated-image')
            expect(mediaInDefault).toHaveLength(0)

            // Switching to YOLO mode authorizes the delivery
            client.setPermissionMode('yolo')
            client.sendAgentMessage({ type: 'message', message: '[report](report.pdf)' })
            expect(await client.flush({ timeoutMs: 1000 })).toBe(true)
            const mediaInYolo = socket.emitted.filter(entry => entry.event === 'message').map(entry => entry.args[0] as {
                message: { content: { data: Record<string, unknown> } }
            }).map(p => p.message.content.data).filter(d => d.type === 'generated-image')
            expect(mediaInYolo).toHaveLength(1)

            // Subagent / sidechain transcripts are excluded from emitting top-level attachments
            await writeFile(join(workspace, 'subnotes.txt'), 'subagent notes')
            client.sendClaudeSessionMessage({
                type: 'assistant',
                uuid: 'subagent-msg',
                isSidechain: true,
                message: { role: 'assistant', content: [{ type: 'text', text: '[subnotes](subnotes.txt)' }] }
            })
            expect(await client.flush({ timeoutMs: 1000 })).toBe(true)
            const mediaAfterSidechain = socket.emitted.filter(entry => entry.event === 'message').map(entry => entry.args[0] as {
                message: { content: { data: Record<string, unknown> } }
            }).map(p => p.message.content.data).filter(d => d.type === 'generated-image')
            expect(mediaAfterSidechain).toHaveLength(1) // subnotes.txt excluded

            // Real permission boundary denial: when a display tool is rejected by the user,
            // the denied path is recorded and subsequent links with fallback enabled never upload it.
            class TestPermHandler extends BasePermissionHandler<{ id: string; approved: boolean; decision?: 'denied'; reason?: string }, any> {
                constructor(c: any) { super(c) }
                triggerRequest(id: string, tool: string, input: unknown) {
                    return new Promise((resolve, reject) => {
                        this.addPendingRequest(id, tool, input, { resolve, reject })
                    })
                }
                protected async handlePermissionResponse(resp: any, pending: any) {
                    if (!resp.approved) pending.reject(new Error('User denied'))
                    else pending.resolve(true)
                    return { status: resp.approved ? 'approved' : 'denied', decision: resp.decision } as PermissionCompletion
                }
                protected handleMissingPendingResponse() {}
            }

            const permHandler = new TestPermHandler(client)
            await writeFile(join(workspace, 'denied.pdf'), 'denied file')
            const pendingReq = permHandler.triggerRequest('req-display-1', 'mcp__hapi__display_media', { path: join(workspace, 'denied.pdf') })

            // Simulate user clicking "Deny" in UI via RPC
            await client.rpcHandlerManager.handleRequest({
                method: `${client.sessionId}:${RPC_METHODS.Permission}`,
                params: JSON.stringify({ id: 'req-display-1', approved: false, decision: 'denied', reason: 'User denied display' })
            })
            await expect(pendingReq).rejects.toThrow()

            // Even with explicit opt-in (HAPI_AUTO_ATTACHMENT_LINKS=1), the denied file must NOT be delivered
            process.env.HAPI_AUTO_ATTACHMENT_LINKS = '1'
            try {
                client.sendAgentMessage({ type: 'message', message: '[denied](denied.pdf)' })
                expect(await client.flush({ timeoutMs: 1000 })).toBe(true)
                const mediaAfterDeniedReq = socket.emitted.filter(entry => entry.event === 'message').map(entry => entry.args[0] as {
                    message: { content: { data: Record<string, unknown> } }
                }).map(p => p.message.content.data).filter(d => d.type === 'generated-image')
                expect(mediaAfterDeniedReq).toHaveLength(1) // denied.pdf was safely blocked

                // Codex nested toolParams approval denial (appServerPermissionAdapter shape)
                await writeFile(join(workspace, 'codex-denied.pdf'), 'codex denied file')
                const codexReq = permHandler.triggerRequest('req-codex-1', 'mcp__hapi__display_media', {
                    message: 'Allow MCP tool call?',
                    toolParams: { path: './codex-denied.pdf' }
                })
                await client.rpcHandlerManager.handleRequest({
                    method: `${client.sessionId}:${RPC_METHODS.Permission}`,
                    params: JSON.stringify({ id: 'req-codex-1', approved: false, decision: 'denied', reason: 'Declined' })
                })
                await expect(codexReq).rejects.toThrow()

                // Different spelling (bare name, relative, absolute) of the denied file are all blocked
                client.sendAgentMessage({ type: 'message', message: '[codex](codex-denied.pdf) [abs](' + join(workspace, 'codex-denied.pdf') + ')' })
                expect(await client.flush({ timeoutMs: 1000 })).toBe(true)
                const mediaAfterCodex = socket.emitted.filter(entry => entry.event === 'message').map(entry => entry.args[0] as {
                    message: { content: { data: Record<string, unknown> } }
                }).map(p => p.message.content.data).filter(d => d.type === 'generated-image')
                expect(mediaAfterCodex).toHaveLength(1) // codex-denied.pdf blocked across spellings

                // File-read denial: Claude Read({ file_path }) rejection also blocks attachment delivery
                await writeFile(join(workspace, 'read-denied.txt'), 'read denied content')
                const readReq = permHandler.triggerRequest('req-read-1', 'Read', { file_path: join(workspace, 'read-denied.txt') })
                await client.rpcHandlerManager.handleRequest({
                    method: `${client.sessionId}:${RPC_METHODS.Permission}`,
                    params: JSON.stringify({ id: 'req-read-1', approved: false, decision: 'denied', reason: 'Declined read' })
                })
                await expect(readReq).rejects.toThrow()

                client.sendAgentMessage({ type: 'message', message: '[read-denied](read-denied.txt)' })
                expect(await client.flush({ timeoutMs: 1000 })).toBe(true)
                const mediaAfterReadDenial = socket.emitted.filter(entry => entry.event === 'message').map(entry => entry.args[0] as {
                    message: { content: { data: Record<string, unknown> } }
                }).map(p => p.message.content.data).filter(d => d.type === 'generated-image')
                expect(mediaAfterReadDenial).toHaveLength(1) // read-denied.txt blocked

                // SharedCodexPermissions denial integration: denying a file read via SharedCodexPermissions
                // records the path on ApiSessionClient and prevents fallback link delivery.
                await writeFile(join(workspace, 'codex-shared-denied.txt'), 'secret shared')
                const codexClient = { respond: vi.fn(), request: vi.fn() } as unknown as CodexAppServerClient
                const sharedCodex = new SharedCodexPermissions(client, codexClient, 'gen-1')
                sharedCodex.receive({
                    id: 101,
                    method: 'item/tool/requestApproval',
                    params: {
                        threadId: 'thread-1',
                        turnId: 'turn-1',
                        itemId: 'call-mcp-read',
                        tool: 'read_file',
                        input: { path: join(workspace, 'codex-shared-denied.txt') }
                    }
                })
                const sharedReqId = 'gen-1:thread-1:number:101'
                await client.rpcHandlerManager.handleRequest({
                    method: `${client.sessionId}:${RPC_METHODS.Permission}`,
                    params: JSON.stringify({ id: sharedReqId, approved: false, decision: 'denied' })
                })

                client.sendAgentMessage({ type: 'message', message: '[shared](codex-shared-denied.txt)' })
                expect(await client.flush({ timeoutMs: 1000 })).toBe(true)
                const mediaAfterSharedCodex = socket.emitted.filter(entry => entry.event === 'message').map(entry => entry.args[0] as {
                    message: { content: { data: Record<string, unknown> } }
                }).map(p => p.message.content.data).filter(d => d.type === 'generated-image')
                expect(mediaAfterSharedCodex).toHaveLength(1) // codex-shared-denied.txt blocked

                // Qualified tool name + neutral native terminal resolution (root.ts production path)
                await writeFile(join(workspace, 'terminal-codex.txt'), 'terminal secret')
                sharedCodex.receive({
                    id: 102,
                    method: 'item/tool/requestApproval',
                    params: {
                        threadId: 'thread-1',
                        turnId: 'turn-1',
                        itemId: 'call-mcp-qualified',
                        tool: 'mcp__custom_filesystem__read_file',
                        input: { path: join(workspace, 'terminal-codex.txt') }
                    }
                })
                // Production serverRequest/resolved calls resolved() without status argument
                sharedCodex.resolved('thread-1', 102)

                client.sendAgentMessage({ type: 'message', message: '[term](terminal-codex.txt)' })
                expect(await client.flush({ timeoutMs: 1000 })).toBe(true)
                const mediaAfterTerminal = socket.emitted.filter(entry => entry.event === 'message').map(entry => entry.args[0] as {
                    message: { content: { data: Record<string, unknown> } }
                }).map(p => p.message.content.data).filter(d => d.type === 'generated-image')
                expect(mediaAfterTerminal).toHaveLength(1) // terminal-codex.txt with underscored server name was blocked!

                // Successful Codex approval followed by native resolution ('resolved') MUST NOT be blocked
                await writeFile(join(workspace, 'codex-approved.txt'), 'approved content')
                sharedCodex.receive({
                    id: 103,
                    method: 'item/tool/requestApproval',
                    params: {
                        threadId: 'thread-1',
                        turnId: 'turn-1',
                        itemId: 'call-mcp-approved',
                        tool: 'read_file',
                        input: { path: join(workspace, 'codex-approved.txt') }
                    }
                })
                const approvedReqId = 'gen-1:thread-1:number:103'
                await client.rpcHandlerManager.handleRequest({
                    method: `${client.sessionId}:${RPC_METHODS.Permission}`,
                    params: JSON.stringify({ id: approvedReqId, approved: true, decision: 'approved' })
                })
                sharedCodex.resolved('thread-1', 103, 'resolved')

                client.sendAgentMessage({ type: 'message', message: '[approved](codex-approved.txt)' })
                expect(await client.flush({ timeoutMs: 1000 })).toBe(true)
                const mediaAfterApproved = socket.emitted.filter(entry => entry.event === 'message').map(entry => entry.args[0] as {
                    message: { content: { data: Record<string, unknown> } }
                }).map(p => p.message.content.data).filter(d => d.type === 'generated-image')
                expect(mediaAfterApproved).toHaveLength(2) // codex-approved.txt was delivered!

                // Multi-file denial: mcp__filesystem__read_multiple_files blocks EVERY path in paths array
                await writeFile(join(workspace, 'multi1.txt'), 'multi 1')
                await writeFile(join(workspace, 'multi2.txt'), 'multi 2')
                sharedCodex.receive({
                    id: 104,
                    method: 'item/tool/requestApproval',
                    params: {
                        threadId: 'thread-1',
                        turnId: 'turn-1',
                        itemId: 'call-mcp-multi',
                        tool: 'mcp__filesystem__read_multiple_files',
                        input: { paths: [join(workspace, 'multi1.txt'), join(workspace, 'multi2.txt')] }
                    }
                })
                const multiReqId = 'gen-1:thread-1:number:104'
                await client.rpcHandlerManager.handleRequest({
                    method: `${client.sessionId}:${RPC_METHODS.Permission}`,
                    params: JSON.stringify({ id: multiReqId, approved: false, decision: 'denied', reason: 'Declined multi' })
                })

                client.sendAgentMessage({ type: 'message', message: '[m1](multi1.txt) [m2](multi2.txt)' })
                expect(await client.flush({ timeoutMs: 1000 })).toBe(true)
                const mediaAfterMulti = socket.emitted.filter(entry => entry.event === 'message').map(entry => entry.args[0] as {
                    message: { content: { data: Record<string, unknown> } }
                }).map(p => p.message.content.data).filter(d => d.type === 'generated-image')
                expect(mediaAfterMulti).toHaveLength(2) // neither multi1 nor multi2 was delivered

                // Codex nested multi-file denial with toolParams.file_paths array
                await writeFile(join(workspace, 'codex-multi1.txt'), 'multi 1')
                await writeFile(join(workspace, 'codex-multi2.txt'), 'multi 2')
                sharedCodex.receive({
                    id: 105,
                    method: 'item/tool/requestApproval',
                    params: {
                        threadId: 'thread-1',
                        turnId: 'turn-1',
                        itemId: 'call-mcp-multi-codex',
                        tool: 'mcp__filesystem__read_multiple_files',
                        input: {
                            message: 'Allow MCP tool call?',
                            toolParams: { file_paths: [join(workspace, 'codex-multi1.txt'), join(workspace, 'codex-multi2.txt')] }
                        }
                    }
                })
                const codexMultiReqId = 'gen-1:thread-1:number:105'
                await client.rpcHandlerManager.handleRequest({
                    method: `${client.sessionId}:${RPC_METHODS.Permission}`,
                    params: JSON.stringify({ id: codexMultiReqId, approved: false, decision: 'denied', reason: 'Declined multi' })
                })
                client.sendAgentMessage({ type: 'message', message: '[cm1](codex-multi1.txt) [cm2](codex-multi2.txt)' })
                expect(await client.flush({ timeoutMs: 1000 })).toBe(true)
                const mediaAfterCodexMulti = socket.emitted.filter(entry => entry.event === 'message').map(entry => entry.args[0] as {
                    message: { content: { data: Record<string, unknown> } }
                }).map(p => p.message.content.data).filter(d => d.type === 'generated-image')
                expect(mediaAfterCodexMulti).toHaveLength(2) // neither codex-multi1 nor codex-multi2 was delivered

                // Terminal approval reconciled by native execution evidence (item/started / item/completed)
                await writeFile(join(workspace, 'terminal-approved.txt'), 'terminal approved')
                sharedCodex.receive({
                    id: 106,
                    method: 'item/tool/requestApproval',
                    params: {
                        threadId: 'thread-1',
                        turnId: 'turn-1',
                        itemId: 'call-mcp-term-appr',
                        tool: 'read_file',
                        input: { path: join(workspace, 'terminal-approved.txt') }
                    }
                })
                sharedCodex.resolved('thread-1', 106) // serverRequest/resolved without web reply
                sharedCodex.observeExecution('read_file', { path: join(workspace, 'terminal-approved.txt') }) // native execution evidence reconciles outcome

                client.sendAgentMessage({ type: 'message', message: '[term-appr](terminal-approved.txt)' })
                expect(await client.flush({ timeoutMs: 1000 })).toBe(true)
                const mediaAfterTermAppr = socket.emitted.filter(entry => entry.event === 'message').map(entry => entry.args[0] as {
                    message: { content: { data: Record<string, unknown> } }
                }).map(p => p.message.content.data).filter(d => d.type === 'generated-image')
                expect(mediaAfterTermAppr).toHaveLength(3) // terminal-approved.txt was delivered!

                // Web denial followed by native resolution: web declined, then serverRequest/resolved arrives with status=resolved
                await writeFile(join(workspace, 'codex-web-denied.txt'), 'web denied secret')
                sharedCodex.receive({
                    id: 107,
                    method: 'item/tool/requestApproval',
                    params: {
                        threadId: 'thread-1',
                        turnId: 'turn-1',
                        itemId: 'call-mcp-web-denied',
                        tool: 'read_file',
                        input: { path: join(workspace, 'codex-web-denied.txt') }
                    }
                })
                const webDeniedReqId = 'gen-1:thread-1:number:107'
                await client.rpcHandlerManager.handleRequest({
                    method: `${client.sessionId}:${RPC_METHODS.Permission}`,
                    params: JSON.stringify({ id: webDeniedReqId, approved: false, decision: 'denied' })
                })
                sharedCodex.resolved('thread-1', 107, 'resolved') // serverRequest/resolved arrives with resolved status

                client.sendAgentMessage({ type: 'message', message: '[web-denied](codex-web-denied.txt)' })
                expect(await client.flush({ timeoutMs: 1000 })).toBe(true)
                const mediaAfterWebDenial = socket.emitted.filter(entry => entry.event === 'message').map(entry => entry.args[0] as {
                    message: { content: { data: Record<string, unknown> } }
                }).map(p => p.message.content.data).filter(d => d.type === 'generated-image')
                expect(mediaAfterWebDenial).toHaveLength(3) // codex-web-denied.txt stays blocked!
            } finally {
                delete process.env.HAPI_AUTO_ATTACHMENT_LINKS
            }
        } finally {
            client.close()
            await rm(workspace, { recursive: true, force: true })
        }
    })
})
