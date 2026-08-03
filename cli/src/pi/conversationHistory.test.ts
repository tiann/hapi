import { describe, expect, it, vi } from 'vitest'
import { PiConversationHistory, PiHistoryRestoreError } from './conversationHistory'
import { PiSession } from './session'

function createSession(options?: { nativeReady?: boolean }) {
    const metadata: Record<string, unknown> = {}
    const client = {
        keepAlive: vi.fn(),
        flushMetadata: vi.fn(async () => true),
        updateMetadata: vi.fn((updater: (current: Record<string, unknown>) => Record<string, unknown>) => {
            Object.assign(metadata, updater(metadata))
        }),
        sendAgentMessage: vi.fn(),
        emitMessagesConsumed: vi.fn(),
        sendSessionEvent: vi.fn(),
        emitSessionReady: vi.fn(),
    }
    const session = new PiSession({
        api: {} as never,
        client: client as never,
        path: '/tmp/project',
        logPath: '/tmp/pi.log',
        startedBy: 'terminal',
        startingMode: 'remote',
    })
    if (options?.nativeReady !== false) session.markNativeReady()
    return {
        metadata,
        client,
        session,
    }
}

const source = { sessionId: 'source-id', sessionFile: '/tmp/source.jsonl' }
const clone = { sessionId: 'clone-id', sessionFile: '/tmp/clone.jsonl' }

describe('PiConversationHistory entry mapping', () => {
    it('pairs duplicate prompts to native user entries strictly FIFO without reading text', () => {
        const { session, metadata } = createSession()
        const history = new PiConversationHistory(session, vi.fn())
        history.registerPrompt('local-1')
        history.registerPrompt('local-2')

        history.observeEntry({ type: 'message', id: 'entry-1', message: { role: 'user', content: 'same' } })
        history.observeEntry({ type: 'message', id: 'assistant-1', message: { role: 'assistant', content: 'same' } })
        // Pi can forward an entry_appended event and later return the same entry
        // from get_entries. It must not consume local-2 twice.
        history.observeEntry({ type: 'message', id: 'entry-1', message: { role: 'user', content: 'same' } })
        history.observeEntry({ type: 'message', id: 'entry-2', message: { role: 'user', content: 'same' } })

        expect(history.getEntryIds()).toEqual({ 'local-1': 'entry-1', 'local-2': 'entry-2' })
        expect(metadata).toMatchObject({
            conversationHistoryPoints: { 'local-1': true, 'local-2': true },
            conversationHistoryEntryIds: { 'local-1': 'entry-1', 'local-2': 'entry-2' },
        })
    })

    it('uses the append cursor for an entry event fallback', async () => {
        const { session } = createSession()
        const rpc = vi.fn(async (command: Record<string, unknown>) => {
            if (rpc.mock.calls.length === 1) {
                expect(command).toEqual({ type: 'get_entries' })
                return {
                    entries: [{ type: 'message', id: 'native-1', message: { role: 'user' } }],
                    leafId: 'branch-leaf-that-moved-backward',
                }
            }
            expect(command).toEqual({ type: 'get_entries', since: 'native-1' })
            return { entries: [], leafId: 'older-active-leaf' }
        })
        const history = new PiConversationHistory(session, rpc)
        history.registerPrompt('local-1')
        await history.syncEntries()
        expect(history.getEntryIds()).toEqual({ 'local-1': 'native-1' })
        await history.syncEntries()
    })

    it('serializes concurrent syncs and ignores a duplicate entry_appended/get_entries user entry', async () => {
        const { session } = createSession()
        let resolveFirstRead!: (value: unknown) => void
        let activeReads = 0
        let maxActiveReads = 0
        const rpc = vi.fn((command: Record<string, unknown>) => {
            activeReads += 1
            maxActiveReads = Math.max(maxActiveReads, activeReads)
            if (rpc.mock.calls.length === 1) {
                return new Promise<unknown>((resolve) => {
                    resolveFirstRead = (value) => {
                        activeReads -= 1
                        resolve(value)
                    }
                })
            }
            expect(command).toEqual({ type: 'get_entries', since: 'entry-1' })
            activeReads -= 1
            return Promise.resolve({ entries: [{ type: 'message', id: 'entry-1', message: { role: 'user' } }], leafId: 'entry-1' })
        })
        const history = new PiConversationHistory(session, rpc)
        history.registerPrompt('local-1')
        history.registerPrompt('local-2')

        const first = history.syncEntries()
        history.observeEntry({ type: 'message', id: 'entry-1', message: { role: 'user' } })
        const concurrent = history.syncEntries()
        resolveFirstRead({ entries: [{ type: 'message', id: 'entry-1', message: { role: 'user' } }], leafId: 'entry-1' })
        await Promise.all([first, concurrent])
        history.observeEntry({ type: 'message', id: 'entry-2', message: { role: 'user' } })

        expect(maxActiveReads).toBe(1)
        expect(history.getEntryIds()).toEqual({ 'local-1': 'entry-1', 'local-2': 'entry-2' })
    })

    it('maps an accepted streaming steer as a conversation-history point', () => {
        const { session, metadata } = createSession()
        const history = new PiConversationHistory(session, vi.fn())
        history.registerSteer('steer-local-id')
        history.observeEntry({ type: 'message', id: 'steer-entry-id', message: { role: 'user' } })

        expect(history.getEntryIds()).toEqual({ 'steer-local-id': 'steer-entry-id' })
        expect(metadata).toMatchObject({
            conversationHistoryPoints: { 'steer-local-id': true },
            conversationHistoryEntryIds: { 'steer-local-id': 'steer-entry-id' },
        })
    })

    it('removes failed prompt/steer records by exact localId without cross-kind consumption', () => {
        const first = createSession()
        const firstHistory = new PiConversationHistory(first.session, vi.fn())
        firstHistory.registerPrompt('prompt-ok')
        firstHistory.registerSteer('steer-failed')
        firstHistory.rejectPendingEntry('steer-failed', 'steer')
        firstHistory.observeEntry({ type: 'message', id: 'prompt-entry', message: { role: 'user' } })
        expect(firstHistory.getEntryIds()).toEqual({ 'prompt-ok': 'prompt-entry' })

        const second = createSession()
        const secondHistory = new PiConversationHistory(second.session, vi.fn())
        secondHistory.registerPrompt('prompt-failed')
        secondHistory.registerSteer('steer-ok')
        secondHistory.rejectPendingEntry('prompt-failed', 'prompt')
        secondHistory.observeEntry({ type: 'message', id: 'steer-entry', message: { role: 'user' } })
        expect(secondHistory.getEntryIds()).toEqual({ 'steer-ok': 'steer-entry' })

        secondHistory.registerPrompt('aborted-before-turn')
        secondHistory.rejectPendingEntry('aborted-before-turn', 'prompt')
        secondHistory.observeEntry({ type: 'message', id: 'unrelated-user-entry', message: { role: 'user' } })
        expect(secondHistory.getEntryIds()).toEqual({ 'steer-ok': 'steer-entry' })
    })
})

describe('PiConversationHistory native transactions', () => {
    it('rejects before native fork when final source locator metadata does not flush', async () => {
        const { session, client } = createSession()
        client.flushMetadata.mockResolvedValue(false)
        const rpc = vi.fn(async (command: Record<string, unknown>) => {
            if (command.type === 'get_entries') return { entries: [], leafId: null }
            throw new Error(`native fork must not run: ${command.type}`)
        })
        const history = new PiConversationHistory(session, rpc)

        await expect(history.fork()).rejects.toThrow('metadata did not persist')
        expect(rpc.mock.calls.map(([command]) => command.type)).toEqual(['get_entries'])
    })

    it('forks current by clone then restores the exact source identity', async () => {
        const { session } = createSession()
        let stateCalls = 0
        const rpc = vi.fn(async (command: Record<string, unknown>) => {
            if (command.type === 'get_entries') return { entries: [], leafId: null }
            if (command.type === 'get_state') return [source, clone, clone, source][stateCalls++]
            if (command.type === 'clone') return { cancelled: false }
            if (command.type === 'switch_session') return { cancelled: false }
            throw new Error(`unexpected ${command.type}`)
        })
        const history = new PiConversationHistory(session, rpc)

        await expect(history.fork()).resolves.toEqual({ nativeSessionId: 'clone-id' })
        expect(rpc.mock.calls.map(([command]) => command)).toEqual([
            { type: 'get_entries' }, { type: 'get_state' }, { type: 'clone' }, { type: 'get_state' },
            { type: 'get_state' }, { type: 'switch_session', sessionPath: source.sessionFile }, { type: 'get_state' },
        ])
        expect(session.isHistoryTransactionActive).toBe(false)
    })

    it('forks a historical boundary from source and restores source afterward', async () => {
        const { session } = createSession()
        let stateCalls = 0
        const rpc = vi.fn(async (command: Record<string, unknown>) => {
            if (command.type === 'get_entries') return { entries: [], leafId: null }
            if (command.type === 'get_state') return [source, clone, clone, source][stateCalls++]
            if (command.type === 'fork' || command.type === 'switch_session') return { cancelled: false }
            throw new Error(`unexpected ${command.type}`)
        })
        const history = new PiConversationHistory(session, rpc)
        history.restoreEntryIds({ local: 'entry-user' })

        await expect(history.fork('local')).resolves.toEqual({ nativeSessionId: 'clone-id' })
        expect(rpc.mock.calls.map(([command]) => command)).toEqual([
            { type: 'get_entries' }, { type: 'get_state' }, { type: 'fork', entryId: 'entry-user' }, { type: 'get_state' },
            { type: 'get_state' }, { type: 'switch_session', sessionPath: source.sessionFile }, { type: 'get_state' },
        ])
    })

    it('commits the rewound branch identity, resets its cursor, and maps the next prompt', async () => {
        const { session, metadata } = createSession()
        const rewound = { sessionId: 'rewind-id', sessionFile: '/tmp/rewind.jsonl' }
        let entriesCalls = 0
        let stateCalls = 0
        const rpc = vi.fn(async (command: Record<string, unknown>) => {
            if (command.type === 'get_entries') {
                entriesCalls += 1
                return entriesCalls === 1
                    ? { entries: [], leafId: null }
                    : { entries: [{ id: 'entry-before-user', type: 'message', message: { role: 'assistant' } }], leafId: 'entry-before-user' }
            }
            if (command.type === 'get_state') return [source, rewound][stateCalls++]
            if (command.type === 'get_fork_messages') return { messages: [{ entryId: 'entry-user', text: 'ignored' }] }
            if (command.type === 'fork') return { cancelled: false }
            throw new Error(`unexpected ${command.type}`)
        })
        const history = new PiConversationHistory(session, rpc)
        history.restoreEntryIds({ local: 'entry-user' })

        await expect(history.rewind('local')).resolves.toEqual({
            success: true,
            truncateFromLocalId: 'local',
            messages: [],
        })
        expect(session.expectedNativeSessionId).toBe('rewind-id')
        expect(session.currentNativeSessionFile).toBe('/tmp/rewind.jsonl')
        expect(metadata).toMatchObject({ piSessionId: 'rewind-id' })
        history.registerPrompt('next-local')
        history.observeEntry({ type: 'message', id: 'next-entry', message: { role: 'user' } })
        expect(history.getEntryIds()).toEqual({ 'next-local': 'next-entry' })
        expect(rpc.mock.calls.map(([command]) => command)).toEqual([
            { type: 'get_entries' }, { type: 'get_state' }, { type: 'get_fork_messages' }, { type: 'fork', entryId: 'entry-user' },
            { type: 'get_state' }, { type: 'get_entries' },
        ])
    })

    it('restores source and rolls back identity/locators when rewind metadata flush fails', async () => {
        const { session, client } = createSession()
        client.flushMetadata.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
        const rewound = { sessionId: 'rewind-id', sessionFile: '/tmp/rewind.jsonl' }
        let stateCalls = 0
        let entryCalls = 0
        const rpc = vi.fn(async (command: Record<string, unknown>) => {
            if (command.type === 'get_entries') {
                entryCalls += 1
                return entryCalls === 1
                    ? { entries: [], leafId: null }
                    : { entries: [{ id: 'branch-prefix', type: 'message', message: { role: 'assistant' } }], leafId: 'branch-prefix' }
            }
            if (command.type === 'get_state') return [source, rewound, rewound, source][stateCalls++]
            if (command.type === 'get_fork_messages') return { messages: [{ entryId: 'entry-user', text: 'user' }] }
            if (command.type === 'fork' || command.type === 'switch_session') return { cancelled: false }
            throw new Error(`unexpected ${command.type}`)
        })
        const history = new PiConversationHistory(session, rpc)
        history.restoreEntryIds({ local: 'entry-user' })

        await expect(history.rewind('local')).resolves.toEqual({
            success: false,
            error: 'Pi rewind metadata did not persist',
            outcome: 'source_restored',
        })
        expect(session.expectedNativeSessionId).toBe(source.sessionId)
        expect(history.getEntryIds()).toEqual({ local: 'entry-user' })
    })

    it('waits for a delayed source sync before rewind, then maps the next branch prompt', async () => {
        const { session } = createSession()
        let resolveStaleRead!: (data: unknown) => void
        const rewound = { sessionId: 'rewind-id', sessionFile: '/tmp/rewind.jsonl' }
        let getEntriesCalls = 0
        const rpc = vi.fn((command: Record<string, unknown>) => {
            if (command.type === 'get_entries') {
                getEntriesCalls += 1
                if (getEntriesCalls === 1) {
                    return new Promise<unknown>((resolve) => { resolveStaleRead = resolve })
                }
                return Promise.resolve({ entries: [{ id: 'new-prefix', type: 'message', message: { role: 'assistant' } }], leafId: 'new-prefix' })
            }
            if (command.type === 'get_state') {
                const states = rpc.mock.calls.filter(([item]) => item.type === 'get_state').length
                return Promise.resolve(states === 1 ? source : rewound)
            }
            if (command.type === 'get_fork_messages') return Promise.resolve({ messages: [{ entryId: 'old-user', text: 'old' }] })
            if (command.type === 'fork') return Promise.resolve({ cancelled: false })
            throw new Error(`unexpected ${command.type}`)
        })
        const history = new PiConversationHistory(session, rpc)
        history.restoreEntryIds({ old: 'old-user' })
        const staleSync = history.syncEntries()
        const rewindPending = history.rewind('old')
        await Promise.resolve()
        expect(rpc.mock.calls.some(([command]) => command.type === 'fork')).toBe(false)
        resolveStaleRead({ entries: [{ id: 'stale-user', type: 'message', message: { role: 'user' } }], leafId: 'stale-user' })
        await staleSync
        const rewind = await rewindPending
        expect(rewind.success).toBe(true)

        history.registerPrompt('next')
        history.observeEntry({ type: 'message', id: 'next-user', message: { role: 'user' } })
        expect(history.getEntryIds()).toEqual({ next: 'next-user' })
    })

    it('refuses history actions before native-ready or while Pi is streaming', async () => {
        const unready = createSession({ nativeReady: false })
        const unreadyHistory = new PiConversationHistory(unready.session, vi.fn())
        await expect(unreadyHistory.fork()).rejects.toThrow('not ready')

        const busy = createSession()
        busy.session.piIsStreaming = true
        const busyHistory = new PiConversationHistory(busy.session, vi.fn())
        await expect(busyHistory.fork()).rejects.toThrow('busy')
    })

    it('returns deterministic failure after restoring source instead of throwing/diverging', async () => {
        const { session } = createSession()
        let stateCalls = 0
        const rpc = vi.fn(async (command: Record<string, unknown>) => {
            if (command.type === 'get_entries') return { entries: [], leafId: null }
            if (command.type === 'get_state') return [source, source][stateCalls++]
            if (command.type === 'get_fork_messages') return { messages: [] }
            throw new Error(`unexpected ${command.type}`)
        })
        const history = new PiConversationHistory(session, rpc)
        history.restoreEntryIds({ local: 'entry-user' })

        await expect(history.rewind('local')).resolves.toEqual({
            success: false,
            error: 'Pi rewind point is no longer available',
            outcome: 'source_restored',
        })
        expect(rpc.mock.calls.some(([command]) => command.type === 'switch_session')).toBe(false)
    })

    it('returns cancelled without a redundant source switch when Pi fork never leaves source', async () => {
        const { session } = createSession()
        let stateCalls = 0
        const rpc = vi.fn(async (command: Record<string, unknown>) => {
            if (command.type === 'get_entries') return { entries: [], leafId: null }
            if (command.type === 'get_state') return [source, source][stateCalls++]
            if (command.type === 'get_fork_messages') return { messages: [{ entryId: 'entry-user', text: 'user' }] }
            if (command.type === 'fork') return { cancelled: true }
            throw new Error(`unexpected ${command.type}`)
        })
        const history = new PiConversationHistory(session, rpc)
        history.restoreEntryIds({ local: 'entry-user' })

        await expect(history.rewind('local')).resolves.toEqual({
            success: false,
            error: 'Pi rewind was cancelled',
            outcome: 'cancelled',
        })
        expect(rpc.mock.calls.some(([command]) => command.type === 'switch_session')).toBe(false)
    })

    it('fails closed when source restoration fails', async () => {
        const { session } = createSession()
        let resolveClone!: (value: unknown) => void
        let stateCalls = 0
        const rpc = vi.fn((command: Record<string, unknown>) => {
            if (command.type === 'get_entries') return Promise.resolve({ entries: [], leafId: null })
            if (command.type === 'get_state') {
                return Promise.resolve([source, clone, clone][stateCalls++])
            }
            if (command.type === 'clone') {
                return new Promise<unknown>((resolve) => { resolveClone = resolve })
            }
            if (command.type === 'switch_session') return Promise.resolve({ cancelled: true })
            throw new Error(`unexpected ${command.type}`)
        })
        const history = new PiConversationHistory(session, rpc)
        let delivered = false
        const pending = history.fork()
        await vi.waitFor(() => expect(resolveClone).toBeTypeOf('function'))
        session.runWhenHistoryIdle(() => { delivered = true }, 'queued-during-restore')
        resolveClone({ cancelled: false })

        await expect(pending).rejects.toBeInstanceOf(PiHistoryRestoreError)
        expect(delivered).toBe(false)
        expect(session.isHistoryTransactionActive).toBe(false)
    })

    it('keeps history operations mutually exclusive and revokes a command that Pi rejects as unknown', async () => {
        const { session } = createSession()
        let rejectClone!: (reason: Error) => void
        const rpc = vi.fn((command: Record<string, unknown>) => {
            if (command.type === 'get_entries') return Promise.resolve({ entries: [], leafId: null })
            if (command.type === 'get_state') return Promise.resolve(source)
            if (command.type === 'clone') return new Promise((_, reject) => { rejectClone = reject })
            return Promise.resolve({ cancelled: false })
        })
        const history = new PiConversationHistory(session, rpc)
        const pending = history.fork()
        await vi.waitFor(() => expect(rejectClone).toBeTypeOf('function'))
        await expect(history.fork()).rejects.toThrow('already in progress')
        rejectClone(new Error('Unknown command: clone'))
        await expect(pending).rejects.toThrow('Unknown command')
        expect(history.getCapabilitiesForMetadata()).toBeUndefined()
    })
})
