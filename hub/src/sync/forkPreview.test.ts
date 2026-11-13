import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import { FORK_PREVIEW_TAIL_ROWS, type ForkBoundary, type ForkPreviewResponse } from '@hapi/protocol/forkBoundary'
import { MACHINE_CAPABILITIES } from '@hapi/protocol'
import type { RpcGateway } from './rpcGateway'

type FixtureOptions = {
    flavor?: string
    thinking?: boolean
    capabilities?: Record<string, unknown>
}

function fixture(options: FixtureOptions = {}) {
    const flavor = options.flavor ?? 'codex'
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const source = engine.getOrCreateSession('source', {
        path: '/tmp/work', host: 'test', machineId: 'machine', hostPid: 42, flavor,
        capabilities: options.capabilities ?? { conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: true } }
    }, { controlledByUser: false }, 'default')
    engine.handleSessionAlive({ sid: source.id, time: Date.now(), thinking: options.thinking === true, mode: 'remote' })
    const addInvoked = (localId: string, content = localId, offset = 0) => {
        store.messages.addMessage(source.id, { role: 'user', content }, localId)
        store.messages.markMessagesInvoked(source.id, [localId], Date.now() + offset)
    }
    addInvoked('u1')
    addInvoked('a1')
    addInvoked('u2')
    addInvoked('a2')
    const rpc = (engine as unknown as { rpcGateway: RpcGateway }).rpcGateway
    const preview = async (intent: 'current' | 'message' | 'rewind', messageLocalId?: string) =>
        await engine.forkPreview(source.id, 'default', intent, messageLocalId)
    return { store, engine, source, rpc, addInvoked, preview }
}

function expectPreview(result: Awaited<ReturnType<SyncEngine['forkPreview']>>): ForkPreviewResponse {
    expect(result.type).toBe('success')
    if (result.type !== 'success') throw new Error(result.message)
    return result.preview
}

describe('fork preview', () => {
    it('answers an idle current fork from hub rows with a current boundary token', async () => {
        const { preview } = fixture()
        const result = await preview('current')
        const response = expectPreview(result)
        expect(response.mode).toBe('current')
        expect(response.boundary).toMatchObject({ v: 1, mode: 'current', tailSeq: 4 })
        expect(typeof response.boundary.epoch).toBe('number')
        expect(response.boundary.messageLocalId).toBeUndefined()
        expect(response.boundary.nativeTurnId).toBeUndefined()
        expect(response.keptTail.map((row) => row.localId)).toEqual(['u1', 'a1', 'u2', 'a2'])
        expect(response.excluded).toEqual([])
        expect(response.counts).toEqual({ kept: 4, excluded: 0 })
    })

    it('windows keptTail to the last rows while counting the full prefix', async () => {
        const { engine, preview, addInvoked } = fixture()
        for (let index = 0; index < FORK_PREVIEW_TAIL_ROWS + 4; index++) {
            addInvoked(`extra-${index}`)
        }
        expect(engine).toBeDefined()
        const response = expectPreview(await preview('current'))
        expect(response.keptTail).toHaveLength(FORK_PREVIEW_TAIL_ROWS)
        expect(response.keptTail.at(-1)?.localId).toBe(`extra-${FORK_PREVIEW_TAIL_ROWS + 3}`)
        expect(response.counts.kept).toBe(4 + FORK_PREVIEW_TAIL_ROWS + 4)
    })

    it('cuts a message preview before the boundary row and names the boundary', async () => {
        const { preview } = fixture()
        const response = expectPreview(await preview('message', 'u2'))
        expect(response.mode).toBe('message')
        expect(response.boundary.messageLocalId).toBe('u2')
        expect(response.keptTail.map((row) => row.localId)).toEqual(['u1', 'a1'])
        expect(response.excluded.map((row) => row.localId)).toEqual(['u2'])
        expect(response.counts).toEqual({ kept: 2, excluded: 2 })
    })

    it('resolves a running Codex current intent to latestCompleted and fails closed without a preview-capable runner', async () => {
        const { preview } = fixture({ thinking: true, capabilities: { conversationHistory: { forkCurrent: true, forkLatestCompleted: true } } })
        const result = await preview('current')
        expect(result).toEqual({ type: 'error', message: 'Update the runner to preview this fork' })
    })

    it('keeps the busy guard for a running Codex without a verified completed turn', async () => {
        const { preview } = fixture({ thinking: true })
        const result = await preview('current')
        expect(result).toEqual({ type: 'error', message: 'Session is busy' })
    })

    it('keeps the busy guard for a running non-Codex source', async () => {
        const { preview } = fixture({ flavor: 'claude', thinking: true })
        const result = await preview('current')
        expect(result).toEqual({ type: 'error', message: 'Session is busy' })
    })

    it('requires the forkAtMessage capability and an invoked boundary', async () => {
        const { preview } = fixture({ capabilities: { conversationHistory: { forkCurrent: true, rewindToMessage: true } } })
        expect(await preview('message', 'u2')).toEqual({ type: 'error', message: 'Historical fork is not supported for this session' })

        const { preview: missing } = fixture()
        expect(await missing('message', 'no-such-row')).toEqual({
            type: 'error', message: 'History boundary message not found or not yet invoked'
        })
    })

    it('previews a rewind as the region that would be deleted', async () => {
        const { preview } = fixture()
        const response = expectPreview(await preview('rewind', 'u2'))
        expect(response.mode).toBe('rewind')
        expect(response.boundary).toMatchObject({ v: 1, mode: 'rewind', messageLocalId: 'u2', tailSeq: 4 })
        expect(response.keptTail.map((row) => row.localId)).toEqual(['u1', 'a1'])
        expect(response.excluded.map((row) => row.localId)).toEqual(['u2', 'a2'])
        expect(response.counts).toEqual({ kept: 2, excluded: 2 })
    })

    it('requires the rewindToMessage capability for a rewind preview', async () => {
        const { preview } = fixture({ capabilities: { conversationHistory: { forkCurrent: true, forkAtMessage: true } } })
        expect(await preview('rewind', 'u2')).toEqual({ type: 'error', message: 'Rewind is not supported for this session' })
    })

    it('shares the confirm guards: queued messages and diverged history refuse the preview', async () => {
        const { store, source, preview } = fixture()
        store.messages.addMessage(source.id, { role: 'user', content: 'queued' }, 'queued')
        expect(await preview('current')).toEqual({ type: 'error', message: 'Session has queued messages' })

        const { store: divergedStore, engine, source: diverged, preview: divergedPreview } = fixture()
        const row = divergedStore.sessions.getSession(diverged.id)!
        divergedStore.sessions.updateSessionMetadata(diverged.id, {
            ...row.metadata as Record<string, unknown>, conversationHistoryDiverged: true
        }, row.metadataVersion, 'default', { touchUpdatedAt: false })
        ;(engine as unknown as { sessionCache: { refreshSession(id: string): void } }).sessionCache.refreshSession(diverged.id)
        expect(await divergedPreview('current')).toEqual({
            type: 'error', message: 'Conversation history is diverged; refuse further fork/rewind'
        })
    })
})

describe('fork preview boundary tokens on confirm', () => {
    function tokenFixture() {
        return fixture()
    }

    it('accepts a fresh current token and forks', async () => {
        const { engine, source, rpc, preview } = tokenFixture()
        const response = expectPreview(await preview('current'))
        rpc.forkConversation = async () => ({ nativeSessionId: 'child-native' })
        rpc.spawnSession = async (...args: unknown[]) => ({ type: 'success', sessionId: args[12]! }) as never
        const result = await engine.forkConversation(source.id, 'default', undefined, false, response.boundary)
        expect(result.type).toBe('success')
    })

    it('rejects a current token once new invoked rows appear, with boundary_moved', async () => {
        const { engine, source, rpc, preview, addInvoked } = tokenFixture()
        const response = expectPreview(await preview('current'))
        addInvoked('u3')
        rpc.forkConversation = async () => ({ nativeSessionId: 'child-native' })
        const result = await engine.forkConversation(source.id, 'default', undefined, false, response.boundary)
        expect(result).toMatchObject({ type: 'error', code: 'boundary_moved' })
    })

    it('rejects a current token once the source starts running, with boundary_moved', async () => {
        const { engine, source, rpc, preview } = tokenFixture()
        const response = expectPreview(await preview('current'))
        engine.handleSessionAlive({ sid: source.id, time: Date.now(), thinking: true, mode: 'remote' })
        rpc.forkConversation = async () => ({ nativeSessionId: 'child-native' })
        const result = await engine.forkConversation(source.id, 'default', undefined, false, response.boundary)
        expect(result).toMatchObject({ type: 'error', code: 'boundary_moved' })
    })

    it('rejects a current token after the epoch moved, with boundary_moved', async () => {
        const { store, engine, source, rpc, preview } = tokenFixture()
        const response = expectPreview(await preview('current'))
        store.messages.truncateMessagesFromLocalId(source.id, 'u2')
        rpc.forkConversation = async () => ({ nativeSessionId: 'child-native' })
        const result = await engine.forkConversation(source.id, 'default', undefined, false, response.boundary)
        expect(result).toMatchObject({ type: 'error', code: 'boundary_moved' })
        expect(engine).toBeDefined()
    })

    it('lets a message token proceed when rows are only appended after the boundary', async () => {
        const { engine, source, rpc, preview, addInvoked } = tokenFixture()
        const response = expectPreview(await preview('message', 'u2'))
        addInvoked('u3')
        rpc.forkConversation = async (_id, payload) => {
            expect(payload).toEqual({ messageLocalId: 'u2' })
            return { nativeSessionId: 'child-native' }
        }
        rpc.spawnSession = async (...args: unknown[]) => ({ type: 'success', sessionId: args[12]! }) as never
        const result = await engine.forkConversation(source.id, 'default', 'u2', false, response.boundary)
        expect(result.type).toBe('success')
    })

    it('rejects a message token when the epoch moved, with boundary_moved', async () => {
        const { store, engine, source, rpc, preview } = tokenFixture()
        const response = expectPreview(await preview('message', 'u2'))
        store.messages.truncateMessagesFromLocalId(source.id, 'u2')
        store.messages.addMessage(source.id, { role: 'user', content: 'u2' }, 'u2')
        store.messages.markMessagesInvoked(source.id, ['u2'], Date.now())
        rpc.forkConversation = async () => ({ nativeSessionId: 'child-native' })
        const result = await engine.forkConversation(source.id, 'default', 'u2', false, response.boundary)
        expect(result).toMatchObject({ type: 'error', code: 'boundary_moved' })
    })

    it('rejects a message token whose boundary row left the invoked history', async () => {
        const { engine, source, rpc, preview } = tokenFixture()
        const response = expectPreview(await preview('message', 'u2'))
        rpc.forkConversation = async () => ({ nativeSessionId: 'child-native' })
        const result = await engine.forkConversation(source.id, 'default', 'a1', false, response.boundary)
        expect(result).toMatchObject({ type: 'error', code: 'boundary_moved' })
    })

    it('lets a latestCompleted token proceed when rows are appended and the epoch holds', async () => {
        const f = fixture({
            capabilities: { concurrentClients: true, conversationHistory: { forkCurrent: true, forkLatestCompleted: true } }
        })
        const { engine, source, rpc, preview, addInvoked } = f
        const child = engine.getOrCreateSession('child', {
            path: '/tmp/work', host: 'test', machineId: 'machine', hostPid: 42, flavor: 'codex',
            codexSessionId: 'native-child', forkedFrom: source.id,
            capabilities: { concurrentClients: true, conversationHistory: { forkCurrent: true, forkLatestCompleted: true } }
        }, { controlledByUser: false }, 'default')
        engine.handleSessionAlive({ sid: child.id, time: Date.now() })
        engine.handleSessionReady({ sid: child.id, time: Date.now() })
        const response = expectPreview(await preview('current'))
        const token: ForkBoundary = { ...response.boundary, mode: 'latestCompleted', nativeTurnId: 'turn-2' }
        addInvoked('u3')
        rpc.forkConversation = async (_id, payload) => {
            expect(payload).toEqual({ latestCompleted: true, lastTurnId: 'turn-2' })
            return { nativeSessionId: 'native-child', sessionId: child.id, completedTurnId: 'turn-2' }
        }
        const result = await engine.forkConversation(source.id, 'default', undefined, true, token)
        expect(result.type).toBe('success')
    })

    it('rejects a latestCompleted token after the epoch moved, with boundary_moved', async () => {
        const f = fixture({ capabilities: { conversationHistory: { forkCurrent: true, forkLatestCompleted: true } } })
        const { store, engine, source, rpc, preview } = f
        const response = expectPreview(await preview('current'))
        const token: ForkBoundary = { ...response.boundary, mode: 'latestCompleted', nativeTurnId: 'turn-2' }
        store.messages.truncateMessagesFromLocalId(source.id, 'u2')
        rpc.forkConversation = async () => ({ nativeSessionId: 'child-native' })
        const result = await engine.forkConversation(source.id, 'default', undefined, true, token)
        expect(result).toMatchObject({ type: 'error', code: 'boundary_moved' })
    })

    it('confirms a rewind with a fresh token', async () => {
        const { engine, source, rpc, preview } = tokenFixture()
        const response = expectPreview(await preview('rewind', 'u2'))
        rpc.rewindConversation = async () => ({ success: true, truncateFromLocalId: 'u2' })
        const result = await engine.rewindConversation(source.id, 'default', 'u2', response.boundary)
        expect(result).toEqual({ type: 'success' })
        expect(storeOf(engine).messages.getAllMessages(source.id).map((row) => row.localId)).toEqual(['u1', 'a1'])
    })

    it('rejects a rewind token once new rows appeared, with boundary_moved', async () => {
        const { engine, source, rpc, preview, addInvoked } = tokenFixture()
        const response = expectPreview(await preview('rewind', 'u2'))
        addInvoked('u3')
        rpc.rewindConversation = async () => ({ success: true, truncateFromLocalId: 'u2' })
        const result = await engine.rewindConversation(source.id, 'default', 'u2', response.boundary)
        expect(result).toMatchObject({ type: 'error', code: 'boundary_moved' })
    })

    it('rejects a rewind token after the epoch moved, with boundary_moved', async () => {
        const { store, engine, source, rpc, preview } = tokenFixture()
        const response = expectPreview(await preview('rewind', 'u2'))
        store.messages.truncateMessagesFromLocalId(source.id, 'a1')
        store.messages.addMessage(source.id, { role: 'user', content: 'a1' }, 'a1')
        store.messages.markMessagesInvoked(source.id, ['a1'], Date.now())
        rpc.rewindConversation = async () => ({ success: true, truncateFromLocalId: 'u2' })
        const result = await engine.rewindConversation(source.id, 'default', 'u2', response.boundary)
        expect(result).toMatchObject({ type: 'error', code: 'boundary_moved' })
    })

    it('keeps the legacy behavior when no boundary is sent', async () => {
        const { engine, source, rpc } = tokenFixture()
        rpc.forkConversation = async () => ({ nativeSessionId: 'child-native' })
        rpc.spawnSession = async (...args: unknown[]) => ({ type: 'success', sessionId: args[12]! }) as never
        const result = await engine.forkConversation(source.id, 'default')
        expect(result.type).toBe('success')
    })
})

describe('preview-capable shared runtime', () => {
    function sharedFixture() {
        return fixture({
            capabilities: {
                concurrentClients: true,
                conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: true, forkLatestCompleted: true, forkPreview: true }
            }
        })
    }

    it('asks the runtime for the boundary cut and carries the native pin', async () => {
        const { engine, source, rpc, preview } = sharedFixture()
        const previewCalls: unknown[] = []
        rpc.previewForkBoundary = async (_id, payload) => {
            previewCalls.push(payload)
            return { nativeTurnId: 'turn-2', cutBeforeLocalId: 'u2' }
        }
        const response = expectPreview(await preview('current'))
        expect(previewCalls).toEqual([{ mode: 'current' }])
        expect(response.boundary.nativeTurnId).toBe('turn-2')
        expect(response.keptTail.map((row) => row.localId)).toEqual(['u1', 'a1'])
        expect(response.excluded.map((row) => row.localId)).toEqual(['u2'])
        expect(response.counts).toEqual({ kept: 2, excluded: 2 })

        rpc.forkConversation = async (_id, payload) => {
            expect(payload).toEqual({ lastTurnId: 'turn-2' })
            return { nativeSessionId: 'child-native' }
        }
        rpc.spawnSession = async (...args: unknown[]) => ({ type: 'success', sessionId: args[12]! }) as never
        const result = await engine.forkConversation(source.id, 'default', undefined, false, response.boundary)
        expect(result.type).toBe('success')
    })

    it('rejects the preview when a turn completes while the runtime boundary RPC is in flight', async () => {
        const { store, source, rpc, preview } = sharedFixture()
        rpc.previewForkBoundary = async () => {
            // A turn completes between the native cut sampling and the hub
            // transcript read: the cut no longer describes the rows below.
            store.messages.addMessage(source.id, { role: 'user', content: 'u3' }, 'u3')
            store.messages.markMessagesInvoked(source.id, ['u3'], Date.now())
            return { nativeTurnId: 'turn-2', cutBeforeLocalId: 'u2' }
        }
        const result = await preview('current')
        expect(result.type).toBe('error')
    })

    it('pins the latestCompleted confirm to the previewed turn', async () => {
        const { engine, source, rpc, preview } = sharedFixture()
        const child = engine.getOrCreateSession('child', {
            path: '/tmp/work', host: 'test', machineId: 'machine', hostPid: 42, flavor: 'codex',
            codexSessionId: 'native-child', forkedFrom: source.id,
            capabilities: { concurrentClients: true, conversationHistory: { forkCurrent: true, forkLatestCompleted: true } }
        }, { controlledByUser: false }, 'default')
        engine.handleSessionAlive({ sid: child.id, time: Date.now() })
        engine.handleSessionReady({ sid: child.id, time: Date.now() })
        rpc.previewForkBoundary = async () => ({ nativeTurnId: 'turn-2', cutBeforeLocalId: 'u2' })
        const response = expectPreview(await preview('current'))
        engine.handleSessionAlive({ sid: source.id, time: Date.now(), thinking: true, mode: 'remote' })
        expect(response.mode).toBe('current')
        const token: ForkBoundary = { ...response.boundary, mode: 'latestCompleted' }
        rpc.forkConversation = async (_id, payload) => {
            expect(payload).toEqual({ latestCompleted: true, lastTurnId: 'turn-2' })
            return { nativeSessionId: 'native-child', sessionId: child.id, completedTurnId: 'turn-2' }
        }
        const result = await engine.forkConversation(source.id, 'default', undefined, true, token)
        expect(result).toMatchObject({ type: 'success' })
    })

    it('propagates a runtime preview failure to the caller', async () => {
        const { preview, rpc } = sharedFixture()
        rpc.previewForkBoundary = async () => { throw new Error('Native history is ambiguous') }
        expect(await preview('current')).toEqual({ type: 'error', message: 'Native history is ambiguous' })
    })

    it('refuses the preview of an inactive session the archived-fork confirm would refuse', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        const source = engine.getOrCreateSession('source', {
            path: '/tmp/work', host: 'test', machineId: 'machine', hostPid: 42, flavor: 'claude',
            capabilities: { conversationHistory: { forkCurrent: true } }
        }, { controlledByUser: false }, 'default')
        store.messages.addMessage(source.id, { role: 'user', content: { type: 'text', text: 'u1' } }, 'u1')
        store.messages.markMessagesInvoked(source.id, ['u1'], Date.now())
        // The confirm runs forkArchivedCodexSession, which demands a Codex
        // session with native history and a machine binding; the preview must
        // refuse the same session instead of answering a forkable boundary.
        const result = await engine.forkPreview(source.id, 'default', 'current')
        expect(result).toMatchObject({ type: 'error', message: expect.stringContaining('Inactive fork requires a Codex session') })
    })

    it('answers the preview for an eligible archived Codex session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        engine.getOrCreateMachine('machine', { host: 'test', platform: 'win32', happyCliVersion: '1',
            capabilities: [MACHINE_CAPABILITIES.ForkArchivedCodex] }, null, 'default')
        engine.handleMachineAlive({ machineId: 'machine', time: Date.now() })
        const source = engine.getOrCreateSession('source', {
            path: '/tmp/work', host: 'test', machineId: 'machine', hostPid: 42, flavor: 'codex',
            lifecycleState: 'archived', codexSessionId: 'native-source',
            capabilities: { conversationHistory: { forkCurrent: true } }
        }, { controlledByUser: false }, 'default')
        store.messages.addMessage(source.id, { role: 'user', content: { type: 'text', text: 'u1' } }, 'u1')
        store.messages.markMessagesInvoked(source.id, ['u1'], Date.now())
        const result = await engine.forkPreview(source.id, 'default', 'current')
        expect(result).toMatchObject({ type: 'success', preview: { mode: 'current' } })
    })

    it('rejects a latestCompleted token once the source stops running, with boundary_moved', async () => {
        const { engine, source, rpc, preview } = sharedFixture()
        engine.handleSessionAlive({ sid: source.id, time: Date.now(), thinking: true, mode: 'remote' })
        rpc.previewForkBoundary = async () => ({ nativeTurnId: 'turn-2' })
        const response = expectPreview(await preview('current'))
        expect(response.mode).toBe('latestCompleted')
        // The runner exits before the confirm: the archived path ignores the
        // pinned turn, so the token must come back as boundary_moved for a
        // fresh preview instead of failing with an unactionable error.
        engine.handleSessionEnd({ sid: source.id, time: Date.now() })
        rpc.forkConversation = async () => ({ nativeSessionId: 'child-native' })
        const result = await engine.forkConversation(source.id, 'default', undefined, true, response.boundary)
        expect(result).toMatchObject({ type: 'error', code: 'boundary_moved' })
    })

    it('still answers a latestCompleted intent for a running preview-capable source', async () => {
        const { engine, source, preview, rpc } = sharedFixture()
        engine.handleSessionAlive({ sid: source.id, time: Date.now(), thinking: true, mode: 'remote' })
        rpc.previewForkBoundary = async (_id, payload) => {
            expect(payload).toEqual({ mode: 'latestCompleted' })
            return { nativeTurnId: 'turn-2', cutBeforeLocalId: 'u2' }
        }
        const response = expectPreview(await preview('current'))
        expect(response.mode).toBe('latestCompleted')
        expect(response.boundary.nativeTurnId).toBe('turn-2')
        void source
    })
})

function storeOf(engine: SyncEngine): Store {
    return (engine as unknown as { store: Store }).store
}