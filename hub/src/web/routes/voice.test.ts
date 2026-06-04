import { describe, expect, it, mock, test, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import type { WebAppEnv } from '../middleware/auth'
import { createAuthMiddleware } from '../middleware/auth'
import { createVoiceRoutes } from './voice'

const JWT_SECRET = new TextEncoder().encode('test-secret')

async function authHeaders() {
    const token = await new SignJWT({ uid: 1, ns: 'default' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(JWT_SECRET)
    return { authorization: `Bearer ${token}` }
}

function createApp() {
    const app = new Hono<WebAppEnv>()
    app.use('*', createAuthMiddleware(JWT_SECRET))
    app.route('/api', createVoiceRoutes())
    return app
}

describe('GET /api/voice/voices', () => {
    it('returns 401 without auth', async () => {
        const app = createApp()
        const res = await app.request('/api/voice/voices')
        expect(res.status).toBe(401)
    })

    it('returns empty list when ELEVENLABS_API_KEY is not set', async () => {
        const app = createApp()
        const headers = await authHeaders()
        const prev = process.env.ELEVENLABS_API_KEY
        delete process.env.ELEVENLABS_API_KEY

        const res = await app.request('/api/voice/voices', { headers })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ voices: [] })

        if (prev) process.env.ELEVENLABS_API_KEY = prev
    })

    it('maps ElevenLabs voice fields correctly', async () => {
        const app = createApp()
        const headers = await authHeaders()
        const prev = process.env.ELEVENLABS_API_KEY
        process.env.ELEVENLABS_API_KEY = 'test-key'

        const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify({
            voices: [
                { voice_id: 'v1', name: 'Alice', preview_url: 'https://cdn.example/a.mp3', category: 'premade' },
                { voice_id: 'v2', name: 'MyClone', preview_url: 'https://cdn.example/c.mp3', category: 'cloned' },
            ]
        }), { status: 200 })))

        const originalFetch = global.fetch
        // @ts-expect-error test override
        global.fetch = fetchMock

        const res = await app.request('/api/voice/voices', { headers })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            voices: [
                { id: 'v1', name: 'Alice', previewUrl: 'https://cdn.example/a.mp3', category: 'premade' },
                { id: 'v2', name: 'MyClone', previewUrl: 'https://cdn.example/c.mp3', category: 'cloned' },
            ]
        })

        global.fetch = originalFetch
        if (prev) process.env.ELEVENLABS_API_KEY = prev
        else delete process.env.ELEVENLABS_API_KEY
    })
})

describe('POST /api/voice/token', () => {
    it('creates/selects voice-specific agent when voiceId is provided', async () => {
        const app = createApp()
        const headers = {
            ...(await authHeaders()),
            'content-type': 'application/json'
        }

        const prevKey = process.env.ELEVENLABS_API_KEY
        const prevAgent = process.env.ELEVENLABS_AGENT_ID
        process.env.ELEVENLABS_API_KEY = 'test-key'
        delete process.env.ELEVENLABS_AGENT_ID

        const requests: Array<{ url: string; init?: RequestInit }> = []
        const originalFetch = global.fetch
        // @ts-expect-error test override
        global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input)
            requests.push({ url, init })

            if (url.endsWith('/convai/agents') && init?.method === 'GET') {
                return new Response(JSON.stringify({ agents: [] }), { status: 200 })
            }
            if (url.endsWith('/convai/agents/create') && init?.method === 'POST') {
                return new Response(JSON.stringify({ agent_id: 'agent_voice_alice' }), { status: 200 })
            }
            if (url.includes('/convai/conversation/token?agent_id=')) {
                return new Response(JSON.stringify({ token: 'tok_alice' }), { status: 200 })
            }
            return new Response('not found', { status: 404 })
        }) as typeof fetch

        const res = await app.request('/api/voice/token', {
            method: 'POST',
            headers,
            body: JSON.stringify({ voiceId: 'alice-voice-id' })
        })

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            allowed: true,
            token: 'tok_alice',
            agentId: 'agent_voice_alice'
        })

        const createCall = requests.find(r => r.url.endsWith('/convai/agents/create'))
        expect(createCall).toBeTruthy()
        const createBody = JSON.parse(String(createCall?.init?.body))
        expect(createBody.name).toContain('[voice:alice-voice-id]')
        expect(createBody.conversation_config?.tts?.voice_id).toBe('alice-voice-id')

        global.fetch = originalFetch
        if (prevKey) process.env.ELEVENLABS_API_KEY = prevKey
        else delete process.env.ELEVENLABS_API_KEY
        if (prevAgent) process.env.ELEVENLABS_AGENT_ID = prevAgent
        else delete process.env.ELEVENLABS_AGENT_ID
    })

    it('prefers voice-specific agent over ELEVENLABS_AGENT_ID when voiceId is provided', async () => {
        const app = createApp()
        const headers = {
            ...(await authHeaders()),
            'content-type': 'application/json'
        }

        const prevKey = process.env.ELEVENLABS_API_KEY
        const prevAgent = process.env.ELEVENLABS_AGENT_ID
        process.env.ELEVENLABS_API_KEY = 'test-key'
        process.env.ELEVENLABS_AGENT_ID = 'env_default_agent'

        const requests: Array<{ url: string; init?: RequestInit }> = []
        const originalFetch = global.fetch
        // @ts-expect-error test override
        global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input)
            requests.push({ url, init })

            if (url.endsWith('/convai/agents') && init?.method === 'GET') {
                return new Response(JSON.stringify({ agents: [] }), { status: 200 })
            }
            if (url.endsWith('/convai/agents/create') && init?.method === 'POST') {
                return new Response(JSON.stringify({ agent_id: 'agent_voice_jessicax' }), { status: 200 })
            }
            if (url.includes('/convai/conversation/token?agent_id=')) {
                return new Response(JSON.stringify({ token: 'tok_jessicax' }), { status: 200 })
            }
            return new Response('not found', { status: 404 })
        }) as typeof fetch

        const res = await app.request('/api/voice/token', {
            method: 'POST',
            headers,
            body: JSON.stringify({ voiceId: 'jessicax-voice-id' })
        })

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            allowed: true,
            token: 'tok_jessicax',
            agentId: 'agent_voice_jessicax'
        })

        const tokenCall = requests.find(r => r.url.includes('/convai/conversation/token?agent_id='))
        expect(tokenCall?.url).toContain('agent_id=agent_voice_jessicax')
        expect(tokenCall?.url).not.toContain('agent_id=env_default_agent')

        global.fetch = originalFetch
        if (prevKey) process.env.ELEVENLABS_API_KEY = prevKey
        else delete process.env.ELEVENLABS_API_KEY
        if (prevAgent) process.env.ELEVENLABS_AGENT_ID = prevAgent
        else delete process.env.ELEVENLABS_AGENT_ID
    })
})

describe('GET /api/voice/backend', () => {
    const originalEnv = process.env.VOICE_BACKEND

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env.VOICE_BACKEND
        } else {
            process.env.VOICE_BACKEND = originalEnv
        }
    })

    test('returns elevenlabs by default', async () => {
        delete process.env.VOICE_BACKEND
        const app = createApp()
        const headers = await authHeaders()
        const res = await app.request('/api/voice/backend', { headers })
        expect(res.status).toBe(200)
        const body = await res.json() as { backend: string }
        expect(body.backend).toBe('elevenlabs')
    })

    test('returns gemini-live when configured', async () => {
        process.env.VOICE_BACKEND = 'gemini-live'
        const app = createApp()
        const headers = await authHeaders()
        const res = await app.request('/api/voice/backend', { headers })
        expect(res.status).toBe(200)
        const body = await res.json() as { backend: string }
        expect(body.backend).toBe('gemini-live')
    })

    test('returns qwen-realtime when configured', async () => {
        process.env.VOICE_BACKEND = 'qwen-realtime'
        const app = createApp()
        const headers = await authHeaders()
        const res = await app.request('/api/voice/backend', { headers })
        expect(res.status).toBe(200)
        const body = await res.json() as { backend: string }
        expect(body.backend).toBe('qwen-realtime')
    })

    test('falls back to elevenlabs for unknown values', async () => {
        process.env.VOICE_BACKEND = 'unknown-backend'
        const app = createApp()
        const headers = await authHeaders()
        const res = await app.request('/api/voice/backend', { headers })
        expect(res.status).toBe(200)
        const body = await res.json() as { backend: string }
        expect(body.backend).toBe('elevenlabs')
    })
})

describe('POST /api/voice/gemini-token', () => {
    const origGemini = process.env.GEMINI_API_KEY
    const origGoogle = process.env.GOOGLE_API_KEY

    afterEach(() => {
        if (origGemini === undefined) delete process.env.GEMINI_API_KEY
        else process.env.GEMINI_API_KEY = origGemini
        if (origGoogle === undefined) delete process.env.GOOGLE_API_KEY
        else process.env.GOOGLE_API_KEY = origGoogle
    })

    test('returns 400 when no API key configured', async () => {
        delete process.env.GEMINI_API_KEY
        delete process.env.GOOGLE_API_KEY
        const app = createApp()
        const headers = await authHeaders()
        const res = await app.request('/api/voice/gemini-token', { method: 'POST', headers })
        expect(res.status).toBe(400)
        const body = await res.json() as { allowed: boolean; error: string }
        expect(body.allowed).toBe(false)
        expect(body.error).toContain('not configured')
    })

    test('returns proxied wsUrl when GEMINI_API_KEY is set', async () => {
        process.env.GEMINI_API_KEY = 'test-gemini-key'
        delete process.env.GOOGLE_API_KEY
        const app = createApp()
        const headers = await authHeaders()
        const res = await app.request('/api/voice/gemini-token', { method: 'POST', headers })
        expect(res.status).toBe(200)
        const body = await res.json() as { allowed: boolean; apiKey: string; wsUrl: string }
        expect(body.allowed).toBe(true)
        expect(body.apiKey).toBe('proxied')
        expect(body.wsUrl).toContain('/api/voice/gemini-ws')
    })

    test('falls back to GOOGLE_API_KEY', async () => {
        delete process.env.GEMINI_API_KEY
        process.env.GOOGLE_API_KEY = 'test-google-key'
        const app = createApp()
        const headers = await authHeaders()
        const res = await app.request('/api/voice/gemini-token', { method: 'POST', headers })
        expect(res.status).toBe(200)
        const body = await res.json() as { allowed: boolean; apiKey: string; wsUrl: string }
        expect(body.allowed).toBe(true)
        expect(body.apiKey).toBe('proxied')
        expect(body.wsUrl).toContain('/api/voice/gemini-ws')
    })
})

describe('POST /api/voice/qwen-token', () => {
    const origDash = process.env.DASHSCOPE_API_KEY
    const origQwen = process.env.QWEN_API_KEY

    afterEach(() => {
        if (origDash === undefined) delete process.env.DASHSCOPE_API_KEY
        else process.env.DASHSCOPE_API_KEY = origDash
        if (origQwen === undefined) delete process.env.QWEN_API_KEY
        else process.env.QWEN_API_KEY = origQwen
    })

    test('returns 400 when no API key configured', async () => {
        delete process.env.DASHSCOPE_API_KEY
        delete process.env.QWEN_API_KEY
        const app = createApp()
        const headers = await authHeaders()
        const res = await app.request('/api/voice/qwen-token', { method: 'POST', headers })
        expect(res.status).toBe(400)
        const body = await res.json() as { allowed: boolean; error: string }
        expect(body.allowed).toBe(false)
        expect(body.error).toContain('not configured')
    })

    test('returns wsUrl when DASHSCOPE_API_KEY is set (no raw key exposed)', async () => {
        process.env.DASHSCOPE_API_KEY = 'test-dash-key'
        delete process.env.QWEN_API_KEY
        const app = createApp()
        const headers = await authHeaders()
        const res = await app.request('/api/voice/qwen-token', { method: 'POST', headers })
        expect(res.status).toBe(200)
        const body = await res.json() as { allowed: boolean; wsUrl: string }
        expect(body.allowed).toBe(true)
        expect(body.wsUrl).toContain('/api/voice/qwen-ws')
        expect(body).not.toHaveProperty('apiKey')
    })

    test('falls back to QWEN_API_KEY', async () => {
        delete process.env.DASHSCOPE_API_KEY
        process.env.QWEN_API_KEY = 'test-qwen-key'
        const app = createApp()
        const headers = await authHeaders()
        const res = await app.request('/api/voice/qwen-token', { method: 'POST', headers })
        expect(res.status).toBe(200)
        const body = await res.json() as { allowed: boolean; wsUrl: string }
        expect(body.allowed).toBe(true)
        expect(body.wsUrl).toContain('/api/voice/qwen-ws')
        expect(body).not.toHaveProperty('apiKey')
    })
})
