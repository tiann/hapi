import { describe, expect, it, vi } from 'vitest'
import { PI_HISTORY_OPERATION_TIMEOUT_MS, PiConversationHistory, PiHistoryRestoreError } from './conversationHistory'
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
    it('persists the append cursor for assistant entries without waiting for another user message', () => {
        const { session, metadata, client } = createSession()
        const history = new PiConversationHistory(session, vi.fn())

        history.observeEntry({ type: 'message', id: 'assistant-leaf', message: { role: 'assistant', content: 'done' } })

        expect(metadata.piHistoryLeafEntryId).toBe('assistant-leaf')
        expect(client.updateMetadata).toHaveBeenCalledOnce()
    })

    it('pairs duplicate prompts to native user entries strictly FIFO without reading text', () => {
        const { session, metadata } = createSession()
        const history = new PiConversationHistory(session, vi.fn())
        history.registerUserEntry('local-1')
        history.registerUserEntry('local-2')

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
        const rpc = vi.fn(async (command: Record<string, unknown>, _timeoutMs?: number) => {
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
        history.registerUserEntry('local-1')
        await history.syncEntries()
        expect(history.getEntryIds()).toEqual({ 'local-1': 'native-1' })
        await history.syncEntries()
    })

    it('persists one metadata snapshot for a multi-entry get_entries batch', async () => {
        const { session, metadata, client } = createSession()
        const rpc = vi.fn(async () => ({
            entries: [
                { type: 'message', id: 'user-1', message: { role: 'user' } },
                { type: 'message', id: 'assistant-1', message: { role: 'assistant' } },
                { type: 'message', id: 'assistant-2', message: { role: 'assistant' } }
            ],
            leafId: 'assistant-2'
        }))
        const history = new PiConversationHistory(session, rpc)
        history.registerUserEntry('local-1')

        await history.syncEntries()

        expect(client.updateMetadata).toHaveBeenCalledOnce()
        expect(metadata).toMatchObject({
            piHistoryLeafEntryId: 'assistant-2',
            conversationHistoryEntryIds: { 'local-1': 'user-1' },
            conversationHistoryPoints: { 'local-1': true }
        })
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
        history.registerUserEntry('local-1')
        history.registerUserEntry('local-2')

        const first = history.syncEntries()
        history.observeEntry({ type: 'message', id: 'entry-1', message: { role: 'user' } })
        const concurrent = history.syncEntries()
        resolveFirstRead({ entries: [{ type: 'message', id: 'entry-1', message: { role: 'user' } }], leafId: 'entry-1' })
        await Promise.all([first, concurrent])
        history.observeEntry({ type: 'message', id: 'entry-2', message: { role: 'user' } })

        expect(maxActiveReads).toBe(1)
        expect(history.getEntryIds()).toEqual({ 'local-1': 'entry-1', 'local-2': 'entry-2' })
    })

    it('disables optional history polling when startup get_entries is unsupported', async () => {
        const { session } = createSession()
        const rpc = vi.fn(async () => { throw new Error('Unknown command: get_entries') })
        const publishCapabilities = vi.fn(async () => {})
        const history = new PiConversationHistory(session, rpc)
        history.setPublishCapabilities(publishCapabilities)

        await history.initialize()
        await history.syncEntries()
        await history.syncEntries()
        history.registerUserEntry('disabled-1')
        history.registerUserEntry('disabled-2')
        history.observeEntry({ type: 'message', id: 'late-user', message: { role: 'user' } })

        expect(rpc).toHaveBeenCalledTimes(1)
        expect(history.getCapabilitiesForMetadata()).toBeUndefined()
        expect(history.getEntryIds()).toEqual({})
        expect(publishCapabilities).toHaveBeenCalledTimes(1)
    })

    it.each([
        ['transient rejection', async () => { throw new Error('temporary read failure') }],
        ['malformed response', async () => ({ entries: null, leafId: null })],
    ])('disables history when the startup baseline has a %s', async (_label, read) => {
        const { session } = createSession()
        const rpc = vi.fn(read)
        const history = new PiConversationHistory(session, rpc)

        await history.initialize()
        history.registerUserEntry('new-local')
        history.observeEntry({ type: 'message', id: 'old-native-user', message: { role: 'user' } })
        await history.syncEntries()

        expect(rpc).toHaveBeenCalledTimes(1)
        expect(history.getCapabilitiesForMetadata()).toBeUndefined()
        expect(history.getEntryIds()).toEqual({})
        await expect(history.fork()).rejects.toThrow('unavailable')
        await expect(history.rewind('stale-local')).resolves.toMatchObject({
            success: false,
            error: expect.stringContaining('unavailable'),
        })
        expect(rpc).toHaveBeenCalledTimes(1)
    })

    it('handles rejection from a detached coalesced sync retry', async () => {
        const { session } = createSession()
        const rpc = vi.fn(async () => { throw new Error('transient history read failure') })
        const history = new PiConversationHistory(session, rpc)

        const first = history.syncEntries().catch(() => {})
        const concurrent = history.syncEntries().catch(() => {})
        await Promise.all([first, concurrent])
        await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2))
        await Promise.resolve()
    })

    it('removes a failed local FIFO prompt by exact localId without consuming its neighbor', () => {
        const { session } = createSession()
        const history = new PiConversationHistory(session, vi.fn())
        history.registerUserEntry('prompt-failed')
        history.registerUserEntry('prompt-ok')
        history.rejectPendingEntry('prompt-failed')
        history.observeEntry({ type: 'message', id: 'prompt-entry', message: { role: 'user' } })
        expect(history.getEntryIds()).toEqual({ 'prompt-ok': 'prompt-entry' })

        history.registerUserEntry('aborted-before-turn')
        history.rejectPendingEntry('aborted-before-turn')
        history.observeEntry({ type: 'message', id: 'unrelated-user-entry', message: { role: 'user' } })
        expect(history.getEntryIds()).toEqual({ 'prompt-ok': 'prompt-entry' })
    })
})

describe('PiConversationHistory native transactions', () => {
    it('rejects before native fork when final source locator metadata does not flush', async () => {
        const { session, client } = createSession()
        client.flushMetadata.mockResolvedValue(false)
        const rpc = vi.fn(async (command: Record<string, unknown>, _timeoutMs?: number) => {
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
        const rpc = vi.fn(async (command: Record<string, unknown>, _timeoutMs?: number) => {
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
        const mutationTimeouts = rpc.mock.calls
            .filter(([command]) => command.type === 'clone' || command.type === 'switch_session')
            .map(([, timeoutMs]) => timeoutMs)
        expect(mutationTimeouts).toHaveLength(2)
        for (const timeoutMs of mutationTimeouts) {
            expect(timeoutMs).toBeGreaterThan(0)
            expect(timeoutMs).toBeLessThanOrEqual(PI_HISTORY_OPERATION_TIMEOUT_MS)
        }
        expect(session.isHistoryTransactionActive).toBe(false)
    })

    it('uses one absolute transaction deadline across clone and source restoration', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(0)
        try {
            const { session } = createSession()
            let stateCalls = 0
            const mutationTimeouts: number[] = []
            const rpc = vi.fn(async (command: Record<string, unknown>, timeoutMs?: number) => {
                if (command.type === 'get_entries') return { entries: [], leafId: null }
                if (command.type === 'get_state') return [source, clone, clone, source][stateCalls++]
                if (command.type === 'clone') {
                    mutationTimeouts.push(timeoutMs ?? 0)
                    vi.setSystemTime(60_000)
                    return { cancelled: false }
                }
                if (command.type === 'switch_session') {
                    mutationTimeouts.push(timeoutMs ?? 0)
                    return { cancelled: false }
                }
                throw new Error(`unexpected ${command.type}`)
            })
            const history = new PiConversationHistory(session, rpc)

            await expect(history.fork()).resolves.toEqual({ nativeSessionId: 'clone-id' })
            expect(mutationTimeouts).toHaveLength(2)
            expect(mutationTimeouts[0]).toBeLessThanOrEqual(PI_HISTORY_OPERATION_TIMEOUT_MS - 10_000)
            expect(mutationTimeouts[1]).toBeLessThanOrEqual(PI_HISTORY_OPERATION_TIMEOUT_MS - 60_000)
        } finally {
            vi.useRealTimers()
        }
    })

    it('treats a pre-mutation read timeout as an ordinary rejection and drains queued work', async () => {
        const { session } = createSession()
        const timeout = Object.assign(new Error('Pi RPC get_state (id=1) timed out after 10000ms'), {
            name: 'PiRpcTimeoutError',
        })
        const rpc = vi.fn(async (command: Record<string, unknown>) => {
            if (command.type === 'get_entries') return { entries: [], leafId: null }
            if (command.type === 'get_state') throw timeout
            throw new Error(`mutation must not run: ${command.type}`)
        })
        const history = new PiConversationHistory(session, rpc)
        let delivered = false

        const pending = history.fork()
        session.runWhenHistoryIdle(() => { delivered = true }, 'queued-after-read-timeout')

        await expect(pending).rejects.toBe(timeout)
        expect(delivered).toBe(true)
        expect(session.isHistoryTransactionActive).toBe(false)
        expect(rpc.mock.calls.map(([command]) => command.type)).toEqual(['get_entries', 'get_state'])
    })

    it('forks a historical boundary from source and restores source afterward', async () => {
        const { session } = createSession()
        let stateCalls = 0
        const rpc = vi.fn(async (command: Record<string, unknown>, _timeoutMs?: number) => {
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
        const mutationTimeouts = rpc.mock.calls
            .filter(([command]) => command.type === 'fork' || command.type === 'switch_session')
            .map(([, timeoutMs]) => timeoutMs)
        expect(mutationTimeouts).toHaveLength(2)
        for (const timeoutMs of mutationTimeouts) {
            expect(timeoutMs).toBeGreaterThan(0)
            expect(timeoutMs).toBeLessThanOrEqual(PI_HISTORY_OPERATION_TIMEOUT_MS)
        }
    })

    it('commits the rewound branch identity, resets its cursor, and maps the next prompt', async () => {
        const { session, metadata } = createSession()
        const sourceState = {
            ...source,
            model: { id: 'source-model', provider: 'source-provider' },
            thinkingLevel: 'low',
            steeringMode: 'all',
            isStreaming: false,
        }
        const rewound = {
            sessionId: 'rewind-id',
            sessionFile: '/tmp/rewind.jsonl',
            model: { id: 'rewind-model', provider: 'rewind-provider' },
            thinkingLevel: 'high',
            steeringMode: 'one-at-a-time',
            isStreaming: true,
        }
        let entriesCalls = 0
        let stateCalls = 0
        const rpc = vi.fn(async (command: Record<string, unknown>, _timeoutMs?: number) => {
            if (command.type === 'get_entries') {
                entriesCalls += 1
                return entriesCalls === 1
                    ? { entries: [], leafId: null }
                    : { entries: [{ id: 'entry-before-user', type: 'message', message: { role: 'assistant' } }], leafId: 'entry-before-user' }
            }
            if (command.type === 'get_state') return [sourceState, rewound][stateCalls++]
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
        expect(session.currentModel).toBe('rewind-model')
        expect(session.currentProvider).toBe('rewind-provider')
        expect(session.currentThinkingLevel).toBe('high')
        expect(session.currentSteeringMode).toBe('one-at-a-time')
        expect(session.piIsStreaming).toBe(true)
        expect(metadata).toMatchObject({
            piSessionId: 'rewind-id',
            piSelectedModel: { provider: 'rewind-provider', modelId: 'rewind-model' },
        })
        history.registerUserEntry('next-local')
        history.observeEntry({ type: 'message', id: 'next-entry', message: { role: 'user' } })
        expect(history.getEntryIds()).toEqual({ 'next-local': 'next-entry' })
        expect(rpc.mock.calls.map(([command]) => command)).toEqual([
            { type: 'get_entries' }, { type: 'get_state' }, { type: 'get_fork_messages' }, { type: 'fork', entryId: 'entry-user' },
            { type: 'get_state' }, { type: 'get_entries' },
        ])
        expect(rpc.mock.calls.find(([command]) => command.type === 'fork')?.[1])
            .toBeLessThanOrEqual(PI_HISTORY_OPERATION_TIMEOUT_MS)
    })

    it('does not combine a changed rewind model with a provider omitted by Pi', async () => {
        const { session, metadata } = createSession()
        session.currentModel = 'old-model'
        session.currentProvider = 'old-provider'
        const sourceState = { ...source, model: { id: 'old-model', provider: 'old-provider' }, isStreaming: false }
        const rewound = { sessionId: 'rewind-id', sessionFile: '/tmp/rewind.jsonl', model: { id: 'branch-model' }, isStreaming: false }
        let stateCalls = 0
        let entriesCalls = 0
        const rpc = vi.fn(async (command: Record<string, unknown>) => {
            if (command.type === 'get_entries') {
                entriesCalls += 1
                return entriesCalls === 1
                    ? { entries: [], leafId: null }
                    : { entries: [{ id: 'prefix', type: 'message', message: { role: 'assistant' } }], leafId: 'prefix' }
            }
            if (command.type === 'get_state') return [sourceState, rewound][stateCalls++]
            if (command.type === 'get_fork_messages') return { messages: [{ entryId: 'entry-user', text: 'user' }] }
            if (command.type === 'fork') return { cancelled: false }
            throw new Error(`unexpected ${command.type}`)
        })
        const history = new PiConversationHistory(session, rpc)
        history.restoreEntryIds({ local: 'entry-user' })

        await expect(history.rewind('local')).resolves.toMatchObject({ success: true })
        expect(session.currentModel).toBe('branch-model')
        expect(session.currentProvider).toBeNull()
        expect(metadata.piSelectedModel).toBeUndefined()
    })

    it('restores source and rolls back identity/locators when rewind metadata flush fails', async () => {
        const { session, client } = createSession()
        client.flushMetadata.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
        const sourceState = {
            ...source,
            model: { id: 'source-model', provider: 'source-provider' },
            thinkingLevel: 'medium',
            steeringMode: 'all',
            isStreaming: false,
        }
        const rewound = {
            sessionId: 'rewind-id',
            sessionFile: '/tmp/rewind.jsonl',
            model: { id: 'rewind-model', provider: 'rewind-provider' },
            thinkingLevel: 'high',
            steeringMode: 'one-at-a-time',
            isStreaming: true,
        }
        let stateCalls = 0
        let entryCalls = 0
        const rpc = vi.fn(async (command: Record<string, unknown>) => {
            if (command.type === 'get_entries') {
                entryCalls += 1
                return entryCalls === 1
                    ? { entries: [], leafId: null }
                    : { entries: [{ id: 'branch-prefix', type: 'message', message: { role: 'assistant' } }], leafId: 'branch-prefix' }
            }
            if (command.type === 'get_state') return [sourceState, rewound, rewound, sourceState][stateCalls++]
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
        expect(session.currentModel).toBe('source-model')
        expect(session.currentProvider).toBe('source-provider')
        expect(session.currentThinkingLevel).toBe('medium')
        expect(session.currentSteeringMode).toBe('all')
        expect(session.piIsStreaming).toBe(false)
        expect(history.getEntryIds()).toEqual({ local: 'entry-user' })
    })

    it('releases the history gate when rollback persistence reaches the transaction deadline', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(0)
        try {
            const { session, client } = createSession()
            client.flushMetadata.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
            const sourceState = { ...source, model: { id: 'source-model', provider: 'source-provider' }, isStreaming: false }
            const rewound = { sessionId: 'rewind-id', sessionFile: '/tmp/rewind.jsonl', model: { id: 'rewind-model', provider: 'rewind-provider' }, isStreaming: false }
            let stateCalls = 0
            let entryCalls = 0
            const rpc = vi.fn(async (command: Record<string, unknown>) => {
                if (command.type === 'get_entries') {
                    entryCalls += 1
                    return entryCalls === 1
                        ? { entries: [], leafId: null }
                        : { entries: [{ id: 'branch-prefix', type: 'message', message: { role: 'assistant' } }], leafId: 'branch-prefix' }
                }
                if (command.type === 'get_state') {
                    const state = [sourceState, rewound, rewound, sourceState][stateCalls++]
                    if (stateCalls === 4) vi.setSystemTime(PI_HISTORY_OPERATION_TIMEOUT_MS + 1)
                    return state
                }
                if (command.type === 'get_fork_messages') return { messages: [{ entryId: 'entry-user', text: 'user' }] }
                if (command.type === 'fork' || command.type === 'switch_session') return { cancelled: false }
                throw new Error(`unexpected ${command.type}`)
            })
            const history = new PiConversationHistory(session, rpc)
            history.restoreEntryIds({ local: 'entry-user' })
            let deferredDelivered = false

            const pending = history.rewind('local')
            session.runWhenHistoryIdle(() => { deferredDelivered = true }, 'queued-during-failed-rollback')

            await expect(pending).rejects.toBeInstanceOf(PiHistoryRestoreError)
            expect(session.isHistoryTransactionActive).toBe(false)
            expect(deferredDelivered).toBe(false)
            await expect(session.runRuntimeMutation(async () => 'released')).resolves.toBe('released')
        } finally {
            vi.useRealTimers()
        }
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

        history.registerUserEntry('next')
        history.observeEntry({ type: 'message', id: 'next-user', message: { role: 'user' } })
        expect(history.getEntryIds()).toEqual({ next: 'next-user' })
    })

    it('refuses history actions before native-ready or while Pi is streaming/prompting', async () => {
        const unready = createSession({ nativeReady: false })
        const unreadyHistory = new PiConversationHistory(unready.session, vi.fn())
        await expect(unreadyHistory.fork()).rejects.toThrow('not ready')

        const busy = createSession()
        busy.session.piIsStreaming = true
        const busyHistory = new PiConversationHistory(busy.session, vi.fn())
        await expect(busyHistory.fork()).rejects.toThrow('busy')

        const preflight = createSession()
        const preflightRpc = vi.fn()
        const preflightHistory = new PiConversationHistory(preflight.session, preflightRpc)
        preflightHistory.registerUserEntry('local-preflight')
        preflightHistory.observeEntry({ type: 'message', id: 'native-preflight', message: { role: 'user' } })
        preflight.session.setPromptInFlight(true)
        await expect(preflightHistory.fork()).rejects.toThrow('busy')
        expect(preflightRpc).not.toHaveBeenCalled()
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

    it('treats a late clone timeout as indeterminate, discards the history queue, and never classifies state', async () => {
        const { session } = createSession()
        let cloneTimedOut = false
        let rejectClone!: (error: Error) => void
        let cloneTimeoutMs = 0
        const rpc = vi.fn(async (command: Record<string, unknown>, timeoutMs?: number) => {
            if (command.type === 'get_entries') return { entries: [], leafId: null }
            if (command.type === 'get_state') {
                if (cloneTimedOut) throw new Error('must not read state after an indeterminate clone timeout')
                return source
            }
            if (command.type === 'clone') {
                cloneTimeoutMs = timeoutMs ?? 0
                expect(cloneTimeoutMs).toBeGreaterThan(0)
                expect(cloneTimeoutMs).toBeLessThan(PI_HISTORY_OPERATION_TIMEOUT_MS)
                return new Promise<unknown>((_, reject) => {
                    rejectClone = (error) => {
                        cloneTimedOut = true
                        reject(error)
                    }
                })
            }
            if (command.type === 'switch_session') throw new Error('must not switch after an indeterminate clone timeout')
            throw new Error(`unexpected ${command.type}`)
        })
        const history = new PiConversationHistory(session, rpc)
        let delivered = false

        const pending = history.fork()
        await vi.waitFor(() => expect(rejectClone).toBeTypeOf('function'))
        session.runWhenHistoryIdle(() => { delivered = true }, 'queued-after-clone-timeout')
        rejectClone(new Error(`Pi RPC clone (id=42) timed out after ${cloneTimeoutMs}ms`))

        await expect(pending).rejects.toBeInstanceOf(PiHistoryRestoreError)
        expect(rpc.mock.calls.map(([command]) => command.type)).toEqual(['get_entries', 'get_state', 'clone'])
        expect(delivered).toBe(false)
        expect(session.isHistoryTransactionActive).toBe(false)
    })

    it('closes the history gate before waiting for an in-flight config mutation', async () => {
        const { session } = createSession()
        const releaseConfigMutation = await session.acquireRuntimeMutation()
        let stateCalls = 0
        const rpc = vi.fn(async (command: Record<string, unknown>) => {
            if (command.type === 'get_entries') return { entries: [], leafId: null }
            if (command.type === 'get_state') return [source, clone, clone, source][stateCalls++]
            if (command.type === 'clone' || command.type === 'switch_session') return { cancelled: false }
            throw new Error(`unexpected ${command.type}`)
        })
        const history = new PiConversationHistory(session, rpc)
        let deferredDelivered = false

        const pending = history.fork()
        session.runWhenHistoryIdle(() => { deferredDelivered = true }, 'prompt-after-history-begin')

        expect(session.isHistoryTransactionActive).toBe(true)
        expect(rpc).not.toHaveBeenCalled()
        releaseConfigMutation()

        await expect(pending).resolves.toEqual({ nativeSessionId: 'clone-id' })
        expect(deferredDelivered).toBe(true)
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
