import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './client'

describe('ApiClient error mapping', () => {
    let originalFetch: typeof globalThis.fetch
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
        originalFetch = globalThis.fetch
        fetchMock = vi.fn()
        globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it('prefers the stable `code` field over the human-readable `error` message in ApiError.code', async () => {
        // Match the shape /sessions/:id/reopen actually returns on a 503.
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({ error: 'No machine online', code: 'no_machine_online' }),
                { status: 503, statusText: 'Service Unavailable' }
            )
        )

        const api = new ApiClient('test-token')
        try {
            await api.reopenSession('session-X')
            expect.unreachable('expected reopenSession to throw')
        } catch (error) {
            expect(error).toBeInstanceOf(ApiError)
            const apiError = error as ApiError
            expect(apiError.status).toBe(503)
            // The stable taxonomy must survive into ApiError.code so callers can
            // branch on `no_machine_online` rather than parsing the message text.
            expect(apiError.code).toBe('no_machine_online')
            expect(apiError.body).toContain('no_machine_online')
        }
    })

    it('falls back to `parsed.error` when `code` is absent (legacy route shape)', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({ error: 'something broke' }),
                { status: 500, statusText: 'Internal Server Error' }
            )
        )

        const api = new ApiClient('test-token')
        try {
            await api.reopenSession('session-Y')
            expect.unreachable('expected reopenSession to throw')
        } catch (error) {
            expect(error).toBeInstanceOf(ApiError)
            expect((error as ApiError).code).toBe('something broke')
        }
    })

    it('passes the 422 missing-metadata body through unchanged so the UI can show the missing fields', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    error: 'Cursor session id is missing from metadata; reopen requires the original cursor chat id',
                    missing: ['cursorSessionId']
                }),
                { status: 422, statusText: 'Unprocessable Entity' }
            )
        )

        const api = new ApiClient('test-token')
        try {
            await api.reopenSession('session-Z')
            expect.unreachable('expected reopenSession to throw')
        } catch (error) {
            expect(error).toBeInstanceOf(ApiError)
            const apiError = error as ApiError
            expect(apiError.status).toBe(422)
            expect(apiError.body).toContain('cursorSessionId')
        }
    })

    it('loads the Cursor chat store status for the selected session', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ onDisk: false, store: null }), { status: 200 })
        )

        const api = new ApiClient('test-token')
        await expect(api.getCursorChatStoreStatus('session cursor')).resolves.toEqual({
            onDisk: false,
            store: null
        })
        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sessions/session%20cursor/cursor-chat-store')
    })

    it('lists and imports Pi sessions through the selected machine', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, sessions: [], machineId: 'machine-1' }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, results: [], machineId: 'machine-1' }), { status: 200 }))
        const api = new ApiClient('test-token')

        await api.getPiSessions('/tmp/project', 'machine-1')
        await api.importPiSessions({ sessionIds: ['pi-1'], cwd: '/tmp/project', machineId: 'machine-1' })

        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/pi/sessions?cwd=%2Ftmp%2Fproject&machineId=machine-1')
        expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/pi/import-sessions')
        expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['pi-1'], cwd: '/tmp/project', machineId: 'machine-1' })
        })
    })

    it('loads the authoritative queued state for encoded session IDs', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({
                queuedLocalIds: ['local-2'],
                invokedLocalMessages: [{ localId: 'local-3', invokedAt: 1_000 }]
            }), { status: 200 })
        )

        const api = new ApiClient('test-token')
        await expect(api.getQueuedState('session /?#', ['local-1', 'local-2'])).resolves.toEqual({
            queuedLocalIds: ['local-2'],
            invokedLocalMessages: [{ localId: 'local-3', invokedAt: 1_000 }]
        })

        const [url, init] = fetchMock.mock.calls[0] ?? []
        expect(url).toBe('/api/sessions/session%20%2F%3F%23/messages/queued-state')
        expect(init).toMatchObject({
            method: 'POST',
            body: JSON.stringify({ localIds: ['local-1', 'local-2'] })
        })
        expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    })

    it('forwards the selected delivery mode when sending a message', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))

        const api = new ApiClient('test-token')
        await api.sendMessage('session /?#', 'steer this', 'local-1', undefined, null, 'steer')

        const [url, init] = fetchMock.mock.calls[0] ?? []
        expect(url).toBe('/api/sessions/session%20%2F%3F%23/messages')
        expect(init).toMatchObject({
            method: 'POST',
            body: JSON.stringify({
                text: 'steer this',
                localId: 'local-1',
                deliveryMode: 'steer',
            })
        })
    })

    it('requests usage buckets in the viewer IANA time zone', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))

        const api = new ApiClient('test-token')
        await api.getUsageSummary('7d', 'America/New_York')

        expect(fetchMock.mock.calls[0]?.[0]).toBe(
            '/api/usage/summary?range=7d&timeZone=America%2FNew_York'
        )
    })

    it('lets fetch set the multipart boundary for transcription uploads', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ text: 'hello' }), { status: 200 }))

        const api = new ApiClient('test-token')
        const file = new File(['audio'], 'speech.webm', { type: 'audio/webm' })
        await api.transcribeVoice({ file, provider: 'openai', mode: 'standard' })

        const [, init] = fetchMock.mock.calls[0] ?? []
        expect(init?.body).toBeInstanceOf(FormData)
        expect(new Headers(init?.headers).has('content-type')).toBe(false)
    })

    it('preserves an unavailable voice backend response', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ backend: null, backends: [] }), { status: 200 })
        )

        const api = new ApiClient('test-token')
        await expect(api.fetchVoiceBackend()).resolves.toEqual({ backend: null, backends: [] })
        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/voice/backend')
    })

    it('reads and updates masked transcription credentials', async () => {
        const status = {
            openai: { configured: true, source: 'settings', hint: '••••cret', editable: true },
            elevenlabs: { configured: false, source: 'none', hint: null, editable: true },
            deepgram: { configured: false, source: 'none', hint: null, editable: true },
            groq: { configured: false, source: 'none', hint: null, editable: true },
            openaiCompatible: {
                configured: false,
                source: 'none',
                baseUrl: null,
                model: null,
                baseUrlEditable: true,
                modelEditable: true,
                apiKey: { configured: false, source: 'none', hint: null, editable: true },
            },
            voiceBackends: {
                elevenlabs: { configured: false, source: 'none', hint: null, editable: true },
                geminiLive: { configured: false, source: 'none', hint: null, editable: true },
                qwenRealtime: { configured: false, source: 'none', hint: null, editable: true },
            },
        }
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify(status), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(status), { status: 200 }))

        const api = new ApiClient('test-token')
        await expect(api.fetchTranscriptionCredentials()).resolves.toEqual(status)
        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/voice/transcription/credentials')

        await expect(api.updateTranscriptionCredentials({ openai: 'sk-test' })).resolves.toEqual(status)
        const [, init] = fetchMock.mock.calls[1] ?? []
        expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/voice/transcription/credentials')
        expect(init?.method).toBe('PUT')
        expect(init?.body).toBe(JSON.stringify({ openai: 'sk-test' }))
    })
})
