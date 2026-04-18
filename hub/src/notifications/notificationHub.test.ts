import { describe, expect, it } from 'bun:test'
import type { Session, SyncEvent, SyncEventListener, SyncEngine } from '../sync/syncEngine'
import type { AttentionReason, NotificationChannel } from './notificationTypes'
import { NotificationHub } from './notificationHub'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeSyncEngine {
    private readonly listeners: Set<SyncEventListener> = new Set()
    private readonly sessions: Map<string, Session> = new Map()

    subscribe(listener: SyncEventListener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    getSession(sessionId: string): Session | undefined {
        return this.sessions.get(sessionId)
    }

    setSession(session: Session): void {
        this.sessions.set(session.id, session)
    }

    emit(event: SyncEvent): void {
        for (const listener of this.listeners) {
            listener(event)
        }
    }
}

class StubChannel implements NotificationChannel {
    readonly readySessions: Session[] = []
    readonly permissionSessions: Session[] = []
    readonly attentionNotifications: Array<{ session: Session; reason: 'failed' | 'interrupted' }> = []

    async sendReady(session: Session): Promise<void> {
        this.readySessions.push(session)
    }

    async sendPermissionRequest(session: Session): Promise<void> {
        this.permissionSessions.push(session)
    }

    async sendAttention(session: Session, reason: 'failed' | 'interrupted'): Promise<void> {
        this.attentionNotifications.push({ session, reason })
    }
}

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        ...overrides
    }
}

describe('NotificationHub', () => {
    it('debounces permission notifications and triggers when request IDs change', async () => {
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel], {
            permissionDebounceMs: 5,
            readyCooldownMs: 5
        })

        const firstSession = createSession({
            agentState: {
                requests: {
                    req1: { tool: 'Edit', arguments: {}, createdAt: 1 }
                }
            }
        })

        engine.setSession(firstSession)
        engine.emit({ type: 'session-updated', sessionId: firstSession.id })
        await sleep(25)

        expect(channel.permissionSessions).toHaveLength(1)

        engine.emit({ type: 'session-updated', sessionId: firstSession.id })
        await sleep(25)

        expect(channel.permissionSessions).toHaveLength(1)

        const secondSession = createSession({
            id: firstSession.id,
            namespace: firstSession.namespace,
            agentState: {
                requests: {
                    req2: { tool: 'Read', arguments: {}, createdAt: 2 }
                }
            }
        })

        engine.setSession(secondSession)
        engine.emit({ type: 'session-updated', sessionId: secondSession.id })
        await sleep(25)

        expect(channel.permissionSessions).toHaveLength(2)

        hub.stop()
    })

    it('throttles ready notifications per session', async () => {
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel], {
            permissionDebounceMs: 1,
            readyCooldownMs: 20
        })

        const session = createSession()
        engine.setSession(session)

        const readyEvent: SyncEvent = {
            type: 'message-received',
            sessionId: session.id,
            message: {
                id: 'message-1',
                seq: 1,
                localId: null,
                createdAt: 0,
                content: {
                    role: 'agent',
                    content: {
                        id: 'event-1',
                        type: 'event',
                        data: { type: 'ready' }
                    }
                }
            }
        }

        engine.emit(readyEvent)
        await sleep(5)
        expect(channel.readySessions).toHaveLength(1)

        engine.emit(readyEvent)
        await sleep(5)
        expect(channel.readySessions).toHaveLength(1)

        await sleep(30)
        engine.emit(readyEvent)
        await sleep(5)
        expect(channel.readySessions).toHaveLength(2)

        hub.stop()
    })

    it('sends ready when thinking stops after agent activity', async () => {
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel], {
            permissionDebounceMs: 1,
            readyCooldownMs: 5
        })

        engine.setSession(createSession({ thinking: true, thinkingAt: 1 }))
        engine.emit({ type: 'session-updated', sessionId: 'session-1' })
        engine.emit({
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'agent-text',
                seq: 2,
                localId: null,
                createdAt: 2,
                content: { role: 'agent', content: { type: 'text', text: 'done' } }
            }
        })

        engine.setSession(createSession({ thinking: false, thinkingAt: 3 }))
        engine.emit({ type: 'session-updated', sessionId: 'session-1' })
        await sleep(10)

        expect(channel.readySessions).toHaveLength(1)
        hub.stop()
    })

    it('does not send transition-ready when a permission request is pending', async () => {
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel], {
            permissionDebounceMs: 5,
            readyCooldownMs: 5
        })

        engine.setSession(createSession({ thinking: true, thinkingAt: 1 }))
        engine.emit({ type: 'session-updated', sessionId: 'session-1' })
        engine.emit({
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'agent-text',
                seq: 2,
                localId: null,
                createdAt: 2,
                content: { role: 'agent', content: { type: 'text', text: 'needs approval' } }
            }
        })
        engine.setSession(createSession({
            thinking: false,
            thinkingAt: 3,
            agentState: {
                requests: {
                    req1: { tool: 'Edit', arguments: {}, createdAt: 3 }
                }
            }
        }))
        engine.emit({ type: 'session-updated', sessionId: 'session-1' })
        await sleep(20)

        expect(channel.readySessions).toHaveLength(0)
        expect(channel.permissionSessions).toHaveLength(1)
        hub.stop()
    })

    it('sends attention notification for failure and interruption events with cooldown', async () => {
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel], {
            permissionDebounceMs: 1,
            readyCooldownMs: 1,
            attentionCooldownMs: 20
        })
        engine.setSession(createSession())

        const failedEvent: SyncEvent = {
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'failed-1',
                seq: 4,
                localId: null,
                createdAt: 4,
                content: { role: 'agent', content: { type: 'event', data: { type: 'failed' } } }
            }
        }

        engine.emit(failedEvent)
        await sleep(5)
        engine.emit(failedEvent)
        await sleep(5)

        expect(channel.attentionNotifications).toHaveLength(1)
        expect(channel.attentionNotifications[0]?.reason).toBe('failed')

        await sleep(25)
        engine.emit({
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'aborted-1',
                seq: 5,
                localId: null,
                createdAt: 5,
                content: { role: 'agent', content: { type: 'event', data: { type: 'aborted' } } }
            }
        })
        await sleep(5)

        expect(channel.attentionNotifications).toHaveLength(2)
        expect(channel.attentionNotifications[1]?.reason).toBe('interrupted')
        hub.stop()
    })

    it('does not treat pre-thinking agent activity as current thinking-cycle activity', async () => {
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel], {
            permissionDebounceMs: 1,
            readyCooldownMs: 0
        })

        engine.setSession(createSession({ thinking: false }))
        engine.emit({
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'agent-text',
                seq: 2,
                localId: null,
                createdAt: 2,
                content: { role: 'agent', content: { type: 'text', text: 'stale' } }
            }
        })

        engine.setSession(createSession({ thinking: true, thinkingAt: 3 }))
        engine.emit({ type: 'session-updated', sessionId: 'session-1' })

        engine.setSession(createSession({ thinking: false, thinkingAt: 4 }))
        engine.emit({ type: 'session-updated', sessionId: 'session-1' })

        expect(channel.readySessions).toHaveLength(0)
        hub.stop()
    })

    it('does not add extra transition-ready after an explicit ready event while thinking', async () => {
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel], {
            permissionDebounceMs: 1,
            readyCooldownMs: 0
        })

        const readyEvent: SyncEvent = {
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'ready-event',
                seq: 1,
                localId: null,
                createdAt: 0,
                content: { role: 'agent', content: { type: 'event', data: { type: 'ready' } } }
            }
        }

        engine.setSession(createSession({ thinking: true, thinkingAt: 1 }))
        engine.emit({ type: 'session-updated', sessionId: 'session-1' })
        engine.emit(readyEvent)

        engine.setSession(createSession({ thinking: false, thinkingAt: 2 }))
        engine.emit({ type: 'session-updated', sessionId: 'session-1' })

        expect(channel.readySessions).toHaveLength(1)
        hub.stop()
    })

    it('does not schedule transition-ready after attention events for the same run', async () => {
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel], {
            permissionDebounceMs: 1,
            readyCooldownMs: 0
        })

        engine.setSession(createSession({ thinking: true, thinkingAt: 1 }))
        engine.emit({ type: 'session-updated', sessionId: 'session-1' })
        engine.emit({
            type: 'message-received',
            sessionId: 'session-1',
            message: {
                id: 'failed-event',
                seq: 2,
                localId: null,
                createdAt: 2,
                content: { role: 'agent', content: { type: 'event', data: { type: 'failed' } } }
            }
        })

        engine.setSession(createSession({ thinking: false, thinkingAt: 3 }))
        engine.emit({ type: 'session-updated', sessionId: 'session-1' })

        expect(channel.attentionNotifications).toHaveLength(1)
        expect(channel.attentionNotifications[0]?.reason).toBe('failed')
        expect(channel.readySessions).toHaveLength(0)
        hub.stop()
    })
})
