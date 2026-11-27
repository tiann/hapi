import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from '../web/middleware/auth'
import { createSessionsRoutes } from '../web/routes/sessions'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

function fixture() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const source = engine.getOrCreateSession('cursor-history', {
        path: '/tmp/synthetic', host: 'localhost', machineId: 'machine', flavor: 'cursor',
        cursorSessionId: 'original', cursorSessionProtocol: 'acp',
        capabilities: { conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: true } },
        conversationHistoryPoints: { second: true },
        lastModelError: { eventId: 'discarded', transient: true, kind: 'model', rawSnippet: '', atTs: 1, priorAssistantClaimsDone: false }
    }, null, 'default')
    engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
    for (const localId of ['first', 'second']) {
        store.messages.addMessage(source.id, { role: 'user', content: localId }, localId)
        store.messages.markMessagesInvoked(source.id, [localId], Date.now())
    }
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createSessionsRoutes(() => engine))
    async function post(action: string, body: object) {
        return app.request(`/api/sessions/${source.id}/${action}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        })
    }
    return {
        engine, store, post, id: source.id, rpc: engine['rpcGateway'],
        rewind: () => engine.rewindConversation(source.id, 'default', 'second'),
        rows: () => store.messages.getAllMessages(source.id).map(m => m.localId)
    }
}

describe('Cursor native history', () => {
    let f: ReturnType<typeof fixture>
    afterEach(() => f.engine.stop())

    it('spawns an ACP child with the exclusive transcript prefix and fresh history points', async () => {
        f = fixture()
        f.rpc.forkConversation = async () => ({ nativeSessionId: 'copy' })
        f.rpc.spawnSession = async (...args) => {
            expect(args[8]).toBe('copy')
            const childId = args[12]!
            expect(f.engine.getSession(childId)?.metadata).toMatchObject({
                cursorSessionId: 'copy', cursorSessionProtocol: 'acp', conversationHistoryPoints: {}, forkedFrom: f.id
            })
            f.engine.handleSessionAlive({ sid: childId, time: Date.now(), mode: 'remote' })
            f.engine.handleSessionReady({ sid: childId, time: Date.now() })
            return { type: 'success', sessionId: childId }
        }
        const preview = await f.post('fork-preview', { intent: 'message', messageLocalId: 'second' })
        expect(preview.status).toBe(200)
        const response = await f.post('fork', { messageLocalId: 'second', boundary: (await preview.json()).boundary })
        expect(response.status).toBe(200)
        expect(f.store.messages.getAllMessages((await response.json()).sessionId).map(m => m.localId)).toEqual(['first'])
        expect(f.rows()).toEqual(['first', 'second'])
    })

    it('commits the shortened transcript and its ACP identity before enabling input', async () => {
        f = fixture()
        const calls: string[] = []
        f.rpc.rewindConversation = async (_, params) => {
            if (params.cursorSourceSessionId === 'original') {
                calls.push('prepare')
                expect(f.rows()).toEqual(['first', 'second'])
                return { success: true, truncateFromLocalId: 'second', nativeSessionId: 'copy' }
            }
            expect(params.cursorCommittedSessionId).toBe('copy')
            expect(f.engine.getSession(f.id)?.metadata).toMatchObject({ cursorSessionId: 'copy', conversationHistoryPoints: {} })
            expect(f.engine.getSession(f.id)?.metadata?.lastModelError).toBeUndefined()
            expect(f.rows()).toEqual(['first'])
            calls.push('activate')
            return { success: true, truncateFromLocalId: 'second' }
        }
        const preview = await f.post('fork-preview', { intent: 'rewind', messageLocalId: 'second' })
        expect(preview.status).toBe(200)
        const response = await f.post('rewind', { messageLocalId: 'second', boundary: (await preview.json()).boundary })
        expect(await response.json()).toEqual({ success: true })
        expect(calls).toEqual(['prepare', 'activate'])
    })

    it.each(['lost reply', 'same identity', 'concurrent message', 'new worker'])('preserves the original binding and transcript on %s', async failure => {
        f = fixture()
        f.rpc.rewindConversation = async () => {
            if (failure === 'lost reply') throw new Error('disconnected')
            if (failure === 'concurrent message') f.store.messages.addMessage(f.id, { role: 'user', content: 'later' }, 'later')
            if (failure === 'new worker') {
                const original = f.engine.getSession(f.id)!
                f.store.sessions.updateSessionMetadata(f.id, { ...original.metadata, hostPid: 100 }, original.metadataVersion, 'default')
            }
            return { success: true, truncateFromLocalId: 'second', nativeSessionId: failure === 'same identity' ? 'original' : 'copy' }
        }
        expect((await f.rewind()).type).toBe('error')
        expect(f.rows().slice(0, 2)).toEqual(['first', 'second'])
        expect(f.engine.getSession(f.id)?.metadata?.cursorSessionId).toBe('original')
    })

    it('preserves the committed cut when activation loses its reply', async () => {
        f = fixture()
        f.rpc.rewindConversation = async (_, params) => {
            if (params.cursorCommittedSessionId) throw new Error('disconnected')
            return { success: true, truncateFromLocalId: 'second', nativeSessionId: 'copy' }
        }
        expect(await f.rewind()).toMatchObject({ type: 'error', message: expect.stringContaining('committed') })
        expect(f.rows()).toEqual(['first'])
        expect(f.engine.getSession(f.id)?.metadata?.cursorSessionId).toBe('copy')
    })
})
