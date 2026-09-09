import { describe, expect, it, vi } from 'vitest'
import {
    PingPeerError,
    controlPeer,
    exitCodeForPingPeerError,
    inspectPeer,
    pingPeer,
    requireExactSessionId,
    waitPeer
} from './pingPeer'

const SESSION_ID = '05d9f0f2-9273-4137-933c-07459a1146a2'
const REMIT_ID = '7ee03698-0fe7-4f76-b8a8-d84f4eddbf5c'
const terminal = (stopReason: string) => ({
    content: { role: 'agent', content: { type: 'codex', data: { type: 'turn_complete', stopReason } } }
})

type MockResponse = { status: number; data: unknown }

function createHttpMock(handlers: {
    post?: (url: string, body?: unknown) => MockResponse | Promise<MockResponse>
    get?: (url: string, config?: { params?: Record<string, unknown> }) => MockResponse | Promise<MockResponse>
    delete?: (url: string) => MockResponse | Promise<MockResponse>
}) {
    return {
        post: vi.fn(async (url: string, body?: unknown) => {
            if (!handlers.post) throw new Error(`unexpected POST ${url}`)
            return handlers.post(url, body)
        }),
        get: vi.fn(async (url: string, config?: { params?: Record<string, unknown> }) => {
            if (!handlers.get) throw new Error(`unexpected GET ${url}`)
            return handlers.get(url, config)
        }),
        delete: vi.fn(async (url: string) => {
            if (!handlers.delete) throw new Error(`unexpected DELETE ${url}`)
            return handlers.delete(url)
        })
    }
}

function authResponse(url: string): MockResponse | null {
    return url.endsWith('/api/auth') ? { status: 200, data: { token: 'jwt' } } : null
}

describe('exact session boundary', () => {
    it('accepts an exact UUID or one exact session citation', () => {
        expect(requireExactSessionId(SESSION_ID)).toBe(SESSION_ID)
        expect(requireExactSessionId(`[peer](/sessions/${SESSION_ID})`)).toBe(SESSION_ID)
    })

    it.each(['05d9f0f2', '', 'not-a-session', `/sessions/${SESSION_ID} /sessions/${REMIT_ID}`])(
        'rejects non-exact target %s',
        (value) => expect(() => requireExactSessionId(value)).toThrowError(/exact HAPI session UUID/)
    )
})

describe('peer lifecycle operations', () => {
    it('messages only the exact target and records a stable remit id', async () => {
        const http = createHttpMock({
            post: (url, body) => {
                const auth = authResponse(url)
                if (auth) return auth
                if (url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) {
                    expect(body).toEqual({ text: 'hello', localId: REMIT_ID })
                    return { status: 200, data: { ok: true } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                expect(url).toBe(`http://hub.test/api/sessions/${SESSION_ID}`)
                return {
                    status: 200,
                    data: { session: { id: SESSION_ID, active: true, metadata: { name: 'Peer' } } }
                }
            }
        })

        await expect(pingPeer({
            sessionId: SESSION_ID,
            message: 'hello',
            remitId: REMIT_ID,
            apiUrl: 'http://hub.test',
            accessToken: 'token',
            http: http as never
        })).resolves.toEqual({ sessionId: SESSION_ID, remitId: REMIT_ID, name: 'Peer', resumed: false })
        expect(http.get).not.toHaveBeenCalledWith('http://hub.test/api/sessions', expect.anything())
    })

    it('returns the generated remit id when the message response is lost', async () => {
        let sentRemitId: string | undefined
        const http = createHttpMock({
            post: (url, body) => {
                const auth = authResponse(url)
                if (auth) return auth
                sentRemitId = (body as { localId?: string }).localId
                throw new Error('socket reset')
            },
            get: () => ({
                status: 200,
                data: { session: { id: SESSION_ID, active: true, metadata: { name: 'Peer' } } }
            })
        })

        try {
            await pingPeer({
                sessionId: SESSION_ID,
                message: 'hello',
                apiUrl: 'http://hub.test',
                accessToken: 'token',
                http: http as never
            })
            throw new Error('expected pingPeer to fail')
        } catch (error) {
            expect(error).toBeInstanceOf(PingPeerError)
            expect(error).toMatchObject({ code: 'send_failed', remitId: sentRemitId })
        }
        expect(sentRemitId).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('reports a reused remit with a different payload as a deterministic conflict', async () => {
        const http = createHttpMock({
            post: (url) => authResponse(url) ?? {
                status: 409,
                data: {
                    error: 'localId is already bound to a different message payload',
                    code: 'local_id_conflict'
                }
            },
            get: () => ({
                status: 200,
                data: { session: { id: SESSION_ID, active: true, metadata: { name: 'Peer' } } }
            })
        })

        await expect(pingPeer({
            sessionId: SESSION_ID,
            message: 'different',
            remitId: REMIT_ID,
            apiUrl: 'http://hub.test',
            accessToken: 'token',
            http: http as never
        })).rejects.toMatchObject({ code: 'remit_conflict', remitId: REMIT_ID })
    })

    it('inspects without resuming or listing sessions', async () => {
        const http = createHttpMock({
            post: (url) => authResponse(url) ?? Promise.reject(new Error(`unexpected POST ${url}`)),
            get: (url) => {
                if (url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) {
                    return {
                        status: 200,
                        data: { messages: [{ id: 'm1', createdAt: 10, content: { role: 'user', content: { text: 'task' } } }] }
                    }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
                    return { status: 200, data: { session: { id: SESSION_ID, active: false, metadata: { name: 'Peer', flavor: 'codex' } } } }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        const result = await inspectPeer({
            sessionId: SESSION_ID,
            apiUrl: 'http://hub.test',
            accessToken: 'token',
            http: http as never
        })
        expect(result).toMatchObject({ sessionId: SESSION_ID, active: false, flavor: 'codex' })
        expect(result.messages).toEqual([{ id: 'm1', role: 'user', text: 'task', createdAt: 10 }])
        expect(http.post).toHaveBeenCalledTimes(1)
    })

    it.each(['wait', 'inspect'] as const)('coalesces cumulative text snapshots for %s, preserving block order', async (operation) => {
        const snapshot = (id: string, streamId: string, text: string, streamSnapshot = true) => ({
            id, createdAt: 10,
            content: { role: 'agent', content: { type: 'codex', data: { type: 'message', id: streamId, message: text, streamSnapshot } } }
        })
        const older = [
            { localId: REMIT_ID, invokedAt: 1, content: { role: 'user' } },
            snapshot('a1', 'first', 'The'),
            snapshot('b1', 'second', 'Other')
        ]
        const newer = [
            snapshot('a2', 'first', 'The answer'),
            snapshot('aside', 'first', 'Aside', false),
            snapshot('a3', 'first', 'The answer is 42'),
            snapshot('b2', 'second', 'Other final'),
            terminal('success')
        ]
        const http = createHttpMock({
            post: (url) => authResponse(url)!,
            get: (url, config) => {
                if (!url.endsWith('/messages')) return { status: 200, data: { session: { id: SESSION_ID, active: true, thinking: false } } }
                if (operation === 'inspect') return { status: 200, data: { messages: [...older, ...newer] } }
                return config?.params?.beforeSeq === 200
                    ? { status: 200, data: { messages: older, page: { hasMore: false } } }
                    : { status: 200, data: { messages: newer, page: { hasMore: true, nextBeforeAt: 200, nextBeforeSeq: 200 } } }
            }
        })
        const options = { sessionId: SESSION_ID, apiUrl: 'http://hub.test', accessToken: 'token', http: http as never }
        const result = operation === 'wait'
            ? await waitPeer({ ...options, remitId: REMIT_ID })
            : await inspectPeer(options)
        expect(result.messages).toEqual([
            { id: 'a3', role: 'agent', text: 'The answer is 42', createdAt: 10 },
            { id: 'b2', role: 'agent', text: 'Other final', createdAt: 10 },
            { id: 'aside', role: 'agent', text: 'Aside', createdAt: 10 }
        ])
        if ('text' in result) expect(result.text).toBe('The answer is 42\n\nOther final\n\nAside')
    })

    it('waits for the assistant result after the exact remit', async () => {
        const http = createHttpMock({
            post: (url) => authResponse(url) ?? Promise.reject(new Error(`unexpected POST ${url}`)),
            get: (url) => {
                if (url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) {
                    return {
                        status: 200,
                        data: {
                            messages: [
                                { id: 'u1', localId: REMIT_ID, invokedAt: 1, content: { role: 'user', content: { text: 'task' } } },
                                { id: 'queued', content: { role: 'user', content: { text: 'scheduled later' } } },
                                { id: 'a1', createdAt: 2, content: { role: 'assistant', content: { type: 'codex', data: { type: 'message', message: 'done' } } } },
                                terminal('success'),
                                { id: 'u2', createdAt: 3, invokedAt: 3, content: { role: 'user', content: { text: 'later turn' } } },
                                { id: 'a2', createdAt: 4, content: { role: 'assistant', content: { type: 'codex', data: { type: 'message', message: 'must not leak' } } } }
                            ]
                        }
                    }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
                    return { status: 200, data: { session: { id: SESSION_ID, active: true, thinking: true } } }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await expect(waitPeer({
            sessionId: SESSION_ID,
            remitId: REMIT_ID,
            apiUrl: 'http://hub.test',
            accessToken: 'token',
            http: http as never
        })).resolves.toMatchObject({ status: 'completed', text: 'done' })
    })

    it('fails immediately when a persisted remit was never accepted before the session ended', async () => {
        let elapsed = 0
        const http = createHttpMock({
            post: (url) => authResponse(url) ?? Promise.reject(new Error(`unexpected POST ${url}`)),
            get: (url) => url.endsWith('/messages')
                ? { status: 200, data: { messages: [{ localId: REMIT_ID, invokedAt: null }] } }
                : { status: 200, data: { session: { id: SESSION_ID, active: false, thinking: false } } }
        })
        await expect(waitPeer({
            sessionId: SESSION_ID,
            remitId: REMIT_ID,
            apiUrl: 'http://hub.test',
            accessToken: 'token',
            http: http as never,
            timeoutSecs: 1,
            now: () => elapsed,
            sleep: async (ms) => { elapsed += ms }
        })).rejects.toMatchObject({ code: 'session_ended' })
        expect(elapsed).toBe(0)
    })

    it('finds an older remit and returns results across message pages', async () => {
        const http = createHttpMock({
            post: (url) => authResponse(url) ?? Promise.reject(new Error(`unexpected POST ${url}`)),
            get: (url, config) => {
                if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
                    return { status: 200, data: { session: { id: SESSION_ID, active: true, thinking: false } } }
                }
                if (!url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) throw new Error(`unexpected GET ${url}`)
                if (config?.params?.beforeSeq === 200) {
                    return {
                        status: 200,
                        data: {
                            messages: [
                                { id: 'u1', seq: 1, localId: REMIT_ID, invokedAt: 1, content: { role: 'user', content: { text: 'task' } } },
                                { id: 'a1', seq: 2, createdAt: 2, content: { role: 'assistant', content: { type: 'codex', data: { type: 'message', message: 'part one' } } } }
                            ],
                            page: { hasMore: false }
                        }
                    }
                }
                return {
                    status: 200,
                    data: {
                        messages: [
                            { id: 'a2', seq: 201, createdAt: 201, content: { role: 'assistant', content: { type: 'codex', data: { type: 'message', message: 'part two' } } } },
                            terminal('success')
                        ],
                        page: { hasMore: true, nextBeforeAt: 200, nextBeforeSeq: 200 }
                    }
                }
            }
        })

        await expect(waitPeer({
            sessionId: SESSION_ID,
            remitId: REMIT_ID,
            apiUrl: 'http://hub.test',
            accessToken: 'token',
            http: http as never
        })).resolves.toMatchObject({ status: 'completed', text: 'part one\n\npart two' })
    })

    it.each(['expired', 'idle', 'cancelled', 'error'] as const)(
        'does not report partial commentary as completed: %s', async (state) => {
            let elapsed = 0
            const http = createHttpMock({
                post: (url) => authResponse(url)!,
                get: (url) => url.endsWith('/messages')
                    ? { status: 200, data: { messages: [
                        { localId: REMIT_ID, invokedAt: 1 },
                        { content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Still working...' } } } },
                        ...(['cancelled', 'error'].includes(state) ? [terminal(state)] : [])
                    ] } }
                    : { status: 200, data: { session: { id: SESSION_ID, active: state !== 'expired', thinking: false } } }
            })
            await expect(waitPeer({
                sessionId: SESSION_ID, remitId: REMIT_ID, apiUrl: 'http://hub.test', accessToken: 'token',
                http: http as never, timeoutSecs: 1, now: () => elapsed, sleep: async (ms) => { elapsed += ms }
            })).rejects.toMatchObject({ code: state === 'idle' ? 'timeout' : 'session_ended' })
        }
    )

    it.each([REMIT_ID, '6acb2b8a-1334-4955-b0c6-86f5a22656d2'])(
        'returns the shared result for either remit consumed in one batch: %s', async (remitId) => {
            let elapsed = 0
            const http = createHttpMock({
                post: (url) => authResponse(url)!,
                get: (url) => url.endsWith('/messages')
                    ? { status: 200, data: { messages: [
                        { localId: REMIT_ID, invokedAt: 1, content: { role: 'user' } },
                        { localId: '6acb2b8a-1334-4955-b0c6-86f5a22656d2', invokedAt: 1, content: { role: 'user' } },
                        { content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Both tasks done' } } } },
                        terminal('end_turn'),
                        { invokedAt: 2, content: { role: 'user' } },
                        { content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Later answer' } } } }
                    ] } }
                    : { status: 200, data: { session: { id: SESSION_ID, active: false, thinking: false } } }
            })
            await expect(waitPeer({
                sessionId: SESSION_ID, remitId, apiUrl: 'http://hub.test', accessToken: 'token',
                http: http as never, timeoutSecs: 1, now: () => elapsed, sleep: async (ms) => { elapsed += ms }
            })).resolves.toMatchObject({ status: 'completed', text: 'Both tasks done' })
        }
    )

    it.each([true, false])('keeps accepted steering inside the remit window: %s', async (steered) => {
        let elapsed = 0
        const http = createHttpMock({
            post: (url) => authResponse(url)!,
            get: (url) => url.endsWith('/messages')
                ? { status: 200, data: { messages: [
                    { localId: REMIT_ID, invokedAt: 1, content: { role: 'user' } },
                    { invokedAt: 2, steered, content: { role: 'user' } },
                    { content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Final answer' } } } },
                    terminal('success'),
                    { invokedAt: 3, content: { role: 'user' } },
                    { content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Later answer' } } } },
                    terminal('success')
                ] } }
                : { status: 200, data: { session: { id: SESSION_ID, active: true, thinking: false } } }
        })
        const result = waitPeer({
            sessionId: SESSION_ID, remitId: REMIT_ID, apiUrl: 'http://hub.test', accessToken: 'token',
            http: http as never, timeoutSecs: 1, now: () => elapsed, sleep: async (ms) => { elapsed += ms }
        })
        if (steered) await expect(result).resolves.toMatchObject({ text: 'Final answer', messages: [{ text: 'Final answer' }] })
        else await expect(result).rejects.toMatchObject({ code: 'timeout' })
    })

    it.each([false, true])('uses the Claude native result outcome, is_error=%s', async (isError) => {
        const http = createHttpMock({
            post: (url) => authResponse(url)!,
            get: (url) => url.endsWith('/messages')
                ? { status: 200, data: { messages: [
                    { localId: REMIT_ID, invokedAt: 1 },
                    { content: { role: 'agent', content: { type: 'output', data: {
                        type: 'system', subtype: 'turn_duration',
                        resultSummary: { subtype: isError ? 'error_max_turns' : 'success', is_error: isError }
                    } } } }
                ] } }
                : { status: 200, data: { session: { id: SESSION_ID, active: false, thinking: false } } }
        })
        const result = waitPeer({
            sessionId: SESSION_ID, remitId: REMIT_ID, apiUrl: 'http://hub.test', accessToken: 'token', http: http as never
        })
        if (isError) await expect(result).rejects.toMatchObject({ code: 'session_ended' })
        else await expect(result).resolves.toMatchObject({ status: 'completed', text: '', messages: [] })
    })

    it.each(['abort', 'stop', 'archive', 'delete'] as const)('sends %s to the exact session', async (action) => {
        const http = createHttpMock({
            post: (url) => {
                const auth = authResponse(url)
                if (auth) return auth
                expect(url).toBe(`http://hub.test/api/sessions/${SESSION_ID}/${action}`)
                return { status: 200, data: { ok: true, alreadyStopped: action === 'stop', alreadyArchived: action === 'archive' } }
            },
            delete: (url) => {
                expect(url).toBe(`http://hub.test/api/sessions/${SESSION_ID}`)
                return { status: 200, data: { ok: true } }
            }
        })
        await expect(controlPeer({
            sessionId: SESSION_ID,
            action,
            apiUrl: 'http://hub.test',
            accessToken: 'token',
            http: http as never
        })).resolves.toMatchObject({ sessionId: SESSION_ID, action })
    })

    it('uses stable nonzero exit codes', () => {
        expect(exitCodeForPingPeerError(new PingPeerError('bad_args', 'x'))).toBe(2)
        expect(exitCodeForPingPeerError(new PingPeerError('remit_conflict', 'x'))).toBe(2)
        expect(exitCodeForPingPeerError(new PingPeerError('resume_failed', 'x'))).toBe(3)
        expect(exitCodeForPingPeerError(new PingPeerError('timeout', 'x'))).toBe(4)
    })
})
