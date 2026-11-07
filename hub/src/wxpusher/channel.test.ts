import { describe, expect, it, mock } from 'bun:test'
import type { SessionEndReason } from '@hapi/protocol'
import type { Session } from '../sync/syncEngine'
import { VisibilityTracker } from '../visibility/visibilityTracker'
import { WXPUSHER_SEND_URL, WXPUSHER_SUMMARY_LIMIT, WxPusherChannel } from './channel'

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
            path: 'F:\\develop\\code\\hapi',
            host: 'DESKTOP',
            name: 'WxPusher review'
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

describe('WxPusherChannel', () => {
    it('sends session completion notifications to configured recipients', async () => {
        const fetchMock = mock(async () => new Response(JSON.stringify({ code: 1000, msg: '处理成功' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const channel = new WxPusherChannel(
                'AT_TEST',
                ['UID_ONE', 'UID_TWO'],
                [42],
                'https://hapi.example.com'
            )

            await channel.sendSessionCompletion(createSession(), 'completed' satisfies SessionEndReason)

            expect(fetchMock).toHaveBeenCalledTimes(1)
            const call = fetchMock.mock.calls[0] as unknown[] | undefined
            expect(String(call?.[0])).toBe(WXPUSHER_SEND_URL)
            const init = call?.[1] as RequestInit | undefined
            expect(init?.method).toBe('POST')
            expect(init?.headers).toEqual({ 'content-type': 'application/json' })
            expect(JSON.parse(String(init?.body))).toEqual({
                appToken: 'AT_TEST',
                content: 'Agent · WxPusher review\n\n会话已结束。\n\nhttps://hapi.example.com/sessions/session-1',
                summary: '完成：WxPusher review',
                contentType: 1,
                uids: ['UID_ONE', 'UID_TWO'],
                topicIds: [42],
                url: 'https://hapi.example.com/sessions/session-1',
            })
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('uses the basename for a Windows path fallback', async () => {
        const fetchMock = mock(async () => new Response(JSON.stringify({ code: 1000 }), { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const channel = new WxPusherChannel('AT_TEST', ['UID_ONE'], [], 'https://hapi.example.com')
            const session = createSession({
                metadata: {
                    path: 'F:\\develop\\code\\hapi',
                    host: 'DESKTOP',
                    name: ''
                }
            })

            await channel.sendSessionCompletion(session, 'completed' satisfies SessionEndReason)

            const call = fetchMock.mock.calls[0] as unknown[] | undefined
            const init = call?.[1] as RequestInit | undefined
            const message = JSON.parse(String(init?.body)) as { content?: string }
            expect(message.content).toContain('Agent · hapi\n\n会话已结束。')
            expect(message.content).not.toContain('F:\\develop\\code\\hapi')
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('limits long Unicode summaries while preserving the full session name in content', async () => {
        const fetchMock = mock(async () => new Response(JSON.stringify({ code: 1000 }), { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const sessionName = '🚀'.repeat(100)
            const channel = new WxPusherChannel('AT_TEST', ['UID_ONE'], [], 'https://hapi.example.com')
            await channel.sendSessionCompletion(createSession({
                metadata: {
                    path: 'F:\\develop\\code\\hapi',
                    host: 'DESKTOP',
                    name: sessionName
                }
            }), 'completed' satisfies SessionEndReason)

            const call = fetchMock.mock.calls[0] as unknown[] | undefined
            const init = call?.[1] as RequestInit | undefined
            const message = JSON.parse(String(init?.body)) as { summary: string; content: string }
            expect(Array.from(message.summary).length).toBe(WXPUSHER_SUMMARY_LIMIT)
            expect(message.summary.startsWith('完成：')).toBe(true)
            expect(message.summary.endsWith('…')).toBe(true)
            expect(message.summary).not.toContain('�')
            expect(message.content).toContain(sessionName)
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('limits combining-mark summaries by code points without splitting graphemes', async () => {
        const fetchMock = mock(async () => new Response(JSON.stringify({ code: 1000 }), { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const sessionName = 'e\u0301'.repeat(60)
            const channel = new WxPusherChannel('AT_TEST', ['UID_ONE'], [], 'https://hapi.example.com')
            await channel.sendSessionCompletion(createSession({
                metadata: {
                    path: 'F:\\develop\\code\\hapi',
                    host: 'DESKTOP',
                    name: sessionName
                }
            }), 'completed' satisfies SessionEndReason)

            const call = fetchMock.mock.calls[0] as unknown[] | undefined
            const init = call?.[1] as RequestInit | undefined
            const message = JSON.parse(String(init?.body)) as { summary: string; content: string }
            expect(Array.from(message.summary).length).toBe(WXPUSHER_SUMMARY_LIMIT)
            expect(message.summary.endsWith('…')).toBe(true)
            expect(message.summary).not.toContain('�')
            expect(message.content).toContain(sessionName)
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('limits multi-code-point emoji summaries without splitting graphemes', async () => {
        const fetchMock = mock(async () => new Response(JSON.stringify({ code: 1000 }), { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const sessionName = '👩‍💻'.repeat(40)
            const channel = new WxPusherChannel('AT_TEST', ['UID_ONE'], [], 'https://hapi.example.com')
            await channel.sendSessionCompletion(createSession({
                metadata: {
                    path: 'F:\\develop\\code\\hapi',
                    host: 'DESKTOP',
                    name: sessionName
                }
            }), 'completed' satisfies SessionEndReason)

            const call = fetchMock.mock.calls[0] as unknown[] | undefined
            const init = call?.[1] as RequestInit | undefined
            const message = JSON.parse(String(init?.body)) as { summary: string; content: string }
            expect(Array.from(message.summary).length).toBe(WXPUSHER_SUMMARY_LIMIT)
            expect(message.summary.endsWith('…')).toBe(true)
            expect(message.summary).not.toContain('�')
            expect(message.content).toContain(sessionName)
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('retains the full session name for composed input-request content', async () => {
        const fetchMock = mock(async () => new Response(JSON.stringify({ code: 1000 }), { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const sessionName = 'Long input request session '.repeat(5)
            const channel = new WxPusherChannel('AT_TEST', ['UID_ONE'], [], 'https://hapi.example.com')
            await channel.sendPermissionRequest(createSession({
                metadata: {
                    path: 'F:\\develop\\code\\hapi',
                    host: 'DESKTOP',
                    name: sessionName
                },
                agentState: {
                    requests: {
                        'request-1': {
                            tool: 'request_user_input',
                            arguments: {
                                questions: [{ question: 'Which option should I use?' }]
                            },
                            createdAt: 1
                        }
                    }
                }
            }))

            const call = fetchMock.mock.calls[0] as unknown[] | undefined
            const init = call?.[1] as RequestInit | undefined
            const message = JSON.parse(String(init?.body)) as { summary: string; content: string }
            expect(message.summary.endsWith('…')).toBe(true)
            expect(message.content).toContain(`会话：${sessionName}`)
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('sends ready, permission, failed task, and session error notifications', async () => {
        const fetchMock = mock(async () => new Response(JSON.stringify({ code: 1000 }), { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const channel = new WxPusherChannel('AT_TEST', ['UID_ONE'], [], 'https://hapi.example.com')
            const session = createSession()
            const permissionSession = createSession({
                agentState: {
                    requests: {
                        'request-1': {
                            tool: 'Bash',
                            arguments: { command: 'bun test' },
                            createdAt: 1
                        }
                    }
                }
            })

            await channel.sendReady(session)
            await channel.sendPermissionRequest(permissionSession)
            await channel.sendTaskNotification(session, { status: 'failed', summary: 'failed' })
            await channel.sendTaskNotification(session, { status: 'completed', summary: 'done' })
            await channel.sendSessionError(session, 'error' satisfies SessionEndReason)

            expect(fetchMock).toHaveBeenCalledTimes(4)
            const summaries = fetchMock.mock.calls.map((call) => {
                const init = (call as unknown[])[1] as RequestInit | undefined
                return (JSON.parse(String(init?.body)) as { summary: string }).summary
            })
            expect(summaries).toEqual([
                '就绪：WxPusher review',
                '授权：WxPusher review',
                '失败：WxPusher review',
                '异常：WxPusher review'
            ])
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('suppresses completion notifications when a visible connection exists in background-only mode', async () => {
        const fetchMock = mock(async () => new Response(JSON.stringify({ code: 1000 }), { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const visibilityTracker = new VisibilityTracker()
            visibilityTracker.registerConnection('visible-1', 'default', 'visible')
            const channel = new WxPusherChannel(
                'AT_TEST',
                ['UID_ONE'],
                [],
                'https://hapi.example.com',
                visibilityTracker,
                true
            )

            await channel.sendReady(createSession())
            await channel.sendPermissionRequest(createSession({
                agentState: {
                    requests: {
                        'request-1': { tool: 'Bash', arguments: {}, createdAt: 1 }
                    }
                }
            }))
            await channel.sendTaskNotification(createSession(), {
                status: 'failed',
                summary: 'Subtask failed'
            })
            await channel.sendSessionError(createSession(), 'error' satisfies SessionEndReason)
            await channel.sendSessionCompletion(createSession(), 'completed' satisfies SessionEndReason)

            expect(fetchMock).not.toHaveBeenCalled()
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('sends completion notifications when no visible connection exists', async () => {
        const fetchMock = mock(async () => new Response(JSON.stringify({ code: 1000 }), { status: 200 }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const visibilityTracker = new VisibilityTracker()
            visibilityTracker.registerConnection('hidden-1', 'default', 'hidden')
            const channel = new WxPusherChannel(
                'AT_TEST',
                ['UID_ONE'],
                [],
                'https://hapi.example.com',
                visibilityTracker,
                true
            )

            await channel.sendSessionCompletion(createSession(), 'completed' satisfies SessionEndReason)

            expect(fetchMock).toHaveBeenCalledTimes(1)
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('rejects non-successful HTTP responses', async () => {
        const fetchMock = mock(async () => new Response('rate limited', {
            status: 429,
            statusText: 'Too Many Requests'
        }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const channel = new WxPusherChannel('AT_TEST', ['UID_ONE'], [], 'https://hapi.example.com')

            await expect(channel.sendSessionCompletion(createSession(), 'completed' satisfies SessionEndReason))
                .rejects.toThrow('WxPusher send failed: HTTP 429 Too Many Requests - rate limited')
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    it('rejects unsuccessful WxPusher API responses', async () => {
        const fetchMock = mock(async () => new Response(JSON.stringify({ code: 1001, msg: 'invalid token' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        }))
        const originalFetch = globalThis.fetch
        globalThis.fetch = fetchMock as unknown as typeof fetch

        try {
            const channel = new WxPusherChannel('AT_TEST', ['UID_ONE'], [], 'https://hapi.example.com')

            await expect(channel.sendSessionCompletion(createSession(), 'completed' satisfies SessionEndReason))
                .rejects.toThrow('WxPusher send failed: invalid token')
        } finally {
            globalThis.fetch = originalFetch
        }
    })
})
