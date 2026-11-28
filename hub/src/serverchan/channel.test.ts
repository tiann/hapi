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

    it('sends session error notifications', async () => {
        const fetchMock = mock(async () => new Response('ok', { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const channel = new ServerChanChannel('SCT_TEST', 'https://hapi.example.com', null, false,
                new Map([['default', { sendKey: 'SCT_TEST', backgroundOnly: false }]]))
            await channel.sendSessionError(createSession({
                id: 'session-error',
                metadata: {
                    path: 'F:\\develop\\code\\usdt',
                    host: 'DESKTOP',
                    name: 'USDT review'
                }
            }), 'error' satisfies SessionEndReason)

            expect(fetchMock).toHaveBeenCalledTimes(1)
            const call = fetchMock.mock.calls[0] as unknown[] | undefined
            const init = call?.[1] as RequestInit | undefined
            expect((init?.body as URLSearchParams).get('title')).toBe('HAPI Session error')
            expect((init?.body as URLSearchParams).get('desp')).toContain('会话异常结束。')
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
                true,
                new Map([['default', { sendKey: 'SCT_TEST', backgroundOnly: true }]])
            )

            await channel.sendReady(createSession())
            await channel.sendPermissionRequest(createSession())
            await channel.sendSessionError(createSession(), 'error' satisfies SessionEndReason)
            await channel.sendSessionCompletion(createSession(), 'completed' satisfies SessionEndReason)

            expect(fetchMock).not.toHaveBeenCalled()
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('isolates session-error destinations without changing legacy completion routing', async () => {
        const fetchMock = mock(async (_url: string, _init: RequestInit) => new Response('ok'))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch
        const visibility = new VisibilityTracker()
        try {
            const channel = new ServerChanChannel('SCT_LEGACY', 'https://hapi.example.com', visibility, false, new Map([
                ['default', { sendKey: 'SCT_DEFAULT_ERROR', backgroundOnly: false }],
                ['team-a', { sendKey: 'SCT_TEAM_A_ERROR', backgroundOnly: true }],
                ['team-b', { sendKey: 'SCT_TEAM_B_ERROR', backgroundOnly: true }],
            ]))
            visibility.registerConnection('visible', 'team-a', 'visible')
            await channel.sendSessionError(createSession({ namespace: 'team-a' }), 'error')
            await channel.sendSessionError(createSession({ namespace: 'Team-b' }), 'error')
            await channel.sendSessionError(createSession({ namespace: 'unknown' }), 'error')
            expect(fetchMock).not.toHaveBeenCalled()

            await channel.sendSessionError(createSession({ namespace: 'team-b' }), 'error')
            await channel.sendSessionError(createSession({ namespace: 'default' }), 'error')
            await channel.sendSessionCompletion(createSession({ namespace: 'unknown' }), 'completed')
            expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
                'https://sctapi.ftqq.com/SCT_TEAM_B_ERROR.send',
                'https://sctapi.ftqq.com/SCT_DEFAULT_ERROR.send',
                'https://sctapi.ftqq.com/SCT_LEGACY.send',
            ])
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('supports an error-only destination even if there is no legacy SendKey', async () => {
        const fetchMock = mock(async (_url: string, _init: RequestInit) => new Response('ok'))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch
        try {
            const channel = new ServerChanChannel(null, 'https://hapi.example.com', null, false,
                new Map([['team', { sendKey: 'SCT_TEAM_ERROR', backgroundOnly: false }]]))
            const session = createSession({ namespace: 'team' })
            await channel.sendReady(session)
            await channel.sendPermissionRequest(session)
            await channel.sendSessionCompletion(session, 'completed')
            await channel.sendSessionError(createSession(), 'error')
            expect(fetchMock).not.toHaveBeenCalled()

            await channel.sendSessionError(session, 'error')
            expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://sctapi.ftqq.com/SCT_TEAM_ERROR.send'])
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
