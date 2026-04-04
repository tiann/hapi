import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createVoiceRoutes } from './voice'

function createApp() {
    const app = new Hono<WebAppEnv>()
    app.route('/api', createVoiceRoutes())
    return app
}

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
        const res = await app.request('/api/voice/backend')
        expect(res.status).toBe(200)
        const body = await res.json() as { backend: string }
        expect(body.backend).toBe('elevenlabs')
    })

    test('returns gemini-live when configured', async () => {
        process.env.VOICE_BACKEND = 'gemini-live'
        const app = createApp()
        const res = await app.request('/api/voice/backend')
        expect(res.status).toBe(200)
        const body = await res.json() as { backend: string }
        expect(body.backend).toBe('gemini-live')
    })

    test('falls back to elevenlabs for unknown values', async () => {
        process.env.VOICE_BACKEND = 'unknown-backend'
        const app = createApp()
        const res = await app.request('/api/voice/backend')
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
        const res = await app.request('/api/voice/gemini-token', { method: 'POST' })
        expect(res.status).toBe(400)
        const body = await res.json() as { allowed: boolean; error: string }
        expect(body.allowed).toBe(false)
        expect(body.error).toContain('not configured')
    })

    test('returns GEMINI_API_KEY when set', async () => {
        process.env.GEMINI_API_KEY = 'test-gemini-key'
        delete process.env.GOOGLE_API_KEY
        const app = createApp()
        const res = await app.request('/api/voice/gemini-token', { method: 'POST' })
        expect(res.status).toBe(200)
        const body = await res.json() as { allowed: boolean; apiKey: string }
        expect(body.allowed).toBe(true)
        expect(body.apiKey).toBe('test-gemini-key')
    })

    test('falls back to GOOGLE_API_KEY', async () => {
        delete process.env.GEMINI_API_KEY
        process.env.GOOGLE_API_KEY = 'test-google-key'
        const app = createApp()
        const res = await app.request('/api/voice/gemini-token', { method: 'POST' })
        expect(res.status).toBe(200)
        const body = await res.json() as { allowed: boolean; apiKey: string }
        expect(body.allowed).toBe(true)
        expect(body.apiKey).toBe('test-google-key')
    })
})
