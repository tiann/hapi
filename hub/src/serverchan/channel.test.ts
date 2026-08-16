import { describe, expect, it, mock } from 'bun:test'
import type { SessionEndReason } from '@hapi/protocol'
import type { Session } from '../sync/syncEngine'
import { VisibilityTracker } from '../visibility/visibilityTracker'
import { ServerChanChannel } from './channel'

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

describe('ServerChanChannel', () => {
    it('does not send completed task notifications', async () => {
        const fetchMock = mock(async () => new Response('ok', { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const channel = new ServerChanChannel('SCT_TEST', 'https://hapi.example.com')
            await channel.sendTaskNotification(createSession(), {
                status: 'completed',
                summary: 'Subtask finished'
            })

            expect(fetchMock).not.toHaveBeenCalled()
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('sends failed task notifications', async () => {
        const fetchMock = mock(async () => new Response('ok', { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const channel = new ServerChanChannel('SCT_TEST', 'https://hapi.example.com')
            await channel.sendTaskNotification(createSession(), {
                status: 'failed',
                summary: 'Subtask failed'
            })

            expect(fetchMock).toHaveBeenCalledTimes(1)
            const call = fetchMock.mock.calls[0] as unknown[] | undefined
            const url = call?.[0]
            const init = call?.[1] as RequestInit | undefined
            expect(String(url)).toContain('https://sctapi.ftqq.com/SCT_TEST.send')
            expect((init?.body as URLSearchParams).get('title')).toBe('HAPI Task failed')
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('sends session completion notifications', async () => {
        const fetchMock = mock(async () => new Response('ok', { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const channel = new ServerChanChannel('SCT_TEST', 'https://hapi.example.com')
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
            const url = call?.[0]
            const init = call?.[1] as RequestInit | undefined
            expect(String(url)).toContain('https://sctapi.ftqq.com/SCT_TEST.send')
            expect((init?.body as URLSearchParams).get('title')).toBe('HAPI Session completed')
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('suppresses every notification when the namespace has a visible connection', async () => {
        const fetchMock = mock(async () => new Response('ok', { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const visibilityTracker = new VisibilityTracker()
            visibilityTracker.registerConnection('visible-1', 'default', 'visible')
            const channel = new ServerChanChannel(
                'SCT_TEST',
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
            const channel = new ServerChanChannel(
                'SCT_TEST',
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

    it('sends when the namespace has no visible connection', async () => {
        const fetchMock = mock(async () => new Response('ok', { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const visibilityTracker = new VisibilityTracker()
            visibilityTracker.registerConnection('hidden-1', 'default', 'hidden')
            const channel = new ServerChanChannel(
                'SCT_TEST',
                'https://hapi.example.com',
                visibilityTracker,
                true
            )

            await channel.sendReady(createSession())

            expect(fetchMock).toHaveBeenCalledTimes(1)
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('only considers visible connections in the same namespace', async () => {
        const fetchMock = mock(async () => new Response('ok', { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const visibilityTracker = new VisibilityTracker()
            visibilityTracker.registerConnection('visible-1', 'other-namespace', 'visible')
            const channel = new ServerChanChannel(
                'SCT_TEST',
                'https://hapi.example.com',
                visibilityTracker,
                true
            )

            await channel.sendReady(createSession())

            expect(fetchMock).toHaveBeenCalledTimes(1)
        } finally {
            globalThis.fetch = originalFetch
        }
    })
})
