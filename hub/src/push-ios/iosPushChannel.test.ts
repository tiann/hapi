import { describe, expect, it } from 'bun:test'

import type { Session } from '../sync/syncEngine'
import type { NotificationSendContext } from '../notifications/notificationSendContext'
import { IosPushNotificationChannel } from './iosPushChannel'
import type { IosPushNotificationPayload, IosPushSendResult } from './iosPushService'

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        name: 'Demo',
        active: true,
        metadata: { flavor: 'codex', name: 'Demo' },
        ...overrides
    } as Session
}

type FakeService = {
    calls: Array<{ namespace: string; payload: IosPushNotificationPayload }>
}

function makeChannel(result: IosPushSendResult): { channel: IosPushNotificationChannel; service: FakeService } {
    const service: FakeService = { calls: [] }
    const channel = new IosPushNotificationChannel({
        sendToNamespace: async (namespace: string, payload: IosPushNotificationPayload) => {
            service.calls.push({ namespace, payload })
            return result
        }
    } as never)
    return { channel, service }
}

describe('IosPushNotificationChannel', () => {
    it('fires unconditionally and sets the nativeGate when a send succeeds', async () => {
        const { channel, service } = makeChannel({ sent: 1, failed: 0, invalidTokens: [] })
        const ctx: NotificationSendContext = { nativeGate: { sent: false } }

        await channel.sendReady(createSession(), ctx)

        expect(service.calls).toHaveLength(1)
        expect(service.calls[0].namespace).toBe('default')
        expect(ctx.nativeGate?.sent).toBe(true)
    })

    it('leaves the nativeGate untouched when nothing was delivered (no devices / all failed)', async () => {
        const { channel } = makeChannel({ sent: 0, failed: 0, invalidTokens: [] })
        const ctx: NotificationSendContext = { nativeGate: { sent: false } }

        await channel.sendReady(createSession(), ctx)

        // Web-push must still fire for this namespace.
        expect(ctx.nativeGate?.sent).toBe(false)
    })

    it('does not clear a gate another native channel already set', async () => {
        const { channel } = makeChannel({ sent: 0, failed: 1, invalidTokens: [] })
        const ctx: NotificationSendContext = { nativeGate: { sent: true } }

        await channel.sendReady(createSession(), ctx)

        expect(ctx.nativeGate?.sent).toBe(true)
    })

    it('skips inactive sessions entirely', async () => {
        const { channel, service } = makeChannel({ sent: 1, failed: 0, invalidTokens: [] })

        await channel.sendReady(createSession({ active: false }))
        await channel.sendPermissionRequest(createSession({ active: false }))
        await channel.sendTaskNotification(createSession({ active: false }), { summary: 'done' })

        expect(service.calls).toHaveLength(0)
    })

    it('builds the FCM-contract plaintext for ready notifications', async () => {
        const { channel, service } = makeChannel({ sent: 1, failed: 0, invalidTokens: [] })

        await channel.sendReady(createSession())

        const payload = service.calls[0].payload
        expect(payload.type).toBe('ready')
        expect(payload.sessionId).toBe('session-1')
        expect(payload.url).toBe('/sessions/session-1')
        expect(payload.contractVersion).toBe('1')
        expect(payload.severity).toBe('info')
        expect(payload.title).toBe('Ready for input')
        expect(payload.body.length).toBeGreaterThan(0)
    })

    it('includes requestId and warning severity on permission requests', async () => {
        const { channel, service } = makeChannel({ sent: 1, failed: 0, invalidTokens: [] })

        await channel.sendPermissionRequest(createSession({
            agentState: {
                requests: {
                    'req-42': { tool: 'Bash', arguments: { command: 'ls' } }
                }
            }
        } as Partial<Session>))

        const payload = service.calls[0].payload
        expect(payload.type).toBe('permission-request')
        expect(payload.requestId).toBe('req-42')
        expect(payload.severity).toBe('warning')
        expect(payload.body).toContain('Bash')
    })

    it('maps task failure status to error severity', async () => {
        const { channel, service } = makeChannel({ sent: 1, failed: 0, invalidTokens: [] })

        await channel.sendTaskNotification(createSession(), { summary: 'exploded', status: 'failed' })

        const payload = service.calls[0].payload
        expect(payload.type).toBe('task-notification')
        expect(payload.severity).toBe('error')
        expect(payload.title).toBe('Task failed')
        expect(payload.body).toContain('exploded')
    })
})
