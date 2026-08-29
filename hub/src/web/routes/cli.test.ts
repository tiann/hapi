import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import { createConfiguration } from '../../configuration'
import { createCliRoutes } from './cli'
import { SessionIdentityConflictError } from '../../store/sessions'

function createApp(engine: Partial<SyncEngine>) {
    const app = new Hono()
    app.route('/cli', createCliRoutes(() => engine as SyncEngine))
    return app
}

function authHeaders() {
    return {
        authorization: 'Bearer test-token'
    }
}

beforeAll(async () => {
    const config = await createConfiguration()
    config._setCliApiToken('test-token', 'env', false)
})

describe('cli resume routes', () => {
    it('returns local resumable sessions', async () => {
        const app = createApp({
            listLocalResumableSessions: () => [{
                sessionId: 'session-1',
                flavor: 'codex',
                directory: '/tmp/project',
                machineId: 'machine-1',
                active: false,
                thinking: false,
                controlledByUser: false,
                agentSessionId: 'codex-thread-1',
                updatedAt: 123
            }]
        } as never)

        const response = await app.request('/cli/sessions/resumable?machineId=machine-1', {
            headers: authHeaders()
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            sessions: [{
                sessionId: 'session-1',
                flavor: 'codex',
                directory: '/tmp/project',
                machineId: 'machine-1',
                active: false,
                thinking: false,
                controlledByUser: false,
                agentSessionId: 'codex-thread-1',
                updatedAt: 123
            }]
        })
    })

    it('returns a local resume target', async () => {
        const app = createApp({
            resolveLocalResumeTarget: () => ({
                type: 'success',
                target: {
                    sessionId: 'session-1',
                    flavor: 'claude',
                    directory: '/tmp/project',
                    machineId: 'machine-1',
                    active: false,
                    thinking: false,
                    controlledByUser: false,
                    agentSessionId: '11111111-1111-4111-8111-111111111111'
                }
            })
        } as never)

        const response = await app.request('/cli/sessions/session-1/resume-target', {
            headers: authHeaders()
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            target: {
                sessionId: 'session-1',
                flavor: 'claude',
                directory: '/tmp/project',
                machineId: 'machine-1',
                active: false,
                thinking: false,
                controlledByUser: false,
                agentSessionId: '11111111-1111-4111-8111-111111111111'
            }
        })
    })

    it('returns handoff errors with status codes', async () => {
        const app = createApp({
            handoffSessionToLocal: async () => ({
                type: 'error',
                message: 'Session is already controlled by a local terminal',
                code: 'already_local'
            })
        } as never)

        const response = await app.request('/cli/sessions/session-1/handoff-local', {
            method: 'POST',
            headers: authHeaders()
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
            error: 'Session is already controlled by a local terminal',
            code: 'already_local'
        })
    })
})

describe('cli OpenCode clear route', () => {
    it.each(['confirm-cleanup', 'abort'] as const)('maps transient %s persistence failure to retryable 500', async (action) => {
        const failure = mock(() => ({
            type: 'error' as const,
            code: 'replacement_link_failed' as const,
            message: 'metadata write failed'
        }))
        const app = createApp(action === 'confirm-cleanup'
            ? { confirmOpenCodeClearCleanup: failure } as never
            : { abortOpenCodeClearSession: failure } as never)
        const response = await app.request(`/cli/sessions/source-session/clear-opencode/${action}`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify({ replacementSessionId: 'reserved-session' })
        })
        expect(response.status).toBe(500)
        expect(await response.json()).toMatchObject({ code: 'replacement_link_failed' })
        expect(failure).toHaveBeenCalledWith('source-session', 'default', 'reserved-session')
    })

    it.each(['confirm-cleanup', 'abort'] as const)('requires reservation identity for %s', async (action) => {
        const app = createApp({} as never)
        const response = await app.request(`/cli/sessions/source-session/clear-opencode/${action}`, {
            method: 'POST', headers: authHeaders(), body: '{}'
        })
        expect(response.status).toBe(400)
    })

    it('durably reserves through the namespace-scoped engine route', async () => {
        const reserveOpenCodeClearSession = mock(() => ({ type: 'success' as const, sessionId: 'reserved-session' }))
        const app = createApp({ reserveOpenCodeClearSession } as never)
        const response = await app.request('/cli/sessions/source-session/clear-opencode/reserve', {
            method: 'POST', headers: authHeaders()
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true, sessionId: 'reserved-session' })
        expect(reserveOpenCodeClearSession).toHaveBeenCalledWith('source-session', 'default')
    })

    it('orchestrates a fresh session only through the namespace-scoped engine route', async () => {
        const clearOpenCodeSession = mock(async () => ({ type: 'success' as const, sessionId: 'fresh-opencode-session' }))
        const app = createApp({ clearOpenCodeSession } as never)

        const response = await app.request('/cli/sessions/source-session/clear-opencode', {
            method: 'POST',
            headers: authHeaders()
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true, sessionId: 'fresh-opencode-session' })
        expect(clearOpenCodeSession).toHaveBeenCalledWith('source-session', 'default')
    })

    it('does not turn an active or wrong-flavor source into a new session', async () => {
        const app = createApp({
            clearOpenCodeSession: async () => ({
                type: 'error' as const,
                code: 'clear_unavailable' as const,
                message: 'Session must be an archived OpenCode clear source'
            })
        } as never)

        const response = await app.request('/cli/sessions/source-session/clear-opencode', {
            method: 'POST',
            headers: authHeaders()
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
            error: 'Session must be an archived OpenCode clear source',
            code: 'clear_unavailable'
        })
    })
})

describe('cli lazy session creation', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111'

    it('creates the machine and requested session identity in one request', async () => {
        const getOrCreateMachine = mock(() => ({ id: 'machine-1' }))
        const getOrCreateSession = mock(() => ({ id: sessionId }))
        const app = createApp({
            getMachine: () => null,
            getOrCreateMachine,
            getOrCreateSession
        } as never)

        const response = await app.request('/cli/sessions', {
            method: 'POST',
            headers: {
                ...authHeaders(),
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                id: sessionId,
                tag: 'lazy-tag',
                metadata: { path: '/tmp/project' },
                agentState: { controlledByUser: true },
                machine: {
                    id: 'machine-1',
                    metadata: { host: 'localhost' }
                }
            })
        })

        expect(response.status).toBe(200)
        expect(getOrCreateMachine).toHaveBeenCalledWith(
            'machine-1',
            { host: 'localhost' },
            null,
            'default'
        )
        expect(getOrCreateSession).toHaveBeenCalledWith(
            'lazy-tag',
            { path: '/tmp/project' },
            { controlledByUser: true },
            'default',
            undefined,
            undefined,
            undefined,
            sessionId
        )
    })

    it('rejects an embedded machine owned by another namespace', async () => {
        const getOrCreateMachine = mock(() => ({ id: 'machine-1' }))
        const getOrCreateSession = mock(() => ({ id: sessionId }))
        const app = createApp({
            getMachine: () => ({ id: 'machine-1', namespace: 'other' }),
            getOrCreateMachine,
            getOrCreateSession
        } as never)

        const response = await app.request('/cli/sessions', {
            method: 'POST',
            headers: {
                ...authHeaders(),
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                id: sessionId,
                tag: 'lazy-tag',
                metadata: {},
                machine: { id: 'machine-1', metadata: {} }
            })
        })

        expect(response.status).toBe(403)
        expect(getOrCreateMachine).not.toHaveBeenCalled()
        expect(getOrCreateSession).not.toHaveBeenCalled()
    })

    it('returns 409 for a requested identity conflict', async () => {
        const app = createApp({
            getOrCreateSession: () => {
                throw new SessionIdentityConflictError('Session tag is already bound to a different id')
            }
        })

        const response = await app.request('/cli/sessions', {
            method: 'POST',
            headers: {
                ...authHeaders(),
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                id: sessionId,
                tag: 'lazy-tag',
                metadata: {}
            })
        })

        expect(response.status).toBe(409)
    })
})

describe('cli durable attachment delivery', () => {
    it('serves an owned original through the authenticated CLI endpoint', async () => {
        const readAttachment = mock(async () => ({
            attachment: { filename: 'document.pdf' } as never,
            variant: 'original' as const,
            data: Buffer.from([1, 2, 3, 4]),
            mimeType: 'application/pdf',
            size: 4,
            sha256: 'hash-2'
        }))
        const app = createApp({
            resolveSessionAccess: () => ({
                ok: true as const,
                sessionId: 'session-1',
                session: {} as never
            }),
            readAttachment
        } as never)

        const response = await app.request('/cli/sessions/session-1/attachments/attachment-1/original', {
            headers: authHeaders()
        })

        expect(response.status).toBe(200)
        expect(readAttachment).toHaveBeenCalledWith('session-1', 'default', 'attachment-1')
        expect(response.headers.get('content-type')).toBe('application/pdf')
        expect(response.headers.get('content-length')).toBe('4')
        expect(response.headers.get('content-disposition')).toBe('attachment; filename="document.pdf"')
        expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
        expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4])
    })

    it('sandboxes active MIME types and sanitizes CLI attachment filenames', async () => {
        const app = createApp({
            resolveSessionAccess: () => ({
                ok: true as const,
                sessionId: 'session-1',
                session: {} as never,
            }),
            readAttachment: mock(async () => ({
                attachment: { filename: 'evil"\r\n.html' } as never,
                variant: 'original' as const,
                data: Buffer.from('<script>alert(1)</script>'),
                mimeType: 'text/html',
                size: 25,
                sha256: 'html-hash',
            })),
        } as never)

        const response = await app.request('/cli/sessions/session-1/attachments/attachment-1/original', {
            headers: authHeaders(),
        })

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('text/html')
        expect(response.headers.get('content-disposition')).toBe('attachment; filename="evil___.html"')
        expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    })

    it('encodes Unicode attachment filenames for CLI download headers', async () => {
        const app = createApp({
            resolveSessionAccess: () => ({
                ok: true as const,
                sessionId: 'session-1',
                session: {} as never,
            }),
            readAttachment: mock(async () => ({
                attachment: { filename: '截图😀.png' } as never,
                variant: 'original' as const,
                data: Buffer.from([1]),
                mimeType: 'image/png',
                size: 1,
                sha256: 'unicode-hash',
            })),
        } as never)

        const response = await app.request('/cli/sessions/session-1/attachments/attachment-1/original', {
            headers: authHeaders(),
        })

        expect(response.status).toBe(200)
        expect(response.headers.get('content-disposition')).toBe(
            "attachment; filename=\"____.png\"; filename*=UTF-8''%E6%88%AA%E5%9B%BE%F0%9F%98%80.png"
        )
    })

    it('does not expose an attachment when the session is outside the CLI namespace', async () => {
        const readAttachment = mock(async () => null)
        const app = createApp({
            resolveSessionAccess: () => ({ ok: false as const, reason: 'access-denied' as const }),
            readAttachment
        } as never)

        const response = await app.request('/cli/sessions/session-1/attachments/attachment-1/original', {
            headers: authHeaders()
        })

        expect(response.status).toBe(403)
        expect(readAttachment).not.toHaveBeenCalled()
    })
})
