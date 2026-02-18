import { jwtVerify } from 'jose'
import { z } from 'zod'
import type { ServerWebSocket, Server as BunServer } from 'bun'

export type VoiceWebSocketData = {
    type: 'voice'
    upstream: WebSocket | null
}

const jwtPayloadSchema = z.object({
    uid: z.number(),
    ns: z.string()
})

export async function handleVoiceUpgrade(
    req: Request,
    server: BunServer<unknown>,
    jwtSecret: Uint8Array
): Promise<Response | undefined> {
    const url = new URL(req.url)
    const token = url.searchParams.get('token')

    if (!token) {
        return new Response('Missing token', { status: 401 })
    }

    try {
        const verified = await jwtVerify(token, jwtSecret, { algorithms: ['HS256'] })
        const parsed = jwtPayloadSchema.safeParse(verified.payload)
        if (!parsed.success) {
            return new Response('Invalid token payload', { status: 401 })
        }
    } catch {
        return new Response('Invalid token', { status: 401 })
    }

    const upgraded = server.upgrade(req, {
        data: { type: 'voice', upstream: null } satisfies VoiceWebSocketData
    })

    if (!upgraded) {
        return new Response('WebSocket upgrade failed', { status: 500 })
    }

    // Bun returns undefined on successful upgrade
    return undefined
}

function buildSpeachesRealtimeUrl(): string {
    const baseUrl = (process.env.LOCAL_WHISPER_URL?.trim() || 'http://127.0.0.1:8000').replace(/\/+$/, '')
    const model = process.env.LOCAL_WHISPER_MODEL?.trim() || 'Systran/faster-distil-whisper-small.en'
    const apiKey = process.env.LOCAL_WHISPER_API_KEY?.trim()

    const wsBase = baseUrl.replace(/^http/, 'ws')
    let url = `${wsBase}/v1/realtime?model=${encodeURIComponent(model)}&intent=transcription`
    if (apiKey) {
        url += `&api_key=${encodeURIComponent(apiKey)}`
    }
    return url
}

export function createVoiceWsHandlers() {
    return {
        open(ws: ServerWebSocket<VoiceWebSocketData>) {
            const speachesUrl = buildSpeachesRealtimeUrl()
            console.log('[Voice WS] Client connected, opening upstream to', speachesUrl)

            const upstream = new WebSocket(speachesUrl)

            upstream.onopen = () => {
                console.log('[Voice WS] Upstream connected')
                try {
                    ws.send(JSON.stringify({ type: 'hapi.upstream.open' }))
                } catch {
                    // Client may have disconnected
                }
            }

            upstream.onmessage = (event) => {
                try {
                    ws.send(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer))
                } catch {
                    // Client may have disconnected
                }
            }

            upstream.onerror = (event) => {
                console.error('[Voice WS] Upstream error:', event)
                try {
                    ws.send(JSON.stringify({ type: 'error', error: { message: 'Upstream connection failed' } }))
                    ws.close(1011, 'Upstream error')
                } catch {
                    // Ignore
                }
            }

            upstream.onclose = () => {
                console.log('[Voice WS] Upstream closed')
                try {
                    ws.close(1000, 'Upstream closed')
                } catch {
                    // Ignore
                }
            }

            ws.data.upstream = upstream
        },

        message(ws: ServerWebSocket<VoiceWebSocketData>, message: string | Buffer) {
            const upstream = ws.data.upstream
            if (!upstream || upstream.readyState !== WebSocket.OPEN) {
                return
            }
            try {
                upstream.send(typeof message === 'string' ? message : new Uint8Array(message))
            } catch (error) {
                console.error('[Voice WS] Failed to forward message to upstream:', error)
            }
        },

        close(ws: ServerWebSocket<VoiceWebSocketData>, _code: number, _reason: string) {
            console.log('[Voice WS] Client disconnected')
            const upstream = ws.data.upstream
            if (upstream && upstream.readyState !== WebSocket.CLOSED) {
                upstream.close()
            }
            ws.data.upstream = null
        }
    }
}
