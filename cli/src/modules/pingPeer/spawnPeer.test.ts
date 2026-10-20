import { describe, expect, it, vi } from 'vitest'
import type { AxiosInstance } from 'axios'
import { spawnPeer } from './pingPeer'

function transport() {
    let localId = ''
    let postOutcome = 'ok'
    const post = vi.fn(async (url: string, body: Record<string, unknown>) => {
        if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
        if (url.endsWith('/create-peer')) return { status: 200, data: { type: 'success', sessionId: 'child' } }
        if (url.endsWith('/messages')) {
            localId = body.localId as string
            if (postOutcome === 'lost-response') throw new Error('lost response')
            return { status: 200, data: { ok: true } }
        }
        if (url.endsWith('/queued-state')) return { status: 200, data: { queuedLocalIds: postOutcome === 'unconfirmed' ? [] : [localId], invokedLocalMessages: [] } }
        throw new Error('Unexpected URL ' + url)
    })
    const get = vi.fn(async () => ({ status: 200, data: { session: { id: 'child', active: true, metadata: { flavor: 'codex', name: 'Review' } } } }))
    return { post, get, http: { post, get } as unknown as AxiosInstance, outcome: (value: string) => { postOutcome = value } }
}

describe('spawn peer', () => {
    it.each(['codex', 'claude'] as const)('creates %s with explicit options through the bound caller route', async (agent) => {
        const t = transport()
        const result = await spawnPeer({ message: 'Review it', agent, model: null, yolo: false }, { http: t.http, apiUrl: 'http://hub', accessToken: 'key:namespace', currentSessionId: 'parent' })
        expect(result.sessionId).toBe('child')
        expect(result.path).toBe('/sessions/child')
        expect(t.post).toHaveBeenCalledWith('http://hub/api/sessions/parent/create-peer', { agent, model: null, yolo: false }, expect.anything())
        const delivery = t.post.mock.calls.find(([url]) => url.endsWith('/messages'))!
        expect(delivery[1]).toMatchObject({ text: 'Review it', localId: expect.any(String) })
        expect(t.post.mock.calls.some(([url]) => url.endsWith('/resume'))).toBe(false)
    })
    it('recovers a lost message response using the exact localId receipt', async () => {
        const t = transport(); t.outcome('lost-response')
        expect((await spawnPeer({ message: 'work' }, { http: t.http, apiUrl: 'http://hub', accessToken: 'key', currentSessionId: 'parent' })).sessionId).toBe('child')
        expect(t.post.mock.calls.filter(([url]) => url.endsWith('/messages'))).toHaveLength(1)
    })
    it('leaves an uncertain child alive and reports its identity', async () => {
        const t = transport(); t.outcome('unconfirmed')
        await expect(spawnPeer({ message: 'work' }, { http: t.http, apiUrl: 'http://hub', accessToken: 'key', currentSessionId: 'parent' })).rejects.toThrow('Created child (/sessions/child)')
        expect(t.post.mock.calls.some(([url]) => /archive|delete|resume/.test(url))).toBe(false)
    })
    it('never accepts a parent or credentials supplied through tool options', async () => {
        const t = transport()
        await expect(spawnPeer({ message: 'work', parentSessionId: 'forged' } as never, { http: t.http })).rejects.toThrow()
        expect(t.post).not.toHaveBeenCalled()
    })
})
