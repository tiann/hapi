import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { RpcRegistry } from '../socket/rpcRegistry'
import { Store } from '../store'
import { SyncEngine } from './syncEngine'

const originalFetch = globalThis.fetch
const titleProviderEnvironment = {
    HAPI_TITLE_PROVIDER_BASE_URL: 'https://provider.example/v1',
    HAPI_TITLE_PROVIDER_API_KEY: 'secret',
    HAPI_TITLE_PROVIDER_MODEL: 'small-model'
} as const

const titleProviderEnvironmentKeys = Object.keys(titleProviderEnvironment) as Array<keyof typeof titleProviderEnvironment>
let restoreTitleProviderEnvironment: (() => void) | undefined

beforeEach(() => {
    const previous = new Map<string, string | undefined>()
    for (const key of titleProviderEnvironmentKeys) {
        previous.set(key, process.env[key])
        process.env[key] = titleProviderEnvironment[key]
    }
    restoreTitleProviderEnvironment = () => {
        for (const key of titleProviderEnvironmentKeys) {
            const value = previous.get(key)
            if (value === undefined) {
                delete process.env[key]
            } else {
                process.env[key] = value
            }
        }
    }
})

afterEach(() => {
    globalThis.fetch = originalFetch
    restoreTitleProviderEnvironment?.()
    restoreTitleProviderEnvironment = undefined
})

describe('automatic first-turn title generation', () => {
    it.each([true, false])('retains a partially answered first turn across restart (thinking heartbeat: %s)', async (thinkingHeartbeat) => {
        let calls = 0
        globalThis.fetch = (async () => {
            calls++
            return Response.json({ choices: [{ message: { content: 'Restarted first turn' } }] })
        }) as unknown as typeof fetch
        const store = new Store(':memory:')
        const createEngine = () => new SyncEngine(store,
            { of: () => ({ to: () => ({ emit() {} }) }) } as never,
            new RpcRegistry(), { broadcast() {} } as never)
        let engine = createEngine()
        try {
            const session = engine.getOrCreateSession('partial-first-turn-restart',
                { path: '/project', host: 'test' }, null, 'tenant')
            const now = Date.now()
            store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'Explain deployment' } })
            engine.handleSessionAlive({ sid: session.id, time: now, thinking: true })
            store.messages.addMessage(session.id, { role: 'assistant', content: { type: 'text', text: 'Checking deployment' } })
            engine.stop()
            engine = createEngine()
            if (thinkingHeartbeat) engine.handleSessionAlive({ sid: session.id, time: now + 1, thinking: true })
            store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'Include rollback' } })
            store.messages.addMessage(session.id, { role: 'assistant', content: { type: 'text', text: 'Deployment and rollback explained' } })
            if (thinkingHeartbeat) {
                engine.handleSessionAlive({ sid: session.id, time: now + 2, thinking: false })
            } else {
                const ready = store.messages.addMessage(session.id,
                    { role: 'agent', content: { type: 'event', data: { type: 'ready' } } })
                engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message: ready })
            }
            for (let i = 0; i < 20 && !engine.getSession(session.id)?.metadata?.summary; i++) {
                await new Promise(resolve => setTimeout(resolve, 0))
            }
            expect(calls).toBe(1)
            expect(engine.getSession(session.id)?.metadata?.summary?.text).toBe('Restarted first turn')
        } finally {
            engine.stop()
            store.close()
        }
    })

    it.each(['batch', 'steer', 'heartbeat-steer'])('generates once for multiple prompts in the first %s turn', async (kind) => {
        let calls = 0
        globalThis.fetch = (async () => {
            calls++
            return Response.json({ choices: [{ message: { content: 'Deployment and rollback' } }] })
        }) as unknown as typeof fetch
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, { of: () => ({ to: () => ({ emit() {} }) }) } as never,
            new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession(`first-turn-${kind}`,
                { path: '/project', host: 'test' }, null, 'tenant')
            const now = Date.now()
            store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'Explain deployment' } }, 'initial')
            engine.handleSessionAlive({ sid: session.id, time: now, thinking: true })
            store.messages.markMessagesInvoked(session.id, ['initial'], now)
            if (kind !== 'batch') {
                store.messages.addMessage(session.id, { role: 'assistant', content: { type: 'text', text: 'Checking deployment' } })
            }
            store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'Include rollback' } }, 'additional')
            store.messages.markMessagesInvoked(session.id, ['additional'], now)
            store.messages.addMessage(session.id, { role: 'assistant', content: { type: 'text', text: 'Deployment and rollback explained' } })
            if (kind === 'steer') {
                const ready = store.messages.addMessage(session.id,
                    { role: 'agent', content: { type: 'event', data: { type: 'ready' } } })
                engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message: ready })
            }
            engine.handleSessionAlive({ sid: session.id, time: now + 1, thinking: false })
            for (let i = 0; i < 20 && !engine.getSession(session.id)?.metadata?.summary; i++) {
                await new Promise(resolve => setTimeout(resolve, 0))
            }
            expect(calls).toBe(1)
            expect(engine.getSession(session.id)?.metadata?.summary?.text).toBe('Deployment and rollback')
        } finally {
            engine.stop()
            store.close()
        }
    })

    it.each(['ready', 'idle-without-completion', 'thinking'])('handles the %s completion boundary', async (boundary) => {
        let calls = 0
        globalThis.fetch = (async () => {
            calls++
            return Response.json({ choices: [{ message: { content: 'Ready boundary title' } }] })
        }) as unknown as typeof fetch
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, { of: () => ({ to: () => ({ emit() {} }) }) } as never,
            new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession(`boundary-${boundary}`,
                { path: '/project', host: 'test' }, null, 'tenant')
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: boundary === 'thinking' })
            store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'Explain deployment' } })
            const assistant = store.messages.addMessage(session.id,
                { role: 'assistant', content: { type: 'text', text: 'Here is the deployment process' } })
            engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message: assistant })
            await new Promise(resolve => setTimeout(resolve, 0))
            expect(calls).toBe(0)
            if (boundary === 'ready') {
                const ready = store.messages.addMessage(session.id,
                    { role: 'agent', content: { type: 'event', data: { type: 'ready' } } })
                engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message: ready })
                for (let i = 0; i < 20 && !engine.getSession(session.id)?.metadata?.summary; i++) {
                    await new Promise(resolve => setTimeout(resolve, 0))
                }
                expect(calls).toBe(1)
                expect(engine.getSession(session.id)?.metadata?.summary?.text).toBe('Ready boundary title')
                expect(engine.getSession(session.id)?.namespace).toBe('tenant')
            }
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('runs after the thinking transition and persists the generated summary', async () => {
        const requests: Request[] = []
        globalThis.fetch = (async (input, init) => {
            requests.push(new Request(String(input), init))
            return new Response(JSON.stringify({
                choices: [{ message: { content: 'Deployment workflow' } }]
            }), { status: 200 })
        }) as typeof fetch

        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            { of: () => ({ to: () => ({ emit: () => {} }) }) } as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'automatic-first-turn',
                { path: '/workspace/project', host: 'localhost' },
                null,
                'default'
            )

            const now = Date.now()
            engine.handleSessionAlive({ sid: session.id, time: now, thinking: false })
            store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'Explain the deployment workflow' }
            })
            engine.handleSessionAlive({ sid: session.id, time: now + 1, thinking: true })
            store.messages.addMessage(session.id, {
                role: 'assistant',
                content: { type: 'text', text: 'The workflow has three steps.' }
            })
            engine.handleSessionAlive({ sid: session.id, time: now + 2, thinking: false })

            for (let attempt = 0; attempt < 20; attempt += 1) {
                if (engine.getSession(session.id)?.metadata?.summary?.text) break
                await new Promise((resolve) => setTimeout(resolve, 0))
            }

            expect(requests).toHaveLength(1)
            expect(requests[0]?.url).toBe('https://provider.example/v1/chat/completions')
            expect(engine.getSession(session.id)?.metadata).toMatchObject({
                summary: { text: 'Deployment workflow' },
                titleSuggestionAutoAttemptedAt: expect.any(Number)
            })
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('runs on a completed session end when no false heartbeat was observed', async () => {
        const requests: Request[] = []
        globalThis.fetch = (async (input, init) => {
            requests.push(new Request(String(input), init))
            return new Response(JSON.stringify({
                choices: [{ message: { content: 'Completed workflow' } }]
            }), { status: 200 })
        }) as typeof fetch

        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            { of: () => ({ to: () => ({ emit: () => {} }) }) } as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'automatic-session-end',
                { path: '/workspace/project', host: 'localhost' },
                null,
                'default'
            )
            const now = Date.now()
            engine.handleSessionAlive({ sid: session.id, time: now, thinking: true })
            store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'Summarize the completed workflow' }
            })
            store.messages.addMessage(session.id, {
                role: 'assistant',
                content: { type: 'text', text: 'The workflow completed successfully.' }
            })
            engine.handleSessionEnd({ sid: session.id, time: now + 1, reason: 'completed' })

            for (let attempt = 0; attempt < 20; attempt += 1) {
                if (engine.getSession(session.id)?.metadata?.summary?.text) break
                await new Promise((resolve) => setTimeout(resolve, 0))
            }

            expect(requests).toHaveLength(1)
            expect(engine.getSession(session.id)?.metadata?.summary?.text).toBe('Completed workflow')
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('runs when the first assistant message arrives after the session is already idle', async () => {
        const requests: Request[] = []
        globalThis.fetch = (async (input, init) => {
            requests.push(new Request(String(input), init))
            return new Response(JSON.stringify({
                choices: [{ message: { content: 'Idle session workflow' } }]
            }), { status: 200 })
        }) as typeof fetch

        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            { of: () => ({ to: () => ({ emit: () => {} }) }) } as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'automatic-message-arrival',
                { path: '/workspace/project', host: 'localhost' },
                null,
                'default'
            )
            const now = Date.now()
            engine.handleSessionAlive({ sid: session.id, time: now, thinking: false })
            store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'Summarize the idle workflow' }
            })
            engine.handleSessionAlive({ sid: session.id, time: now + 1, thinking: true })
            engine.handleSessionAlive({ sid: session.id, time: now + 2, thinking: false })
            const assistant = store.messages.addMessage(session.id, {
                role: 'assistant',
                content: { type: 'text', text: 'The workflow is complete.' }
            })
            engine.handleRealtimeEvent({
                type: 'message-received',
                sessionId: session.id,
                message: {
                    id: assistant.id,
                    seq: assistant.seq,
                    localId: assistant.localId,
                    content: assistant.content,
                    createdAt: assistant.createdAt,
                    invokedAt: assistant.invokedAt
                }
            } as never)

            for (let attempt = 0; attempt < 20; attempt += 1) {
                if (engine.getSession(session.id)?.metadata?.summary?.text) break
                await new Promise((resolve) => setTimeout(resolve, 0))
            }

            expect(requests).toHaveLength(1)
            expect(engine.getSession(session.id)?.metadata?.summary?.text).toBe('Idle session workflow')
        } finally {
            engine.stop()
            store.close()
        }
    })

    it.each(['error', 'terminated', 'cleared'])('runs the title fallback when the session ends via %s without a turn boundary', async (reason) => {
        const requests: Request[] = []
        globalThis.fetch = (async (input, init) => {
            requests.push(new Request(String(input), init))
            return new Response(JSON.stringify({
                choices: [{ message: { content: 'Interrupted workflow' } }]
            }), { status: 200 })
        }) as typeof fetch

        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            { of: () => ({ to: () => ({ emit: () => {} }) }) } as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                `session-end-${reason}`,
                { path: '/workspace/project', host: 'localhost' },
                null,
                'default'
            )
            const now = Date.now()
            // The thinking-true transition opens the turn; the matching
            // thinking-false transition never arrives (dropped heartbeat), so
            // the session end below is the only remaining turn boundary.
            engine.handleSessionAlive({ sid: session.id, time: now, thinking: true })
            store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'Summarize the interrupted workflow' }
            })
            store.messages.addMessage(session.id, {
                role: 'assistant',
                content: { type: 'text', text: 'The workflow was interrupted midway.' }
            })
            engine.handleSessionEnd({ sid: session.id, time: now + 1, reason })

            for (let attempt = 0; attempt < 20; attempt += 1) {
                if (engine.getSession(session.id)?.metadata?.summary?.text) break
                await new Promise((resolve) => setTimeout(resolve, 0))
            }

            expect(requests).toHaveLength(1)
            expect(engine.getSession(session.id)?.metadata?.summary?.text).toBe('Interrupted workflow')
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('seeds the prompt title from a transcript echo of the first prompt', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            { of: () => ({ to: () => ({ emit: () => {} }) }) } as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'prompt-title-echo',
                { path: '/workspace/project', host: 'localhost' },
                null,
                'default'
            )
            // A web-spawned ACP session replays its queued first prompt from
            // the CLI transcript with isTranscriptEcho set; the queued row
            // itself never emits message-received.
            const echo = store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'Why do deployment pipelines fail?' },
                meta: { isTranscriptEcho: true }
            })
            engine.handleRealtimeEvent({
                type: 'message-received',
                sessionId: session.id,
                message: {
                    id: echo.id,
                    seq: echo.seq,
                    localId: echo.localId,
                    content: echo.content,
                    createdAt: echo.createdAt,
                    invokedAt: echo.invokedAt
                }
            } as never)
            await new Promise((resolve) => setTimeout(resolve, 0))

            expect(engine.getSession(session.id)?.metadata?.promptTitle).toBe('Why do deployment pipelines fail?')

            // The gate holds once a real title exists: a later echo of a
            // different prompt must not replace it.
            const laterEcho = store.messages.addMessage(session.id, {
                role: 'user',
                content: { type: 'text', text: 'Unrelated second topic arrives later' },
                meta: { isTranscriptEcho: true }
            })
            engine.handleRealtimeEvent({
                type: 'message-received',
                sessionId: session.id,
                message: {
                    id: laterEcho.id,
                    seq: laterEcho.seq,
                    localId: laterEcho.localId,
                    content: laterEcho.content,
                    createdAt: laterEcho.createdAt,
                    invokedAt: laterEcho.invokedAt
                }
            } as never)
            await new Promise((resolve) => setTimeout(resolve, 0))

            expect(engine.getSession(session.id)?.metadata?.promptTitle).toBe('Why do deployment pipelines fail?')
        } finally {
            engine.stop()
            store.close()
        }
    })
})
