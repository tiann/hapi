import { describe, expect, it } from 'bun:test'
import { SSEManager } from './sseManager'
import type { SyncEvent } from '../sync/syncEngine'
import { VisibilityTracker } from '../visibility/visibilityTracker'

describe('SSEManager namespace filtering', () => {
    it('routes events to matching namespace', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const receivedAlpha: SyncEvent[] = []
        const receivedBeta: SyncEvent[] = []

        manager.subscribe({
            id: 'alpha',
            namespace: 'alpha',
            all: true,
            send: (event) => {
                receivedAlpha.push(event)
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'beta',
            namespace: 'beta',
            all: true,
            send: (event) => {
                receivedBeta.push(event)
            },
            sendHeartbeat: () => {}
        })

        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'alpha' })

        expect(receivedAlpha).toHaveLength(1)
        expect(receivedBeta).toHaveLength(0)
    })

    it('broadcasts connection-changed to all namespaces', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const received: Array<{ id: string; event: SyncEvent }> = []

        manager.subscribe({
            id: 'alpha',
            namespace: 'alpha',
            all: true,
            send: (event) => {
                received.push({ id: 'alpha', event })
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'beta',
            namespace: 'beta',
            all: true,
            send: (event) => {
                received.push({ id: 'beta', event })
            },
            sendHeartbeat: () => {}
        })

        manager.broadcast({ type: 'connection-changed', data: { status: 'connected' } })

        expect(received).toHaveLength(2)
        expect(received.map((entry) => entry.id).sort()).toEqual(['alpha', 'beta'])
    })

    it('sends toast only to visible connections in a namespace', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const received: Array<{ id: string; event: SyncEvent }> = []

        manager.subscribe({
            id: 'visible',
            namespace: 'alpha',
            all: true,
            visibility: 'visible',
            send: (event) => {
                received.push({ id: 'visible', event })
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'hidden',
            namespace: 'alpha',
            all: true,
            visibility: 'hidden',
            send: (event) => {
                received.push({ id: 'hidden', event })
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'other',
            namespace: 'beta',
            all: true,
            visibility: 'visible',
            send: (event) => {
                received.push({ id: 'other', event })
            },
            sendHeartbeat: () => {}
        })

        const toastEvent: Extract<SyncEvent, { type: 'toast' }> = {
            type: 'toast',
            data: {
                title: 'Test',
                body: 'Toast body',
                sessionId: 'session-1',
                url: '/sessions/session-1'
            }
        }

        const delivered = await manager.sendToast('alpha', toastEvent)

        expect(delivered).toBe(1)
        expect(received).toHaveLength(1)
        expect(received[0]?.id).toBe('visible')
    })

    it('broadcasts session sort preference updates to namespace even with session-scoped subscription', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const received: SyncEvent[] = []

        manager.subscribe({
            id: 'alpha-session',
            namespace: 'alpha',
            userId: 1,
            all: false,
            sessionId: 'session-1',
            send: (event) => {
                received.push(event)
            },
            sendHeartbeat: () => {}
        })

        manager.broadcast({
            type: 'session-sort-preference-updated',
            namespace: 'alpha',
            data: {
                userId: 1,
                version: 2
            }
        })

        expect(received).toHaveLength(1)
        expect(received[0]?.type).toBe('session-sort-preference-updated')
    })

    it('filters session sort preference updates by userId', () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const receivedUser1: SyncEvent[] = []
        const receivedUser2: SyncEvent[] = []

        manager.subscribe({
            id: 'user1-conn',
            namespace: 'alpha',
            userId: 1,
            all: true,
            send: (event) => {
                receivedUser1.push(event)
            },
            sendHeartbeat: () => {}
        })

        manager.subscribe({
            id: 'user2-conn',
            namespace: 'alpha',
            userId: 2,
            all: true,
            send: (event) => {
                receivedUser2.push(event)
            },
            sendHeartbeat: () => {}
        })

        manager.broadcast({
            type: 'session-sort-preference-updated',
            namespace: 'alpha',
            data: {
                userId: 1,
                version: 3
            }
        })

        expect(receivedUser1).toHaveLength(1)
        expect(receivedUser2).toHaveLength(0)
    })
})
