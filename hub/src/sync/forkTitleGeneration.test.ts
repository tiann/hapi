import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import { TitleSuggestionService } from './titleSuggestion'
import type { Metadata } from '@hapi/protocol/types'

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function fixture(shared = true, childMetadata: Partial<Metadata> = {}, flavor = 'codex') {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const source = engine.getOrCreateSession('parent', {
        path: '/tmp/work', host: 'test', machineId: 'machine', flavor, codexSessionId: 'native-parent',
        name: 'Current title', capabilities: { concurrentClients: shared,
            conversationHistory: { forkCurrent: true, forkAtMessage: true } }
    }, null, 'default')
    engine.handleSessionAlive({ sid: source.id, time: Date.now() })
    const child = shared ? engine.getOrCreateSession('child', {
        path: '/tmp/work', host: 'test', machineId: 'machine', flavor, codexSessionId: 'native-child',
        forkedFrom: source.id, capabilities: { concurrentClients: true }, ...childMetadata
    }, null, 'default') : undefined
    if (child && childMetadata.titleLocked === true) {
        const current = store.sessions.getSession(child.id)!
        store.sessions.updateSessionMetadata(child.id, { ...(current.metadata as Metadata), titleLocked: true },
            current.metadataVersion, 'default', { allowTitleUpdate: true, titleLocked: true })
        ;(engine as any).sessionCache.refreshSession(child.id)
    }
    if (child) engine.handleSessionAlive({ sid: child.id, time: Date.now() })
    const internal = engine as any
    internal.rpcGateway.forkConversation = async () => ({ nativeSessionId: 'native-child',
        ...(child ? { sessionId: child.id } : {}) })
    internal.rpcGateway.spawnSession = async (...args: unknown[]) => ({ type: 'success', sessionId: args[12] })
    internal.waitForExactNativeForkBound = async () => true
    const setMetadata = (id: string, update: (metadata: Metadata) => Metadata) => {
        const current = store.sessions.getSession(id)!
        store.sessions.updateSessionMetadata(id, update(current.metadata as Metadata), current.metadataVersion, 'default')
        internal.sessionCache.refreshSession(id)
    }
    const message = (id: string, text: string, localId: string) => {
        store.messages.addMessage(id, { role: 'user', content: text }, localId)
        store.messages.markMessagesInvoked(id, [localId], Date.now())
    }
    return { store, engine, source, child, internal, setMetadata, message,
        close() { engine.stop(); store.close() } }
}

describe('fork title generation', () => {
    it('generates for a native shared fork readiness event and deduplicates the REST trigger', async () => {
        const seed = { text: 'Fork: Current title', updatedAt: 1 }
        const f = fixture(true, { summary: seed, forkTitleSeed: seed })
        try {
            let requests = 0
            let finish!: (title: string) => void
            f.internal.titleSuggestionService.suggestTitle = async () => {
                requests++
                return await new Promise<string>(resolve => { finish = resolve })
            }
            f.engine.handleSessionReady({ sid: f.child!.id, time: Date.now() })
            f.engine.handleSessionReady({ sid: f.child!.id, time: Date.now() })
            await flush()
            expect(requests).toBe(1)
            await f.engine.forkConversation(f.source.id, 'default')
            expect(requests).toBe(1)
            const reconnected = new SyncEngine(f.store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
            try {
                ;(reconnected as any).titleSuggestionService.suggestTitle = async () => { requests++; return 'Duplicate' }
                reconnected.handleSessionReady({ sid: f.child!.id, time: Date.now() })
                expect(requests).toBe(1)
            } finally { reconnected.stop() }
            finish('Native terminal fork title')
            await flush()
            expect(f.engine.getSession(f.child!.id)?.metadata?.summary?.text).toBe('Native terminal fork title')
        } finally { f.close() }
    })
    it.each(['manual-name', 'manual-summary', 'locked', 'deleted', 'stopped'])(
        'does not apply an in-flight result after %s', async action => {
            const f = fixture()
            try {
                let finish!: (title: string) => void
                f.internal.titleSuggestionService.suggestTitle = () => new Promise<string>(resolve => { finish = resolve })
                const result = await f.engine.forkConversation(f.source.id, 'default')
                expect(result.type).toBe('success')
                const id = f.child!.id
                if (action === 'manual-name') await f.engine.renameSession(id, 'Chosen child name')
                if (action === 'manual-summary') await f.engine.updateSessionSummary(id, 'User-generated draft')
                if (action === 'locked') await f.engine.renameSession(id, undefined, true)
                if (action === 'deleted') f.store.sessions.deleteSession(id, 'default')
                if (action === 'stopped') f.engine.stop()
                finish('Provider result')
                await flush()
                expect((f.store.sessions.getSession(id)?.metadata as Metadata | undefined)?.summary?.text).not.toBe('Provider result')
                if (action === 'manual-name') expect(f.engine.getSession(id)?.metadata?.name).toBe('Chosen child name')
                if (action === 'manual-summary') expect(f.engine.getSession(id)?.metadata?.summary?.text).toBe('User-generated draft')
                if (action === 'manual-name' || action === 'manual-summary') {
                    expect(f.engine.getSession(id)?.metadata?.forkTitleSeed).toBeUndefined()
                    expect(f.engine.getSession(id)?.metadata?.forkTitleGenerationAttemptedAt).toBeUndefined()
                }
            } finally { f.close() }
        })

    it.each(['unconfigured', 'failure', 'empty'])(
        'keeps the seed when the provider is %s and permits a later manual retry', async mode => {
            const f = fixture()
            try {
                if (mode === 'unconfigured') f.internal.titleSuggestionService = new TitleSuggestionService(f.store)
                else {
                    f.message(f.child!.id, 'Fork topic', 'prompt')
                    f.internal.titleSuggestionService = new TitleSuggestionService(f.store, { provider: {
                        suggest: async () => { if (mode === 'failure') throw new Error(mode); return '   ' }
                    } })
                }
                await f.engine.forkConversation(f.source.id, 'default')
                await flush()
                expect(f.engine.getSession(f.child!.id)?.metadata?.summary?.text).toBe('Fork: Current title')
                f.internal.titleSuggestionService.suggestTitle = async () => 'Manual retry result'
                const title = await f.engine.suggestSessionTitle(f.child!.id)
                await f.engine.updateSessionSummary(f.child!.id, title)
                expect(f.engine.getSession(f.child!.id)?.metadata?.summary?.text).toBe('Manual retry result')
            } finally { f.close() }
        })

    it.each(['claude', 'grok', 'pi'])(
        'uses the completed %s fork prefix and excludes its historical boundary and queued prompts', async flavor => {
            const f = fixture(false, {}, flavor)
            try {
                f.message(f.source.id, 'Earlier payment topic', 'before')
                f.message(f.source.id, 'Excluded boundary', 'boundary')
                f.message(f.source.id, 'Later source topic', 'after')
                f.setMetadata(f.source.id, metadata => ({ ...metadata, conversationHistoryPoints: { boundary: true } }))
                f.internal.rpcGateway.forkConversation = async () => {
                    // A row arriving during the native RPC must not enter the prefix.
                    f.store.messages.addMessage(f.source.id, { role: 'user', content: 'Queued source prompt' }, 'queued')
                    return { nativeSessionId: 'native-child' }
                }
                let prompt = ''
                f.internal.titleSuggestionService = new TitleSuggestionService(f.store, {
                    provider: { suggest: async value => { prompt = value; return 'Payment branch' } }
                })
                const result = await f.engine.forkConversation(f.source.id, 'default', 'boundary')
                if (result.type !== 'success') throw new Error(result.message)
                expect(result.type).toBe('success')
                await flush()
                expect(prompt).toContain('Earlier payment topic')
                expect(prompt).not.toContain('Excluded boundary')
                expect(prompt).not.toContain('Later source topic')
                expect(prompt).not.toContain('Queued source prompt')
                expect(f.engine.getSession(result.sessionId)?.metadata?.summary?.text).toBe('Payment branch')
                expect(f.engine.getSession(f.source.id)?.metadata?.name).toBe('Current title')
            } finally { f.close() }
        })

    it('passes the shared child history to the same provider service used by manual Generate', async () => {
        const f = fixture()
        try {
            f.message(f.source.id, 'Parent-only later topic', 'parent-only')
            f.message(f.child!.id, 'Actual fork topic', 'child-prompt')
            let prompt = ''
            f.internal.titleSuggestionService = new TitleSuggestionService(f.store, {
                provider: { suggest: async value => { prompt = value; return 'Child topic' } }
            })
            await f.engine.forkConversation(f.source.id, 'default')
            await flush()
            expect(prompt).toContain('Actual fork topic')
            expect(prompt).not.toContain('Parent-only later topic')
            expect(f.engine.getSession(f.child!.id)?.metadata?.summary?.text).toBe('Child topic')
            expect(f.engine.getSession(f.child!.id)?.metadata?.forkTitleSeed).toBeUndefined()
        } finally { f.close() }
    })

    it.each([{ name: 'Existing name' }, { summary: { text: 'Existing summary', updatedAt: 1 } }, { titleLocked: true }])(
        'preserves an already named or locked child: %j', async metadata => {
            const f = fixture(true, metadata)
            try {
                let requests = 0
                f.internal.titleSuggestionService.suggestTitle = async () => { requests++; return 'Unexpected' }
                await f.engine.forkConversation(f.source.id, 'default')
                expect(requests).toBe(0)
                expect(f.engine.getSession(f.child!.id)?.metadata).toMatchObject(metadata)
            } finally { f.close() }
        })

    it('does not invoke a provider when native fork fails', async () => {
        const f = fixture()
        try {
            let requests = 0
            f.internal.titleSuggestionService.suggestTitle = async () => { requests++; return 'Unexpected' }
            f.internal.rpcGateway.forkConversation = async () => { throw new Error('Native failure') }
            expect(await f.engine.forkConversation(f.source.id, 'default')).toMatchObject({ type: 'error' })
            expect(requests).toBe(0)
        } finally { f.close() }
    })

    it.each(['unrelated-update', 'rename', 'write-error'])(
        'rechecks title ownership after a metadata %s', async action => {
            const f = fixture()
            try {
                let finish!: (title: string) => void
                f.internal.titleSuggestionService.suggestTitle = () => new Promise<string>(resolve => { finish = resolve })
                await f.engine.forkConversation(f.source.id, 'default')
                const original = f.store.sessions.updateSessionMetadata.bind(f.store.sessions)
                let raced = false
                f.store.sessions.updateSessionMetadata = (...args) => {
                    if (!raced) {
                        raced = true
                        if (action === 'write-error') return { result: 'error' }
                        const current = f.store.sessions.getSession(f.child!.id)!
                        original(current.id, { ...(current.metadata as Metadata),
                            ...(action === 'rename' ? { name: 'Concurrent rename' } : { version: 'new-version' })
                        }, current.metadataVersion, 'default')
                    }
                    return original(...args)
                }
                finish('Provider result')
                await flush()
                const metadata = f.engine.getSession(f.child!.id)?.metadata
                expect(metadata?.summary?.text).toBe(action === 'unrelated-update' ? 'Provider result' : 'Fork: Current title')
                if (action === 'rename') expect(metadata?.name).toBe('Concurrent rename')
                if (action === 'unrelated-update') expect(metadata?.version).toBe('new-version')
            } finally { f.close() }
        })

    it('generates a title for an untitled fork when history is available', async () => {
        const f = fixture()
        try {
            f.setMetadata(f.source.id, metadata => ({ ...metadata, name: undefined }))
            f.message(f.child!.id, 'Untitled fork topic', 'prompt')
            f.internal.titleSuggestionService = new TitleSuggestionService(f.store, {
                provider: { suggest: async () => 'Untitled branch named' }
            })
            await f.engine.forkConversation(f.source.id, 'default')
            await flush()
            expect(f.engine.getSession(f.child!.id)?.metadata?.summary?.text).toBe('Untitled branch named')
        } finally { f.close() }
    })

    it('seeds the shared child and generates from its fork snapshot without waiting for another turn', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const source = engine.getOrCreateSession('parent', {
                path: '/tmp/work', host: 'test', machineId: 'machine', flavor: 'codex', codexSessionId: 'native-parent',
                name: 'Current parent title', capabilities: { concurrentClients: true, conversationHistory: { forkCurrent: true } }
            }, null, 'default')
            engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            const child = engine.getOrCreateSession('child', {
                path: '/tmp/work', host: 'test', machineId: 'machine', flavor: 'codex', codexSessionId: 'native-child',
                forkedFrom: source.id, capabilities: { concurrentClients: true }
            }, null, 'default')
            engine.handleSessionAlive({ sid: child.id, time: Date.now() })
            store.messages.addMessage(child.id, { role: 'user', content: 'Latest payment topic' }, 'prompt')
            store.messages.markMessagesInvoked(child.id, ['prompt'], Date.now())
            const internal = engine as any
            internal.rpcGateway.forkConversation = async () => ({ nativeSessionId: 'native-child', sessionId: child.id })
            let finish!: (value: string) => void
            let requested = false
            internal.titleSuggestionService.suggestTitle = async () => {
                requested = true
                return await new Promise<string>(resolve => { finish = resolve })
            }
            expect(await engine.forkConversation(source.id, 'default')).toEqual({ type: 'success', sessionId: child.id })
            expect(engine.getSession(child.id)?.metadata?.summary?.text).toBe('Fork: Current parent title')
            expect(requested).toBe(true)
            finish('Payment optimization')
            await new Promise(resolve => setTimeout(resolve, 0))
            expect(engine.getSession(child.id)?.metadata?.summary?.text).toBe('Payment optimization')
        } finally { engine.stop() }
    })
})
