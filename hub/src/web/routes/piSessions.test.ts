import { afterEach, describe, expect, it } from 'vitest'
import type { PiLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { Store } from '../../store'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import { importPiSession } from './piSessions'

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

function transcript(
    sessionId: string,
    entries: Array<ReturnType<typeof userMessage>>,
    activeEntryIds = entries.map((entry) => entry.entryId)
): PiLocalSessionWithMessages {
    return {
        id: sessionId,
        title: `Session ${sessionId}`,
        lastUserMessage: entries.at(-1)?.content.content.text ?? null,
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
