import { describe, expect, it, mock, test, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import type { WebAppEnv } from '../middleware/auth'
import { createAuthMiddleware } from '../middleware/auth'
import { createVoiceRoutes } from './voice'
import { resetProviderCredentialEnvLocksForTests } from '../../config/providerCredentials'

const JWT_SECRET = new TextEncoder().encode('test-secret')

async function authHeaders() {
    const token = await new SignJWT({ uid: 1, ns: 'default' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(JWT_SECRET)
    return { authorization: `Bearer ${token}` }
}

function createApp(dataDir?: string) {
    const app = new Hono<WebAppEnv>()
    app.use('*', createAuthMiddleware(JWT_SECRET))
    app.route('/api', createVoiceRoutes(dataDir ? { dataDir } : {}))
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

describe('voice transcription routes', () => {
    test('discovers only providers configured at hub startup', async () => {
        const app = createApp()
        const headers = await authHeaders()
        const previous = {
            openai: process.env.OPENAI_API_KEY,
            elevenlabs: process.env.ELEVENLABS_API_KEY,
            deepgram: process.env.DEEPGRAM_API_KEY,
            groq: process.env.GROQ_API_KEY,
            baseUrl: process.env.TRANSCRIPTION_BASE_URL,
            model: process.env.TRANSCRIPTION_MODEL
        }
        delete process.env.OPENAI_API_KEY
        delete process.env.ELEVENLABS_API_KEY
        delete process.env.DEEPGRAM_API_KEY
        delete process.env.GROQ_API_KEY
        delete process.env.TRANSCRIPTION_BASE_URL
        delete process.env.TRANSCRIPTION_MODEL
        process.env.OPENAI_API_KEY = 'server-only-key'
        process.env.TRANSCRIPTION_BASE_URL = 'http://localhost:8000/v1'
        process.env.TRANSCRIPTION_MODEL = 'local-whisper'

        const res = await app.request('/api/voice/transcription/providers', { headers })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ providers: [
            { id: 'openai', label: 'OpenAI', modes: ['standard', 'realtime'] },
            { id: 'openai-compatible', label: 'OpenAI-compatible / local', modes: ['standard'] }
        ] })

        for (const [key, value] of Object.entries({
            OPENAI_API_KEY: previous.openai,
            ELEVENLABS_API_KEY: previous.elevenlabs,
            DEEPGRAM_API_KEY: previous.deepgram,
            GROQ_API_KEY: previous.groq,
            TRANSCRIPTION_BASE_URL: previous.baseUrl,
            TRANSCRIPTION_MODEL: previous.model
        })) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    })

    test('proxies a bounded recording to OpenAI with the default best model', async () => {
        const app = createApp()
        const headers = await authHeaders()
        const previousKey = process.env.OPENAI_API_KEY
        process.env.OPENAI_API_KEY = 'server-only-key'
        const originalFetch = global.fetch
        let upstreamUrl = ''
        let upstreamInit: RequestInit | undefined
        // @ts-expect-error test override
        global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            upstreamUrl = String(input)
            upstreamInit = init
            return new Response(JSON.stringify({ text: 'transcribed text', language: 'en' }), { status: 200 })
        }) as typeof fetch

        const form = new FormData()
        form.set('provider', 'openai')
        form.set('mode', 'standard')
        form.set('language', 'zh-CN')
        form.set('file', new File(['audio bytes'], 'speech.webm', { type: 'audio/webm' }))
        const res = await app.request('/api/voice/transcription', { method: 'POST', headers, body: form })

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ text: 'transcribed text', language: 'en' })
        expect(upstreamUrl).toBe('https://api.openai.com/v1/audio/transcriptions')
        expect(new Headers(upstreamInit?.headers).get('authorization')).toBe('Bearer server-only-key')
        expect(upstreamInit?.body).toBeInstanceOf(FormData)
        expect((upstreamInit?.body as FormData).get('model')).toBe('gpt-transcribe')
        expect((upstreamInit?.body as FormData).get('languages[]')).toBe('zh-cn')

        form.set('language', 'en-US')
        const englishRes = await app.request('/api/voice/transcription', { method: 'POST', headers, body: form })
        expect(englishRes.status).toBe(200)
        expect((upstreamInit?.body as FormData).get('languages[]')).toBe('en')

        global.fetch = originalFetch
        if (previousKey === undefined) delete process.env.OPENAI_API_KEY
        else process.env.OPENAI_API_KEY = previousKey
    })

    test('rejects unsupported files before calling a provider', async () => {
        const app = createApp()
        const headers = await authHeaders()
        const form = new FormData()
        form.set('provider', 'openai')
        form.set('file', new File(['not audio'], 'notes.txt', { type: 'text/plain' }))

        const res = await app.request('/api/voice/transcription', { method: 'POST', headers, body: form })
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ error: 'Unsupported audio file type' })
    })

    test('rejects oversized request bodies before multipart parsing', async () => {
        const app = createApp()
        const res = await app.request('/api/voice/transcription', {
            method: 'POST',
            headers: {
                ...(await authHeaders()),
                'content-length': String(27 * 1024 * 1024),
                'content-type': 'multipart/form-data; boundary=test'
            },
            body: '--test--'
        })

        expect(res.status).toBe(413)
        expect(await res.json()).toEqual({ error: 'Audio file too large' })
    })

    test('mints provider-specific short-lived realtime credentials without exposing API keys', async () => {
        const app = createApp()
        const headers = { ...(await authHeaders()), 'content-type': 'application/json' }
        const previous = {
            openai: process.env.OPENAI_API_KEY,
            elevenlabs: process.env.ELEVENLABS_API_KEY,
            deepgram: process.env.DEEPGRAM_API_KEY
        }
        process.env.OPENAI_API_KEY = 'openai-server-key'
        process.env.ELEVENLABS_API_KEY = 'elevenlabs-server-key'
        process.env.DEEPGRAM_API_KEY = 'deepgram-server-key'
        const originalFetch = global.fetch
        const requests: Array<{ url: string; init?: RequestInit }> = []
        // @ts-expect-error test override
        global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input)
            requests.push({ url, init })
            if (url.endsWith('/realtime/client_secrets')) {
                return new Response(JSON.stringify({ value: 'openai-client-token' }), { status: 200 })
            }
            if (url.endsWith('/single-use-token/realtime_scribe')) {
                return new Response(JSON.stringify({ token: 'elevenlabs-client-token' }), { status: 200 })
            }
            return new Response(JSON.stringify({ access_token: 'deepgram-client-token' }), { status: 200 })
        }) as typeof fetch

        for (const provider of ['openai', 'elevenlabs', 'deepgram'] as const) {
            const res = await app.request('/api/voice/transcription/realtime-token', {
                method: 'POST',
                headers,
                body: JSON.stringify({ provider, language: 'zh-TW' })
            })
            expect(res.status).toBe(200)
            expect(await res.json()).toEqual({ token: `${provider}-client-token` })
        }
        const englishOpenAI = await app.request('/api/voice/transcription/realtime-token', {
            method: 'POST',
            headers,
            body: JSON.stringify({ provider: 'openai', language: 'en-US' })
        })
        expect(englishOpenAI.status).toBe(200)

        expect(requests.map((request) => request.url)).toEqual([
            'https://api.openai.com/v1/realtime/client_secrets',
            'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe',
            'https://api.deepgram.com/v1/auth/grant',
            'https://api.openai.com/v1/realtime/client_secrets'
        ])
        expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe('Bearer openai-server-key')
        expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
            session: {
                type: 'transcription',
                audio: { input: { transcription: { model: 'gpt-live-transcribe', languages: ['zh-tw'] } } }
            }
        })
        expect(JSON.parse(String(requests[3]?.init?.body))).toMatchObject({
            session: { audio: { input: { transcription: { languages: ['en'] } } } }
        })
        expect(new Headers(requests[1]?.init?.headers).get('xi-api-key')).toBe('elevenlabs-server-key')
        expect(new Headers(requests[2]?.init?.headers).get('authorization')).toBe('Token deepgram-server-key')

        global.fetch = originalFetch
        for (const [key, value] of Object.entries({
            OPENAI_API_KEY: previous.openai,
            ELEVENLABS_API_KEY: previous.elevenlabs,
            DEEPGRAM_API_KEY: previous.deepgram
        })) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
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

    it('reconciles platform_settings.overrides on existing agents (one PATCH per process)', async () => {
        const app = createApp()
        const headers = {
            ...(await authHeaders()),
            'content-type': 'application/json'
        }

        const prevKey = process.env.ELEVENLABS_API_KEY
        const prevAgent = process.env.ELEVENLABS_AGENT_ID
        process.env.ELEVENLABS_API_KEY = 'test-key-ensure'
        delete process.env.ELEVENLABS_AGENT_ID

        const existingAgentId = `agent_ensure_${Math.random().toString(36).slice(2, 10)}`
        const existingAgentName = `Hapi Voice Assistant [voice:ensure-voice-${Math.random().toString(36).slice(2, 6)}]`
        const voiceId = existingAgentName.match(/\[voice:([^\]]+)\]/)?.[1] ?? ''

        const patchCalls: Array<{ url: string; body: unknown }> = []
        const originalFetch = global.fetch
        // @ts-expect-error test override
        global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input)

            if (url.endsWith('/convai/agents') && init?.method === 'GET') {
                return new Response(JSON.stringify({
                    agents: [{ agent_id: existingAgentId, name: existingAgentName }]
                }), { status: 200 })
            }
            if (
                url.includes(`/convai/agents/${existingAgentId}`)
                && init?.method === 'PATCH'
            ) {
                const body = init?.body ? JSON.parse(String(init.body)) : null
                patchCalls.push({ url, body })
                return new Response(JSON.stringify({ agent_id: existingAgentId }), { status: 200 })
            }
            if (url.includes('/convai/conversation/token?agent_id=')) {
                return new Response(JSON.stringify({ token: 'tok_ensure' }), { status: 200 })
            }
            return new Response('not found', { status: 404 })
        }) as typeof fetch

        const first = await app.request('/api/voice/token', {
            method: 'POST',
            headers,
            body: JSON.stringify({ voiceId })
        })
        expect(first.status).toBe(200)
        expect(await first.json()).toMatchObject({
            allowed: true,
            agentId: existingAgentId,
            token: 'tok_ensure'
        })

        expect(patchCalls.length).toBeGreaterThanOrEqual(1)
        const patchedBody = patchCalls[0]?.body as {
            platform_settings?: {
                overrides?: {
                    conversation_config_override?: {
                        agent?: { language?: boolean; prompt?: { prompt?: boolean } }
                        tts?: {
                            voice_id?: boolean
                            stability?: boolean
                            similarity_boost?: boolean
                            style?: boolean
                            speed?: boolean
                        }
                    }
                }
            }
        }
        const overrides = patchedBody.platform_settings?.overrides?.conversation_config_override
        expect(overrides?.agent?.language).toBe(true)
        expect(overrides?.agent?.prompt?.prompt).toBe(true)
        expect(overrides?.tts?.voice_id).toBe(true)
        expect(overrides?.tts?.stability).toBe(true)
        expect(overrides?.tts?.similarity_boost).toBe(true)
        expect(overrides?.tts?.style).toBe(true)
        expect(overrides?.tts?.speed).toBe(true)

        // Second call within the same process must NOT re-issue the PATCH.
        const before = patchCalls.length
        const second = await app.request('/api/voice/token', {
            method: 'POST',
            headers,
            body: JSON.stringify({ voiceId })
        })
        expect(second.status).toBe(200)
        expect(patchCalls.length).toBe(before)

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
    const originalEnv = {
        VOICE_BACKEND: process.env.VOICE_BACKEND,
        ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
        GEMINI_API_KEY: process.env.GEMINI_API_KEY,
        GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
        DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
        QWEN_API_KEY: process.env.QWEN_API_KEY
    }

    afterEach(() => {
        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) {
                delete process.env[key]
            } else {
                process.env[key] = value
            }
        }
    })

    test('returns no backend when no voice credentials are configured', async () => {
        delete process.env.VOICE_BACKEND
        delete process.env.ELEVENLABS_API_KEY
        delete process.env.GEMINI_API_KEY
        delete process.env.GOOGLE_API_KEY
        delete process.env.DASHSCOPE_API_KEY
        delete process.env.QWEN_API_KEY
        const app = createApp()
        const headers = await authHeaders()
        const res = await app.request('/api/voice/backend', { headers })
        expect(res.status).toBe(200)
        const body = await res.json() as { backend: string | null; backends: string[] }
        expect(body).toEqual({ backend: null, backends: [] })
    })

    test('returns elevenlabs by default with backends list', async () => {
        delete process.env.VOICE_BACKEND
        delete process.env.GEMINI_API_KEY
        delete process.env.GOOGLE_API_KEY
        delete process.env.DASHSCOPE_API_KEY
        delete process.env.QWEN_API_KEY
        process.env.ELEVENLABS_API_KEY = 'test-el'
        const app = createApp()
        const headers = await authHeaders()
        const res = await app.request('/api/voice/backend', { headers })
        expect(res.status).toBe(200)
        const body = await res.json() as { backend: string; backends: string[] }
        expect(body.backend).toBe('elevenlabs')
        expect(body.backends).toEqual(['elevenlabs'])
    })

    test('returns gemini-live when configured and key present', async () => {
        process.env.VOICE_BACKEND = 'gemini-live'
        process.env.GEMINI_API_KEY = 'test-gm'
        delete process.env.ELEVENLABS_API_KEY
        delete process.env.DASHSCOPE_API_KEY
        const app = createApp()
        const headers = await authHeaders()
        const res = await app.request('/api/voice/backend', { headers })
        expect(res.status).toBe(200)
        const body = await res.json() as { backend: string; backends: string[] }
        expect(body.backend).toBe('gemini-live')
        expect(body.backends).toEqual(['gemini-live'])
    })

    test('lists every backend with credentials', async () => {
        process.env.VOICE_BACKEND = 'gemini-live'
        process.env.ELEVENLABS_API_KEY = 'test-el'
        process.env.GEMINI_API_KEY = 'test-gm'
        process.env.DASHSCOPE_API_KEY = 'test-qw'
        const app = createApp()
        const headers = await authHeaders()
        const res = await app.request('/api/voice/backend', { headers })
        expect(res.status).toBe(200)
        const body = await res.json() as { backend: string; backends: string[] }
        expect(body.backend).toBe('gemini-live')
        expect(body.backends).toEqual(['elevenlabs', 'gemini-live', 'qwen-realtime'])
    })

    test('falls back to elevenlabs for unknown VOICE_BACKEND values', async () => {
        process.env.VOICE_BACKEND = 'unknown-backend'
        delete process.env.GEMINI_API_KEY
        delete process.env.GOOGLE_API_KEY
        delete process.env.DASHSCOPE_API_KEY
        delete process.env.QWEN_API_KEY
        process.env.ELEVENLABS_API_KEY = 'test-el'
        const app = createApp()
        const headers = await authHeaders()
        const res = await app.request('/api/voice/backend', { headers })
        expect(res.status).toBe(200)
        const body = await res.json() as { backend: string; backends: string[] }
        expect(body.backend).toBe('elevenlabs')
        expect(body.backends).toEqual(['elevenlabs'])
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

describe('transcription credentials onboarding', () => {
    const managedKeys = [
        'OPENAI_API_KEY',
        'ELEVENLABS_API_KEY',
        'DEEPGRAM_API_KEY',
        'GROQ_API_KEY',
        'TRANSCRIPTION_BASE_URL',
        'TRANSCRIPTION_MODEL',
        'TRANSCRIPTION_API_KEY',
    ] as const
    const previous = new Map<string, string | undefined>()
    let dir: string | null = null

    afterEach(() => {
        for (const key of managedKeys) {
            const value = previous.get(key)
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        previous.clear()
        resetProviderCredentialEnvLocksForTests()
        if (dir) {
            rmSync(dir, { recursive: true, force: true })
            dir = null
        }
    })

    function clearManagedEnv(): void {
        for (const key of managedKeys) {
            previous.set(key, process.env[key])
            delete process.env[key]
        }
        resetProviderCredentialEnvLocksForTests()
    }

    test('PUT saves a key, masks GET response, and discovers the provider live', async () => {
        clearManagedEnv()
        dir = mkdtempSync(join(tmpdir(), 'hapi-voice-creds-'))
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({}))
        const app = createApp(dir)
        const headers = await authHeaders()

        const put = await app.request('/api/voice/transcription/credentials', {
            method: 'PUT',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ openai: 'sk-live-onboard-secret' }),
        })
        expect(put.status).toBe(200)
        const putBody = await put.json() as { openai: { configured: boolean; hint: string | null; source: string } }
        expect(putBody.openai.configured).toBe(true)
        expect(putBody.openai.source).toBe('settings')
        expect(putBody.openai.hint).toBe('••••cret')
        expect(JSON.stringify(putBody)).not.toContain('sk-live-onboard-secret')
        // Settings-backed secrets must stay out of process.env (tunnel/ACP/Codex inherit it).
        expect(process.env.OPENAI_API_KEY).toBeUndefined()

        const providers = await app.request('/api/voice/transcription/providers', { headers })
        expect(await providers.json()).toEqual({
            providers: [{ id: 'openai', label: 'OpenAI', modes: ['standard', 'realtime'] }],
        })

        const get = await app.request('/api/voice/transcription/credentials', { headers })
        expect(get.status).toBe(200)
        const getBody = await get.json() as { openai: { hint: string | null } }
        expect(getBody.openai.hint).toBe('••••cret')
        expect(JSON.stringify(getBody)).not.toContain('sk-live-onboard-secret')
    })

    test('PUT refuses to overwrite an env-locked key', async () => {
        clearManagedEnv()
        process.env.OPENAI_API_KEY = 'env-locked-key'
        resetProviderCredentialEnvLocksForTests()
        // Re-lock as if hub started with this env
        const { applyProviderCredentialsFromSettings } = await import('../../config/providerCredentials')
        dir = mkdtempSync(join(tmpdir(), 'hapi-voice-creds-env-'))
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({}))
        await applyProviderCredentialsFromSettings(dir)

        const app = createApp(dir)
        const headers = await authHeaders()
        const put = await app.request('/api/voice/transcription/credentials', {
            method: 'PUT',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ openai: 'ui-attempt' }),
        })
        expect(put.status).toBe(409)
        expect(process.env.OPENAI_API_KEY).toBe('env-locked-key')
    })

    test('credentials routes refuse non-owner namespaces', async () => {
        clearManagedEnv()
        dir = mkdtempSync(join(tmpdir(), 'hapi-voice-creds-ns-'))
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({}))
        const app = createApp(dir)
        const token = await new SignJWT({ uid: 2, ns: 'other' })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(JWT_SECRET)
        const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

        const get = await app.request('/api/voice/transcription/credentials', { headers })
        expect(get.status).toBe(403)

        const put = await app.request('/api/voice/transcription/credentials', {
            method: 'PUT',
            headers,
            body: JSON.stringify({ openai: 'ns-attack' }),
        })
        expect(put.status).toBe(403)
        expect(process.env.OPENAI_API_KEY).toBeUndefined()
        const { readFileSync } = await import('node:fs')
        const saved = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
            providerCredentials?: Record<string, string>
        }
        expect(saved.providerCredentials?.OPENAI_API_KEY).toBeUndefined()
    })
})
