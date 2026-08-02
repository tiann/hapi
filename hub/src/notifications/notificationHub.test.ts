import { describe, expect, it } from 'bun:test'
import type { Session, SyncEvent, SyncEventListener, SyncEngine } from '../sync/syncEngine'
import type { SessionEndReason } from '@hapi/protocol'
import type {
    ModelErrorNotification,
    ModelErrorSendOutcome,
    NotificationChannel,
    TaskNotification
} from './notificationTypes'
import { NotificationHub } from './notificationHub'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeSyncEngine {
    private readonly listeners: Set<SyncEventListener> = new Set()
    private readonly sessions: Map<string, Session> = new Map()
    readonly modelErrorNotifiedMarks: Array<{ sessionId: string; atTs: number }> = []

    subscribe(listener: SyncEventListener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    getSession(sessionId: string): Session | undefined {
        return this.sessions.get(sessionId)
    }

    getSessions(): Session[] {
        return Array.from(this.sessions.values())
    }

    setSession(session: Session): void {
        this.sessions.set(session.id, session)
    }

    async markModelErrorNotified(sessionId: string, atTs: number): Promise<void> {
        this.modelErrorNotifiedMarks.push({ sessionId, atTs })
        const session = this.sessions.get(sessionId)
        const err = session?.metadata?.lastModelError
        if (!session || !err || err.atTs !== atTs) {
            return
        }
        this.sessions.set(sessionId, {
            ...session,
            metadata: {
                ...session.metadata!,
                lastModelError: {
                    ...err,
                    notifiedAt: Date.now()
                }
            }
        })
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
    readonly taskNotifications: Array<{ session: Session; notification: TaskNotification }> = []
    readonly sessionCompletions: Session[] = []
    readonly modelErrors: Array<{ session: Session; notification: ModelErrorNotification }> = []

    async sendReady(session: Session): Promise<void> {
        this.readySessions.push(session)
    }

    async sendPermissionRequest(session: Session): Promise<void> {
        this.permissionSessions.push(session)
    }

    async sendTaskNotification(session: Session, notification: TaskNotification): Promise<void> {
        this.taskNotifications.push({ session, notification })
    }

    async sendSessionCompletion(session: Session): Promise<void> {
        this.sessionCompletions.push(session)
    }

    async sendModelError(session: Session, notification: ModelErrorNotification): Promise<ModelErrorSendOutcome> {
        this.modelErrors.push({ session, notification })
        return 'delivered'
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
        serviceTier: null,
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

    it('sends task notifications for task_notification system messages', async () => {
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel], {
            permissionDebounceMs: 1,
            readyCooldownMs: 20
        })

        const session = createSession()
        engine.setSession(session)

        const taskEvent: SyncEvent = {
            type: 'message-received',
            sessionId: session.id,
            message: {
                id: 'message-task',
                seq: 2,
                localId: null,
                createdAt: 0,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'system',
                            subtype: 'task_notification',
                            status: 'completed',
                            summary: 'Commit T4 finished'
                        }
                    }
                }
            }
        }

        engine.emit(taskEvent)
        await sleep(5)

        expect(channel.taskNotifications).toHaveLength(1)
        expect(channel.taskNotifications[0]?.notification).toEqual({
            status: 'completed',
            summary: 'Commit T4 finished'
        })

        hub.stop()
    })

    it('sends session completion only for completed session-ended events', async () => {
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel], {
            permissionDebounceMs: 1,
            readyCooldownMs: 20
        })

        const completedSession = createSession({ id: 'session-completed', active: false })
        const terminatedSession = createSession({ id: 'session-terminated', active: false })
        engine.setSession(completedSession)
        engine.setSession(terminatedSession)

        engine.emit({
            type: 'session-ended',
            sessionId: completedSession.id,
            reason: 'completed' satisfies SessionEndReason
        })
        engine.emit({
            type: 'session-ended',
            sessionId: terminatedSession.id,
            reason: 'terminated' satisfies SessionEndReason
        })
        await sleep(5)

        expect(channel.sessionCompletions).toHaveLength(1)
        expect(channel.sessionCompletions[0]?.id).toBe(completedSession.id)

        hub.stop()
    })

    it('fires model-error notification when lastModelError.atTs advances', async () => {
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel])

        const session = createSession({
            metadata: {
                lastModelError: {
                    kind: 'quota_exhausted',
                    transient: false,
                    rawSnippet: 'Error: T: [resource_exhausted] capacity exceeded',
                    atTs: 1000,
                    priorAssistantClaimsDone: true
                }
            } as Session['metadata']
        })

        engine.setSession(session)
        engine.emit({ type: 'session-updated', sessionId: session.id })
        await sleep(5)

        expect(channel.modelErrors).toHaveLength(1)
        const fired = channel.modelErrors[0]?.notification
        expect(fired?.kind).toBe('quota_exhausted')
        expect(fired?.transient).toBe(false)
        expect(fired?.priorAssistantClaimsDone).toBe(true)
        expect(fired?.atTs).toBe(1000)

        hub.stop()
    })

    it('dedupes model-error notifications across repeat session-updated events', async () => {
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel])

        const session = createSession({
            metadata: {
                lastModelError: {
                    kind: 'transport_closed',
                    transient: true,
                    rawSnippet: 'WritableIterable is closed',
                    atTs: 2000,
                    priorAssistantClaimsDone: false
                }
            } as Session['metadata']
        })

        engine.setSession(session)
        engine.emit({ type: 'session-updated', sessionId: session.id })
        engine.emit({ type: 'session-updated', sessionId: session.id })
        engine.emit({ type: 'session-updated', sessionId: session.id })
        await sleep(5)

        expect(channel.modelErrors).toHaveLength(1)

        hub.stop()
    })

    it('fires again when a NEW lastModelError replaces an older one', async () => {
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel])

        const firstSession = createSession({
            metadata: {
                lastModelError: {
                    kind: 'quota_exhausted',
                    transient: false,
                    rawSnippet: 'first',
                    atTs: 1000,
                    priorAssistantClaimsDone: false
                }
            } as Session['metadata']
        })
        engine.setSession(firstSession)
        engine.emit({ type: 'session-updated', sessionId: firstSession.id })
        await sleep(5)
        expect(channel.modelErrors).toHaveLength(1)

        const secondSession = createSession({
            metadata: {
                lastModelError: {
                    kind: 'transport_closed',
                    transient: true,
                    rawSnippet: 'second',
                    atTs: 2000,
                    priorAssistantClaimsDone: false
                }
            } as Session['metadata']
        })
        engine.setSession(secondSession)
        engine.emit({ type: 'session-updated', sessionId: secondSession.id })
        await sleep(5)

        expect(channel.modelErrors).toHaveLength(2)
        expect(channel.modelErrors[1]?.notification.atTs).toBe(2000)

        hub.stop()
    })

    it('rehydrates undelivered model-error for inactive sessions on hub construct', async () => {
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const session = createSession({
            active: false,
            metadata: {
                lastModelError: {
                    kind: 'quota_exhausted',
                    transient: false,
                    rawSnippet: 'Error: T: [resource_exhausted]',
                    atTs: 4500,
                    priorAssistantClaimsDone: true
                }
            } as Session['metadata']
        })
        // Seed before hub exists — mirrors SyncEngine.reloadAll() before
        // NotificationHub is constructed in startHub.
        engine.setSession(session)

        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel])
        await sleep(10)

        expect(channel.modelErrors).toHaveLength(1)
        expect(channel.modelErrors[0]?.notification.atTs).toBe(4500)
        expect(engine.modelErrorNotifiedMarks).toEqual([{ sessionId: session.id, atTs: 4500 }])
        hub.stop()
    })

    it('persists notifiedAt after successful delivery and skips after hub restart', async () => {
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel])

        const session = createSession({
            metadata: {
                lastModelError: {
                    kind: 'quota_exhausted',
                    transient: false,
                    rawSnippet: 'Error: T: [resource_exhausted]',
                    atTs: 4000,
                    priorAssistantClaimsDone: false
                }
            } as Session['metadata']
        })
        engine.setSession(session)
        engine.emit({ type: 'session-updated', sessionId: session.id })
        await sleep(10)

        expect(channel.modelErrors).toHaveLength(1)
        expect(engine.modelErrorNotifiedMarks).toEqual([{ sessionId: session.id, atTs: 4000 }])
        expect(engine.getSession(session.id)?.metadata?.lastModelError?.notifiedAt).toEqual(
            expect.any(Number)
        )
        hub.stop()

        // Fresh hub = lost in-memory watermark; durable notifiedAt must gate.
        const channel2 = new StubChannel()
        const hub2 = new NotificationHub(engine as unknown as SyncEngine, [channel2])
        engine.emit({ type: 'session-updated', sessionId: session.id })
        await sleep(10)
        expect(channel2.modelErrors).toHaveLength(0)
        hub2.stop()
    })

    it('does not fire model-error for already-acknowledged errors', async () => {
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel])

        const session = createSession({
            metadata: {
                lastModelError: {
                    kind: 'quota_exhausted',
                    transient: false,
                    rawSnippet: 'first',
                    atTs: 1000,
                    priorAssistantClaimsDone: false,
                    acknowledgedAt: 1500
                }
            } as Session['metadata']
        })
        engine.setSession(session)
        engine.emit({ type: 'session-updated', sessionId: session.id })
        await sleep(5)

        expect(channel.modelErrors).toHaveLength(0)

        hub.stop()
    })

    it('skips model-error dispatch when no channels implement it', async () => {
        const engine = new FakeSyncEngine()
        // Channel WITHOUT sendModelError -- should silently skip, no throw.
        const minimalChannel: NotificationChannel = {
            async sendReady() {},
            async sendPermissionRequest() {},
            async sendTaskNotification() {}
        }
        const hub = new NotificationHub(engine as unknown as SyncEngine, [minimalChannel])

        const session = createSession({
            metadata: {
                lastModelError: {
                    kind: 'quota_exhausted',
                    transient: false,
                    rawSnippet: 'no-channel',
                    atTs: 3000,
                    priorAssistantClaimsDone: false
                }
            } as Session['metadata']
        })
        engine.setSession(session)
        engine.emit({ type: 'session-updated', sessionId: session.id })
        await sleep(5)

        // No assertions other than "didn't throw"; the channel has no
        // recording surface. Test passes if hub.stop() returns cleanly.
        hub.stop()
    })

    it('shares nativeGate across model-error channels so later channels can defer', async () => {
        const engine = new FakeSyncEngine()
        const fcmCalls: ModelErrorNotification[] = []
        const pushCalls: ModelErrorNotification[] = []

        const fcmChannel: NotificationChannel = {
            async sendReady() {},
            async sendPermissionRequest() {},
            async sendTaskNotification() {},
            async sendModelError(_session, notification, ctx) {
                fcmCalls.push(notification)
                if (ctx?.nativeGate) {
                    ctx.nativeGate.sent = true
                }
                return 'delivered'
            }
        }
        const pushChannel: NotificationChannel = {
            async sendReady() {},
            async sendPermissionRequest() {},
            async sendTaskNotification() {},
            async sendModelError(_session, notification, ctx) {
                if (ctx?.nativeGate?.sent) {
                    return 'unavailable'
                }
                pushCalls.push(notification)
                return 'delivered'
            }
        }

        const hub = new NotificationHub(engine as unknown as SyncEngine, [fcmChannel, pushChannel])
        const session = createSession({
            metadata: {
                lastModelError: {
                    kind: 'quota_exhausted',
                    transient: false,
                    rawSnippet: 'gate-test',
                    atTs: 4000,
                    priorAssistantClaimsDone: false
                }
            } as Session['metadata']
        })
        engine.setSession(session)
        engine.emit({ type: 'session-updated', sessionId: session.id })
        await sleep(5)

        expect(fcmCalls).toHaveLength(1)
        expect(pushCalls).toHaveLength(0)

        hub.stop()
    })

    it('falls back to later model-error channels when native gate stays unset', async () => {
        const engine = new FakeSyncEngine()
        const pushCalls: ModelErrorNotification[] = []

        const fcmChannel: NotificationChannel = {
            async sendReady() {},
            async sendPermissionRequest() {},
            async sendTaskNotification() {},
            async sendModelError() {
                // Delivered zero - leave nativeGate.sent false
                return 'failed'
            }
        }
        const pushChannel: NotificationChannel = {
            async sendReady() {},
            async sendPermissionRequest() {},
            async sendTaskNotification() {},
            async sendModelError(_session, notification, ctx) {
                if (ctx?.nativeGate?.sent) {
                    return 'unavailable'
                }
                pushCalls.push(notification)
                return 'delivered'
            }
        }

        const hub = new NotificationHub(engine as unknown as SyncEngine, [fcmChannel, pushChannel])
        const session = createSession({
            metadata: {
                lastModelError: {
                    kind: 'rate_limited',
                    transient: true,
                    rawSnippet: 'fallback-test',
                    atTs: 5000,
                    priorAssistantClaimsDone: false
                }
            } as Session['metadata']
        })
        engine.setSession(session)
        engine.emit({ type: 'session-updated', sessionId: session.id })
        await sleep(5)

        expect(pushCalls).toHaveLength(1)
        expect(pushCalls[0]?.atTs).toBe(5000)

        hub.stop()
    })

    it('schedules bounded backoff retry when every channel throws (keeps watermark)', async () => {
        const engine = new FakeSyncEngine()
        let attempts = 0
        const channel: NotificationChannel = {
            async sendReady() {},
            async sendPermissionRequest() {},
            async sendTaskNotification() {},
            async sendModelError() {
                attempts++
                throw new Error('transient outage')
            }
        }
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel], {
            modelErrorRetryDelaysMs: [25]
        })
        const session = createSession({
            metadata: {
                lastModelError: {
                    kind: 'quota_exhausted',
                    transient: false,
                    rawSnippet: 'retry-me',
                    atTs: 6000,
                    priorAssistantClaimsDone: false
                }
            } as Session['metadata']
        })
        engine.setSession(session)
        engine.emit({ type: 'session-updated', sessionId: session.id })
        await sleep(10)
        expect(attempts).toBe(1)

        // Keepalive session-updated must NOT storm - watermark stays.
        engine.emit({ type: 'session-updated', sessionId: session.id })
        await sleep(5)
        expect(attempts).toBe(1)

        // Backoff timer fires the retry.
        await sleep(35)
        expect(attempts).toBe(2)

        hub.stop()
    })

    it('schedules backoff retry when channels resolve with failed (zero deliveries)', async () => {
        const engine = new FakeSyncEngine()
        let attempts = 0
        const channel: NotificationChannel = {
            async sendReady() {},
            async sendPermissionRequest() {},
            async sendTaskNotification() {},
            async sendModelError() {
                attempts++
                return 'failed'
            }
        }
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel], {
            modelErrorRetryDelaysMs: [15]
        })
        const session = createSession({
            metadata: {
                lastModelError: {
                    kind: 'quota_exhausted',
                    transient: false,
                    rawSnippet: 'zero-sent',
                    atTs: 6500,
                    priorAssistantClaimsDone: false
                }
            } as Session['metadata']
        })
        engine.setSession(session)
        engine.emit({ type: 'session-updated', sessionId: session.id })
        await sleep(5)
        expect(attempts).toBe(1)

        engine.emit({ type: 'session-updated', sessionId: session.id })
        await sleep(5)
        expect(attempts).toBe(1)

        await sleep(25)
        expect(attempts).toBe(2)

        hub.stop()
    })

    it('retries model-error for inactive sessions via backoff timer', async () => {
        const engine = new FakeSyncEngine()
        let attempts = 0
        const channel: NotificationChannel = {
            async sendReady() {},
            async sendPermissionRequest() {},
            async sendTaskNotification() {},
            async sendModelError(session) {
                attempts++
                // Production channels used to return unavailable when !active —
                // that marked retries "completed" and dropped the ping.
                if (attempts === 1) {
                    expect(session.active).toBe(true)
                    return 'failed'
                }
                expect(session.active).toBe(false)
                return 'delivered'
            }
        }
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel], {
            modelErrorRetryDelaysMs: [20]
        })
        const session = createSession({
            metadata: {
                lastModelError: {
                    kind: 'rate_limited',
                    transient: true,
                    rawSnippet: 'status 429',
                    atTs: 6600,
                    priorAssistantClaimsDone: false
                }
            } as Session['metadata']
        })
        engine.setSession(session)
        engine.emit({ type: 'session-updated', sessionId: session.id })
        await sleep(5)
        expect(attempts).toBe(1)

        // Go inactive before the retry - timer must still fire AND deliver.
        engine.setSession({ ...session, active: false })
        engine.emit({ type: 'session-updated', sessionId: session.id })
        await sleep(30)
        expect(attempts).toBe(2)

        hub.stop()
    })

    it('does not let an obsolete retry schedule over a newer atTs', async () => {
        const engine = new FakeSyncEngine()
        const outcomes: number[] = []
        const channel: NotificationChannel = {
            async sendReady() {},
            async sendPermissionRequest() {},
            async sendTaskNotification() {},
            async sendModelError(_session, notification) {
                outcomes.push(notification.atTs)
                // First error always fails; second succeeds.
                return notification.atTs === 7000 ? 'failed' : 'delivered'
            }
        }
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel], {
            modelErrorRetryDelaysMs: [40]
        })

        const first = createSession({
            id: 'session-1',
            metadata: {
                lastModelError: {
                    kind: 'canceled',
                    transient: true,
                    rawSnippet: 'first',
                    atTs: 7000,
                    priorAssistantClaimsDone: false
                }
            } as Session['metadata']
        })
        engine.setSession(first)
        engine.emit({ type: 'session-updated', sessionId: first.id })
        await sleep(5)
        expect(outcomes).toEqual([7000])

        // Newer error arrives while first retry is pending.
        const second = {
            ...first,
            metadata: {
                lastModelError: {
                    kind: 'quota_exhausted',
                    transient: false,
                    rawSnippet: 'second',
                    atTs: 8000,
                    priorAssistantClaimsDone: false
                }
            } as Session['metadata']
        }
        engine.setSession(second)
        engine.emit({ type: 'session-updated', sessionId: second.id })
        await sleep(5)
        expect(outcomes).toEqual([7000, 8000])

        // Obsolete timer for 7000 must not steal / block retries for 8000.
        // Force 8000 to fail once so it needs its own retry, then wait.
        // (8000 already delivered above — verify stale timer is a no-op.)
        await sleep(50)
        expect(outcomes.filter((ts) => ts === 7000)).toHaveLength(1)
        expect(outcomes.filter((ts) => ts === 8000)).toHaveLength(1)

        hub.stop()
    })

    it('does not re-fire model-error after inactive/resume for the same atTs', async () => {
        const engine = new FakeSyncEngine()
        const channel = new StubChannel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel])
        const session = createSession({
            metadata: {
                lastModelError: {
                    kind: 'rate_limited',
                    transient: true,
                    rawSnippet: 'status 429',
                    atTs: 7000,
                    priorAssistantClaimsDone: false
                }
            } as Session['metadata']
        })
        engine.setSession(session)
        engine.emit({ type: 'session-updated', sessionId: session.id })
        await sleep(10)
        expect(channel.modelErrors).toHaveLength(1)

        // Become inactive (clears timers but keeps watermark).
        engine.setSession({ ...session, active: false })
        engine.emit({ type: 'session-updated', sessionId: session.id })
        await sleep(5)

        // Resume with same unacknowledged atTs - must not re-ping.
        engine.setSession({ ...session, active: true })
        engine.emit({ type: 'session-updated', sessionId: session.id })
        await sleep(10)
        expect(channel.modelErrors).toHaveLength(1)

        hub.stop()
    })
})
