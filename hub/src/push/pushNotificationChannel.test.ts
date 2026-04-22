import { describe, expect, it } from 'bun:test'
import { PushNotificationChannel } from './pushNotificationChannel'
import type { PushPayload, PushService } from './pushService'
import type { Session } from '../sync/syncEngine'
import type { SSEManager } from '../sse/sseManager'
import type { VisibilityTracker } from '../visibility/visibilityTracker'

type ToastEvent = {
    type: 'toast'
    data: {
        title: string
        body: string
        sessionId: string
        url: string
    }
}

class FakePushService {
    readonly sent: Array<{ namespace: string; payload: PushPayload }> = []

    async sendToNamespace(namespace: string, payload: PushPayload): Promise<void> {
        this.sent.push({ namespace, payload })
    }
}

class FakeSSEManager {
    readonly toasts: Array<{ namespace: string; event: ToastEvent }> = []
    delivered = 0

    async sendToast(namespace: string, event: ToastEvent): Promise<number> {
        this.toasts.push({ namespace, event })
        return this.delivered
    }
}

class FakeVisibilityTracker {
    visible = false

    hasVisibleConnection(_namespace: string): boolean {
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
        metadata: { path: '/repo', host: 'mac', summary: { text: 'Build UI', updatedAt: 1 } },
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

function createChannel() {
    const push = new FakePushService()
    const sse = new FakeSSEManager()
    const visibility = new FakeVisibilityTracker()
    const channel = new PushNotificationChannel(
        push as unknown as PushService,
        sse as unknown as SSEManager,
        visibility as unknown as VisibilityTracker,
        ''
    )
    return { channel, push, sse, visibility }
}

describe('PushNotificationChannel', () => {
    it('sends foreground toast and skips Web Push when visible toast is delivered', async () => {
        const { channel, push, sse, visibility } = createChannel()
        visibility.visible = true
        sse.delivered = 1

        await channel.sendReady(createSession())

        expect(sse.toasts).toHaveLength(1)
        expect(sse.toasts[0]?.event.data.title).toBe('Ready for input')
        expect(push.sent).toHaveLength(0)
    })

    it('falls back to Web Push when there is no visible delivered toast', async () => {
        const { channel, push, sse, visibility } = createChannel()
        visibility.visible = true
        sse.delivered = 0

        await channel.sendReady(createSession())

        expect(sse.toasts).toHaveLength(1)
        expect(push.sent).toHaveLength(1)
        expect(push.sent[0]?.payload.data?.type).toBe('ready')
    })

    it('formats attention notification payloads', async () => {
        const { channel, push } = createChannel()

        await channel.sendAttention(createSession(), 'failed')

        expect(push.sent).toHaveLength(1)
        expect(push.sent[0]?.payload).toEqual({
            title: 'Task needs attention',
            body: 'Build UI stopped or failed',
            tag: 'attention-session-1',
            data: {
                type: 'attention',
                sessionId: 'session-1',
                url: '/sessions/session-1'
            }
        })
    })
})
