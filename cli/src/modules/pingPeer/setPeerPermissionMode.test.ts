import { describe, expect, it, vi } from 'vitest'
import { PingPeerError, setPeerPermissionMode } from './pingPeer'

const sessionId = '7d55ed21-8a9f-4309-b4f8-30069df36b4b'

function createHttpMock(options: { flavor: string; active: boolean; shared?: boolean; modeResponse?: { status: number; data: unknown } }) {
    const session = {
        id: sessionId,
        active: options.active,
        metadata: { name: 'worker', flavor: options.flavor, capabilities: { concurrentClients: options.shared ?? false } }
    }
    return {
        post: vi.fn(async (url: string, _body?: unknown) => {
            if (url.endsWith('/api/auth')) {
                return { status: 200, data: { token: 'jwt' } }
            }
            if (url.endsWith(`/api/sessions/${sessionId}/permission-mode`)) {
                return options.modeResponse ?? { status: 200, data: { ok: true } }
            }
            throw new Error(`unexpected POST ${url}`)
        }),
        get: vi.fn(async (url: string) => {
            if (url.endsWith('/api/sessions')) {
                return { status: 200, data: { sessions: [session] } }
            }
            if (url.endsWith(`/api/sessions/${sessionId}`)) {
                return { status: 200, data: { session } }
            }
            throw new Error(`unexpected GET ${url}`)
        })
    }
}

const base = { accessToken: 'tok', apiUrl: 'http://hub.test' }

describe('setPeerPermissionMode', () => {
    it.each([
        { mode: 'yolo', shared: false },
        { mode: 'yolo', shared: true },
        { mode: 'autoReview', shared: false },
        { mode: 'autoReview', shared: true }
    ])('resolves a prefix and posts $mode to the permission-mode route (shared: $shared)', async ({ mode, shared }) => {
        const http = createHttpMock({ flavor: 'codex', active: true, shared })

        const result = await setPeerPermissionMode({ ...base, sessionIdPrefix: '7d55ed21', mode, http: http as never })

        expect(result).toEqual({ sessionId, name: 'worker', flavor: 'codex', mode, active: true })
        expect(http.post).toHaveBeenCalledWith(
            `http://hub.test/api/sessions/${sessionId}/permission-mode`,
            { mode },
            expect.anything()
        )
    })

    it('rejects a mode the flavor does not allow without calling the hub', async () => {
        const http = createHttpMock({ flavor: 'codex', active: false })

        const error = await setPeerPermissionMode({ ...base, sessionIdPrefix: sessionId, mode: 'bypassPermissions', http: http as never })
            .catch((e: unknown) => e)

        expect(error).toBeInstanceOf(PingPeerError)
        expect((error as PingPeerError).code).toBe('bad_args')
        expect((error as PingPeerError).message).toContain('allowed: default, read-only, safe-yolo, autoReview, yolo')
        expect(http.post).toHaveBeenCalledTimes(1)
    })

    it('rejects Safe Yolo for a shared session without calling the hub', async () => {
        const http = createHttpMock({ flavor: 'codex', active: false, shared: true })

        await expect(setPeerPermissionMode({ ...base, sessionIdPrefix: sessionId, mode: 'safe-yolo', http: http as never }))
            .rejects.toMatchObject({ code: 'bad_args', message: "invalid mode 'safe-yolo' for codex; allowed: default, read-only, autoReview, yolo" })
        expect(http.post).toHaveBeenCalledTimes(1)
    })

    it('surfaces the hub error', async () => {
        const http = createHttpMock({
            flavor: 'opencode',
            active: true,
            modeResponse: { status: 409, data: { error: 'OpenCode plan mode is only supported for remote sessions' } }
        })

        await expect(setPeerPermissionMode({ ...base, sessionIdPrefix: sessionId, mode: 'plan', http: http as never }))
            .rejects.toMatchObject({ code: 'apply_failed', message: 'set-mode failed: OpenCode plan mode is only supported for remote sessions' })
    })
})
