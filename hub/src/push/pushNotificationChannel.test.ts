import { describe, expect, it } from 'bun:test'
import type { Session } from '../sync/syncEngine'
import { PushNotificationChannel } from './pushNotificationChannel'
import type { PushPayload } from './pushService'

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-task-toast',
        namespace: 'default',
        active: true,
        metadata: { name: 'Demo task', flavor: 'codex' },
        ...overrides
    } as Session
}

describe('PushNotificationChannel', () => {
    it('sends task notifications to visible web clients before falling back to push', async () => {
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

        await channel.sendTaskNotification(createSession(), {
            status: 'completed',
            summary: 'Background work finished'
        })

        expect(toasts).toHaveLength(1)
        expect(pushed).toHaveLength(0)
    })

    it('does not reuse one replacement tag for all task notifications in a session', async () => {
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

        await channel.sendTaskNotification(createSession(), {
            status: 'completed',
            summary: 'First task'
        })
        await channel.sendTaskNotification(createSession(), {
            status: 'failed',
            summary: 'Second task'
        })

        expect(pushed).toHaveLength(2)
        expect(pushed[0].payload.tag).toBeUndefined()
        expect(pushed[1].payload.tag).toBeUndefined()
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
        await channel.sendTaskNotification(createSession(), {
            status: 'completed',
            summary: 'Done'
        }, ctx)

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

    it('applies custom copy from getCopyConfig', async () => {
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
            '',
            async () => ({
                ready: { title: 'Yo {agentName}', body: '{sessionName} is ready at {url}' }
            })
        )

        await channel.sendReady(createSession())

        expect(pushed).toHaveLength(1)
        expect(pushed[0].payload.title).toBe('Yo Codex')
        expect(pushed[0].payload.body).toBe('Demo task is ready at /sessions/session-task-toast')
    })

    it('falls back to defaults for empty template fields', async () => {
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
            '',
            async () => ({
                ready: { title: '', body: '  ' }
            })
        )

        await channel.sendReady(createSession())

        expect(pushed[0].payload.title).toBe('Ready for input')
        expect(pushed[0].payload.body).toBe('Codex is waiting in Demo task')
    })

    it('selects taskFailed vs taskCompleted copy by status', async () => {
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
            '',
            async () => ({
                taskFailed: { title: 'Oops', body: '{summary}' },
                taskCompleted: { title: 'Nice', body: '{summary}' }
            })
        )

        await channel.sendTaskNotification(createSession(), { status: 'failed', summary: 'Broke' })
        await channel.sendTaskNotification(createSession(), { status: 'completed', summary: 'Passed' })

        expect(pushed[0].payload.title).toBe('Oops')
        expect(pushed[1].payload.title).toBe('Nice')
    })

    it('delivers session completion via web push even when the session is inactive', async () => {
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
            '',
            async () => ({
                sessionCompletion: { title: '{sessionName} done', body: '{agentName} finished' }
            })
        )

        await channel.sendSessionCompletion(createSession({ active: false }), 'completed')

        expect(pushed).toHaveLength(1)
        expect(pushed[0].payload.tag).toBe('session-completion-session-task-toast')
        expect(pushed[0].payload.title).toBe('Demo task done')
        expect(pushed[0].payload.body).toBe('Codex finished')
    })

    it('still delivers with defaults when getCopyConfig throws', async () => {
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
            '',
            async () => {
                throw new Error('settings unreadable')
            }
        )

        await channel.sendReady(createSession())

        expect(pushed).toHaveLength(1)
        expect(pushed[0].payload.title).toBe('Ready for input')
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
        await channel.sendTaskNotification(createSession(), {
            status: 'completed',
            summary: 'Done'
        }, ctx)

        // Even when the PWA is foreground/visible, the operator asked to mute
        // it - the in-page React toast and the OS web-push are both dropped
        // when an FCM companion is on the wrist.
        expect(toasts).toHaveLength(0)
        expect(pushed).toHaveLength(0)
    })
})
