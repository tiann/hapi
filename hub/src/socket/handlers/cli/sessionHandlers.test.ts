import { describe, expect, it, mock } from 'bun:test'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { Store, type StoredSession } from '../../../store'
import type { SyncEvent } from '../../../sync/syncEngine'
import type { CliSocketWithData } from '../../socketTypes'
import { registerSessionHandlers } from './sessionHandlers'

class FakeSocket {
    readonly roomEvents: Array<{ room: string; event: string; data: unknown }> = []
    private readonly handlers = new Map<string, (data: unknown, ack?: (response: unknown) => void) => void>()

    on(event: string, handler: (data: unknown, ack?: (response: unknown) => void) => void): this {
        this.handlers.set(event, handler)
        return this
    }

    to(room: string): { emit: (event: string, data: unknown) => void } {
        return {
            emit: (event: string, data: unknown) => {
                this.roomEvents.push({ room, event, data })
            }
        }
    }

    trigger(event: string, data: unknown, ack?: (response: unknown) => void): void {
        this.handlers.get(event)?.(data, ack)
    }
}

it('does not rebroadcast stored messages and retains repeated consumption acknowledgements', () => {
    const store = new Store(':memory:')
    const session = store.sessions.getOrCreateSession('dedupe-replay', {}, null, 'default')
    const socket = new FakeSocket()
    const events: SyncEvent[] = []
    const progress = mock(() => {})
    registerSessionHandlers(socket as unknown as CliSocketWithData, {
        store, resolveSessionAccess: () => ({ ok: true, value: session }), emitAccessError() {},
        onWebappEvent: event => events.push(event), onAgentProgress: progress
    })
    const message = { sid: session.id, localId: 'stable-1', message: { role: 'user', content: { type: 'text', text: 'hello' } } }
    socket.trigger('message', message)
    socket.trigger('messages-consumed', { sid: session.id, localIds: ['stable-1'] })
    socket.trigger('message', message)
    socket.trigger('messages-consumed', { sid: session.id, localIds: ['stable-1'] })
    expect(events.filter(event => event.type === 'message-received')).toHaveLength(1)
    expect(events.filter(event => event.type === 'messages-consumed')).toHaveLength(2)
    expect(progress).toHaveBeenCalledTimes(1)
    expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
    store.close()
})

describe('a locally handled command does not answer the agent (#1717)', () => {
    function harness() {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('local-command', {}, null, 'default')
        const socket = new FakeSocket()
        const delivered = mock((_sid: string, _at: number) => {})
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store, resolveSessionAccess: () => ({ ok: true, value: session }), emitAccessError() {},
            onWebappEvent() {}, onPromptDelivered: delivered
        })
        return { store, session, socket, delivered }
    }

    function sendPrompt(socket: FakeSocket, sid: string, localId: string): void {
        socket.trigger('message', {
            sid, localId, message: { role: 'user', content: { type: 'text', text: '/status' } }
        })
    }

    it('clears the blocker when the prompt actually reaches the agent', () => {
        // Positive control: the same shape WITHOUT the local-handler flag must
        // still clear, or the assertion below would pass on a handler that
        // never fires at all.
        const { socket, session, delivered, store } = harness()
        sendPrompt(socket, session.id, 'answer-1')
        socket.trigger('messages-consumed', { sid: session.id, localIds: ['answer-1'] })

        expect(delivered).toHaveBeenCalledTimes(1)
        store.close()
    })

    it('reports the maintenance turn UP to the hub, not just hub-side', () => {
        // My previous test for this called `markMaintenanceTurn` on the cache
        // directly, so it could not see that the callback was declared in both
        // option types and supplied by `startHub` but never forwarded to this
        // handler — the fix was dead on arrival in production. Asserting the
        // callback actually fires is what pins the wiring.
        const { socket, session, store } = harness()
        const maintenance: string[] = []
        const socket2 = new FakeSocket()
        registerSessionHandlers(socket2 as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session }),
            emitAccessError() {},
            onWebappEvent() {},
            onMaintenanceTurn: (sid) => { maintenance.push(sid) }
        })
        socket2.trigger('message', {
            sid: session.id,
            localId: 'compact-wire',
            message: { role: 'user', content: { type: 'text', text: '/compact' } }
        })
        socket2.trigger('messages-consumed', {
            sid: session.id, localIds: ['compact-wire'], maintenance: true
        })

        expect(maintenance).toEqual([session.id])
        void socket
        store.close()
    })

    it('leaves the blocker alone for a maintenance command, which keeps its grace', () => {
        // OpenCode acknowledges /compact when it DEQUEUES the command, before
        // compaction starts, and that consumed a command rather than
        // delivering a prompt. It cannot reuse `clearQueuedThinkingGrace`,
        // because /compact must KEEP that grace for the prompts queued behind
        // it — so without a separate flag the hub cleared an unanswered
        // blocker, and a cancellation during setup consumed no rows, leaving
        // the blocker gone for good.
        const { socket, session, delivered, store } = harness()
        sendPrompt(socket, session.id, 'compact-1')
        socket.trigger('messages-consumed', {
            sid: session.id, localIds: ['compact-1'], maintenance: true
        })

        expect(delivered).not.toHaveBeenCalled()
        store.close()
    })

    it('leaves the blocker alone for a command the CLI handled itself', () => {
        // Copilot `/model`, Pi `/stats`, a rejected or aborted message, a
        // failed steer: the CLI consumes the row and returns without ever
        // prompting the agent. The operator typed something, so the row is
        // genuinely consumed — but the question the agent asked is still
        // unanswered, and clearing here dropped it out of the Blocked section
        // with nobody having answered it.
        const { socket, session, delivered, store } = harness()
        sendPrompt(socket, session.id, 'slash-1')
        socket.trigger('messages-consumed', {
            sid: session.id, localIds: ['slash-1'], clearQueuedThinkingGrace: true
        })

        expect(delivered).not.toHaveBeenCalled()
        store.close()
    })
})

describe('hub arrival survives the socket hop into ingestion (#1717)', () => {
    function footerText(status: string): string {
        return `Prose.\n\nAGENT_NOTIFY_SUMMARY ${JSON.stringify({
            version: 1, status, summary: `s-${status}`
        })}`
    }

    it('carries receivedAt on the emitted event, so ingestion does not fall back to the runner clock', () => {
        // The handler builds the event by hand, and dropping `receivedAt` there
        // silently defeated the whole boundary: ingestion fell back to
        // `createdAt`, which is the agent runner's clock. A slow-clock runner's
        // genuine blocked footer then looked older than the hub's delivery
        // stamp and was rejected — the session never appeared in Blocked.
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('arrival-hop', {}, null, 'default')
        const socket = new FakeSocket()
        const events: SyncEvent[] = []
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store, resolveSessionAccess: () => ({ ok: true, value: session }), emitAccessError() {},
            onWebappEvent: event => events.push(event)
        })

        // Runner clock an hour behind the hub.
        const runnerStamp = Date.now() - 3_600_000
        socket.trigger('message', {
            sid: session.id,
            message: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: { type: 'assistant', message: { content: [{ type: 'text', text: footerText('blocked') }] } }
                }
            },
            createdAt: runnerStamp
        })

        const received = events.find(event => event.type === 'message-received') as
            { message: { createdAt: number; receivedAt?: number | null } } | undefined
        expect(received).toBeTruthy()
        expect(received!.message.createdAt).toBe(runnerStamp)
        // The arrival is the hub's own, not the runner's — that is the whole
        // point, so assert they actually differ.
        expect(received!.message.receivedAt).toBeGreaterThan(runnerStamp)
        store.close()
    })
})

describe('blocked chrome through the real socket-to-ingestion path (#1717)', () => {
    function footerText(status: string): string {
        return `Prose.\n\nAGENT_NOTIFY_SUMMARY ${JSON.stringify({
            version: 1, status, summary: `s-${status}`
        })}`
    }

    async function wire(tag: string) {
        const { SyncEngine } = await import('../../../sync/syncEngine')
        const { RpcRegistry } = await import('../../rpcRegistry')
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const session = engine.getOrCreateSession(tag, { path: '/tmp', host: 'h', flavor: 'claude' }, null, 'default')
        const stored = store.sessions.getSessionByNamespace(session.id, 'default')!
        const socket = new FakeSocket()
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: stored }),
            emitAccessError() {},
            onWebappEvent: (event) => engine.handleRealtimeEvent(event as SyncEvent),
            onPromptDelivered: (sid, at) => engine.clearSessionLastNotifyOnDelivery(sid, at)
        })
        return { store, engine, session, socket }
    }

    function sendFooter(socket: FakeSocket, sid: string, status: string, createdAt: number): void {
        socket.trigger('message', {
            sid,
            message: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: { type: 'assistant', message: { content: [{ type: 'text', text: footerText(status) }] } }
                }
            },
            createdAt
        })
    }

    function deliverPrompt(socket: FakeSocket, sid: string, localId: string): void {
        socket.trigger('message', {
            sid, localId, message: { role: 'user', content: { type: 'text', text: 'carry on' } }
        })
        socket.trigger('messages-consumed', { sid, localIds: [localId] })
    }

    it('shows a slow-clock runner blocked after the prompt that provoked it', async () => {
        // The runner is an hour behind, so its footer's author time predates
        // the hub's delivery stamp for the prompt that caused it. Only the
        // footer's hub ARRIVAL can tell the truth here, and it has to survive
        // the socket hop to be available at all.
        const { engine, session, socket } = await wire('socket-slow-clock')
        deliverPrompt(socket, session.id, 'prompt-1')

        sendFooter(socket, session.id, 'blocked', Date.now() - 3_600_000)

        expect(engine.getSession(session.id)?.lastNotify?.status).toBe('blocked')
    })

    it('does not readmit a delayed footer from the turn the prompt answered', async () => {
        // The other direction, and the reason arrival alone is not enough: this
        // footer was authored BEFORE the reply but reaches the hub after it, so
        // its arrival is genuinely later. The author time of the footer the
        // delivery superseded is what rejects it.
        const { engine, session, socket } = await wire('socket-delayed-sibling')
        const runnerNow = Date.now()

        sendFooter(socket, session.id, 'blocked', runnerNow - 10_000)
        expect(engine.getSession(session.id)?.lastNotify?.status).toBe('blocked')

        deliverPrompt(socket, session.id, 'prompt-1')
        expect(engine.getSession(session.id)?.lastNotify ?? null).toBeNull()

        // Late output from that same, already-answered turn.
        sendFooter(socket, session.id, 'blocked', runnerNow - 20_000)

        expect(engine.getSession(session.id)?.lastNotify ?? null).toBeNull()
    })
})

function redundantGoalStatusContent(message: string): unknown {
    return {
        role: 'agent',
        content: {
            id: `event-${message}`,
            type: 'event',
            data: { type: 'message', message }
        }
    }
}

function reasoningContent(streamId: string, text: string, live: boolean): unknown {
    return {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data: { type: 'reasoning', message: text, id: streamId, ...(live ? { live: true } : {}) }
        }
    }
}

function reasoningTextOf(message: { content: unknown }): string {
    return (message.content as { content: { data: { message: string } } }).content.data.message
}

type ToolCallFields = {
    input?: unknown
    status?: string
    nativeTitle?: string
}

function toolCallContent(callId: string, fields: ToolCallFields = {}): unknown {
    return {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data: {
                type: 'tool-call',
                callId,
                name: 'Read',
                ...(fields.input !== undefined ? { input: fields.input } : {}),
                ...(fields.status !== undefined ? { status: fields.status } : {}),
                ...(fields.nativeTitle !== undefined ? { nativeTitle: fields.nativeTitle } : {})
            }
        }
    }
}

function toolCallResultContent(callId: string, output: unknown): unknown {
    return {
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data: { type: 'tool-call-result', callId, output }
        }
    }
}

describe('cli session handlers', () => {
    it('advances the agent-progress clock when a tool-call tick merges into its row', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('merge-progress', {}, null, 'default')
        const socket = new FakeSocket()
        const progressTimes: number[] = []
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store, resolveSessionAccess: () => ({ ok: true, value: session }), emitAccessError() {},
            onAgentProgress: (sid, at) => progressTimes.push(at)
        })
        const now = Date.now()
        // Two ticks of one live call, two minutes apart per the CLI's own
        // transcript timestamps. The merged row keeps its first snapshot's
        // createdAt for stable ordering — but each tick must still advance
        // the keepalive-idle clock, or an ACP call with thinking=false and no
        // background task can be marked idle despite fresh updates.
        socket.trigger('message', {
            sid: session.id,
            message: toolCallContent('call-1', { status: 'running' }),
            createdAt: now - 120_000
        })
        expect(progressTimes).toHaveLength(1)
        socket.trigger('message', {
            sid: session.id,
            message: toolCallContent('call-1', { status: 'running', input: { file: 'b' } }),
            createdAt: now - 60_000
        })
        expect(progressTimes).toHaveLength(2)
        expect(progressTimes[1]!).toBeGreaterThan(progressTimes[0]!)
        expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
        store.close()
    })
    it.each([undefined, 'terminated', 'error'] as const)('preserves shared Codex pending input on execution exit (%s)', reason => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('shared-end', { flavor: 'codex', capabilities: { concurrentClients: true } }, null, 'default')
        store.messages.addMessage(session.id, { text: 'pending' }, 'pending')
        const socket = new FakeSocket(); const sweep = mock(); const end = mock()
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store, resolveSessionAccess: () => ({ ok: true, value: session }), emitAccessError() {},
            onSweepImmediateQueued: sweep, onSessionEnd: end
        })
        socket.trigger('session-end', { sid: session.id, time: Date.now(), reason })
        expect(sweep).not.toHaveBeenCalled(); expect(end).toHaveBeenCalledTimes(1)
        expect(store.messages.getAllMessages(session.id)[0]).toMatchObject({ localId: 'pending', invokedAt: null })
        store.close()
    })
    it('mirrors native queued edits/removal without overwriting or deleting a consumed row', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('shared-queue', { capabilities: { concurrentClients: true } }, null, 'default')
        const socket = new FakeSocket(); const events: SyncEvent[] = []
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store, resolveSessionAccess: () => ({ ok: true, value: session }), emitAccessError() {}, onWebappEvent: event => events.push(event)
        })
        const sync = (localId: string, text: string | null) => socket.trigger('native-queue-message', { sid: session.id, localId, text })
        sync('queued', 'one'); sync('queued', 'edited')
        expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
        expect(store.messages.getAllMessages(session.id)[0]).toMatchObject({ invokedAt: null, content: {
            content: { text: 'edited' }, meta: { sentFrom: 'cli', isNativeQueuedMessage: true }
        } })
        sync('queued', null); expect(events.at(-1)).toMatchObject({ type: 'message-cancelled', localId: 'queued' })
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'original', attachments: [{ name: 'image.png' }] }, meta: { sentFrom: 'web' } }, 'attachment')
        sync('attachment', 'edited')
        expect(store.messages.getAllMessages(session.id)[0]).toMatchObject({ content: { content: { attachments: [{ name: 'image.png' }], text: 'edited' }, meta: { sentFrom: 'web' } } })
        sync('attachment', null)
        sync('consumed', 'executed'); store.messages.markMessagesInvoked(session.id, ['consumed'], Date.now())
        sync('consumed', 'stale'); sync('consumed', null)
        expect(store.messages.getAllMessages(session.id)[0]).toMatchObject({ content: { content: { text: 'executed' } } })
    })
    it('preserves immediate queued rows for cleared handoff transfer', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('clear-end', {}, null, 'default')
        store.messages.addMessage(session.id, { text: 'held' }, 'held-local')
        const socket = new FakeSocket()
        let swept = false
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {},
            onSweepImmediateQueued: () => { swept = true }
        })
        socket.trigger('session-end', { sid: session.id, time: Date.now(), reason: 'cleared' })
        expect(swept).toBe(false)
        expect(store.messages.getAllMessages(session.id)).toEqual([
            expect.objectContaining({ localId: 'held-local', invokedAt: null })
        ])
    })

    it('collapses a live reasoning stream into its settled message', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('reasoning-stream-session', {}, null, 'default')
        const socket = new FakeSocket()

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            }
        })

        for (const text of ['th', 'thin', 'think']) {
            socket.trigger('message', { sid: session.id, message: reasoningContent('stream-1', text, true) })
        }
        socket.trigger('message', { sid: session.id, message: reasoningContent('stream-1', 'thinking', false) })
        // A second stream in the same turn must survive the first one's cleanup.
        socket.trigger('message', { sid: session.id, message: reasoningContent('stream-2', 'more', true) })

        expect(store.messages.getAllMessages(session.id).map(reasoningTextOf)).toEqual(['thinking', 'more'])
    })

    it('collapses a live text stream into its settled boundary message', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('text-stream-session', {}, null, 'default')
        const socket = new FakeSocket()

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            }
        })

        // Idle flushes: the CLI re-sends the growing buffer under one id,
        // marked live; the boundary flush re-sends the full text with only
        // the snapshot marker. Only the settled row may survive.
        const textContent = (streamId: string, text: string, live: boolean) => ({
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'message',
                    message: text,
                    id: streamId,
                    streamSnapshot: true,
                    ...(live ? { live: true } : {})
                }
            }
        })
        for (const text of ['He', 'Hello', 'Hello wor', 'Hello world, the ans']) {
            socket.trigger('message', { sid: session.id, message: textContent('text-1', text, true) })
        }
        socket.trigger('message', { sid: session.id, message: textContent('text-1', 'Hello world, the answer.', false) })

        const bodies = store.messages.getAllMessages(session.id)
            .map((message) => (message.content as { content: { data: { message: string } } }).content.data.message)
        expect(bodies).toEqual(['Hello world, the answer.'])
    })

    it('keeps plain text messages without a stream id untouched', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('plain-text-session', {}, null, 'default')
        const socket = new FakeSocket()

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            }
        })

        for (const text of ['one', 'two']) {
            socket.trigger('message', {
                sid: session.id,
                message: { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'message', message: text } } }
            })
        }

        expect(store.messages.getAllMessages(session.id)).toHaveLength(2)
    })

    it('keeps every reasoning snapshot that carries no stream id', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('reasoning-idless-session', {}, null, 'default')
        const socket = new FakeSocket()

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            }
        })

        for (const text of ['one', 'two']) {
            socket.trigger('message', {
                sid: session.id,
                message: { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'reasoning', message: text } } }
            })
        }

        expect(store.messages.getAllMessages(session.id)).toHaveLength(2)
    })

    it('drops redundant goal status events before persistence and broadcast', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('goal-status-session', {}, null, 'default')
        const socket = new FakeSocket()
        const webEvents: SyncEvent[] = []

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onWebappEvent: (event) => {
                webEvents.push(event)
            }
        })

        for (const message of [
            'Goal active · 8016 tokens',
            'Goal blocked',
            'Goal limited by usage · 8016 tokens'
        ]) {
            socket.trigger('message', {
                sid: session.id,
                message: redundantGoalStatusContent(message)
            })
        }

        expect(store.messages.getMessages(session.id)).toHaveLength(0)
        expect(socket.roomEvents).toHaveLength(0)
        expect(webEvents).toHaveLength(0)
    })

    it('emits a structured todos patch when a TodoWrite message lands (closes second half of #884)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('todos-session', { path: '/tmp', host: 'h' }, null, 'default')
        const socket = new FakeSocket()
        const webEvents: SyncEvent[] = []

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onWebappEvent: (event) => {
                webEvents.push(event)
            }
        })

        socket.trigger('message', {
            sid: session.id,
            message: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            content: [
                                {
                                    type: 'tool_use',
                                    name: 'TodoWrite',
                                    input: {
                                        todos: [
                                            { content: 'pending thing', status: 'pending' },
                                            { content: 'done thing', status: 'completed' }
                                        ]
                                    }
                                }
                            ]
                        }
                    }
                }
            }
        })

        const sessionUpdated = webEvents.find((e) => e.type === 'session-updated')
        expect(sessionUpdated).toBeDefined()
        if (!sessionUpdated || sessionUpdated.type !== 'session-updated') return
        expect(sessionUpdated.data).toMatchObject({
            todos: {
                version: expect.any(Number),
                value: [
                    { content: 'pending thing', status: 'pending' },
                    { content: 'done thing', status: 'completed' }
                ]
            }
        })
        expect(typeof (sessionUpdated.data as { updatedAt?: number }).updatedAt).toBe('number')
        expect((sessionUpdated.data as { updatedAt?: number }).updatedAt).toBeGreaterThan(0)
    })

    it('emits a structured metadata patch on update-metadata RPC (closes second half of #884)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'metadata-patch-session',
            { path: '/tmp/project', host: 'example' },
            null,
            'default'
        )
        const socket = new FakeSocket()
        const webEvents: SyncEvent[] = []

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onWebappEvent: (event) => {
                webEvents.push(event)
            }
        })

        socket.trigger(
            'update-metadata',
            {
                sid: session.id,
                expectedVersion: session.metadataVersion,
                metadata: { lifecycleState: 'archived' }
            },
            () => {}
        )

        const sessionUpdated = webEvents.find((e) => e.type === 'session-updated')
        expect(sessionUpdated).toBeDefined()
        if (!sessionUpdated || sessionUpdated.type !== 'session-updated') return
        const data = sessionUpdated.data as { metadata?: { version: number; value: Record<string, unknown> }; updatedAt?: number } | undefined
        expect(data?.metadata?.version).toBe(session.metadataVersion + 1)
        // Merged value: original path/host preserved + new lifecycleState applied.
        expect(data?.metadata?.value).toMatchObject({
            path: '/tmp/project',
            host: 'example',
            lifecycleState: 'archived'
        })
        expect(typeof data?.updatedAt).toBe('number')
        // Same-ms create+update is common in unit tests; store still touches updated_at.
        expect(data?.updatedAt).toBeGreaterThanOrEqual(session.updatedAt)
    })

    it('emits a structured agentState patch on update-state RPC (closes second half of #884)', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'agent-state-patch-session',
            { path: '/tmp', host: 'h' },
            null,
            'default'
        )
        const socket = new FakeSocket()
        const webEvents: SyncEvent[] = []

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onWebappEvent: (event) => {
                webEvents.push(event)
            }
        })

        socket.trigger(
            'update-state',
            {
                sid: session.id,
                expectedVersion: session.agentStateVersion,
                agentState: { controlledByUser: true }
            },
            () => {}
        )

        const sessionUpdated = webEvents.find((e) => e.type === 'session-updated')
        expect(sessionUpdated).toBeDefined()
        if (!sessionUpdated || sessionUpdated.type !== 'session-updated') return
        const data = sessionUpdated.data as {
            agentState?: { version: number; value: { controlledByUser?: boolean } }
            updatedAt?: number
        } | undefined
        expect(data?.agentState?.version).toBe(session.agentStateVersion + 1)
        expect(data?.agentState?.value).toMatchObject({ controlledByUser: true })
        expect(typeof data?.updatedAt).toBe('number')
        // Same-ms create+update is common in unit tests; store still touches updated_at.
        expect(data?.updatedAt).toBeGreaterThanOrEqual(session.updatedAt)
    })

    it('update-metadata broadcasts the merged value, not the pre-merge payload', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'broadcast-merged',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'broadcast-survives'
            },
            null,
            'default'
        )
        const socket = new FakeSocket()

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            }
        })

        let ackResponse: unknown = null
        socket.trigger(
            'update-metadata',
            {
                sid: session.id,
                expectedVersion: session.metadataVersion,
                metadata: {
                    lifecycleState: 'archived',
                    archivedBy: 'cli',
                    archiveReason: 'Session crashed'
                }
            },
            (response) => {
                ackResponse = response
            }
        )

        // Ack: success and the version bumps; the persisted value carries the
        // merged metadata so other CLIs can update their cache to the truth.
        const ack = ackResponse as { result: string; version: number; metadata: unknown }
        expect(ack.result).toBe('success')
        const ackMetadata = ack.metadata as Record<string, unknown>
        expect(ackMetadata.cursorSessionId).toBe('broadcast-survives')
        expect(ackMetadata.path).toBe('/tmp/project')

        // Broadcast: the room event must carry the same merged value.
        const broadcast = socket.roomEvents.find((event) => event.event === 'update')
        expect(broadcast).toBeDefined()
        const broadcastBody = (broadcast?.data as { body: { metadata: { value: Record<string, unknown> } } }).body
        expect(broadcastBody.metadata.value.cursorSessionId).toBe('broadcast-survives')
        expect(broadcastBody.metadata.value.path).toBe('/tmp/project')
        expect(broadcastBody.metadata.value.lifecycleState).toBe('archived')
    })

    // Agent messages used to be stamped with
    // the hub's own Date.now() at receive time (see messages.ts addMessage),
    // ignoring the transcript's own jsonl timestamp entirely. During a burst
    // (e.g. resume replaying several transcript lines back-to-back), the CLI-side
    // processing/emit order does not always match the jsonl append order, so the
    // hub's arrival-time stamping could display messages out of jsonl order. The
    // fix is for agent messages to respect a client-provided `createdAt` (the
    // transcript entry's own timestamp) for BOTH created_at and invoked_at, so
    // getMessagesByPosition's existing COALESCE(invoked_at, created_at) sort
    // reproduces jsonl order regardless of arrival order.
    it('agent messages: display order follows client-provided createdAt (jsonl order), not hub arrival order', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('order-drift', {}, null, 'default')
        const socket = new FakeSocket()

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            }
        })

        // jsonl SSOT order is msg-1 (createdAt=1000) then msg-2 (createdAt=2000).
        // Simulate the burst/resume drift by having the hub receive msg-2 FIRST.
        socket.trigger('message', {
            sid: session.id,
            message: { role: 'agent', content: { type: 'output', data: { uuid: 'msg-2' } } },
            createdAt: 2000
        })
        socket.trigger('message', {
            sid: session.id,
            message: { role: 'agent', content: { type: 'output', data: { uuid: 'msg-1' } } },
            createdAt: 1000
        })

        const ordered = store.messages.getMessagesByPosition(session.id, 10)
        const uuids = ordered.map((m) => (m.content as { content: { data: { uuid: string } } }).content.data.uuid)
        expect(uuids).toEqual(['msg-1', 'msg-2'])
    })

it.each([
        ['codexImportedAt', 1234],
        ['supersededBySessionId', 'foreign-session'],
        ['opencodeClearOperation', { replacementSessionId: 'foreign-session', state: 'reserved', updatedAt: Date.now() }],
        ['opencodeForkPending', true],
        ['titleSuggestionAutoAttemptedAt', 1234],
        ['titleSuggestionTurn', { first: false, completed: true }],
        ['promptTitle', 'Forged title'],
        ['jobsAcceptedFromSessionIds', ['foreign-session']],
        ['jobsTransferredToSessionId', 'foreign-session'],
        ['jobKeyRedirects', { 'foreign-session/beets': 'beets.foreign' }],
    ] as const)(
        'ignores a forged hub-owned %s addition from CLI metadata',
        (field, forged) => {
            const store = new Store(':memory:')
            const session = store.sessions.getOrCreateSession('forged-clear-link', { path: '/tmp/project' }, null, 'default')
            const socket = new FakeSocket()
            registerSessionHandlers(socket as unknown as CliSocketWithData, {
                store,
                resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
                emitAccessError: () => { throw new Error('unexpected access error') }
            })
            socket.trigger('update-metadata', {
                sid: session.id,
                expectedVersion: session.metadataVersion,
                metadata: {
                    path: '/tmp/project',
                    [field]: forged
                }
            }, () => {})
            expect(store.sessions.getSessionByNamespace(session.id, 'default')?.metadata).not.toHaveProperty(field)
        }
    )

    it.each([1234, null])('preserves Codex import state %s across CLI bootstrap replacements', (codexImportedAt) => {
        const store = new Store(':memory:')
        try {
            const session = store.sessions.getOrCreateSession('preserve-import-state', {
                path: '/tmp/project', codexImportedAt
            }, null, 'default')
            const socket = new FakeSocket()
            registerSessionHandlers(socket as unknown as CliSocketWithData, {
                store,
                resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
                emitAccessError: () => { throw new Error('unexpected access error') }
            })
            socket.trigger('update-metadata', {
                sid: session.id,
                expectedVersion: session.metadataVersion,
                metadata: { path: '/tmp/project' }
            }, () => {})
            expect(store.sessions.getSessionByNamespace(session.id, 'default')?.metadata)
                .toHaveProperty('codexImportedAt', codexImportedAt)
        } finally {
            store.close()
        }
    })

    it('preserves existing hub-owned clear and job-redirect metadata across CLI metadata updates', () => {
        const store = new Store(':memory:')
        const operation = { replacementSessionId: 'owned-target', state: 'completed', updatedAt: Date.now() }
        const session = store.sessions.getOrCreateSession('preserve-clear-link', {
            supersededBySessionId: 'owned-target',
            opencodeClearOperation: operation,
            opencodeForkPending: true,
            jobsAcceptedFromSessionIds: ['old-session'],
            jobsTransferredToSessionId: 'merge-target',
            jobKeyRedirects: { 'old-session/beets': 'beets.oldsess1' },
        }, null, 'default')
        const socket = new FakeSocket()
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => { throw new Error('unexpected access error') }
        })
        socket.trigger('update-metadata', {
            sid: session.id,
            expectedVersion: session.metadataVersion,
            metadata: {
                lifecycleState: 'archived',
                supersededBySessionId: 'forged-target', opencodeForkPending: false,
                opencodeClearOperation: { replacementSessionId: 'forged-target', state: 'reserved', updatedAt: 0 },
                jobsAcceptedFromSessionIds: ['forged-session'],
                jobsTransferredToSessionId: 'forged-target',
                jobKeyRedirects: { 'forged/beets': 'beets.forged' },
            }
        }, () => {})
        expect(store.sessions.getSessionByNamespace(session.id, 'default')?.metadata).toMatchObject({
            supersededBySessionId: 'owned-target',
            opencodeClearOperation: operation,
            opencodeForkPending: true,
            jobsAcceptedFromSessionIds: ['old-session'],
            jobsTransferredToSessionId: 'merge-target',
            jobKeyRedirects: { 'old-session/beets': 'beets.oldsess1' },
            lifecycleState: 'archived',
        })
    })

    it('preserves the automatic title attempt marker across CLI metadata updates', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('preserve-auto-title-marker', {
            path: '/tmp/project',
            titleSuggestionAutoAttemptedAt: 1234,
            titleSuggestionTurn: { first: true, completed: false },
            promptTitle: 'Fix the login bug'
        }, null, 'default')
        const socket = new FakeSocket()
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => { throw new Error('unexpected access error') }
        })

        socket.trigger('update-metadata', {
            sid: session.id,
            expectedVersion: session.metadataVersion,
            metadata: { path: '/tmp/project', titleSuggestionAutoAttemptedAt: 9999, titleSuggestionTurn: { first: false, completed: true } }
        }, () => {})

        expect(store.sessions.getSessionByNamespace(session.id, 'default')?.metadata).toMatchObject({
            titleSuggestionAutoAttemptedAt: 1234,
            titleSuggestionTurn: { first: true, completed: false },
            promptTitle: 'Fix the login bug'
        })
    })

    it('applies a refined TodoWrite snapshot merged into the same callId row', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('acp-todowrite-merge', {}, null, 'default')
        const socket = new FakeSocket()
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store, resolveSessionAccess: () => ({ ok: true, value: session }), emitAccessError() {}
        })
        const todoCall = (todos: Array<{ content: string; status: string }>) => ({
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: { type: 'tool-call', callId: 'todo-1', name: 'TodoWrite', input: { todos }, status: 'in_progress' }
            }
        })
        const send = (content: unknown) => socket.trigger('message', { sid: session.id, message: content })

        send(todoCall([{ content: 'first', status: 'pending' }]))
        // The refined snapshot re-emits the same callId with a different valid
        // todos array; the merged row must feed the session's todo list too.
        send(todoCall([
            { content: 'first', status: 'completed' },
            { content: 'second', status: 'pending' }
        ]))

        const rows = store.messages.getAllMessages(session.id)
        expect(rows).toHaveLength(1)
        expect(store.sessions.getSession(session.id)?.todos).toEqual([
            { content: 'first', status: 'completed', priority: 'medium', id: '' },
            { content: 'second', status: 'pending', priority: 'medium', id: '' }
        ])
        store.close()
    })

    it('folds repeated ACP tool-call updates into one stored row and rebroadcasts the merged row', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('acp-toolcall-fold', {}, null, 'default')
        const socket = new FakeSocket()
        const events: SyncEvent[] = []
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store, resolveSessionAccess: () => ({ ok: true, value: session }), emitAccessError() {},
            onWebappEvent: event => events.push(event)
        })
        const send = (content: unknown) => socket.trigger('message', { sid: session.id, message: content })

        send(toolCallContent('call-1', { input: { path: '/a' }, status: 'in_progress', nativeTitle: 'Reading /a' }))
        expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
        send(toolCallContent('call-1', { status: 'in_progress' }))
        // The update replaces the row in place: no second row mid-stream.
        expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
        send(toolCallContent('call-1', { status: 'completed' }))
        send(toolCallResultContent('call-1', 'done'))

        const rows = store.messages.getAllMessages(session.id)
        expect(rows).toHaveLength(2)

        const received = events.filter((event): event is Extract<SyncEvent, { type: 'message-received' }> => event.type === 'message-received')
        expect(received).toHaveLength(4)
        const firstId = received[0]!.message.id
        const firstSeq = received[0]!.message.seq
        // Every update is broadcast under the FIRST row's id/seq so live
        // clients replace the row in place instead of appending a duplicate.
        expect(received[1]!.message.id).toBe(firstId)
        expect(received[1]!.message.seq).toBe(firstSeq)
        expect(received[2]!.message.id).toBe(firstId)
        expect(received[2]!.message.seq).toBe(firstSeq)
        // The result stays its own row with its own id.
        expect(received[3]!.message.id).not.toBe(firstId)
        // The final broadcast of the call carries the merged content.
        const mergedData = (received[2]!.message.content as { content: { data: Record<string, unknown> } }).content.data
        expect(mergedData.input).toEqual({ path: '/a' })
        expect(mergedData.nativeTitle).toBe('Reading /a')
        expect(mergedData.status).toBe('completed')

        // The session-room socket broadcast re-emits the same existing id/seq.
        const roomUpdates = socket.roomEvents.filter(event => event.event === 'update')
        expect(roomUpdates).toHaveLength(4)
        const updatedBody = (roomUpdates[1]!.data as {
            body: { t: string; message: { id: string; seq: number | null; content: unknown } }
        }).body
        expect(updatedBody.t).toBe('new-message')
        expect(updatedBody.message.id).toBe(firstId)
        expect(updatedBody.message.seq).toBe(firstSeq)
        expect((updatedBody.message.content as { content: { data: Record<string, unknown> } }).content.data.status).toBe('in_progress')
        store.close()
    })
})
