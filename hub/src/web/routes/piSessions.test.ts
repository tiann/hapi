import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { Hono } from 'hono'
import type { PiLocalSessionSummary, PiLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { Store } from '../../store'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createPiSessionRoutes, importPiSession } from './piSessions'

function machine(id: string): Machine {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            host: `${id}.local`,
            platform: 'darwin',
            happyCliVersion: 'test'
        },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1,
        health: null
    }
}

function userMessage(sessionId: string, entryId: string, parentEntryId: string | null, text: string, createdAt: number) {
    return {
        localId: `pi:${sessionId}:${entryId}:user`,
        entryId,
        parentEntryId,
        createdAt,
        content: {
            role: 'user' as const,
            content: { type: 'text' as const, text },
            meta: { sentFrom: 'cli' as const }
        }
    }
}

function toolResultMessage(sessionId: string, entryId: string, parentEntryId: string | null, output: string, createdAt: number) {
    return {
        localId: `pi:${sessionId}:${entryId}:tool-result`,
        entryId,
        parentEntryId,
        createdAt,
        content: {
            role: 'agent' as const,
            content: {
                type: 'codex' as const,
                data: { type: 'tool-call-result', callId: 'tool-1', output, is_error: false }
            },
            meta: { sentFrom: 'cli' as const }
        }
    }
}

function transcript(
    sessionId: string,
    entries: Array<ReturnType<typeof userMessage> | ReturnType<typeof toolResultMessage>>,
    activeEntryIds = entries.map((entry) => entry.entryId)
): PiLocalSessionWithMessages {
    const lastUser = [...entries].reverse().find((entry) => entry.content.role === 'user')
    return {
        id: sessionId,
        title: `Session ${sessionId}`,
        lastUserMessage: lastUser?.content.role === 'user' ? lastUser.content.content.text : null,
        cwd: '/tmp/project',
        file: `/tmp/${sessionId}.jsonl`,
        modifiedAt: entries.at(-1)?.createdAt ?? 1,
        model: 'gpt-5.6',
        thinkingLevel: 'high',
        leafEntryId: activeEntryIds.at(-1) ?? null,
        messageCount: entries.length,
        messages: entries,
        activeEntryIds
    }
}

describe('Pi session import', () => {
    const stores: Store[] = []

    afterEach(() => {
        for (const store of stores.splice(0)) store.close()
    })

    function setup() {
        const store = new Store(':memory:')
        stores.push(store)
        const events: unknown[] = []
        const engine = {
            recordSessionActivity: (sessionId: string, updatedAt: number) => {
                store.sessions.touchSessionUpdatedAt(sessionId, updatedAt, 'default')
            },
            handleRealtimeEvent: (event: unknown) => events.push(event)
        } as unknown as SyncEngine
        return { store, engine, events }
    }

    it('loads imported sessions once when listing multiple Pi summaries', async () => {
        const { store } = setup()
        const selectedMachine = machine('machine-1')
        const imported = store.sessions.getOrCreateSession('imported-native-1', {
            flavor: 'pi',
            machineId: selectedMachine.id,
            piSessionId: 'native-1',
            piImportState: { state: 'complete' }
        }, {}, 'default')
        const summaries: PiLocalSessionSummary[] = [
            transcript('native-1', []),
            transcript('native-2', [])
        ]
        const engine = {
            getOnlineMachinesByNamespace: () => [selectedMachine],
            listPiSessionsForMachine: async () => ({ success: true, sessions: summaries })
        } as unknown as SyncEngine
        const getSessionsSpy = spyOn(store.sessions, 'getSessionsByNamespace')
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createPiSessionRoutes({ store, getSyncEngine: () => engine }))

        const response = await app.request('/api/pi/sessions?machineId=machine-1')

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
            success: true,
            sessions: [
                { id: 'native-1', hapiSessionId: imported.id, importState: 'complete' },
                { id: 'native-2' }
            ]
        })
        expect(getSessionsSpy).toHaveBeenCalledTimes(1)
    })

    it('loads imported sessions once for a deduplicated batch import', async () => {
        const { store } = setup()
        const selectedMachine = machine('machine-1')
        const transcripts = [
            transcript('native-batch-1', [userMessage('native-batch-1', 'entry-1', null, 'one', 1_000)]),
            transcript('native-batch-2', [userMessage('native-batch-2', 'entry-1', null, 'two', 2_000)])
        ]
        let requestedIds: string[] | undefined
        const engine = {
            getOnlineMachinesByNamespace: () => [selectedMachine],
            listPiSessionsForMachine: async (_machineId: string, _cwd: string | null, sessionIds?: string[]) => {
                requestedIds = sessionIds
                return { success: true, sessions: transcripts }
            },
            recordSessionActivity: (sessionId: string, updatedAt: number) => {
                store.sessions.touchSessionUpdatedAt(sessionId, updatedAt, 'default')
            },
            handleRealtimeEvent: () => {}
        } as unknown as SyncEngine
        const getSessionsSpy = spyOn(store.sessions, 'getSessionsByNamespace')
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createPiSessionRoutes({ store, getSyncEngine: () => engine }))

        const response = await app.request('/api/pi/import-sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                machineId: selectedMachine.id,
                sessionIds: ['native-batch-1', 'native-batch-2', 'native-batch-1']
            })
        })

        expect(response.status).toBe(200)
        expect(requestedIds).toEqual(['native-batch-1', 'native-batch-2'])
        expect(await response.json()).toMatchObject({
            success: true,
            results: [
                { piSessionId: 'native-batch-1', action: 'created' },
                { piSessionId: 'native-batch-2', action: 'created' }
            ]
        })
        expect(getSessionsSpy).toHaveBeenCalledTimes(1)
    })

    it('imports idempotently and appends only entries after the persisted native leaf', () => {
        const { store, engine } = setup()
        const first = transcript('native-1', [
            userMessage('native-1', 'entry-1', null, 'one', 1_000)
        ])
        const initial = importPiSession({ store, engine, namespace: 'default', machine: machine('machine-1'), transcript: first })
        expect(initial).toMatchObject({ action: 'created', appended: 1 })
        expect(store.messages.getAllMessages(initial.hapiSessionId!)[0]).toMatchObject({
            localId: 'pi:native-1:entry-1:user',
            invokedAt: 1_000
        })

        const unchanged = importPiSession({ store, engine, namespace: 'default', machine: machine('machine-1'), transcript: first })
        expect(unchanged).toMatchObject({ hapiSessionId: initial.hapiSessionId, action: 'unchanged', appended: 0 })

        const extended = transcript('native-1', [
            userMessage('native-1', 'entry-1', null, 'one', 1_000),
            userMessage('native-1', 'entry-2', 'entry-1', 'two', 2_000)
        ])
        const updated = importPiSession({ store, engine, namespace: 'default', machine: machine('machine-1'), transcript: extended })
        expect(updated).toMatchObject({ hapiSessionId: initial.hapiSessionId, action: 'updated', appended: 1 })
        expect(store.messages.getAllMessages(initial.hapiSessionId!)).toHaveLength(2)
        const metadata = store.sessions.getSession(initial.hapiSessionId!)?.metadata as Record<string, unknown>
        expect(metadata.piHistoryLeafEntryId).toBe('entry-2')
        expect(metadata.conversationHistoryEntryIds).toMatchObject({
            'pi:native-1:entry-1:user': 'entry-1',
            'pi:native-1:entry-2:user': 'entry-2'
        })
    })

    it('keeps the same native Pi id separate on different machines', () => {
        const { store, engine } = setup()
        const source = transcript('same-native-id', [userMessage('same-native-id', 'entry-1', null, 'one', 1_000)])
        const first = importPiSession({ store, engine, namespace: 'default', machine: machine('machine-1'), transcript: source })
        const second = importPiSession({ store, engine, namespace: 'default', machine: machine('machine-2'), transcript: source })

        expect(first.hapiSessionId).not.toBe(second.hapiSessionId)
        expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(2)
    })

    it('preserves a custom HAPI session name during later Pi reconciliation', () => {
        const { store, engine } = setup()
        const source = transcript('native-renamed', [userMessage('native-renamed', 'entry-1', null, 'one', 1_000)])
        const first = importPiSession({ store, engine, namespace: 'default', machine: machine('machine-1'), transcript: source })
        const stored = store.sessions.getSession(first.hapiSessionId!)!
        store.sessions.updateSessionMetadata(
            stored.id,
            { ...(stored.metadata as Record<string, unknown>), name: 'My custom HAPI title' },
            stored.metadataVersion,
            'default'
        )

        const extended = transcript('native-renamed', [
            userMessage('native-renamed', 'entry-1', null, 'one', 1_000),
            userMessage('native-renamed', 'entry-2', 'entry-1', 'two', 2_000)
        ])
        const result = importPiSession({ store, engine, namespace: 'default', machine: machine('machine-1'), transcript: extended })

        expect(result.error).toBeUndefined()
        expect((store.sessions.getSession(stored.id)?.metadata as { name?: string }).name).toBe('My custom HAPI title')
    })

    it('keeps a mid-transcript incremental import idempotent and rebuilds missing user locators', () => {
        const { store, engine } = setup()
        const source = transcript('native-mid', [
            userMessage('native-mid', 'entry-1', null, 'one', 1_000),
            userMessage('native-mid', 'entry-2', 'entry-1', 'two', 2_000)
        ])
        const existing = store.sessions.getOrCreateSession('existing-mid', {
            path: '/tmp/project',
            host: 'machine-1.local',
            machineId: 'machine-1',
            flavor: 'pi',
            piSessionId: 'native-mid',
            piHistoryLeafEntryId: 'entry-1'
        }, {}, 'default')

        const first = importPiSession({ store, engine, namespace: 'default', machine: machine('machine-1'), transcript: source })
        expect(first).toMatchObject({ hapiSessionId: existing.id, action: 'updated', appended: 1 })
        const second = importPiSession({ store, engine, namespace: 'default', machine: machine('machine-1'), transcript: source })
        expect(second).toMatchObject({ hapiSessionId: existing.id, action: 'unchanged', appended: 0 })
        expect(second.error).toBeUndefined()
        expect((store.sessions.getSession(existing.id)?.metadata as { conversationHistoryEntryIds?: Record<string, string> }).conversationHistoryEntryIds).toMatchObject({
            'pi:native-mid:entry-2:user': 'entry-2'
        })
    })

    it('rebuilds locators for messages persisted before a failed metadata finalize', () => {
        const { store, engine } = setup()
        const source = transcript('native-retry', [
            userMessage('native-retry', 'entry-1', null, 'one', 1_000),
            userMessage('native-retry', 'entry-2', 'entry-1', 'two', 2_000)
        ])
        const existing = store.sessions.getOrCreateSession('existing-retry', {
            path: '/tmp/project', host: 'machine-1.local', machineId: 'machine-1', flavor: 'pi', piSessionId: 'native-retry'
        }, {}, 'default')
        store.messages.addImportedMessage(existing.id, source.messages[0]!.content, source.messages[0]!.localId, 1_000)

        const result = importPiSession({ store, engine, namespace: 'default', machine: machine('machine-1'), transcript: source })
        expect(result).toMatchObject({ action: 'updated', appended: 1 })
        expect((store.sessions.getSession(existing.id)?.metadata as { conversationHistoryEntryIds?: Record<string, string> }).conversationHistoryEntryIds).toMatchObject({
            'pi:native-retry:entry-1:user': 'entry-1',
            'pi:native-retry:entry-2:user': 'entry-2'
        })
    })

    it('compares oversized imported content using the persisted truncation form', () => {
        const { store, engine } = setup()
        const source = transcript('native-large', [toolResultMessage('native-large', 'entry-1', null, 'x'.repeat(70_000), 1_000)])
        const first = importPiSession({ store, engine, namespace: 'default', machine: machine('machine-1'), transcript: source })
        const second = importPiSession({ store, engine, namespace: 'default', machine: machine('machine-1'), transcript: source })

        expect(first).toMatchObject({ action: 'created', appended: 1 })
        expect(second).toMatchObject({ action: 'unchanged', appended: 0 })
        expect(second.error).toBeUndefined()
    })

    it('marks the import diverged when the active branch drops or rewrites imported history', () => {
        const { store, engine } = setup()
        const source = transcript('native-diverged', [userMessage('native-diverged', 'entry-1', null, 'one', 1_000)])
        const first = importPiSession({ store, engine, namespace: 'default', machine: machine('machine-1'), transcript: source })

        const rewritten = transcript('native-diverged', [
            userMessage('native-diverged', 'entry-1', null, 'changed', 1_000)
        ])
        const result = importPiSession({ store, engine, namespace: 'default', machine: machine('machine-1'), transcript: rewritten })
        expect(result.error?.code).toBe('transcript_diverged')
        expect((store.sessions.getSession(first.hapiSessionId!)?.metadata as { piImportState?: { state?: string } }).piImportState?.state).toBe('diverged')
    })

    it('does not interleave new imported entries into an active HAPI session', () => {
        const { store, engine } = setup()
        const first = importPiSession({
            store,
            engine,
            namespace: 'default',
            machine: machine('machine-1'),
            transcript: transcript('native-active', [userMessage('native-active', 'entry-1', null, 'one', 1_000)])
        })
        store.sessions.setSessionActive(first.hapiSessionId!, true, 2_000, 'default')
        const extended = transcript('native-active', [
            userMessage('native-active', 'entry-1', null, 'one', 1_000),
            userMessage('native-active', 'entry-2', 'entry-1', 'two', 2_000)
        ])

        const result = importPiSession({ store, engine, namespace: 'default', machine: machine('machine-1'), transcript: extended })
        expect(result.error?.code).toBe('session_active')
        expect(store.messages.getAllMessages(first.hapiSessionId!)).toHaveLength(1)
    })
})
