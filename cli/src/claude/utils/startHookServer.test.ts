import { describe, it, expect } from 'vitest'
import { request } from 'node:http'
import { startHookServer, type SessionHookData } from './startHookServer'

const sendHookRequest = async (port: number, body: string, token?: string, path = '/hook/session-start'): Promise<{ statusCode?: number; body: string }> => {
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
            path,
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

    describe('pre-tool-use', () => {
        const sendPreToolUse = (port: number, payload: unknown, token?: string) =>
            sendHookRequest(port, JSON.stringify(payload), token, '/hook/pre-tool-use')

        it('forwards the tool call to onPreToolUse and returns its decision', async () => {
            let received: unknown = null
            const server = await startHookServer({
                onSessionHook: () => {},
                onPreToolUse: async (data) => {
                    received = data
                    return { permissionDecision: 'deny', reason: 'not allowed' }
                }
            })

            try {
                const response = await sendPreToolUse(
                    server.port,
                    { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tc-1', hook_event_name: 'PreToolUse' },
                    server.token
                )
                expect(response.statusCode).toBe(200)
                expect(JSON.parse(response.body)).toEqual({ permissionDecision: 'deny', reason: 'not allowed' })
            } finally {
                server.stop()
            }

            expect((received as { tool_name?: string }).tool_name).toBe('Bash')
        })

        it('allows by default when no onPreToolUse handler is wired', async () => {
            const server = await startHookServer({ onSessionHook: () => {} })
            try {
                const response = await sendPreToolUse(
                    server.port,
                    { tool_name: 'Bash', tool_use_id: 'tc-2' },
                    server.token
                )
                expect(response.statusCode).toBe(200)
                expect(JSON.parse(response.body)).toEqual({ permissionDecision: 'allow' })
            } finally {
                server.stop()
            }
        })

        it('fails closed (deny) when the handler throws', async () => {
            const server = await startHookServer({
                onSessionHook: () => {},
                onPreToolUse: async () => {
                    throw new Error('bridge down')
                }
            })
            try {
                const response = await sendPreToolUse(server.port, { tool_name: 'Write', tool_use_id: 'tc-3' }, server.token)
                expect(response.statusCode).toBe(200)
                expect(JSON.parse(response.body).permissionDecision).toBe('deny')
            } finally {
                server.stop()
            }
        })

        it('returns 401 when the token is missing', async () => {
            let called = false
            const server = await startHookServer({
                onSessionHook: () => {},
                onPreToolUse: async () => {
                    called = true
                    return { permissionDecision: 'allow' }
                }
            })
            try {
                const response = await sendPreToolUse(server.port, { tool_name: 'Bash' })
                expect(response.statusCode).toBe(401)
            } finally {
                server.stop()
            }
            expect(called).toBe(false)
        })
    })
})
