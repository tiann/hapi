import { describe, expect, it, vi } from 'vitest'
import type { Session } from './types'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { OpenCodeRewindOperation } from '@hapi/protocol/schemas'
import type { OpenCodeRewindReport } from '@hapi/protocol/apiTypes'
import { OpenCodeRewind, OpenCodeRuntimeGate } from '../opencode/rewind'
import { MessageQueue2 } from '../utils/MessageQueue2'
import { getProcessStartMarker } from '../utils/process'

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
    get: vi.fn(),
    post: vi.fn()
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
            emitWithAckImpl: async () => ({})
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
        post: axiosHarness.post,
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
    for (const fault of ['version-race', 'persisted-ack-loss'] as const) {
        it.each([false, true])(`recovers a prepared report ${fault} through the real Hub (${fault}, reconstructed=%s)`, async reconstructed => {
            socketHarness.sockets.length = 0
            axiosHarness.get.mockReset()
            axiosHarness.post.mockReset()
            const directory = mkdtempSync(join(tmpdir(), 'api-rewind-preparation-'))
            const database = join(directory, 'hub.db')
            const hubModule = (path: string) => JSON.stringify(new URL(`../../../hub/src/${path}`, import.meta.url).href)
            const runHub = (body: string) => {
                const source = `import { Store } from ${hubModule('store/index.ts')};
                    import { Database } from 'bun:sqlite';
                    import { SyncEngine } from ${hubModule('sync/syncEngine.ts')};
                    import { RpcRegistry } from ${hubModule('socket/rpcRegistry.ts')};
                    const store = new Store(${JSON.stringify(database)});
                    const db = new Database(${JSON.stringify(database)});
                    const engine = new SyncEngine(store, {}, new RpcRegistry(), { broadcast() {} });
                    const invalidations = [];
                    engine.subscribe(event => { if (event.type === 'messages-invalidated') invalidations.push(event); });
                    const state = id => {
                        const session = store.sessions.getSession(id);
                        return { session, history: { rows: store.messages.getAllMessages(id),
                            checkpoint: session.metadata.opencodeHistoryCheckpoint, indexes: session.metadata.conversationHistoryIndexes,
                            epoch: store.messages.getMessageEpoch(id),
                            read: db.query('SELECT content_revision, read_revision, read_state_version, manual_unread FROM sessions WHERE id = ?').get(id),
                            fts: db.query('SELECT rowid, * FROM message_content_search ORDER BY rowid').all(),
                            lookup: db.query('SELECT * FROM message_content_search_lookup ORDER BY search_rowid').all(),
                            short: db.query('SELECT * FROM message_content_search_short ORDER BY gram, search_rowid').all() }, invalidations };
                    };
                    try { ${body} } finally { engine.stop(); db.close(); store.close(); }`
                const result = spawnSync('bun', ['--eval', source], { encoding: 'utf8', timeout: 15_000 })
                expect(result.status, result.stderr).toBe(0)
                return JSON.parse(result.stdout.trim().split('\n').at(-1)!)
            }
            const initial = runHub(`
                const session = engine.getOrCreateSession('preparation-recovery', { path: '/tmp', host: 'test', flavor: 'opencode',
                    opencodeSessionId: 'native', opencodeWorkerId: 'worker', opencodeWorkerProcess: { workerId: 'worker', pid: ${process.pid}, startMarker: ${JSON.stringify(getProcessStartMarker(process.pid))} }, conversationHistoryIndexes: { local1: 0, local2: 1 },
                    opencodeHistoryCheckpoint: { sessionId: 'native', messageIds: ['u1', 'a1', 'u2', 'a2'],
                        userMessageIds: ['u1', 'u2'], localMessageIds: [] },
                    capabilities: { conversationHistory: { rewindToMessage: true } } }, null, 'default');
                engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' });
                for (const [role, localId, text] of [['user','local1','retainedprefix'], ['agent',null,'retainedprefix answer'],
                    ['user','local2','removedsuffix'], ['agent',null,'removedsuffix answer']]) {
                    store.messages.addMessage(session.id, { role, content: role === 'user' ? { type:'text', text }
                        : { type:'codex', data: { type:'message', id:text, message:text } } }, localId ?? undefined);
                    if (localId) store.messages.markMessagesInvoked(session.id, [localId], Date.now());
                }
                let operation;
                engine.rpcGateway.rewindConversation = async (_id, request) => {
                    operation = request.opencodeRewind;
                    return { success:false, outcome:'unknown', error:'dispatch deferred to controller' };
                };
                await engine.rewindConversation(session.id, 'default', 'local2');
                console.log(JSON.stringify({ operation, state: state(session.id) }));`)
            const id = initial.state.session.id as string
            const inspect = () => runHub(`console.log(JSON.stringify(state(${JSON.stringify(id)})));`)
            let inject = true
            const persistedReports: Array<{ phase: string; result: any }> = []
            axiosHarness.get.mockImplementation(async (url: string) => url.endsWith('/messages') ? { data: { messages: [] } }
                : { data: { session: inspect().session } })
            axiosHarness.post.mockImplementation(async (_url: string, input: { report: OpenCodeRewindReport; expectedVersion: number }) => {
                const preparedFault = inject && input.report.phase === 'prepared'
                if (preparedFault) inject = false
                const result = runHub(`
                    const input = ${JSON.stringify(input)};
                    if (${preparedFault && fault === 'version-race'}) {
                        const current = store.sessions.getSession(${JSON.stringify(id)});
                        const changed = store.sessions.updateSessionMetadata(current.id,
                            { ...current.metadata, name:'concurrent metadata update' }, current.metadataVersion, 'default');
                        if (changed.result !== 'success') throw new Error('metadata race setup failed');
                    }
                    try {
                        const operation = engine.reportOpenCodeRewind(${JSON.stringify(id)}, 'default', input.report, input.expectedVersion);
                        console.log(JSON.stringify({ operation, state:state(${JSON.stringify(id)}) }));
                    } catch (error) { console.log(JSON.stringify({ error:String(error.message), state:state(${JSON.stringify(id)}) })); }`)
                persistedReports.push({ phase: input.report.phase, result })
                if (result.error) throw new Error(result.error)
                if (preparedFault && fault === 'persisted-ack-loss') throw new Error('prepared ACK lost after persistence')
                return { data: { operation: result.operation } }
            })
            const client = new ApiSessionClient('token', createSession({ id, metadata: initial.state.session.metadata,
                metadataVersion: initial.state.session.metadataVersion }))
            const nativeRows = [{ id:'u1', type:'user' }, { id:'a1', type:'assistant' }, { id:'u2', type:'user' }, { id:'a2', type:'assistant' }]
            const nativeRequest = vi.fn(async (url: string, init?: RequestInit) => {
                if (init?.method === 'POST') throw new Error('unexpected native mutation before preparation')
                if (url.includes('/message?')) return Response.json({ data:nativeRows, cursor:{} })
                if (url.endsWith('/active')) return Response.json({ data:{} })
                if (url.endsWith('/inbox')) return Response.json({ data:[] })
                return Response.json({ data:{ id:'native' } })
            })
            const gate = new OpenCodeRuntimeGate()
            const options = { directory, hapiSessionId:id, workerId:'worker', gate, baseUrl:'http://synthetic-native',
                nativeSessionId:'native', headers:{}, request:nativeRequest, report:(report:OpenCodeRewindReport) => client.reportOpenCodeRewind(report),
                getAuthoritativeOperation: async () => { if (!await client.refreshMetadata()) throw new Error('refresh failed'); return client.getMetadata()?.opencodeRewind },
                flush:async () => true, isIdle:() => true,
                sourceCheckpoint:() => initial.state.session.metadata.opencodeHistoryCheckpoint,
                sourceIndexes:() => ({ local1:0, local2:1 }), requestsFromPreviousWorkerCannotRun:() => false }
            const rewind = new OpenCodeRewind(options)
            try {
                expect(await rewind.execute(initial.operation)).toMatchObject({ success:false, outcome:'unknown' })
                const failed = inspect()
                const intent = rewind.readIntent()!
                const backup = readFileSync(intent.backupPath, 'utf8')
                expect(gate.isBlocked()).toBe(true)
                expect(intent.pendingRequest).toBe(false)
                const recoveryGate = reconstructed ? new OpenCodeRuntimeGate() : gate
                const recovery = reconstructed ? new OpenCodeRewind({ ...options, gate:recoveryGate,
                    workerId:'replacement', previousWorkerCannotRun:() => true }) : rewind
                const result = await recovery.recover(failed.session.metadata.opencodeRewind)
                const after = inspect()
                expect(result).toMatchObject({ success:false, outcome:'rejected', error:'Native source is unchanged' })
                expect(failed.session.metadata.opencodeRewind.phase).toBe(fault === 'version-race' ? 'reserved' : 'unknown')
                expect(persistedReports[0]?.result.error).toBe(fault === 'version-race' ? 'OpenCode rewind metadata version changed' : undefined)
                expect(after.session.metadata.opencodeRewind.phase).toBe('rejected')
                expect(after.history).toEqual(initial.state.history)
                expect(failed.history).toEqual(initial.state.history)
                expect(after.invalidations).toEqual([])
                expect(nativeRequest.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([])
                expect(recovery.readIntent()?.phase).toBe('finalized')
                expect(readFileSync(intent.backupPath, 'utf8')).toBe(backup)
                expect(recoveryGate.isBlocked()).toBe(false)
                const release = recoveryGate.enterRuntime()
                release()
            } finally { client.close() }
        }, 15_000)
    }

    it('catches up a new row below the boundary seq after invocation-ordered Hub rewind', async () => {
        socketHarness.sockets.length = 0
        axiosHarness.get.mockReset()
        const hubModule = (path: string) => JSON.stringify(new URL(`../../../hub/src/${path}`, import.meta.url).href)
        const source = `import { Store } from ${hubModule('store/index.ts')};
            import { SyncEngine } from ${hubModule('sync/syncEngine.ts')};
            import { RpcRegistry } from ${hubModule('socket/rpcRegistry.ts')};
            const store = new Store(':memory:');
            const engine = new SyncEngine(store, {}, new RpcRegistry(), { broadcast() {} });
            const checkpoint = { sessionId: 'native', messageIds: ['u1', 'u2', 'u3'],
                userMessageIds: ['u1', 'u2', 'u3'], localMessageIds: [] };
            const session = engine.getOrCreateSession('ordered-catchup', { path: '/tmp', host: 'test', flavor: 'opencode',
                opencodeSessionId: 'native', opencodeWorkerId: 'worker', opencodeWorkerProcess: { workerId: 'worker', pid: 4321, startMarker: 'worker-generation' }, opencodeHistoryCheckpoint: checkpoint,
                conversationHistoryIndexes: { one: 0, two: 1, three: 2 },
                capabilities: { conversationHistory: { rewindToMessage: true } } }, null, 'default');
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' });
            const at = Date.now() - 10000;
            const user = text => ({ role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'webapp' } });
            const first = store.messages.addMessage(session.id, user('retained'), 'one', undefined, at);
            store.messages.markMessagesInvoked(session.id, ['one'], at);
            store.messages.addMessage(session.id, user('later scheduled'), 'three', at + 3000, at + 1000);
            const boundary = store.messages.addMessage(session.id, user('boundary scheduled'), 'two', at + 2000, at + 1500);
            store.messages.markMessagesInvoked(session.id, ['two'], at + 2000);
            store.messages.markMessagesInvoked(session.id, ['three'], at + 3000);
            const oldTail = store.messages.addMessage(session.id, { role: 'agent', content: { type: 'text', text: 'old tail' } },
                undefined, undefined, at + 4000);
            engine.rpcGateway.rewindConversation = async (_id, { opencodeRewind: operation }) => {
                const hashes = { sourceHash: 'a'.repeat(64), prefixHash: 'b'.repeat(64) };
                engine.reportOpenCodeRewind(session.id, 'default', { operation, phase: 'prepared', ...hashes }, store.sessions.getSession(session.id).metadataVersion);
                engine.reportOpenCodeRewind(session.id, 'default', { operation, phase: 'applied', ...hashes,
                    checkpoint: { ...checkpoint, messageIds: ['u1'], userMessageIds: ['u1'] }, indexes: { one: 0 } }, store.sessions.getSession(session.id).metadataVersion);
                return { success: true };
            };
            const result = await engine.rewindConversation(session.id, 'default', 'two');
            const retained = store.messages.getAllMessages(session.id);
            const pending = store.messages.addMessage(session.id, user('new disconnected input'), 'new-input');
            const current = store.sessions.getSession(session.id);
            const messages = engine.getDeliverableMessagesAfter(session.id, { afterSeq: 0, limit: 200, now: Date.now() });
            console.log(JSON.stringify({ result, first, boundary, oldTail, retained, pending, metadata: current.metadata,
                metadataVersion: current.metadataVersion, messages }));
            engine.stop(); store.close();`
        const result = spawnSync('bun', ['--eval', source], { encoding: 'utf8', timeout: 15_000 })
        expect(result.status, result.stderr).toBe(0)
        const hub = JSON.parse(result.stdout.trim().split('\n').at(-1)!)
        expect(hub.result).toEqual({ type: 'success' })
        expect(hub.retained.map((row: { id: string }) => row.id)).toEqual([hub.first.id])
        expect(hub.pending.seq).toBeLessThan(hub.boundary.seq)
        expect(hub.metadata.opencodeRewind.cutoffSeq).toBe(hub.boundary.seq)
        axiosHarness.get.mockImplementation(async (url: string, config: { params?: { afterSeq: number } }) =>
            url.endsWith('/messages') ? { data: { messages: hub.messages.filter((row: { seq: number }) => row.seq > config.params!.afterSeq) } }
                : { data: { session: { metadataVersion: hub.metadataVersion, metadata: hub.metadata } } })
        const client = new ApiSessionClient('token', createSession({ metadataVersion: 1,
            metadata: { path: '/tmp', host: 'test', flavor: 'opencode' } }))
        const socket = socketHarness.sockets[0]
        const received = vi.fn()
        client.onUserMessage(received)
        triggerIncomingUserMessage(socket, { id: hub.oldTail.id, seq: hub.oldTail.seq, text: 'old tail', sentFrom: 'cli' })
        socket.connected = false
        socket.trigger('disconnect', 'transport close')
        socket.triggerConnect()
        try {
            await vi.waitFor(() => expect(axiosHarness.get).toHaveBeenCalledWith(expect.stringContaining('/messages'), expect.anything()))
            await vi.waitFor(() => expect((client as unknown as { backfillInFlight: Promise<void> | null }).backfillInFlight).toBeNull())
            expect(received.mock.calls.map(([, id]) => id)).toEqual(['new-input'])
        } finally { client.close() }
    })

    it('does not reissue an evicted invoked postcommit row from durable Hub recovery backfill', async () => {
        socketHarness.sockets.length = 0
        axiosHarness.get.mockReset()
        const database = join(mkdtempSync(join(tmpdir(), 'api-rewind-replay-')), 'hub.db')
        const hubModule = (path: string) => JSON.stringify(new URL(`../../../hub/src/${path}`, import.meta.url).href)
        const runHub = (body: string) => {
            const source = `import { Store } from ${hubModule('store/index.ts')};
                import { Database } from 'bun:sqlite';
                import { registerSessionHandlers } from ${hubModule('socket/handlers/cli/sessionHandlers.ts')};
                import { SyncEngine } from ${hubModule('sync/syncEngine.ts')};
                import { RpcRegistry } from ${hubModule('socket/rpcRegistry.ts')};
                const database = ${JSON.stringify(database)}; ${body}`
            const result = spawnSync('bun', ['--eval', source], { encoding: 'utf8', timeout: 15_000 })
            expect(result.status, result.stderr).toBe(0)
            return JSON.parse(result.stdout.trim().split('\n').at(-1)!)
        }
        const initial = runHub(`
            const store = new Store(database);
            const session = store.sessions.getOrCreateSession('rewind-replay',
                { path: '/tmp', host: 'test', flavor: 'opencode' }, null, 'default');
            for (let n = 0; n < 9; n++) store.messages.addMessage(session.id,
                { role: 'agent', content: { type: 'text', text: 'old-' + n } });
            const oldTail = store.messages.getAllMessages(session.id).at(-1);
            store.messages.truncateOpenCodeRewind(session.id, 3, store.messages.getAllMessages(session.id).find(row => row.seq === 3).id);
            const user = text => ({ role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'webapp' } });
            const invoked = store.messages.addMessage(session.id, user('invoked-X'), 'invoked-X');
            const missed = store.messages.addMessage(session.id, user('missed-Y'), 'missed-Y');
            const live = Array.from({ length: 300 }, (_, n) => store.messages.addMessage(session.id,
                { role: 'agent', content: { type: 'text', text: 'later-' + n } }));
            store.close();
            console.log(JSON.stringify({ sessionId: session.id, oldTail, invoked, missed, live }));
        `)
        const response = deferred<{ messages: typeof initial.live }>()
        const committed = { path: '/tmp', host: 'test', flavor: 'opencode' as const, opencodeRewind: {
            operationId: 'eviction-recovery', nativeSessionId: 'native', workerId: 'worker', requestedLocalId: 'removed',
            nativeMessageId: 'native-removed', cutoffSeq: 3, sourceEpoch: 0, sourceMaxSeq: 9,
            reservationVersion: 2, sourceTranscriptHash: 'a'.repeat(64), phase: 'committed' as const
        } }
        axiosHarness.get.mockImplementation(async (url: string, config: { params?: { afterSeq: number } }) => {
            if (!url.endsWith('/messages')) return { data: { session: { metadataVersion: 2, metadata: committed } } }
            const result = await response.promise
            return { data: { messages: result.messages.filter((m: { seq: number }) => m.seq > config.params!.afterSeq).slice(0, 200) } }
        })
        const client = new ApiSessionClient('token', createSession({ id: initial.sessionId, metadataVersion: 1,
            metadata: { path: '/tmp', host: 'test', flavor: 'opencode' } }))
        const socket = socketHarness.sockets[0]
        const queue = new MessageQueue2(() => 'plain')
        queue.onBatchConsumed = ids => client.emitMessagesConsumed(ids)
        client.onUserMessage((message, localId) => queue.push(message.content.text, {}, localId))
        const issued: string[] = []
        await Promise.resolve()
        socket.trigger('update', { body: { t: 'new-message', message: initial.oldTail } })
        socket.trigger('update', { body: { t: 'update-session', metadata: { version: 2, value: committed } } })
        socket.trigger('update', { body: { t: 'new-message', message: initial.invoked } })
        try {
            expect(initial.live.length).toBeGreaterThan(256)
            const first = await queue.waitForMessagesAndGetAsString()
            expect(first?.items.map(item => item.localId)).toEqual(['invoked-X'])
            issued.push(...first!.items.map(item => item.localId!))
            const ack = socket.emitted.find(event => event.event === 'messages-consumed')?.args[0]
            expect(ack).toMatchObject({ sid: initial.sessionId, localIds: ['invoked-X'] })
            const persisted = runHub(`
                const store = new Store(database);
                const session = store.sessions.getSession(${JSON.stringify(initial.sessionId)});
                const handlers = new Map();
                const socket = { on(event, handler) { handlers.set(event, handler); return this; },
                    to() { return { emit() {} }; } };
                registerSessionHandlers(socket, { store,
                    resolveSessionAccess: () => ({ ok: true, value: session }), emitAccessError() {} });
                handlers.get('messages-consumed')(${JSON.stringify(ack)});
                store.close();
                const reopened = new Store(database);
                const probeDb = new Database(database);
                const probe = probeDb.query('SELECT invoked_at, delivery_state FROM messages WHERE session_id = ? AND local_id = ?')
                    .get(session.id, 'invoked-X');
                probeDb.close();
                const engine = new SyncEngine(reopened, {}, new RpcRegistry(), { broadcast() {} });
                const messages = [];
                let cursor = 0;
                while (true) {
                    const page = engine.getDeliverableMessagesAfter(session.id, { afterSeq: cursor, limit: 200, now: Date.now() });
                    messages.push(...page);
                    if (page.length < 200) break;
                    cursor = page.at(-1).seq;
                }
                engine.stop(); reopened.close();
                console.log(JSON.stringify({ probe, messages }));
            `)
            expect(persisted.probe).toMatchObject({ delivery_state: 'queued', invoked_at: expect.any(Number) })
            expect(persisted.messages.find((m: { localId: string }) => m.localId === 'invoked-X'))
                .toMatchObject({ invokedAt: persisted.probe.invoked_at })
            expect(persisted.messages.find((m: { localId: string }) => m.localId === 'missed-Y'))
                .toMatchObject({ invokedAt: null })
            // Durable invocation/ACK precedes the later live burst that evicts X.
            for (const message of initial.live) socket.trigger('update', { body: { t: 'new-message', message } })
            expect((client as unknown as { incomingFilter: { seenIds: Set<string> } })
                .incomingFilter.seenIds.has(initial.invoked.id)).toBe(false)
            response.resolve(persisted)
            socket.connected = false
            socket.trigger('disconnect', 'transport close')
            socket.triggerConnect()
            await vi.waitFor(() => expect(axiosHarness.get).toHaveBeenCalledWith(expect.stringContaining('/messages'),
                expect.objectContaining({ params: { afterSeq: 0, limit: 200 } })))
            await vi.waitFor(() => expect((client as unknown as { backfillInFlight: Promise<void> | null })
                .backfillInFlight).toBeNull())
            expect(queue.size()).toBeGreaterThan(0)
            const catchup = await queue.waitForMessagesAndGetAsString()
            issued.push(...catchup!.items.map(item => item.localId!))
            expect(issued.filter(id => id === 'invoked-X')).toHaveLength(1)
            expect(issued.filter(id => id === 'missed-Y')).toHaveLength(1)
            expect(catchup?.items.map(item => item.localId)).toEqual(['missed-Y'])
        } finally { response.resolve({ messages: [] }); client.close() }
    })

    describe('HAPI7-CURSOR-R2 invocation contract', () => {
        const committed = { path: '/tmp', host: 'test', flavor: 'opencode' as const, opencodeRewind: {
            operationId: 'invocation-contract', nativeSessionId: 'native', workerId: 'worker', requestedLocalId: 'removed',
            nativeMessageId: 'native-removed', cutoffSeq: 3, sourceEpoch: 0, sourceMaxSeq: 9,
            reservationVersion: 2, sourceTranscriptHash: 'a'.repeat(64), phase: 'committed' as const
        } }
        const user = (id: string, seq: number, invokedAt?: number | null) => ({
            id, seq, createdAt: seq, localId: id, ...(invokedAt === undefined ? {} : { invokedAt }),
            content: { role: 'user', content: { type: 'text', text: id }, meta: { sentFrom: 'webapp' } }
        })

        it.each([false, true])('uses invocation proof only during rewind recovery (%s)', async recovery => {
            socketHarness.sockets.length = 0
            axiosHarness.get.mockReset()
            const metadata = recovery ? committed : { path: '/tmp', host: 'test', flavor: 'claude' as const }
            const agent = { id: 'agent-output', seq: 6, createdAt: 6, localId: null, invokedAt: 123,
                content: { role: 'agent', content: { type: 'text', text: 'history event' } } }
            const messages = [user('invoked-zero', 3, 0), user('uninvoked', 4, null), user('legacy', 5), agent]
            axiosHarness.get.mockImplementation(async (url: string, config: { params?: { afterSeq: number } }) =>
                url.endsWith('/messages')
                    ? { data: { messages: messages.filter(m => m.seq > config.params!.afterSeq) } }
                    : { data: { session: { metadataVersion: 2, metadata } } })
            const client = new ApiSessionClient('token', createSession({ metadataVersion: 1,
                metadata: { path: '/tmp', host: 'test', flavor: metadata.flavor } }))
            const socket = socketHarness.sockets[0]
            const received = vi.fn()
            const output = vi.fn()
            client.onUserMessage(received)
            client.on('message', output)
            await Promise.resolve()
            triggerIncomingUserMessage(socket, { id: 'initial', seq: 2, text: 'local history', sentFrom: 'cli' })
            socket.connected = false
            socket.trigger('disconnect', 'transport close')
            socket.triggerConnect()
            try {
                await vi.waitFor(() => expect(output).toHaveBeenCalledWith(agent.content))
                expect(received.mock.calls.map(([, id]) => id)).toEqual(recovery
                    ? ['uninvoked', 'legacy'] : ['invoked-zero', 'uninvoked', 'legacy'])
            } finally { client.close() }
        })

        it('advances past an invoked-only recovery page without enqueueing or repeating it', async () => {
            socketHarness.sockets.length = 0
            axiosHarness.get.mockReset()
            const messages = [user('already-invoked', 3, 1)]
            axiosHarness.get.mockImplementation(async (url: string, config: { params?: { afterSeq: number } }) =>
                url.endsWith('/messages')
                    ? { data: { messages: messages.filter(m => m.seq > config.params!.afterSeq) } }
                    : { data: { session: { metadataVersion: 2, metadata: committed } } })
            const client = new ApiSessionClient('token', createSession({ metadataVersion: 1,
                metadata: { path: '/tmp', host: 'test', flavor: 'opencode' } }))
            const socket = socketHarness.sockets[0]
            const received = vi.fn()
            client.onUserMessage(received)
            await Promise.resolve()
            triggerIncomingUserMessage(socket, { id: 'old-tail', seq: 9, text: 'old local tail', sentFrom: 'cli' })
            socket.connected = false
            socket.trigger('disconnect', 'transport close')
            socket.triggerConnect()
            try {
                await vi.waitFor(() => expect(axiosHarness.get).toHaveBeenCalledWith(expect.stringContaining('/messages'),
                    expect.objectContaining({ params: { afterSeq: 0, limit: 200 } })))
                await vi.waitFor(() => expect((client as unknown as { backfillInFlight: Promise<void> | null })
                    .backfillInFlight).toBeNull())
                expect(received).not.toHaveBeenCalled()
                axiosHarness.get.mockClear()
                socket.connected = false
                socket.trigger('disconnect', 'transport close')
                socket.triggerConnect()
                await vi.waitFor(() => expect(axiosHarness.get).toHaveBeenCalledWith(expect.stringContaining('/messages'),
                    expect.objectContaining({ params: { afterSeq: 3, limit: 200 } })))
                expect(received).not.toHaveBeenCalled()
            } finally { client.close() }
        })
    })

    describe('HAPI7-CURSOR-R1 unscanned recovery floor', () => {
        const metadata = (operationId = 'floor-a', cutoffSeq = 3) => ({
            path: '/tmp', host: 'test', flavor: 'opencode' as const,
            opencodeRewind: {
                operationId, nativeSessionId: 'native', workerId: 'worker', requestedLocalId: 'removed',
                nativeMessageId: 'native-removed', cutoffSeq, sourceEpoch: 0, sourceMaxSeq: 9,
                reservationVersion: 2, sourceTranscriptHash: 'a'.repeat(64), phase: 'committed' as const
            }
        })
        const prompt = (id: string, seq: number) => ({ id, seq, createdAt: seq, localId: id,
            content: { role: 'user', content: { type: 'text', text: id }, meta: { sentFrom: 'webapp' } } })
        const settled = async (client: ApiSessionClient) => {
            await vi.waitFor(() => expect((client as unknown as { backfillInFlight: Promise<void> | null })
                .backfillInFlight).toBeNull())
        }

        it.each(['old message request', 'reconnect metadata'] as const)(
            'keeps queued3 below live4 while awaiting %s', async held => {
                socketHarness.sockets.length = 0
                axiosHarness.get.mockReset()
                const old = deferred<{ data: { messages: unknown[] } }>()
                const meta = deferred<{ data: { session: { metadataVersion: number; metadata: ReturnType<typeof metadata> } } }>()
                const rows = [prompt('queued3', 3), prompt('live4', 4)]
                let metaReads = 0
                axiosHarness.get.mockImplementation(async (url: string, config: { params?: { afterSeq: number } }) => {
                    if (!url.endsWith('/messages')) {
                        if (++metaReads === 1 && held === 'reconnect metadata') return await meta.promise
                        return { data: { session: { metadataVersion: 1,
                            metadata: { path: '/tmp', host: 'test', flavor: 'opencode' } } } }
                    }
                    if (config.params!.afterSeq === 9) return await old.promise
                    return { data: { messages: rows.filter(m => m.seq > config.params!.afterSeq) } }
                })
                const client = new ApiSessionClient('token', createSession({ metadataVersion: 1,
                    metadata: { path: '/tmp', host: 'test', flavor: 'opencode' } }))
                const socket = socketHarness.sockets[0]
                const received = vi.fn()
                client.onUserMessage(received)
                await Promise.resolve() // Finish initial-connect continuation before disconnecting.
                triggerIncomingUserMessage(socket, { id: 'old-tail', seq: 9, text: 'old tail', sentFrom: 'cli' })
                socket.connected = false
                socket.trigger('disconnect', 'transport close')
                socket.triggerConnect()
                try {
                    if (held === 'old message request') {
                        await vi.waitFor(() => expect(axiosHarness.get).toHaveBeenCalledWith(expect.stringContaining('/messages'),
                            expect.objectContaining({ params: { afterSeq: 9, limit: 200 } })))
                    } else {
                        await vi.waitFor(() => expect(metaReads).toBe(1))
                        expect(axiosHarness.get.mock.calls.filter(([url]) => String(url).endsWith('/messages'))).toHaveLength(0)
                    }
                    socket.trigger('update', { body: { t: 'update-session', metadata: { version: 2, value: metadata() } } })
                    socket.trigger('update', { body: { t: 'new-message', message: rows[1] } })
                    socket.trigger('update', { body: { t: 'update-session', metadata: { version: 3, value: metadata() } } })
                    old.resolve({ data: { messages: [prompt('removed-old-suffix', 10)] } })
                    meta.resolve({ data: { session: { metadataVersion: 2, metadata: metadata() } } })
                    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(expect.anything(), 'queued3'))
                    expect(received).toHaveBeenCalledTimes(2)
                    expect(received.mock.calls.some(([, id]) => id === 'removed-old-suffix')).toBe(false)
                    socket.trigger('update', { body: { t: 'new-message', message: rows[0] } })
                    socket.trigger('update', { body: { t: 'new-message', message: rows[1] } })
                    expect(received).toHaveBeenCalledTimes(2)
                    await settled(client)
                } finally {
                    old.resolve({ data: { messages: [] } })
                    meta.resolve({ data: { session: { metadataVersion: 3, metadata: metadata() } } })
                    client.close()
                }
            }
        )

        it('starts repair on live committed metadata without an old query or another reconnect', async () => {
            socketHarness.sockets.length = 0
            axiosHarness.get.mockReset()
            const rows = [prompt('queued3', 3), prompt('live4', 4)]
            axiosHarness.get.mockImplementation(async (url: string, config: { params?: { afterSeq: number } }) =>
                url.endsWith('/messages')
                    ? { data: { messages: rows.filter(m => m.seq > config.params!.afterSeq) } }
                    : { data: { session: { metadataVersion: 3, metadata: metadata() } } })
            const client = new ApiSessionClient('token', createSession({ metadataVersion: 1,
                metadata: { path: '/tmp', host: 'test', flavor: 'opencode' } }))
            const socket = socketHarness.sockets[0]
            const received = vi.fn()
            client.onUserMessage(received)
            await Promise.resolve() // No leftover initial-connect backfill in this live-only case.
            triggerIncomingUserMessage(socket, { id: 'old-tail', seq: 9, text: 'old tail', sentFrom: 'cli' })
            try {
                expect(axiosHarness.get).not.toHaveBeenCalled()
                socket.trigger('update', { body: { t: 'update-session', metadata: { version: 2, value: metadata() } } })
                socket.trigger('update', { body: { t: 'new-message', message: rows[1] } })
                await vi.waitFor(() => expect(received).toHaveBeenCalledWith(expect.anything(), 'queued3'))
                await settled(client)
                expect(received).toHaveBeenCalledTimes(2)
                expect(axiosHarness.get).toHaveBeenCalledWith(expect.stringContaining('/messages'),
                    expect.objectContaining({ params: { afterSeq: 0, limit: 200 } }))
                const reads = axiosHarness.get.mock.calls.length
                socket.trigger('update', { body: { t: 'update-session', metadata: { version: 3, value: metadata() } } })
                socket.trigger('update', { body: { t: 'new-message', message: rows[0] } })
                expect(received).toHaveBeenCalledTimes(2)
                expect(axiosHarness.get.mock.calls.length).toBe(reads)
            } finally { client.close() }
        })

        it('starts the newer recovery epoch after a superseded old request rejects', async () => {
            socketHarness.sockets.length = 0
            axiosHarness.get.mockReset()
            const held = deferred<{ data: { messages: unknown[] } }>()
            const rows = [prompt('queued3', 3), prompt('live4', 4)]
            axiosHarness.get.mockImplementation(async (url: string, config: { params?: { afterSeq: number } }) => {
                if (!url.endsWith('/messages')) return { data: { session: { metadataVersion: 1,
                    metadata: { path: '/tmp', host: 'test', flavor: 'opencode' } } } }
                if (config.params!.afterSeq === 9) return await held.promise
                return { data: { messages: rows.filter(m => m.seq > config.params!.afterSeq) } }
            })
            const client = new ApiSessionClient('token', createSession({ metadataVersion: 1,
                metadata: { path: '/tmp', host: 'test', flavor: 'opencode' } }))
            const socket = socketHarness.sockets[0]
            const received = vi.fn()
            client.onUserMessage(received)
            await Promise.resolve()
            triggerIncomingUserMessage(socket, { id: 'old-tail', seq: 9, text: 'old tail', sentFrom: 'cli' })
            socket.connected = false
            socket.trigger('disconnect', 'transport close')
            socket.triggerConnect()
            try {
                await vi.waitFor(() => expect(axiosHarness.get).toHaveBeenCalledWith(expect.stringContaining('/messages'),
                    expect.objectContaining({ params: { afterSeq: 9, limit: 200 } })))
                socket.trigger('update', { body: { t: 'update-session', metadata: { version: 2, value: metadata() } } })
                socket.trigger('update', { body: { t: 'new-message', message: rows[1] } })
                held.reject(new Error('superseded request failed'))
                await vi.waitFor(() => expect(received).toHaveBeenCalledWith(expect.anything(), 'queued3'))
                await settled(client)
                expect(received).toHaveBeenCalledTimes(2)
                expect(axiosHarness.get.mock.calls.filter(([url]) => String(url).endsWith('/messages'))
                    .map(([, config]) => config.params.afterSeq)).toEqual([9, 0])
            } finally { held.resolve({ data: { messages: [] } }); client.close() }
        })

        it.each(['failed', 'interrupted'] as const)(
            'does not raise an earlier floor when a newer rewind follows a %s scan', async outcome => {
                socketHarness.sockets.length = 0
                axiosHarness.get.mockReset()
                let current = metadata()
                let version = 2
                let reads = 0
                const first = deferred<{ data: { messages: unknown[] } }>()
                const rows: ReturnType<typeof prompt>[] = []
                axiosHarness.get.mockImplementation(async (url: string, config: { params?: { afterSeq: number } }) => {
                    if (!url.endsWith('/messages')) return { data: { session: { metadataVersion: version, metadata: current } } }
                    if (++reads === 1) return await first.promise
                    return { data: { messages: rows.filter(m => m.seq > config.params!.afterSeq) } }
                })
                const client = new ApiSessionClient('token', createSession({ metadataVersion: 1,
                    metadata: { path: '/tmp', host: 'test', flavor: 'opencode' } }))
                const socket = socketHarness.sockets[0]
                const received = vi.fn()
                client.onUserMessage(received)
                await Promise.resolve()
                triggerIncomingUserMessage(socket, { id: 'old-tail', seq: 9, text: 'old tail', sentFrom: 'cli' })
                socket.connected = false
                socket.trigger('disconnect', 'transport close')
                socket.triggerConnect()
                try {
                    await vi.waitFor(() => expect(reads).toBe(1))
                    // The first response snapshot predates these queued rows.
                    rows.push(prompt('queued3', 3), prompt('live4', 4))
                    socket.trigger('update', { body: { t: 'new-message', message: rows[1] } })
                    if (outcome === 'interrupted') {
                        socket.connected = false
                        socket.trigger('disconnect', 'transport close')
                        first.resolve({ data: { messages: [] } })
                    } else {
                        first.reject(new Error('transient backfill failure'))
                    }
                    await settled(client)
                    socket.connected = false
                    socket.trigger('disconnect', 'transport close')
                    current = metadata('floor-b', 5)
                    version = 4
                    expect(await client.refreshMetadata()).toBe(true)
                    version = 5
                    expect(await client.refreshMetadata()).toBe(true)
                    axiosHarness.get.mockClear()
                    socket.triggerConnect()
                    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(expect.anything(), 'queued3'))
                    await settled(client)
                    expect(received).toHaveBeenCalledTimes(2)
                    expect(axiosHarness.get).toHaveBeenCalledWith(expect.stringContaining('/messages'),
                        expect.objectContaining({ params: { afterSeq: 0, limit: 200 } }))
                    axiosHarness.get.mockClear()
                    socket.connected = false
                    socket.trigger('disconnect', 'transport close')
                    socket.triggerConnect()
                    await vi.waitFor(() => expect(axiosHarness.get).toHaveBeenCalledWith(expect.stringContaining('/messages'),
                        expect.objectContaining({ params: { afterSeq: 4, limit: 200 } })))
                    expect(received).toHaveBeenCalledTimes(2)
                } finally { first.resolve({ data: { messages: [] } }); client.close() }
            }
        )

        it('keeps the earlier floor when a newer reserved rewind suppresses a response', async () => {
            socketHarness.sockets.length = 0
            axiosHarness.get.mockReset()
            const held = deferred<{ data: { messages: unknown[] } }>()
            const rows = [prompt('queued3', 3), prompt('live4', 4)]
            let reads = 0
            axiosHarness.get.mockImplementation(async (url: string, config: { params?: { afterSeq: number } }) => {
                if (!url.endsWith('/messages')) return { data: { session: { metadataVersion: 2, metadata: metadata() } } }
                if (++reads === 1) return await held.promise
                return { data: { messages: rows.filter(m => m.seq > config.params!.afterSeq) } }
            })
            const client = new ApiSessionClient('token', createSession({ metadataVersion: 1,
                metadata: { path: '/tmp', host: 'test', flavor: 'opencode' } }))
            const socket = socketHarness.sockets[0]
            const received = vi.fn()
            client.onUserMessage(received)
            await Promise.resolve()
            triggerIncomingUserMessage(socket, { id: 'old-tail', seq: 9, text: 'old tail', sentFrom: 'cli' })
            socket.connected = false
            socket.trigger('disconnect', 'transport close')
            socket.triggerConnect()
            try {
                await vi.waitFor(() => expect(reads).toBe(1))
                socket.trigger('update', { body: { t: 'new-message', message: rows[1] } })
                const next = metadata('floor-b', 5)
                socket.trigger('update', { body: { t: 'update-session', metadata: { version: 3, value: {
                    ...next, opencodeRewind: { ...next.opencodeRewind, phase: 'reserved' }
                } } } })
                // Hub's durable pending-operation gate may return no deliverable
                // rows. That is not evidence that the old prefix was drained.
                held.resolve({ data: { messages: [] } })
                await settled(client)
                expect(received).toHaveBeenCalledTimes(1)
                socket.trigger('update', { body: { t: 'update-session', metadata: { version: 4, value: next } } })
                await vi.waitFor(() => expect(received).toHaveBeenCalledWith(expect.anything(), 'queued3'))
                await settled(client)
                expect(received).toHaveBeenCalledTimes(2)
                expect(axiosHarness.get.mock.calls.filter(([url]) => String(url).endsWith('/messages'))
                    .map(([, config]) => config.params.afterSeq)).toEqual([0, 0])
            } finally { held.resolve({ data: { messages: [] } }); client.close() }
        })
    })

    it.each([false, true])('delivers a queued lower-seq prompt exactly once on the same client after disconnected commit/consumption (recovery=%s)', async recoverCommitted => {
        socketHarness.sockets.length = 0
        axiosHarness.get.mockReset()
        axiosHarness.post.mockReset()
        const operation: OpenCodeRewindOperation = {
            operationId: 'same-client-delivery', nativeSessionId: 'native', workerId: 'worker',
            workerPid: process.pid, workerStartMarker: getProcessStartMarker(process.pid)!,
            requestedLocalId: 'two', nativeMessageId: 'u2', cutoffSeq: 3, sourceEpoch: 0,
            sourceMaxSeq: 9, reservationVersion: 2, sourceTranscriptHash: 'a'.repeat(64), phase: 'reserved'
        }
        let authoritative = operation
        let version = 2
        const metadata = () => ({ path: '/tmp', host: 'test', flavor: 'opencode' as const,
            opencodeSessionId: 'native', opencodeRewind: authoritative })
        const queued: Array<{ id: string; seq: number; createdAt: number; localId: string; content: unknown }> = []
        axiosHarness.get.mockImplementation(async (url: string, config: { params?: { afterSeq: number } }) => {
            if (url.endsWith('/messages')) return { data: { messages: queued.filter(m => m.seq > config.params!.afterSeq) } }
            return { data: { session: { metadataVersion: version, metadata: metadata() } } }
        })
        axiosHarness.post.mockImplementation(async (_url: string, { report }: { report: OpenCodeRewindReport }) => {
            if (authoritative.phase !== 'committed') {
                authoritative = { ...report.operation, phase: report.phase === 'applied' ? 'committed' : report.phase }
                version += 1
            }
            return { data: { operation: authoritative } }
        })
        const client = new ApiSessionClient('token', createSession({ metadata: metadata(), metadataVersion: version }))
        const socket = socketHarness.sockets[0]
        const received = vi.fn()
        client.onUserMessage(received)
        triggerIncomingUserMessage(socket, { id: 'old-tail', seq: 9, text: 'old transcript', sentFrom: 'cli' })
        socket.connected = false
        socket.trigger('disconnect', 'transport close')
        let rows = [{ id: 'u1', type: 'user' }, { id: 'a1', type: 'assistant' },
            { id: 'u2', type: 'user' }, { id: 'a2', type: 'assistant' }]
        let staged: string | undefined
        const nativeRequest = vi.fn(async (url: string, init?: RequestInit) => {
            if (url.endsWith('/revert/stage')) {
                staged = JSON.parse(init!.body as string).messageID
                return Response.json({})
            }
            if (url.endsWith('/revert/commit')) {
                rows = rows.slice(0, 2)
                staged = undefined
                return new Response(null, { status: 204 })
            }
            if (url.includes('/message?')) return Response.json({ data: rows, cursor: {} })
            if (url.endsWith('/active')) return Response.json({ data: {} })
            if (url.endsWith('/inbox')) return Response.json({ data: [] })
            return Response.json({ data: { id: 'native', ...(staged ? { revert: { messageID: staged } } : {}) } })
        })
        let failConsumption = recoverCommitted
        const consumeCommitted = vi.fn(async () => {
            expect(socket.connected).toBe(false)
            expect(authoritative.phase).toBe('committed')
            // A runtime-consumption metadata update can carry the same committed
            // receipt at a newer version, including recovery and duplicate use.
            version += 1
            expect(await client.refreshMetadata()).toBe(true)
            if (failConsumption) {
                failConsumption = false
                throw new Error('interrupted committed runtime consumption')
            }
        })
        const gate = new OpenCodeRuntimeGate()
        const rewind = new OpenCodeRewind({
            directory: mkdtempSync(join(tmpdir(), 'api-rewind-delivery-')), hapiSessionId: client.sessionId,
            workerId: 'worker', gate, baseUrl: 'http://synthetic-native', nativeSessionId: 'native', headers: {},
            request: nativeRequest, report: report => client.reportOpenCodeRewind(report),
            getAuthoritativeOperation: async () => { if (!await client.refreshMetadata()) throw new Error('refresh failed'); return client.getMetadata()?.opencodeRewind },
            flush: async () => true, isIdle: () => true,
            sourceCheckpoint: () => ({ sessionId: 'native', messageIds: ['u1', 'a1', 'u2', 'a2'],
                userMessageIds: ['u1', 'u2'], localMessageIds: [] }),
            sourceIndexes: () => ({ one: 0, two: 1 }), requestsFromPreviousWorkerCannotRun: () => true,
            consumeCommitted
        })
        try {
            expect((await rewind.execute(operation)).success).toBe(!recoverCommitted)
            expect(authoritative.phase).toBe('committed')
            if (recoverCommitted) {
                nativeRequest.mockClear()
                expect((await rewind.recover(authoritative)).success).toBe(true)
                expect(nativeRequest).not.toHaveBeenCalled()
            }
            expect(rewind.readIntent()?.phase).toBe('finalized')
            expect(gate.isBlocked()).toBe(false)
            expect(received).not.toHaveBeenCalled()
            // The input is accepted only AFTER disconnected commit/consumption.
            const prompt = { id: 'new-prompt', seq: 3, createdAt: 3, localId: 'new-input',
                content: { role: 'user', content: { type: 'text', text: 'queued after commit' }, meta: { sentFrom: 'webapp' } } }
            queued.push(prompt)
            socket.triggerConnect()
            await vi.waitFor(() => expect(received).toHaveBeenCalledWith(
                expect.objectContaining({ content: { type: 'text', text: 'queued after commit' } }), 'new-input'))
            expect(received).toHaveBeenCalledTimes(1)
            triggerIncomingUserMessage(socket, { id: 'later', seq: 6, text: 'postcommit progress', sentFrom: 'webapp' })
            socket.connected = false
            socket.trigger('disconnect', 'transport close')
            // Committed recovery after progress stays terminal: the finalized
            // journal is released without re-consumption (the runner's entry
            // reconciliation owns history refresh), so delivery continues
            // without resetting to the old cutoff.
            expect((await rewind.recover(authoritative)).success).toBe(true)
            axiosHarness.get.mockClear()
            socket.triggerConnect()
            await vi.waitFor(() => expect(axiosHarness.get).toHaveBeenCalledWith(expect.stringContaining('/messages'),
                expect.objectContaining({ params: { afterSeq: 6, limit: 200 } })))
            socket.trigger('update', { body: { t: 'new-message', message: prompt } })
            triggerIncomingUserMessage(socket, { id: 'retained-scheduled', seq: 1, text: 'mature scheduled', sentFrom: 'webapp' })
            triggerIncomingUserMessage(socket, { id: 'retained-scheduled', seq: 1, text: 'mature scheduled', sentFrom: 'webapp' })
            expect(received).toHaveBeenCalledTimes(3)
            // Consumption ran during execute plus (recovery=true) the applied-
            // journal recovery; post-progress recovery is terminal and does
            // not re-consume.
            expect(consumeCommitted).toHaveBeenCalledTimes(recoverCommitted ? 2 : 1)
        } finally { client.close() }
    })

    it.each(['live update', 'reconnect refresh', 'metadata acknowledgement'] as const)(
        'backfills an immediate prompt below the old cursor after committed rewind (%s)', async commitDelivery => {
            socketHarness.sockets.length = 0
            axiosHarness.get.mockReset()
            const metadata = { path: '/tmp', host: 'test', flavor: 'opencode' as const }
            const committed = { ...metadata, opencodeRewind: {
                operationId: 'rewind-delivery', nativeSessionId: 'native', workerId: 'worker',
                requestedLocalId: 'removed-turn', nativeMessageId: 'native-removed',
                cutoffSeq: 3, sourceEpoch: 0, sourceMaxSeq: 9, reservationVersion: 2,
                sourceTranscriptHash: 'a'.repeat(64), phase: 'committed' as const
            } }
            let version = 2
            const prompt = { id: 'post-rewind-prompt', seq: 3, createdAt: 3, localId: 'new-prompt',
                content: { role: 'user', content: { type: 'text', text: 'queued during disconnect' },
                    meta: { sentFrom: 'webapp' } } }
            axiosHarness.get.mockImplementation(async (url: string, config: { params?: { afterSeq: number } }) => {
                if (url.endsWith('/messages')) {
                    return { data: { messages: config.params!.afterSeq < prompt.seq ? [prompt] : [] } }
                }
                return { data: { session: { metadataVersion: version, metadata: committed } } }
            })
            const client = new ApiSessionClient('token', createSession({ metadata, metadataVersion: 1 }))
            const socket = socketHarness.sockets[0]
            const received = vi.fn()
            client.onUserMessage(received)
            triggerIncomingUserMessage(socket, { id: 'old-tail', seq: 9, text: 'old local tail', sentFrom: 'cli' })
            if (commitDelivery === 'live update') {
                socket.trigger('update', { body: { t: 'update-session', metadata: { version, value: committed } } })
            } else if (commitDelivery === 'metadata acknowledgement') {
                socket.emitWithAckImpl = async event => event === 'update-metadata'
                    ? { result: 'success', version, metadata: committed } : {}
                client.updateMetadata(meta => ({ ...meta, hostPid: 42 }))
                expect(await client.flushMetadata()).toBe(true)
            }
            socket.connected = false
            socket.trigger('disconnect', 'transport close')
            socket.triggerConnect()
            try {
                await vi.waitFor(() => expect(received).toHaveBeenCalledWith(
                    expect.objectContaining({ content: { type: 'text', text: 'queued during disconnect' } }), 'new-prompt'))
                expect(axiosHarness.get).toHaveBeenCalledWith(expect.stringContaining('/messages'),
                    expect.objectContaining({ params: { afterSeq: 0, limit: 200 } }))
                // The same committed tombstone in later metadata must not
                // repeatedly rewind the cursor or erase ID deduplication.
                version = 3
                socket.trigger('update', { body: { t: 'update-session', metadata: { version, value: committed } } })
                socket.trigger('update', { body: { t: 'new-message', message: prompt } })
                expect(received).toHaveBeenCalledTimes(1)
                triggerIncomingUserMessage(socket, { id: 'later', seq: 6, text: 'later prompt', sentFrom: 'webapp' })
                axiosHarness.get.mockClear()
                socket.connected = false
                socket.trigger('disconnect', 'transport close')
                socket.triggerConnect()
                await vi.waitFor(() => expect(axiosHarness.get).toHaveBeenCalledWith(expect.stringContaining('/messages'),
                    expect.objectContaining({ params: { afterSeq: 6, limit: 200 } })))
                expect(received).toHaveBeenCalledTimes(2)
            } finally { client.close() }
        }
    )

    it.each(['reserved', 'prepared', 'unknown', 'rejected'] as const)(
        'does not rewind the delivery cursor for a noncommitted operation (%s)', async phase => {
            socketHarness.sockets.length = 0
            axiosHarness.get.mockReset()
            const metadata = { path: '/tmp', host: 'test', flavor: 'opencode' as const, opencodeRewind: {
                operationId: 'not-committed', nativeSessionId: 'native', workerId: 'worker',
                requestedLocalId: 'removed', nativeMessageId: 'native-removed', cutoffSeq: 3,
                sourceEpoch: 0, sourceMaxSeq: 9, reservationVersion: 2,
                sourceTranscriptHash: 'a'.repeat(64), phase
            } }
            axiosHarness.get.mockImplementation(async (url: string) => url.endsWith('/messages')
                ? { data: { messages: [] } } : { data: { session: { metadataVersion: 2, metadata } } })
            const client = new ApiSessionClient('token', createSession({ metadataVersion: 1,
                metadata: { path: '/tmp', host: 'test', flavor: 'opencode' } }))
            const socket = socketHarness.sockets[0]
            triggerIncomingUserMessage(socket, { id: 'old-tail', seq: 9, text: 'old tail', sentFrom: 'cli' })
            socket.connected = false
            socket.trigger('disconnect', 'transport close')
            socket.triggerConnect()
            try {
                await vi.waitFor(() => expect(axiosHarness.get).toHaveBeenCalledWith(expect.stringContaining('/messages'),
                    expect.objectContaining({ params: { afterSeq: 9, limit: 200 } })))
            } finally { client.close() }
        }
    )

    it.each([1, 201])('restarts an in-flight old-cursor backfill without losing postcommit progress (%s queued)', async queuedCount => {
        socketHarness.sockets.length = 0
        axiosHarness.get.mockReset()
        const metadata = { path: '/tmp', host: 'test', flavor: 'opencode' as const }
        const pending = deferred<{ data: { messages: unknown[] } }>()
        const prompts = Array.from({ length: queuedCount }, (_, index) => ({
            id: `new-after-rewind-${index}`, seq: index + 3, createdAt: index + 3, localId: `new-prompt-${index}`,
            content: { role: 'user', content: { type: 'text', text: `new retained history ${index}` }, meta: { sentFrom: 'webapp' } }
        }))
        axiosHarness.get.mockImplementation(async (url: string, config: { params?: { afterSeq: number } }) => {
            if (!url.endsWith('/messages')) return { data: { session: { metadataVersion: 1, metadata } } }
            if (config.params!.afterSeq === 9) return await pending.promise
            return { data: { messages: prompts.filter(m => m.seq > config.params!.afterSeq).slice(0, 200) } }
        })
        const client = new ApiSessionClient('token', createSession({ metadata, metadataVersion: 1 }))
        const socket = socketHarness.sockets[0]
        const received = vi.fn()
        client.onUserMessage(received)
        triggerIncomingUserMessage(socket, { id: 'old-tail', seq: 9, text: 'old tail', sentFrom: 'cli' })
        socket.connected = false
        socket.trigger('disconnect', 'transport close')
        socket.triggerConnect()
        try {
            await vi.waitFor(() => expect(axiosHarness.get).toHaveBeenCalledWith(expect.stringContaining('/messages'),
                expect.objectContaining({ params: { afterSeq: 9, limit: 200 } })))
            // A second reconnect must join the old request, not start another
            // high-cursor backfill while that response is still outstanding.
            socket.connected = false
            socket.trigger('disconnect', 'transport close')
            socket.triggerConnect()
            await vi.waitFor(() => expect(axiosHarness.get.mock.calls.filter(([url]) => !String(url).endsWith('/messages'))).toHaveLength(2))
            expect(axiosHarness.get.mock.calls.filter(([url]) => String(url).endsWith('/messages'))).toHaveLength(1)
            const committed = {
                ...metadata, opencodeRewind: {
                    operationId: 'rewind-in-flight', nativeSessionId: 'native', workerId: 'worker',
                    requestedLocalId: 'removed', nativeMessageId: 'native-removed', cutoffSeq: 3,
                    sourceEpoch: 0, sourceMaxSeq: 9, reservationVersion: 2,
                    sourceTranscriptHash: 'a'.repeat(64), phase: 'committed' as const
                }
            }
            socket.trigger('update', { body: { t: 'update-session', metadata: { version: 2, value: committed } } })
            const progressSeq = queuedCount + 20
            triggerIncomingUserMessage(socket, { id: 'postcommit-progress', seq: progressSeq,
                text: 'live postcommit progress', sentFrom: 'webapp' })
            socket.trigger('update', { body: { t: 'update-session', metadata: { version: 3, value: committed } } })
            pending.resolve({ data: { messages: [{ ...prompts[0], id: 'deleted-old-response', seq: 10,
                localId: 'removed-prompt', content: { ...prompts[0].content,
                    content: { type: 'text', text: 'deleted stale response' } } }] } })
            await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(queuedCount + 1))
            expect(received).toHaveBeenCalledWith(expect.objectContaining({
                content: { type: 'text', text: 'new retained history 0' } }), 'new-prompt-0')
            expect(received.mock.calls.some(([, id]) => id === 'removed-prompt')).toBe(false)
            // ID duplicates stay rejected, and the next reconnect starts at the
            // live progress cursor rather than the retained cutoff or old9.
            socket.trigger('update', { body: { t: 'new-message', message: prompts[0] } })
            expect(received).toHaveBeenCalledTimes(queuedCount + 1)
            axiosHarness.get.mockClear()
            socket.connected = false
            socket.trigger('disconnect', 'transport close')
            socket.triggerConnect()
            await vi.waitFor(() => expect(axiosHarness.get).toHaveBeenCalledWith(expect.stringContaining('/messages'),
                expect.objectContaining({ params: { afterSeq: progressSeq, limit: 200 } })))
        } finally { pending.resolve({ data: { messages: [] } }); client.close() }
    })

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

    it('rewinds only the sequence cursor and preserves seen IDs, including an empty retained prefix', () => {
        const filter = new IncomingMessageFilter()
        filter.accept({ id: 'old-tail', seq: 9 })
        filter.rewindCursor(2)
        expect(filter.cursorSeq()).toBe(2)
        expect(filter.accept({ id: 'old-tail', seq: 9 })).toBe(false)
        expect(filter.accept({ id: 'new-prompt', seq: 3 })).toBe(true)
        filter.rewindCursor(8)
        expect(filter.cursorSeq()).toBe(3)
        filter.rewindCursor(0)
        expect(filter.cursorSeq()).toBe(0)
        expect(filter.accept({ id: 'first-new-turn', seq: 1 })).toBe(true)
        expect(filter.accept({ id: 'new-prompt', seq: 3 })).toBe(false)
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

describe('strict OpenCode rewind metadata and socket entry', () => {
    type StrictReader = { readRewindMetadata(): Promise<{ metadata: NonNullable<Session['metadata']>; version: number } | null> };
    it('returns the parsed equal-version REST snapshot itself without rewriting the equal-version cache', async () => {
        const cached = { path: '/cached', host: 'test', name: 'cached' };
        const authoritative = { path: '/fresh', host: 'test', name: 'fresh' };
        const client = new ApiSessionClient('test-token', createSession({ metadataVersion: 10, metadata: cached }));
        try {
            axiosHarness.get.mockResolvedValue({ data: { session: { metadataVersion: 10, metadata: authoritative } } });
            expect(await (client as unknown as StrictReader).readRewindMetadata()).toEqual({ metadata: authoritative, version: 10 });
            expect(client.getMetadata()).toMatchObject(cached);
        } finally { client.close(); }
    });

    it('rejects null, malformed, stale and failed strict metadata snapshots', async () => {
        const client = new ApiSessionClient('test-token', createSession({ metadataVersion: 10, metadata: { path: '/cached', host: 'test' } }));
        try {
            for (const session of [{ metadataVersion: 11, metadata: null }, { metadataVersion: 11, metadata: { titleLocked: true } },
                { metadataVersion: 9, metadata: { path: '/stale', host: 'test' } }]) {
                axiosHarness.get.mockResolvedValue({ data: { session } });
                expect(await (client as unknown as StrictReader).readRewindMetadata()).toBeNull();
            }
            axiosHarness.get.mockRejectedValue(new Error('offline'));
            expect(await (client as unknown as StrictReader).readRewindMetadata()).toBeNull();
        } finally { client.close(); }
    });

    it('rejects a snapshot superseded by a socket version while REST is in flight', async () => {
        const client = new ApiSessionClient('test-token', createSession({ metadataVersion: 10, metadata: { path: '/old', host: 'test' } }));
        const socket = socketHarness.sockets.at(-1)!; const held = deferred<unknown>();
        try {
            axiosHarness.get.mockReturnValue(held.promise);
            const reading = (client as unknown as StrictReader).readRewindMetadata();
            socket.trigger('update', { body: { t: 'update-session', metadata: { version: 12, value: { path: '/new', host: 'test' } } } });
            held.resolve({ data: { session: { metadataVersion: 11, metadata: { path: '/stale', host: 'test' } } } });
            expect(await reading).toBeNull();
            expect(client.getMetadata()).toMatchObject({ path: '/new' });
        } finally { client.close(); }
    });

    it('does not invent authoritative absence or materialize a lazy pending session', async () => {
        const materialize = vi.fn(async () => createSession());
        const client = new ApiSessionClient('test-token', createSession(), { materialize });
        try {
            axiosHarness.get.mockClear();
            expect(await client.readRewindMetadata()).toBeNull();
            expect(axiosHarness.get).not.toHaveBeenCalled();
            expect(materialize).not.toHaveBeenCalled();
        } finally { client.close(); }
    });

    it('emits a synchronous opt-in reconnect start before REST and queued acknowledgement', async () => {
        const client = new ApiSessionClient('test-token', createSession({ metadataVersion: 1, metadata: { path: '/fixture', host: 'test' } }));
        const socket = socketHarness.sockets.at(-1)!; const held = deferred<unknown>(); const gate = new OpenCodeRuntimeGate();
        await new Promise<void>(resolve => setImmediate(resolve));
        const queue = new MessageQueue2<{ permissionMode: 'default' }>(() => 'mode'); const acknowledged = vi.fn();
        queue.beforeDequeue = () => { gate.enterRuntime(); }; queue.onBatchConsumed = acknowledged;
        let fence: symbol | undefined; const order: string[] = [];
        const rpcConnect = vi.spyOn(client.rpcHandlerManager, 'onSocketConnect').mockImplementation(() => { order.push('rpc'); });
        client.on('connection-start', () => { order.push('start'); fence = (gate as unknown as { acquireEntryFence(): symbol }).acquireEntryFence(); });
        client.on('connected', () => { order.push('connected'); });
        try {
            axiosHarness.get.mockImplementation(() => { order.push('REST'); return held.promise; });
            queue.push('queued input', { permissionMode: 'default' }, 'queued'); socket.triggerConnect();
            expect(order[0]).toBe('start'); expect(gate.isBlocked()).toBe(true);
            expect(order.indexOf('rpc')).toBeGreaterThan(order.indexOf('start'));
            expect(order.indexOf('REST')).toBeGreaterThan(order.indexOf('rpc'));
            await expect(queue.waitForMessagesAndGetAsString()).rejects.toThrow('reconciliation');
            expect(acknowledged).not.toHaveBeenCalled(); expect(queue.size()).toBe(1);
            expect(order).not.toContain('connected');
        } finally {
            held.resolve({ data: { session: { metadataVersion: 1, metadata: { path: '/fixture', host: 'test' } } } });
            rpcConnect.mockRestore();
            if (fence) (gate as unknown as { releaseEntryFence(token: symbol): void }).releaseEntryFence(fence);
            queue.close(); client.close();
        }
    });
});

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
