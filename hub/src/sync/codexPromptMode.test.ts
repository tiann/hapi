import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

describe('Codex prompt mode', () => {
    it('persists both modes, refreshes clients and preserves a concurrent metadata update', async () => {
        const store = new Store(':memory:')
        const events: unknown[] = []
        const engine = new SyncEngine(store, {
            of: () => ({ to: () => ({ emit: (_event: string, update: unknown) => events.push(update) }) })
        } as never, new RpcRegistry(), { broadcast() { } } as never)
        try {
            const session = engine.getOrCreateSession('toggle', { path: '/tmp', host: 'test', flavor: 'codex' }, null, 'default')
            store.sessions.updateSessionMetadata(session.id, { ...session.metadata, name: 'Concurrent title' }, session.metadataVersion, 'default')
            await engine.setCodexPromptMode(session.id, 'steer')
            expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({ name: 'Concurrent title', codexPromptMode: 'steer' })
            expect(engine.getSession(session.id)?.metadata?.codexPromptMode).toBe('steer')
            expect(events.at(-1)).toMatchObject({ body: { t: 'update-session', sid: session.id, metadata: { value: { codexPromptMode: 'steer' } } } })
            await engine.setCodexPromptMode(session.id, 'queue')
            expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({ name: 'Concurrent title', codexPromptMode: 'queue' })
            const other = engine.getOrCreateSession('other', { path: '/tmp', host: 'test', flavor: 'claude' }, null, 'default')
            await expect(engine.setCodexPromptMode(other.id, 'steer')).rejects.toThrow('Codex')
        } finally { engine.stop(); store.close() }
    })
})
