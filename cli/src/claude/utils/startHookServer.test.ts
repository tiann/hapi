import { describe, it, expect, vi } from 'vitest'
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

    describe('permission-request', () => {
        const payload = { hook_event_name: 'PermissionRequest', session_id: 's-1', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Color?' }] } }
        const sendPermission = (port: number, token?: string, body: unknown = payload) =>
            sendHookRequest(port, JSON.stringify(body), token, '/hook/permission-request')

        it('authenticates and validates before invoking the permission handler', async () => {
            const handler = vi.fn(async () => null)
            const server = await startHookServer({ onSessionHook: () => {}, onPermissionRequest: handler })
            try {
                expect((await sendPermission(server.port)).statusCode).toBe(401)
                expect((await sendPermission(server.port, 'wrong-token')).statusCode).toBe(401)
                expect((await sendPermission(server.port, server.token, { ...payload, tool_input: null })).statusCode).toBe(400)
                expect(handler).not.toHaveBeenCalled()
            } finally {
                server.stop()
            }
        })

        it('holds the response for an explicit answer and preserves structured input', async () => {
            const decision = { behavior: 'allow' as const, updatedInput: { ...payload.tool_input, answers: { 'Color?': 'Blue' } } }
            const deferred = Promise.withResolvers<typeof decision>()
            const handler = vi.fn(() => deferred.promise)
            const server = await startHookServer({ onSessionHook: () => {}, onPermissionRequest: handler })
            try {
                let returned = false
                const response = sendPermission(server.port, server.token).then(value => { returned = true; return value })
                await vi.waitFor(() => expect(handler).toHaveBeenCalled())
                expect(returned).toBe(false)
                expect(handler.mock.calls[0]).toEqual([payload, expect.any(AbortSignal)])
                deferred.resolve(decision)
                expect(JSON.parse((await response).body)).toEqual(decision)
            } finally {
                server.stop()
            }
        })

        it.each(['absent', 'null', 'error'] as const)('leaves the native flow untouched when handler is %s', async mode => {
            const server = await startHookServer({
                onSessionHook: () => {},
                onPermissionRequest: mode === 'absent' ? undefined : async () => {
                    if (mode === 'error') throw new Error('bridge unavailable')
                    return null
                }
            })
            try {
                const response = await sendPermission(server.port, server.token)
                expect(response.statusCode).toBe(200)
                expect(JSON.parse(response.body)).toEqual({})
            } finally {
                server.stop()
            }
        })

        it('aborts the pending bridge when the hook process disconnects', async () => {
            const started = Promise.withResolvers<AbortSignal>()
            const canceled = Promise.withResolvers<void>()
            const server = await startHookServer({
                onSessionHook: () => {},
                onPermissionRequest: (_data, signal) => {
                    started.resolve(signal)
                    signal.addEventListener('abort', () => canceled.resolve(), { once: true })
                    return new Promise(() => {})
                }
            })
            const req = request({ host: '127.0.0.1', port: server.port, path: '/hook/permission-request', method: 'POST', headers: {
                'x-hapi-hook-token': server.token, 'Content-Type': 'application/json'
            } })
            req.on('error', () => {})
            try {
                req.end(JSON.stringify(payload))
                const signal = await started.promise
                req.destroy()
                await canceled.promise
                expect(signal.aborted).toBe(true)
            } finally {
                req.destroy()
                server.stop()
            }
        })

        it('releases pending hooks without a decision on server shutdown', async () => {
            const started = Promise.withResolvers<AbortSignal>()
            const server = await startHookServer({
                onSessionHook: () => {},
                onPermissionRequest: (_data, signal) => {
                    started.resolve(signal)
                    return new Promise(() => {})
                }
            })
            try {
                const response = sendPermission(server.port, server.token)
                const signal = await started.promise
                server.stop()
                expect(signal.aborted).toBe(true)
                expect(JSON.parse((await response).body)).toEqual({})
            } finally {
                server.stop()
            }
        })
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

        it('makes no decision when no onPreToolUse handler is wired', async () => {
            const server = await startHookServer({ onSessionHook: () => {} })
            try {
                const response = await sendPreToolUse(
                    server.port,
                    { tool_name: 'Bash', tool_use_id: 'tc-2' },
                    server.token
                )
                expect(response.statusCode).toBe(200)
                expect(JSON.parse(response.body)).toEqual({})
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

    describe('agy-pre-invocation (legacy no-op route)', () => {
        const sendAgyInvocation = (port: number, payload: unknown, token?: string) =>
            sendHookRequest(port, JSON.stringify(payload), token, '/hook/agy-pre-invocation')

        it('responds 200 without a handler (legacy PTY hook configs must never block agy)', async () => {
            const server = await startHookServer({ onSessionHook: () => {} })
            try {
                const response = await sendAgyInvocation(
                    server.port,
                    { conversationId: 'brain-1', invocationNum: 0, modelName: 'gemini-3.5-flash' },
                    server.token
                )
                expect(response.statusCode).toBe(200)
            } finally {
                server.stop()
            }
        })

        it('responds 200 even without a token (route is a no-op, not a security boundary)', async () => {
            const server = await startHookServer({ onSessionHook: () => {} })
            try {
                const response = await sendAgyInvocation(server.port, { conversationId: 'brain-2' })
                expect(response.statusCode).toBe(200)
            } finally {
                server.stop()
            }
        })
    })
})
