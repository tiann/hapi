import { describe, expect, it } from 'bun:test'
import type { Session } from '../sync/syncEngine'
import { PushNotificationChannel } from './pushNotificationChannel'
import type { PushPayload } from './pushService'

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-toast',
        namespace: 'default',
        name: 'Demo session',
        active: true,
        metadata: { flavor: 'codex' },
        ...overrides
    } as Session
}

describe('PushNotificationChannel', () => {
    it('sends ready notifications to visible web clients before falling back to push', async () => {
        const pushed: Array<{ namespace: string; payload: PushPayload }> = []
        const toasts: unknown[] = []
        const channel = new PushNotificationChannel(
            {
                sendToNamespace: async (namespace: string, payload: PushPayload) => {
                    pushed.push({ namespace, payload })
                }
            } as never,
            {
                sendToast: async (_namespace: string, event: unknown) => {
                    toasts.push(event)
                    return 1
                }
            } as never,
            {
                hasVisibleConnection: () => true
            } as never,
            ''
        )

        await channel.sendReady(createSession())

        expect(toasts).toHaveLength(1)
        expect(pushed).toHaveLength(0)
    })

    it('skips web-push when native FCM delivered in the same dispatch', async () => {
        const pushed: Array<{ namespace: string; payload: PushPayload }> = []
        const channel = new PushNotificationChannel(
            {
                sendToNamespace: async (namespace: string, payload: PushPayload) => {
                    pushed.push({ namespace, payload })
                }
            } as never,
            {
                sendToast: async () => 0
            } as never,
            {
                hasVisibleConnection: () => false
            } as never,
            ''
        )

        const ctx = { nativeGate: { sent: true } }

        await channel.sendPermissionRequest(createSession({
            agentState: {
                requests: { 'req-1': { tool: 'Bash', arguments: {} } }
            }
        }), ctx)
        await channel.sendReady(createSession(), ctx)

        expect(pushed).toHaveLength(0)
    })

    it('falls back to web-push when native gate is unset (FCM failed or absent)', async () => {
        const pushed: Array<{ namespace: string; payload: PushPayload }> = []
        const channel = new PushNotificationChannel(
            {
                sendToNamespace: async (namespace: string, payload: PushPayload) => {
                    pushed.push({ namespace, payload })
                }
            } as never,
            {
                sendToast: async () => 0
            } as never,
            {
                hasVisibleConnection: () => false
            } as never,
            ''
        )

        await channel.sendReady(createSession(), { nativeGate: { sent: false } })

        expect(pushed).toHaveLength(1)
    })

    it('still sends web-push when no native gate is provided', async () => {
        const pushed: Array<{ namespace: string; payload: PushPayload }> = []
        const channel = new PushNotificationChannel(
            {
                sendToNamespace: async (namespace: string, payload: PushPayload) => {
                    pushed.push({ namespace, payload })
                }
            } as never,
            {
                sendToast: async () => 0
            } as never,
            {
                hasVisibleConnection: () => false
            } as never,
            ''
        )

        await channel.sendReady(createSession())

        expect(pushed).toHaveLength(1)
    })

    it('also skips SSE in-page toast when native gate reports delivery', async () => {
        const pushed: Array<{ namespace: string; payload: PushPayload }> = []
        const toasts: unknown[] = []
        const channel = new PushNotificationChannel(
            {
                sendToNamespace: async (namespace: string, payload: PushPayload) => {
                    pushed.push({ namespace, payload })
                }
            } as never,
            {
                sendToast: async (_namespace: string, event: unknown) => {
                    toasts.push(event)
                    return 99
                }
            } as never,
            {
                hasVisibleConnection: () => true
            } as never,
            ''
        )

        const ctx = { nativeGate: { sent: true } }

        await channel.sendReady(createSession(), ctx)
        await channel.sendPermissionRequest(createSession({
            agentState: { requests: { 'r-1': { tool: 'Bash', arguments: {} } } }
        }), ctx)

        // Even when the PWA is foreground/visible, the operator asked to mute
        // it - the in-page React toast and the OS web-push are both dropped
        // when an FCM companion is on the wrist.
        expect(toasts).toHaveLength(0)
        expect(pushed).toHaveLength(0)
    })
})
