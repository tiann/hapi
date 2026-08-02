import { describe, expect, it, spyOn } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'
import { NotificationHub } from '../notifications/notificationHub'
import type { SyncEngine, Session } from './syncEngine'
import type {
    ModelErrorNotification,
    ModelErrorSendOutcome,
    NotificationChannel
} from '../notifications/notificationTypes'

function createCapturingPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('SessionCache.markModelErrorNotified', () => {
    it('retries version-mismatch then persists notifiedAt so a fresh hub does not redeliver', async () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, createCapturingPublisher([]))
        const atTs = 9_001
        const session = cache.getOrCreateSession(
            'model-error-notified-retry',
            {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'cursor',
                lastModelError: {
                    kind: 'quota_exhausted',
                    transient: false,
                    rawSnippet: 'Error: T: [resource_exhausted]',
                    atTs,
                    priorAssistantClaimsDone: false
                }
            },
            null,
            'default'
        )

        let calls = 0
        const original = store.sessions.updateSessionMetadata.bind(store.sessions)
        spyOn(store.sessions, 'updateSessionMetadata').mockImplementation((...args) => {
            calls += 1
            if (calls === 1) {
                return {
                    result: 'version-mismatch' as const,
                    version: session.metadataVersion,
                    value: session.metadata
                }
            }
            return original(...args)
        })

        await cache.markModelErrorNotified(session.id, atTs)

        expect(calls).toBeGreaterThanOrEqual(2)
        const refreshed = cache.getSession(session.id)
        expect(refreshed?.metadata?.lastModelError?.notifiedAt).toEqual(expect.any(Number))
        expect(refreshed?.metadata?.lastModelError?.atTs).toBe(atTs)

        class Channel implements NotificationChannel {
            readonly modelErrors: ModelErrorNotification[] = []
            async sendReady() {}
            async sendPermissionRequest() {}
            async sendTaskNotification() {}
            async sendSessionCompletion() {}
            async sendModelError(
                _session: Session,
                notification: ModelErrorNotification
            ): Promise<ModelErrorSendOutcome> {
                this.modelErrors.push(notification)
                return 'delivered'
            }
        }

        const engine = {
            listeners: new Set<(e: { type: string; sessionId: string }) => void>(),
            getSession: (id: string) => cache.getSession(id),
            subscribe(listener: (e: { type: string; sessionId: string }) => void) {
                this.listeners.add(listener)
                return () => this.listeners.delete(listener)
            },
            async markModelErrorNotified() {},
            emit(sessionId: string) {
                for (const listener of this.listeners) {
                    listener({ type: 'session-updated', sessionId })
                }
            }
        }
        const channel = new Channel()
        const hub = new NotificationHub(engine as unknown as SyncEngine, [channel])
        engine.emit(session.id)
        await sleep(10)
        expect(channel.modelErrors).toHaveLength(0)
        hub.stop()
    })
})
