import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
const transcriptionSchema = z.object({
    language: z.string().trim().min(1).max(32).optional()
})

export function createVoiceRoutes(): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/voice/transcribe', async (c) => {
        const whisperBaseUrl = process.env.LOCAL_WHISPER_URL?.trim() || 'http://127.0.0.1:8000'
        const whisperModel = process.env.LOCAL_WHISPER_MODEL?.trim() || 'Systran/faster-distil-whisper-small.en'
        const whisperApiKey = process.env.LOCAL_WHISPER_API_KEY?.trim()

        try {
            const form = await c.req.formData()
            const audio = form.get('audio')
            const language = form.get('language')

            if (!(audio instanceof File)) {
                return c.json({ ok: false, error: 'Missing audio file' }, 400)
            }

            const parsed = transcriptionSchema.safeParse({
                language: typeof language === 'string' ? language : undefined
            })
            if (!parsed.success) {
                return c.json({ ok: false, error: 'Invalid language parameter' }, 400)
            }

            const upstreamForm = new FormData()
            upstreamForm.set('model', whisperModel)
            upstreamForm.set('file', audio, audio.name || 'audio.webm')
            if (parsed.data.language) {
                upstreamForm.set('language', parsed.data.language)
            }

            const headers = new Headers()
            if (whisperApiKey) {
                headers.set('authorization', `Bearer ${whisperApiKey}`)
            }

            const response = await fetch(
                `${whisperBaseUrl.replace(/\/+$/, '')}/v1/audio/transcriptions`,
                {
                    method: 'POST',
                    headers,
                    body: upstreamForm
                }
            )

            if (!response.ok) {
                const errorBody = await response.text().catch(() => '')
                console.error('[Voice] Local Whisper upstream error:', {
                    url: `${whisperBaseUrl.replace(/\/+$/, '')}/v1/audio/transcriptions`,
                    status: response.status,
                    body: errorBody
                })
                return c.json({
                    ok: false,
                    error: errorBody || `Local Whisper error: ${response.status}`
                }, 502)
            }

            const data = await response.json().catch(() => null) as { text?: string } | null
            const text = typeof data?.text === 'string' ? data.text.trim() : ''
            return c.json({ ok: true, text })
        } catch (error) {
            console.error('[Voice] Transcription failed:', error)
            return c.json({
                ok: false,
                error: error instanceof Error ? error.message : 'Failed to transcribe audio'
            }, 500)
        }
    })

    return app
}
