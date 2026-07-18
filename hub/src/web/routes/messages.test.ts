import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createMessagesRoutes } from './messages'

function createSession(overrides?: Partial<Session>): Session {
    const baseMetadata = {
        path: '/tmp/project',
        host: 'localhost',
        flavor: 'codex' as const
    }
    const base: Session = {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: baseMetadata,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 1,
        model: 'gpt-5.4',
        modelReasoningEffort: null,
        effort: null,
        permissionMode: 'default',
        collaborationMode: 'default'
    }

    return {
        ...base,
        ...overrides,
        metadata: overrides?.metadata === undefined
            ? base.metadata
            : overrides.metadata === null
                ? null
                : {
                    ...baseMetadata,
                    ...overrides.metadata
                }
    }
}

function createApp(args?: {
    session?: Session
    accessResult?: { ok: true; sessionId: string; session: Session } | { ok: false; reason: 'not-found' | 'access-denied' }
    recentMessages?: Array<{ id: string; seq: number; createdAt: number; localId?: string | null; content: unknown }>
    recentUserMessages?: Array<{ id: string; seq: number; createdAt: number; text: string }>
    takeoverResult?: { type: 'success'; sessionId: string } | { type: 'error'; message: string; code: 'takeover_busy' | 'no_machine_online' | 'access_denied' | 'session_not_found' | 'resume_unavailable' | 'resume_failed' }
    resumeResult?: { type: 'success'; sessionId: string } | { type: 'error'; message: string; code: 'no_machine_online' | 'access_denied' | 'session_not_found' | 'resume_unavailable' | 'resume_failed' }
}) {
    const session = args?.session ?? createSession()
    const accessResult = args?.accessResult ?? { ok: true as const, sessionId: session.id, session }
    const recentMessages = args?.recentMessages ?? []
    const sendMessageCalls: Array<[string, Record<string, unknown>]> = []
    const readCalls: Array<[string, string]> = []
    const takeoverCalls: Array<[string, string]> = []
    const resumeCalls: Array<[string, string]> = []
    const recentUserCalls: Array<[string, { limit: number }]> = []
    const messagePageCalls: Array<[string, { limit: number; beforeSeq: number | null; afterSeq: number | null }]> = []
    let sessionAccessCalls = 0

    const engine = {
        resolveSessionAccess: () => {
            sessionAccessCalls += 1
            return accessResult
        },
        getMessagesPage: (
            sessionId: string,
            options: { limit: number; beforeSeq: number | null; afterSeq: number | null },
        ) => {
            messagePageCalls.push([sessionId, options])
            return {
                messages: recentMessages,
                page: {
                    limit: options.limit,
                    direction: options.afterSeq !== null ? 'newer' : options.beforeSeq !== null ? 'older' : 'latest',
                    beforeSeq: options.beforeSeq,
                    afterSeq: options.afterSeq,
                    nextBeforeSeq: null,
                    nextAfterSeq: null,
                    hasMore: false,
                    hasOlder: false,
                    hasNewer: false,
                    range: null,
                    startComplete: true,
                    endComplete: true,
                    continuation: null,
                },
            }
        },
        markSessionRead: (sessionId: string, namespace: string) => {
            readCalls.push([sessionId, namespace])
        },
        getRecentUserMessages: (sessionId: string, options: { limit: number }) => {
            recentUserCalls.push([sessionId, options])
            return args?.recentUserMessages ?? []
        },
        takeoverSession: async (sessionId: string, namespace: string) => {
            takeoverCalls.push([sessionId, namespace])
            return args?.takeoverResult ?? { type: 'success' as const, sessionId }
        },
        resumeSession: async (sessionId: string, namespace: string) => {
            resumeCalls.push([sessionId, namespace])
            return args?.resumeResult ?? { type: 'success' as const, sessionId }
        },
        sendMessage: async (sessionId: string, payload: Record<string, unknown>) => {
            sendMessageCalls.push([sessionId, payload])
        }
    } as Partial<SyncEngine>

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createMessagesRoutes(() => engine as SyncEngine))

    return {
        app,
        sendMessageCalls,
        readCalls,
        takeoverCalls,
        resumeCalls,
        recentUserCalls,
        messagePageCalls,
        sessionAccessCalls: () => sessionAccessCalls,
    }
}

function attachment(overrides: Record<string, unknown> = {}) {
    return {
        id: 'attachment-1',
        filename: 'file.txt',
        mimeType: 'text/plain',
        size: 1,
        path: '/tmp/file.txt',
        ...overrides,
    }
}

function whitespacePaddedJsonStream(json: string, totalBytes: number): ReadableStream<Uint8Array> {
    const encoded = new TextEncoder().encode(json)
    if (encoded.byteLength > totalBytes) {
        throw new Error('JSON exceeds requested stream size')
    }

    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoded)
            const whitespaceChunk = new Uint8Array(1024 * 1024).fill(0x20)
            let remaining = totalBytes - encoded.byteLength
            while (remaining >= whitespaceChunk.byteLength) {
                controller.enqueue(whitespaceChunk)
                remaining -= whitespaceChunk.byteLength
            }
            if (remaining > 0) controller.enqueue(whitespaceChunk.subarray(0, remaining))
            controller.close()
        },
    })
}

describe('messages routes', () => {
    it('returns recent user messages without marking the session read', async () => {
        const { app, readCalls, recentUserCalls } = createApp({
            recentUserMessages: [
                { id: 'message-2', seq: 2, createdAt: 20, text: 'second prompt' },
                { id: 'message-1', seq: 1, createdAt: 10, text: 'first prompt' }
            ]
        })

        const response = await app.request('/api/sessions/session-1/recent-user-messages?limit=10')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            messages: [
                { id: 'message-2', seq: 2, createdAt: 20, text: 'second prompt' },
                { id: 'message-1', seq: 1, createdAt: 10, text: 'first prompt' }
            ]
        })
        expect(recentUserCalls).toEqual([['session-1', { limit: 10 }]])
        expect(readCalls).toEqual([])
    })

    it('rejects recent user messages when session access is denied', async () => {
        const { app, recentUserCalls } = createApp({
            accessResult: { ok: false, reason: 'access-denied' }
        })

        const response = await app.request('/api/sessions/session-1/recent-user-messages?limit=10')

        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: 'Session access denied' })
        expect(recentUserCalls).toEqual([])
    })

    it('returns not found for recent user messages when the session does not exist', async () => {
        const { app, recentUserCalls } = createApp({
            accessResult: { ok: false, reason: 'not-found' }
        })

        const response = await app.request('/api/sessions/missing/recent-user-messages?limit=10')

        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: 'Session not found' })
        expect(recentUserCalls).toEqual([])
    })

    it('does not mark latest messages read unless requested', async () => {
        const { app, readCalls } = createApp()

        const response = await app.request('/api/sessions/session-1/messages?limit=50')

        expect(response.status).toBe(200)
        expect(readCalls).toEqual([])
    })

    it('marks latest messages read when requested by an active viewer', async () => {
        const { app, readCalls } = createApp()

        const response = await app.request('/api/sessions/session-1/messages?limit=50&markRead=true')

        expect(response.status).toBe(200)
        expect(readCalls).toEqual([['session-1', 'default']])
    })

    it('forwards a newer cursor without marking history read', async () => {
        const { app, messagePageCalls, readCalls } = createApp()

        const response = await app.request(
            '/api/sessions/session-1/messages?limit=50&afterSeq=5&markRead=true',
        )

        expect(response.status).toBe(200)
        expect(messagePageCalls).toEqual([[
            'session-1',
            { limit: 50, beforeSeq: null, afterSeq: 5 },
        ]])
        expect(readCalls).toEqual([])
    })

    it('rejects simultaneous older and newer cursors', async () => {
        const { app, messagePageCalls, readCalls } = createApp()

        const response = await app.request(
            '/api/sessions/session-1/messages?beforeSeq=10&afterSeq=5',
        )

        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ error: 'Invalid query' })
        expect(messagePageCalls).toEqual([])
        expect(readCalls).toEqual([])
    })

    const invalidMessageBodies = [
        ['text over 1,000,000 characters', () => ({ text: 'x'.repeat(1_000_001) })],
        ['local ID over 512 characters', () => ({ text: 'x', localId: 'l'.repeat(513) })],
        ['attachment ID over 512 characters', () => ({ text: '', attachments: [attachment({ id: 'a'.repeat(513) })] })],
        ['filename over 255 characters', () => ({ text: '', attachments: [attachment({ filename: 'f'.repeat(256) })] })],
        ['MIME type over 255 characters', () => ({ text: '', attachments: [attachment({ mimeType: 'm'.repeat(256) })] })],
        ['path over 4,096 characters', () => ({ text: '', attachments: [attachment({ path: 'p'.repeat(4_097) })] })],
        ['preview URL over 7,000,000 characters', () => ({ text: '', attachments: [attachment({ previewUrl: 'u'.repeat(7_000_001) })] })],
        ['non-integer attachment size', () => ({ text: '', attachments: [attachment({ size: 1.5 })] })],
        ['negative attachment size', () => ({ text: '', attachments: [attachment({ size: -1 })] })],
        ['attachment size over 50 MiB', () => ({ text: '', attachments: [attachment({ size: 50 * 1024 * 1024 + 1 })] })],
        ['more than 16 attachments', () => ({ text: '', attachments: Array.from({ length: 17 }, (_, index) => attachment({ id: `attachment-${index}` })) })],
        ['unknown top-level fields', () => ({ text: 'x', unexpected: true })],
    ] as const

    for (const [label, createBody] of invalidMessageBodies) {
        it(`rejects ${label} before any session control or send`, async () => {
            const { app, sendMessageCalls, takeoverCalls, resumeCalls } = createApp()

            const response = await app.request('/api/sessions/session-1/messages', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(createBody()),
            })

            expect(response.status).toBe(400)
            expect(sendMessageCalls).toEqual([])
            expect(takeoverCalls).toEqual([])
            expect(resumeCalls).toEqual([])
        })
    }

    it('accepts the maximum text and local ID lengths', async () => {
        const { app, sendMessageCalls } = createApp()
        const text = 'x'.repeat(1_000_000)
        const localId = 'l'.repeat(512)

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text, localId }),
        })

        expect(response.status).toBe(200)
        expect(sendMessageCalls).toHaveLength(1)
        expect(sendMessageCalls[0]?.[1]).toMatchObject({ text, localId })
    })

    it('accepts every maximum attachment field length and size', async () => {
        const { app, sendMessageCalls } = createApp()
        const maxAttachment = attachment({
            id: 'a'.repeat(512),
            filename: 'f'.repeat(255),
            mimeType: 'm'.repeat(255),
            size: 50 * 1024 * 1024,
            path: 'p'.repeat(4_096),
            previewUrl: 'u'.repeat(7_000_000),
        })

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: '', attachments: [maxAttachment] }),
        })

        expect(response.status).toBe(200)
        expect(sendMessageCalls).toHaveLength(1)
        expect(sendMessageCalls[0]?.[1]).toMatchObject({ attachments: [maxAttachment] })
    })

    it('accepts exactly 16 attachments', async () => {
        const { app, sendMessageCalls } = createApp()
        const attachments = Array.from(
            { length: 16 },
            (_, index) => attachment({ id: `attachment-${index}` }),
        )

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: '', attachments }),
        })

        expect(response.status).toBe(200)
        expect(sendMessageCalls).toHaveLength(1)
        expect(sendMessageCalls[0]?.[1]).toMatchObject({ attachments })
    })

    it('rejects a streamed body over 16 MiB before parsing or sending', async () => {
        const { app, sendMessageCalls, takeoverCalls, resumeCalls } = createApp()
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const chunk = new Uint8Array(1024 * 1024).fill(0x20)
                for (let index = 0; index < 16; index += 1) controller.enqueue(chunk)
                controller.enqueue(new Uint8Array([0x20]))
                controller.close()
            },
        })

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: stream,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' })

        expect(response.status).toBe(413)
        expect(await response.json()).toEqual({ error: 'Request body too large' })
        expect(sendMessageCalls).toEqual([])
        expect(takeoverCalls).toEqual([])
        expect(resumeCalls).toEqual([])
    })

    it('rejects an over-limit stream with an understated Content-Length before session access or send', async () => {
        const {
            app,
            sessionAccessCalls,
            sendMessageCalls,
            takeoverCalls,
            resumeCalls,
        } = createApp()
        const stream = whitespacePaddedJsonStream(
            '{"text":"x"}',
            16 * 1024 * 1024 + 1,
        )

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': '1',
            },
            body: stream,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' })

        expect(response.status).toBe(413)
        expect(await response.json()).toEqual({ error: 'Request body too large' })
        expect(sessionAccessCalls()).toBe(0)
        expect(sendMessageCalls).toEqual([])
        expect(takeoverCalls).toEqual([])
        expect(resumeCalls).toEqual([])
    })

    it('accepts a valid streamed body of exactly 16 MiB', async () => {
        const { app, sendMessageCalls } = createApp()
        const stream = whitespacePaddedJsonStream('{"text":"x"}', 16 * 1024 * 1024)

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: stream,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' })

        expect(response.status).toBe(200)
        expect(sendMessageCalls).toEqual([[
            'session-1',
            {
                text: 'x',
                localId: undefined,
                attachments: undefined,
                sentFrom: 'webapp',
            },
        ]])
    })

    it('keeps malformed JSON at 400 without session control or sending', async () => {
        const { app, sendMessageCalls, takeoverCalls, resumeCalls } = createApp()

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{',
        })

        expect(response.status).toBe(400)
        expect(sendMessageCalls).toEqual([])
        expect(takeoverCalls).toEqual([])
        expect(resumeCalls).toEqual([])
    })

    it('automatically takes over before sends enter a desktop-owned mirror session', async () => {
        const { app, sendMessageCalls, takeoverCalls } = createApp({
            takeoverResult: { type: 'success', sessionId: 'session-runner' },
            session: createSession({
                metadata: {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'codex',
                    mirrorSource: 'codex-desktop-sync',
                    executionControl: {
                        owner: 'desktop-sync',
                        generation: 1,
                        leaseExpiresAt: null,
                        runnerSessionId: null,
                        updatedAt: 1
                    }
                }
            })
        })

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hello from hapi' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(takeoverCalls).toEqual([['session-1', 'default']])
        expect(sendMessageCalls).toEqual([
            ['session-runner', {
                text: 'hello from hapi',
                localId: undefined,
                attachments: undefined,
                sentFrom: 'webapp'
            }]
        ])
    })

    it('allows sends for mirror sessions after takeover gives ownership to hapi-runner', async () => {
        const { app, sendMessageCalls } = createApp({
            session: createSession({
                metadata: {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'codex',
                    mirrorSource: 'codex-desktop-sync',
                    executionControl: {
                        owner: 'hapi-runner',
                        generation: 2,
                        leaseExpiresAt: 60_000,
                        runnerSessionId: 'session-1',
                        updatedAt: 2
                    }
                }
            })
        })

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hello from hapi' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(sendMessageCalls).toEqual([
            ['session-1', {
                text: 'hello from hapi',
                localId: undefined,
                attachments: undefined,
                sentFrom: 'webapp'
            }]
        ])
    })

    it('automatically takes over when only recent messages identify a desktop mirror', async () => {
        const { app, sendMessageCalls, takeoverCalls } = createApp({
            recentMessages: [
                {
                    id: 'message-1',
                    seq: 10,
                    createdAt: 10,
                    localId: 'codex:thread-1:12:abc123',
                    content: {
                        role: 'agent',
                        content: {
                            type: 'codex',
                            data: {
                                type: 'tool-call',
                                name: 'exec_command',
                                input: { cmd: 'pwd' }
                            }
                        },
                        meta: {
                            sentFrom: 'codex-desktop-sync'
                        }
                    }
                }
            ]
        })

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hello from hapi' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(takeoverCalls).toEqual([['session-1', 'default']])
        expect(sendMessageCalls).toEqual([
            ['session-1', {
                text: 'hello from hapi',
                localId: undefined,
                attachments: undefined,
                sentFrom: 'webapp'
            }]
        ])
    })

    it('still rejects a desktop mirror send when takeover reports the desktop is busy', async () => {
        const { app, sendMessageCalls, takeoverCalls } = createApp({
            takeoverResult: { type: 'error', code: 'takeover_busy', message: 'Desktop session is still running' },
            session: createSession({
                metadata: {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'codex',
                    mirrorSource: 'codex-desktop-sync',
                    executionControl: {
                        owner: 'desktop-sync',
                        generation: 1,
                        leaseExpiresAt: null,
                        runnerSessionId: null,
                        updatedAt: 1
                    }
                }
            })
        })

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hello from hapi' })
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
            error: 'Desktop session is still running',
            code: 'takeover_busy'
        })
        expect(takeoverCalls).toEqual([['session-1', 'default']])
        expect(sendMessageCalls).toEqual([])
    })

    it('automatically resumes an inactive native session before sending', async () => {
        const { app, sendMessageCalls, resumeCalls, takeoverCalls } = createApp({
            session: createSession({
                active: false,
                metadata: {
                    path: '/tmp/project',
                    host: 'localhost',
                    flavor: 'codex'
                }
            }),
            resumeResult: { type: 'success', sessionId: 'session-resumed' }
        })

        const response = await app.request('/api/sessions/session-1/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'resume then send' })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(takeoverCalls).toEqual([])
        expect(resumeCalls).toEqual([['session-1', 'default']])
        expect(sendMessageCalls).toEqual([
            ['session-resumed', {
                text: 'resume then send',
                localId: undefined,
                attachments: undefined,
                sentFrom: 'webapp'
            }]
        ])
    })

    const resumeFailures = [
        ['no_machine_online', 503],
        ['resume_unavailable', 409],
        ['access_denied', 403],
        ['session_not_found', 404],
        ['resume_failed', 500]
    ] as const

    for (const [code, status] of resumeFailures) {
        it(`maps ${code} resume failures before sending`, async () => {
            const { app, sendMessageCalls, resumeCalls, takeoverCalls } = createApp({
                session: createSession({
                    active: false,
                    metadata: {
                        path: '/tmp/project',
                        host: 'localhost',
                        flavor: 'codex'
                    }
                }),
                resumeResult: { type: 'error', code, message: `resume failed: ${code}` }
            })

            const response = await app.request('/api/sessions/session-1/messages', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text: 'resume then send' })
            })

            expect(response.status).toBe(status)
            expect(await response.json()).toEqual({
                error: `resume failed: ${code}`,
                code
            })
            expect(takeoverCalls).toEqual([])
            expect(resumeCalls).toEqual([['session-1', 'default']])
            expect(sendMessageCalls).toEqual([])
        })
    }
})
