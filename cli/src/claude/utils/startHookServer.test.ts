import { describe, it, expect } from 'vitest'
import { request } from 'node:http'
import { startHookServer, type SessionHookData } from './startHookServer'

const sendHookRequest = async (port: number, body: string, token?: string): Promise<{ statusCode?: number; body: string }> => {
    return await new Promise((resolve, reject) => {
        const headers: Record<string, string | number> = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
        }
        if (token) {
            headers['x-hapi-hook-token'] = token
        }

        const req = request({
            host: '127.0.0.1',
            port,
            path: '/hook/session-start',
            method: 'POST',
            headers
        }, (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk) => chunks.push(chunk as Buffer))
            res.on('error', reject)
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    body: Buffer.concat(chunks).toString('utf-8')
                })
            })
        })

        req.on('error', reject)
        req.end(body)
    })
}

describe('startHookServer', () => {
    it('forwards session hook payload to callback', async () => {
        let received: { sessionId?: string; data?: SessionHookData } = {}
        const server = await startHookServer({
            onSessionHook: (sessionId, data) => {
                received = { sessionId, data }
            }
        })

        try {
            const body = JSON.stringify({ session_id: 'session-123', extra: 'ok' })
            const response = await sendHookRequest(server.port, body, server.token)
            expect(response.statusCode).toBe(200)
        } finally {
            server.stop()
        }

        expect(received.sessionId).toBe('session-123')
        expect(received.data?.session_id).toBe('session-123')
    })

    it('returns 400 for invalid JSON payloads', async () => {
        let hookCalled = false
        const server = await startHookServer({
            onSessionHook: () => {
                hookCalled = true
            }
        })

        try {
            const response = await sendHookRequest(server.port, '{"session_id":', server.token)
            expect(response.statusCode).toBe(400)
            expect(response.body).toBe('invalid json')
        } finally {
            server.stop()
        }

        expect(hookCalled).toBe(false)
    })

    it('returns 422 when session_id is missing', async () => {
        let hookCalled = false
        const server = await startHookServer({
            onSessionHook: () => {
                hookCalled = true
            }
        })

        try {
            const body = JSON.stringify({ extra: 'ok' })
            const response = await sendHookRequest(server.port, body, server.token)
            expect(response.statusCode).toBe(422)
            expect(response.body).toBe('missing session_id')
        } finally {
            server.stop()
        }

        expect(hookCalled).toBe(false)
    })

    it('returns 401 when hook token is missing', async () => {
        let hookCalled = false
        const server = await startHookServer({
            onSessionHook: () => {
                hookCalled = true
            }
        })

        try {
            const body = JSON.stringify({ session_id: 'session-123' })
            const response = await sendHookRequest(server.port, body)
            expect(response.statusCode).toBe(401)
            expect(response.body).toBe('unauthorized')
        } finally {
            server.stop()
        }

        expect(hookCalled).toBe(false)
    })
})
