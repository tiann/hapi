import { describe, expect, it, mock } from 'bun:test'
import type { SessionEndReason } from '@hapi/protocol'
import type { Session } from '../sync/syncEngine'
import { VisibilityTracker } from '../visibility/visibilityTracker'
import { WebhookChannel } from './channel'

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: {
            path: 'F:\\develop\\code\\usdt',
            host: 'DESKTOP'
        },
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

describe('WebhookChannel', () => {
    it('does not send completed task notifications', async () => {
        const fetchMock = mock(async () => new Response('ok', { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const channel = new WebhookChannel('https://example.com/hook', null, 'https://hapi.example.com')
            await channel.sendTaskNotification(createSession(), {
                status: 'completed',
                summary: 'Subtask finished'
            })

            expect(fetchMock).not.toHaveBeenCalled()
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('sends failed task notifications with the configured key as a query param and header', async () => {
        const fetchMock = mock(async () => new Response('ok', { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const channel = new WebhookChannel('https://example.com/hook', 'secret-key', 'https://hapi.example.com')
            await channel.sendTaskNotification(createSession(), {
                status: 'failed',
                summary: 'Subtask failed'
            })

            expect(fetchMock).toHaveBeenCalledTimes(1)
            const call = fetchMock.mock.calls[0] as unknown[] | undefined
            const url = call?.[0] as URL
            const init = call?.[1] as RequestInit | undefined

            expect(url.toString()).toBe('https://example.com/hook?key=secret-key')
            expect((init?.headers as Record<string, string>)['x-hapi-webhook-key']).toBe('secret-key')

            const body = JSON.parse(init?.body as string)
            expect(body.event).toBe('task_failed')
            expect(body.content).toBe('Subtask failed')
            expect(body.sessionId).toBe('session-1')
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('omits the key query param and header when no key is configured', async () => {
        const fetchMock = mock(async () => new Response('ok', { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const channel = new WebhookChannel('https://example.com/hook', null, 'https://hapi.example.com')
            await channel.sendReady(createSession())

            expect(fetchMock).toHaveBeenCalledTimes(1)
            const call = fetchMock.mock.calls[0] as unknown[] | undefined
            const url = call?.[0] as URL
            const init = call?.[1] as RequestInit | undefined

            expect(url.toString()).toBe('https://example.com/hook')
            expect((init?.headers as Record<string, string>)['x-hapi-webhook-key']).toBeUndefined()
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('sends session completion notifications', async () => {
        const fetchMock = mock(async () => new Response('ok', { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const channel = new WebhookChannel('https://example.com/hook', null, 'https://hapi.example.com')
            await channel.sendSessionCompletion(createSession({
                id: 'session-complete',
                metadata: {
                    path: 'F:\\develop\\code\\usdt',
                    host: 'DESKTOP',
                    name: 'USDT review'
                }
            }), 'completed' satisfies SessionEndReason)

            expect(fetchMock).toHaveBeenCalledTimes(1)
            const call = fetchMock.mock.calls[0] as unknown[] | undefined
            const init = call?.[1] as RequestInit | undefined
            const body = JSON.parse(init?.body as string)
            expect(body.event).toBe('completed')
            expect(body.title).toContain('USDT review')
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('throws a descriptive error when the endpoint responds with a non-2xx status', async () => {
        const fetchMock = mock(async () => new Response('bad request', { status: 400, statusText: 'Bad Request' }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const channel = new WebhookChannel('https://example.com/hook', null, 'https://hapi.example.com')
            await expect(channel.sendReady(createSession())).rejects.toThrow('Webhook 发送失败: HTTP 400')
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('suppresses every notification when the namespace has a visible connection and backgroundOnly is set', async () => {
        const fetchMock = mock(async () => new Response('ok', { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const visibilityTracker = new VisibilityTracker()
            visibilityTracker.registerConnection('visible-1', 'default', 'visible')
            const channel = new WebhookChannel(
                'https://example.com/hook',
                null,
                'https://hapi.example.com',
                visibilityTracker,
                true
            )

            await channel.sendReady(createSession())
            await channel.sendPermissionRequest(createSession())
            await channel.sendTaskNotification(createSession(), {
                status: 'failed',
                summary: 'Subtask failed'
            })
            await channel.sendSessionCompletion(createSession(), 'completed' satisfies SessionEndReason)

            expect(fetchMock).not.toHaveBeenCalled()
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('keeps sending when background-only mode is disabled', async () => {
        const fetchMock = mock(async () => new Response('ok', { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const visibilityTracker = new VisibilityTracker()
            visibilityTracker.registerConnection('visible-1', 'default', 'visible')
            const channel = new WebhookChannel(
                'https://example.com/hook',
                null,
                'https://hapi.example.com',
                visibilityTracker,
                false
            )

            await channel.sendReady(createSession())

            expect(fetchMock).toHaveBeenCalledTimes(1)
        } finally {
            globalThis.fetch = originalFetch
        }
    })
})
