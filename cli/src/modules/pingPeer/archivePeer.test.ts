import { describe, expect, it, vi } from 'vitest'
import { archivePeer, type PingPeerSessionSummary } from './pingPeer'

const sessions: PingPeerSessionSummary[] = [
    { id: 'caller-1', active: true, metadata: { name: 'Caller' } },
    { id: 'review-1', active: true, metadata: { name: 'Review' } },
    { id: 'review-2', active: false, metadata: { name: 'Old review', lifecycleState: 'archived' } }
]
function setup(options: { sessions?: PingPeerSessionSummary[]; status?: number; body?: unknown; disconnect?: boolean } = {}) {
    const post = vi.fn(async (url: string) => {
        if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
        if (options.disconnect) throw new Error('connection closed')
        return { status: options.status ?? 200, data: options.body ?? { ok: true } }
    })
    const get = vi.fn(async () => ({ status: 200, data: { sessions: options.sessions ?? sessions } }))
    return { post, get, options: { apiUrl: 'http://hub.test', accessToken: 'tok:team', http: { post, get } as never } }
}

describe('archive targeting and failures', () => {
    it('uses the bound current session only when no explicit target was provided', async () => {
        const { post, options } = setup()
        await expect(archivePeer({ ...options, currentSessionId: 'caller-1' })).resolves.toMatchObject({ sessionId: 'caller-1' })
        expect(post.mock.calls[1]?.[0]).toBe('http://hub.test/api/sessions/caller-1/archive')
        await expect(archivePeer({ ...options, currentSessionId: 'caller-1', sessionIdPrefix: 'review-1' })).resolves.toMatchObject({ sessionId: 'review-1' })
    })
    it.each(['', '  ', 'missing', 'review'])('refuses invalid, absent or ambiguous explicit targets %j', async (target) => {
        const { post, options } = setup()
        await expect(archivePeer({ ...options, currentSessionId: 'caller-1', sessionIdPrefix: target })).rejects.toThrow()
        expect(post.mock.calls.every(([url]) => url.endsWith('/api/auth'))).toBe(true)
    })
    it('does not archive an outside-namespace ID absent from the authenticated list', async () => {
        const { options, post } = setup()
        await expect(archivePeer({ ...options, sessionIdPrefix: 'outside-namespace-id' })).rejects.toMatchObject({ code: 'not_found' })
        expect(post).toHaveBeenCalledTimes(1)
    })
    it('acknowledges repeated archive requests without resuming or deleting', async () => {
        const { options, post } = setup({ body: { ok: true, alreadyArchived: true } })
        await expect(archivePeer({ ...options, sessionIdPrefix: 'review-2' })).resolves.toMatchObject({ alreadyArchived: true })
        expect(post.mock.calls.map(([url]) => url)).toEqual(['http://hub.test/api/auth', 'http://hub.test/api/sessions/review-2/archive'])
    })
    it.each([401, 403, 404, 409, 500])('reports a rejected archive (HTTP %i)', async (status) => {
        const { options } = setup({ status, body: { error: 'Archive refused' } })
        await expect(archivePeer({ ...options, sessionIdPrefix: 'review-1' })).rejects.toThrow('Archive refused')
    })
    it('treats a broken response or transport as unconfirmed and never retries the mutation', async () => {
        const { options, post } = setup({ disconnect: true })
        await expect(archivePeer({ ...options, sessionIdPrefix: 'caller-1' })).rejects.toThrow(/unconfirmed.*may have succeeded/)
        expect(post).toHaveBeenCalledTimes(2)
        const malformed = setup({ body: { ok: false } })
        await expect(archivePeer({ ...malformed.options, sessionIdPrefix: 'review-1' })).rejects.toThrow('Archive failed')
    })
    it('refuses implicit self-archive outside a bound session', async () => {
        const { options, post } = setup()
        await expect(archivePeer(options)).rejects.toMatchObject({ code: 'bad_args' })
        expect(post).not.toHaveBeenCalled()
    })
})
