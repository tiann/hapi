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
