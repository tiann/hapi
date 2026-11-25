import { describe, expect, it, mock } from 'bun:test'
import { resolveQqBotSettings } from '../config/qqBotSettings'
import { NotificationHub } from '../notifications/notificationHub'
import { RpcRegistry } from '../socket/rpcRegistry'
import { Store } from '../store'
import { SyncEngine, type Session } from '../sync/syncEngine'
import { VisibilityTracker } from '../visibility/visibilityTracker'
import { QqBotChannel } from './channel'
import { QqBotClient } from './client'

const config = {
    appId: '12345', appSecret: 'test-secret', userOpenId: 'test-open-id', namespace: 'work', backgroundOnly: false
}
const baseUrl = 'https://hapi.example.test:38443/base?token=should-not-be-shared#fragment'
const tokenUrl = 'https://api.bot.qq.com/app/getAppAccessToken'
const messageUrl = 'https://api.bot.qq.com/v2/users/test-open-id/messages'
const pendingPermission = { requests: { req: { tool: 'Read', arguments: {}, createdAt: 1 } } }
const tokenResponse = (token = 'test-token', expiresIn: string | number = '7200') => Response.json({
    access_token: token, expires_in: expiresIn
})

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1', namespace: 'work', seq: 1, createdAt: 0, updatedAt: 0,
        active: true, activeAt: 0, thinking: false, thinkingAt: 0,
        metadata: { path: '/workspace/project', host: 'test', name: 'My session' },
        metadataVersion: 0, agentState: null, agentStateVersion: 0,
        model: null, modelReasoningEffort: null, effort: null, serviceTier: null, ...overrides
    }
}

function mockFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response> = (url) => (
    url === tokenUrl ? tokenResponse() : Response.json({ id: 'message-id' })
)) {
    return mock(async (url: string | URL | Request, init?: RequestInit) => respond(String(url), init))
}

function getBody(init?: RequestInit) {
    return JSON.parse(String(init?.body))
}

describe('QQ bot DM notifications', () => {
    it('sends all three events as proactive Markdown, sharing one token and never including URL credentials', async () => {
        const fetch = mockFetch()
        const channel = new QqBotChannel(config, baseUrl, new VisibilityTracker(), () => createSession({ agentState: pendingPermission }), fetch)
        const session = createSession({ agentState: pendingPermission })
        await Promise.all([
            channel.sendReady(session),
            channel.sendPermissionRequest(session),
            channel.sendSessionCompletion(createSession({ active: false }), 'completed')
        ])

        expect(fetch.mock.calls.filter(([url]) => url === tokenUrl)).toHaveLength(1)
        const [auth] = fetch.mock.calls
        expect(auth?.[1]).toMatchObject({ method: 'POST', redirect: 'error' })
        expect(getBody(auth?.[1])).toEqual({ appId: '12345', clientSecret: 'test-secret' })
        const sends = fetch.mock.calls.filter(([url]) => url === messageUrl)
        expect(sends).toHaveLength(3)
        const content = sends.map(([, init]) => {
            expect(new Headers(init?.headers).get('authorization')).toBe('QQBot test-token')
            expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
            const payload = getBody(init)
            expect(Object.keys(payload).sort()).toEqual(['markdown', 'msg_type'])
            expect(payload.msg_type).toBe(2)
            expect(payload.markdown.content).toContain('[Open HAPI session](https://hapi.example.test:38443/sessions/session-1)')
            expect(payload.markdown.content).toContain('Session: session-\n')
            expect(payload.markdown.content).not.toContain('My session')
            expect(payload.markdown.content).not.toContain('should-not-be-shared')
            return payload.markdown.content
        })
        expect(content).toEqual(expect.arrayContaining([
            expect.stringContaining('HAPI Ready for input'),
            expect.stringContaining('HAPI Permission Request'),
            expect.stringContaining('HAPI Session completed')
        ]))
    })

    it('suppresses background-only delivery in its namespace without authenticating', async () => {
        const fetch = mockFetch()
        const visibility = new VisibilityTracker()
        visibility.registerConnection('work-open', 'work', 'visible')
        visibility.registerConnection('other-open', 'other', 'visible')
        const channel = new QqBotChannel({ ...config, backgroundOnly: true }, baseUrl, visibility, () => createSession({ agentState: pendingPermission }), fetch)
        await channel.sendReady(createSession())
        await channel.sendPermissionRequest(createSession({ agentState: pendingPermission }))
        await channel.sendSessionCompletion(createSession(), 'completed')
        expect(fetch).not.toHaveBeenCalled()

        visibility.removeConnection('work-open')
        visibility.registerConnection('work-hidden', 'work', 'hidden')
        await channel.sendReady(createSession())
        expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('never sends outside its namespace, for inactive ready/permission or for a failed session end', async () => {
        const fetch = mockFetch()
        const channel = new QqBotChannel(config, baseUrl, new VisibilityTracker(), () => createSession({ agentState: pendingPermission }), fetch)
        const other = createSession({ namespace: 'other', agentState: pendingPermission })
        await channel.sendReady(other)
        await channel.sendPermissionRequest(other)
        await channel.sendSessionCompletion(other, 'completed')
        await channel.sendReady(createSession({ active: false }))
        await channel.sendPermissionRequest(createSession({ active: false, agentState: pendingPermission }))
        await channel.sendSessionCompletion(createSession(), 'error')
        expect(fetch).not.toHaveBeenCalled()
    })

    it('does not authenticate or send when there is nothing left to answer', async () => {
        const fetch = mockFetch()
        const channel = new QqBotChannel(config, baseUrl, new VisibilityTracker(), () => createSession({ agentState: pendingPermission }), fetch)
        await channel.sendPermissionRequest(createSession({ agentState: { requests: {} } }))
        expect(fetch).not.toHaveBeenCalled()
    })

    it.each([false, true])('does not submit a permission alert cleared during token acquisition (retry: %s)', async (retry) => {
        const authStarted = Promise.withResolvers<void>()
        const releaseAuth = Promise.withResolvers<Response>()
        let authentications = 0
        let current = createSession({ agentState: pendingPermission })
        const fetch = mockFetch((url) => {
            if (url === messageUrl) return new Response(null, { status: 401 })
            if (++authentications === 1 && retry) return tokenResponse()
            authStarted.resolve()
            return releaseAuth.promise
        })
        const channel = new QqBotChannel(config, baseUrl, new VisibilityTracker(), () => current, fetch)
        const delivery = channel.sendPermissionRequest(current)
        try {
            await Promise.race([authStarted.promise, delivery.then(() => { throw new Error('Authentication was not reached') })])
            current = createSession({ agentState: { requests: {} } })
        } finally {
            releaseAuth.resolve(tokenResponse())
        }
        await delivery
        expect(fetch.mock.calls.filter(([url]) => url === messageUrl)).toHaveLength(retry ? 1 : 0)
    })

    it.each(['imported name', 'generated summary', 'workspace path'])(
        'keeps private session metadata and input request arguments out of QQ (%s)', async (source) => {
            const fetch = mockFetch()
            const visibility = new VisibilityTracker()
            visibility.registerConnection('open', 'work', 'visible')
            const secret = 'private-fixture-text'
            const id = '7b134bd8-3e07-4fc8-a5ed-938a04d68780'
            const session = createSession({
                id,
                metadata: {
                    host: 'test', path: `/workspace/${secret}`,
                    ...(source === 'imported name' ? { name: secret } : {}),
                    ...(source === 'generated summary' ? { summary: { text: secret, updatedAt: 1 } } : {})
                },
                agentState: { requests: { pending: { tool: 'AskUserQuestion', arguments: { questions: [{ question: 'private question' }] }, createdAt: 1 } } }
            })
            const channel = new QqBotChannel(config, baseUrl, visibility, () => session, fetch)
            await channel.sendPermissionRequest(session)
            const content = getBody(fetch.mock.calls[1]?.[1]).markdown.content
            expect(content).toBe(`**HAPI: Agent needs your input**\n\nSession: 7b134bd8\n\n[Open HAPI session](https://hapi.example.test:38443/sessions/${id})`)
            expect(content).not.toContain(secret)
            expect(content).not.toContain('private question')
        }
    )
})

it('delivers real SyncEngine notification events through NotificationHub to the QQ API boundary', async () => {
    const store = new Store(':memory:')
    const io = { of: () => ({ to: () => ({ emit() {} }) }) }
    const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
    const fetch = mockFetch()
    const scoped = resolveQqBotSettings({ enabled: true, ...config, namespace: 'team west' }, {}, baseUrl)!
    const channel = new QqBotChannel(scoped, baseUrl, new VisibilityTracker(), id => engine.getSession(id), fetch)
    const hub = new NotificationHub(engine, [channel], { readyCooldownMs: 60_000, permissionDebounceMs: 1 })
    const deliveries = () => fetch.mock.calls.filter(([url]) => url === messageUrl)
    const waitForMessageCount = async (count: number) => {
        const deadline = Date.now() + 1_000
        while (deliveries().length < count && Date.now() < deadline) await Bun.sleep(5)
        expect(deliveries()).toHaveLength(count)
    }
    try {
        const metadata = { path: '/workspace/test', host: 'test', name: 'Integration fixture' }
        const session = engine.getOrCreateSession('test-session', metadata, {}, scoped.namespace)
        const time = Date.now()
        engine.handleSessionAlive({ sid: session.id, time, mode: 'remote' })
        const readyMessage = {
            id: 'message-1', seq: 1, localId: null, createdAt: time,
            content: { role: 'agent', content: { type: 'event', data: { type: 'ready' } } }
        }
        engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message: readyMessage })
        engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message: readyMessage })
        const update = store.sessions.updateSessionAgentState(session.id, {
            requests: { req: { tool: 'Bash', arguments: { command: 'not for QQ' }, createdAt: time } }
        }, session.agentStateVersion, scoped.namespace)
        expect(update.result).toBe('success')
        engine.handleRealtimeEvent({ type: 'session-updated', sessionId: session.id })
        await waitForMessageCount(2)

        const foreign = engine.getOrCreateSession('foreign-session', metadata, {}, 'foreign')
        engine.handleSessionAlive({ sid: foreign.id, time, mode: 'remote' })
        engine.handleSessionEnd({ sid: foreign.id, time: time + 1, reason: 'completed' })
        engine.handleSessionEnd({ sid: session.id, time: time + 1, reason: 'completed' })
        await waitForMessageCount(3)
        const notifications = deliveries().map(([, init]) => getBody(init).markdown.content)
        expect(notifications).toEqual([
            expect.stringContaining('HAPI Ready for input'),
            expect.stringContaining('HAPI Permission Request'),
            expect.stringContaining('HAPI Session completed')
        ])
        expect(notifications.every(content => content.includes(`/sessions/${session.id}`))).toBe(true)
    } finally {
        hub.stop()
        engine.stop()
        store.close()
    }
})

it('suppresses a permission request cleared during the NotificationHub debounce', async () => {
    const store = new Store(':memory:')
    const io = { of: () => ({ to: () => ({ emit() {} }) }) }
    const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
    const fetch = mockFetch()
    const channel = new QqBotChannel(config, baseUrl, new VisibilityTracker(), id => engine.getSession(id), fetch)
    const dispatched = mock(async () => {})
    // This second channel confirms the debounce actually reached dispatch.
    const hub = new NotificationHub(engine, [channel, { sendReady: async () => {}, sendPermissionRequest: dispatched }], {
        permissionDebounceMs: 1
    })
    try {
        const session = engine.getOrCreateSession('cleared-request', { path: '/workspace/test', host: 'test' }, {}, config.namespace)
        const now = Date.now()
        engine.handleSessionAlive({ sid: session.id, time: now, mode: 'remote' })
        const first = store.sessions.updateSessionAgentState(session.id, {
            requests: { req: { tool: 'Read', arguments: {}, createdAt: now } }
        }, session.agentStateVersion, config.namespace)
        expect(first.result).toBe('success')
        if (first.result !== 'success') throw new Error('Could not set the pending request fixture')
        engine.handleRealtimeEvent({ type: 'session-updated', sessionId: session.id })
        const cleared = store.sessions.updateSessionAgentState(session.id, { requests: {} }, first.version, config.namespace)
        expect(cleared.result).toBe('success')
        engine.handleRealtimeEvent({ type: 'session-updated', sessionId: session.id })

        const deadline = Date.now() + 1_000
        while (dispatched.mock.calls.length === 0 && Date.now() < deadline) await Bun.sleep(5)
        expect(dispatched).toHaveBeenCalledTimes(1)
        expect(fetch).not.toHaveBeenCalled()
    } finally {
        hub.stop()
        engine.stop()
        store.close()
    }
})

describe('QQ bot transport', () => {
    it('refreshes tokens ahead of expiration', async () => {
        let now = 0
        let authorizations = 0
        const fetch = mockFetch((url) => url === tokenUrl
            ? tokenResponse(`token-${++authorizations}`, 120)
            : Response.json({ id: 'message-id' }))
        const client = new QqBotClient(config, fetch, () => now)
        await client.sendMarkdown('first')
        now = 59_000
        await client.sendMarkdown('second')
        now = 60_000
        await client.sendMarkdown('third')
        expect(authorizations).toBe(2)
        expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get('authorization')).toBe('QQBot token-2')
    })

    it('shares one refresh when simultaneous sends receive HTTP 401', async () => {
        let authorizations = 0
        const fetch = mockFetch((url, init) => {
            if (url === tokenUrl) return tokenResponse(`token-${++authorizations}`)
            return new Headers(init?.headers).get('authorization') === 'QQBot token-1'
                ? new Response(null, { status: 401 })
                : Response.json({ id: 'message-id' })
        })
        const client = new QqBotClient(config, fetch)
        await Promise.all([client.sendMarkdown('first'), client.sendMarkdown('second')])
        expect(authorizations).toBe(2)
        expect(fetch.mock.calls.filter(([url]) => url === messageUrl)).toHaveLength(4)
    })

    it('retries only once on HTTP 401', async () => {
        const fetch = mockFetch((url) => url === tokenUrl ? tokenResponse() : new Response(null, { status: 401 }))
        await expect(new QqBotClient(config, fetch).sendMarkdown('test')).rejects.toThrow('HTTP 401')
        expect(fetch.mock.calls.filter(([url]) => url === messageUrl)).toHaveLength(2)
    })

    it.each([403, 429, 500])('does not retry HTTP %i or include a sensitive response body', async (status) => {
        const fetch = mockFetch((url) => url === tokenUrl ? tokenResponse() : Response.json({
            code: 40034105, message: 'private response echo including test-secret'
        }, { status }))
        const result = new QqBotClient(config, fetch).sendMarkdown('test')
        await expect(result).rejects.toThrow(`QQ Bot message failed (HTTP ${status}, code 40034105)`)
        expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('redacts network errors and does not retry uncertain delivery', async () => {
        const fetch = mockFetch((url, init) => {
            if (url === tokenUrl) return tokenResponse()
            expect(init?.signal).toBeInstanceOf(AbortSignal)
            throw new Error('includes test-open-id and test-token')
        })
        await expect(new QqBotClient(config, fetch).sendMarkdown('test')).rejects.toThrow(/^QQ Bot message request failed$/)
        expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('does not cache a malformed token response and recovers on a later notification', async () => {
        let tokenRequests = 0
        const fetch = mockFetch((url) => url === tokenUrl
            ? (++tokenRequests === 1 ? tokenResponse('test-token', '') : tokenResponse())
            : Response.json({ id: 'message-id' }))
        const client = new QqBotClient(config, fetch)
        await expect(client.sendMarkdown('test')).rejects.toThrow('invalid token response')
        expect(fetch).toHaveBeenCalledTimes(1)
        await client.sendMarkdown('test again')
        expect(fetch).toHaveBeenCalledTimes(3)
    })

    it('rejects an unexpected success body without retrying', async () => {
        const fetch = mockFetch((url) => url === tokenUrl ? tokenResponse() : new Response('not JSON'))
        await expect(new QqBotClient(config, fetch).sendMarkdown('test')).rejects.toThrow('invalid message response')
        expect(fetch).toHaveBeenCalledTimes(2)
    })
})
