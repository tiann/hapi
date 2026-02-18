import { describe, expect, it } from 'bun:test'
import type { Session } from '../sync/syncEngine'
import { PushNotificationChannel } from './pushNotificationChannel'
import type { PushPayload } from './pushService'

class FakePushService {
    readonly calls: Array<{ namespace: string; payload: PushPayload }> = []

    async sendToNamespace(namespace: string, payload: PushPayload): Promise<void> {
        this.calls.push({ namespace, payload })
    }
}

class FakeSSEManager {
    deliveredCount = 0
    readonly calls: Array<{ namespace: string; sessionId: string }> = []

    async sendToast(namespace: string, event: { data: { sessionId: string } }): Promise<number> {
        this.calls.push({ namespace, sessionId: event.data.sessionId })
        return this.deliveredCount
    }
}

class FakeVisibilityTracker {
    visible = false

    hasVisibleConnection(): boolean {
        return this.visible
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
        ...overrides
    }
}

describe('PushNotificationChannel', () => {
    it('skips push notification when local toast was delivered', async () => {
        const push = new FakePushService()
        const sse = new FakeSSEManager()
        const visibility = new FakeVisibilityTracker()
        visibility.visible = true
        sse.deliveredCount = 1

        const channel = new PushNotificationChannel(
            push as never,
            sse as never,
            visibility as never,
            'https://example.test'
        )

        await channel.sendReady(createSession())

        expect(sse.calls).toHaveLength(1)
        expect(push.calls).toHaveLength(0)
    })

    it('falls back to push when local toast was not delivered', async () => {
        const push = new FakePushService()
        const sse = new FakeSSEManager()
        const visibility = new FakeVisibilityTracker()
        visibility.visible = true
        sse.deliveredCount = 0

        const channel = new PushNotificationChannel(
            push as never,
            sse as never,
            visibility as never,
            'https://example.test'
        )

        await channel.sendPermissionRequest(createSession())

        expect(sse.calls).toHaveLength(1)
        expect(push.calls).toHaveLength(1)
    })
})
