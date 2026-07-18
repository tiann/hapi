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

    it('rejects subscriptions over the per-namespace connection cap', () => {
        const manager = new SSEManager(0, new VisibilityTracker(), 1)

        const first = manager.subscribe({
            id: 'first',
            namespace: 'alpha',
            all: true,
            visibility: 'visible',
            send: () => {},
            sendHeartbeat: () => {}
        })
        const second = manager.subscribe({
            id: 'second',
            namespace: 'alpha',
            all: true,
            visibility: 'visible',
            send: () => {},
            sendHeartbeat: () => {}
        })

        expect(first).not.toBeNull()
        expect(second).toBeNull()
    })

    it('allows many browser tabs by default before hitting the namespace cap', () => {
        const manager = new SSEManager(0, new VisibilityTracker())

        const subscriptions = Array.from({ length: 64 }, (_, index) => manager.subscribe({
            id: `tab-${index}`,
            namespace: 'alpha',
            all: true,
            send: () => {},
            sendHeartbeat: () => {}
        }))

        expect(subscriptions.every((subscription) => subscription !== null)).toBe(true)
    })

    it('evicts an old hidden connection before rejecting a visible subscription at the cap', () => {
        const visibilityTracker = new VisibilityTracker()
        const manager = new SSEManager(0, visibilityTracker, 2)

        const hidden = manager.subscribe({
            id: 'hidden',
            namespace: 'alpha',
            all: true,
            visibility: 'hidden',
            send: () => {},
            sendHeartbeat: () => {}
        })
        const visible = manager.subscribe({
            id: 'visible',
            namespace: 'alpha',
            all: true,
            visibility: 'visible',
            send: () => {},
            sendHeartbeat: () => {}
        })
        const newcomer = manager.subscribe({
            id: 'new-visible',
            namespace: 'alpha',
            all: true,
            visibility: 'visible',
            send: () => {},
            sendHeartbeat: () => {}
        })

        expect(hidden).not.toBeNull()
        expect(visible).not.toBeNull()
        expect(newcomer).not.toBeNull()
        expect(visibilityTracker.isVisibleConnection('visible')).toBe(true)
        expect(visibilityTracker.isVisibleConnection('new-visible')).toBe(true)
        expect(visibilityTracker.isVisibleConnection('hidden')).toBe(false)
    })
})
