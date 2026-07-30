import { describe, expect, it } from 'bun:test'
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

describe('cli session handlers', () => {
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

        socket.trigger('message', {
            sid: session.id,
            message: redundantGoalStatusContent('Goal active · 8016 tokens')
        })

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

    it.each(['supersededBySessionId', 'opencodeClearOperation'] as const)(
        'ignores a forged hub-owned %s addition from CLI metadata',
        (field) => {
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
                    [field]: field === 'supersededBySessionId'
                        ? 'foreign-session'
                        : { replacementSessionId: 'foreign-session', state: 'reserved', updatedAt: Date.now() }
                }
            }, () => {})
            expect(store.sessions.getSessionByNamespace(session.id, 'default')?.metadata).not.toHaveProperty(field)
        }
    )

    it('preserves existing hub-owned clear metadata across CLI metadata updates', () => {
        const store = new Store(':memory:')
        const operation = { replacementSessionId: 'owned-target', state: 'completed', updatedAt: Date.now() }
        const session = store.sessions.getOrCreateSession('preserve-clear-link', {
            supersededBySessionId: 'owned-target', opencodeClearOperation: operation
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
                supersededBySessionId: 'forged-target',
                opencodeClearOperation: { replacementSessionId: 'forged-target', state: 'reserved', updatedAt: 0 }
            }
        }, () => {})
        expect(store.sessions.getSessionByNamespace(session.id, 'default')?.metadata).toMatchObject({
            supersededBySessionId: 'owned-target', opencodeClearOperation: operation, lifecycleState: 'archived'
        })
    })
})
