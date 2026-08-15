import { afterEach, describe, expect, it } from 'bun:test'
import type { DshImportedMessage, DshLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { Store } from '../../store'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import { importDshSession } from './dshSessions'

function machine(id: string): Machine {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { host: `${id}.local`, platform: 'darwin', happyCliVersion: 'test', homeDir: '/tmp' },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1,
        health: null
    }
}

function userMessage(sessionId: string, eventSeq: number, text: string): DshImportedMessage {
    return {
        localId: `dsh:${sessionId}:${eventSeq}:user`,
        eventSeq,
        createdAt: 1_000 + eventSeq,
        content: {
            role: 'user',
            content: { type: 'text', text },
            meta: { sentFrom: 'cli' }
        }
    }
}

function transcript(sessionId: string, messages: DshImportedMessage[]): DshLocalSessionWithMessages {
    const lastUser = [...messages].reverse().find((message) => message.content.role === 'user')
    return {
        id: sessionId,
        title: `Session ${sessionId}`,
        lastUserMessage: lastUser?.content.role === 'user' && lastUser.content.content.type === 'text'
            ? lastUser.content.content.text
            : null,
        cwd: '/tmp/project',
        modifiedAt: messages.at(-1)?.createdAt ?? 1,
        model: 'deepseek-v4-pro',
        reasoningEffort: 'max',
        messageCount: messages.length,
        running: false,
        parentSessionId: null,
        messages,
        lastEventSeq: messages.at(-1)?.eventSeq ?? null
    }
}

describe('DeepSeek Harness session import', () => {
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

    it('is idempotent, appends by native event sequence, and blocks active updates', () => {
        const { store, engine } = setup()
        const selectedMachine = machine('machine-1')
        const firstTranscript = transcript('native-1', [
            userMessage('native-1', 1, 'first'),
            userMessage('native-1', 2, 'second')
        ])
        const first = importDshSession({
            store,
            engine,
            namespace: 'default',
            machine: selectedMachine,
            sourceUrl: 'http://127.0.0.1:3080',
            transcript: firstTranscript
        })
        expect(first).toMatchObject({ action: 'created', appended: 2 })

        const unchanged = importDshSession({
            store,
            engine,
            namespace: 'default',
            machine: selectedMachine,
            sourceUrl: 'http://127.0.0.1:3080',
            transcript: firstTranscript
        })
        expect(unchanged).toMatchObject({ hapiSessionId: first.hapiSessionId, action: 'unchanged', appended: 0 })

        const extended = transcript('native-1', [
            ...firstTranscript.messages,
            userMessage('native-1', 3, 'third')
        ])
        const updated = importDshSession({
            store,
            engine,
            namespace: 'default',
            machine: selectedMachine,
            sourceUrl: 'http://127.0.0.1:3080',
            transcript: extended
        })
        expect(updated).toMatchObject({ hapiSessionId: first.hapiSessionId, action: 'updated', appended: 1 })
        expect(store.messages.getAllMessages(first.hapiSessionId!)).toHaveLength(3)

        store.sessions.setSessionActive(first.hapiSessionId!, true, 2_000, 'default')
        const activeResult = importDshSession({
            store,
            engine,
            namespace: 'default',
            machine: selectedMachine,
            sourceUrl: 'http://127.0.0.1:3080',
            transcript: transcript('native-1', [...extended.messages, userMessage('native-1', 4, 'fourth')])
        })
        expect(activeResult.error?.code).toBe('session_active')
        expect(store.messages.getAllMessages(first.hapiSessionId!)).toHaveLength(3)
        const stored = store.sessions.getSession(first.hapiSessionId!)!
        expect(stored.model).toBe('deepseek-v4-pro')
        expect(stored.modelReasoningEffort).toBe('max')
        expect((stored.metadata as { dshHistoryLastEventSeq?: number }).dshHistoryLastEventSeq).toBe(3)
    })

    it('scopes the same native id by machine', () => {
        const { store, engine } = setup()
        const source = transcript('same-native-id', [userMessage('same-native-id', 1, 'hello')])
        const first = importDshSession({
            store, engine, namespace: 'default', machine: machine('machine-1'),
            sourceUrl: 'http://127.0.0.1:3080', transcript: source
        })
        const second = importDshSession({
            store, engine, namespace: 'default', machine: machine('machine-2'),
            sourceUrl: 'http://127.0.0.1:3080', transcript: source
        })
        expect(first.hapiSessionId).not.toBe(second.hapiSessionId)
    })

    it('does not duplicate events observed before a mid-turn process failure', () => {
        const { store, engine } = setup()
        const selectedMachine = machine('machine-1')
        const initial = transcript('native-crash', [
            userMessage('native-crash', 1, 'first'),
            userMessage('native-crash', 2, 'second')
        ])
        const imported = importDshSession({
            store,
            engine,
            namespace: 'default',
            machine: selectedMachine,
            sourceUrl: 'http://127.0.0.1:3080',
            transcript: initial
        })
        const sessionId = imported.hapiSessionId!

        store.messages.addMessage(sessionId, userMessage('native-crash', 3, 'mid-turn').content)
        const stored = store.sessions.getSession(sessionId)!
        const storedMetadata = stored.metadata && typeof stored.metadata === 'object'
            ? stored.metadata as Record<string, unknown>
            : {}
        const metadataResult = store.sessions.updateSessionMetadata(
            sessionId,
            {
                ...storedMetadata,
                dshHistoryLastEventSeq: 3
            },
            stored.metadataVersion,
            'default'
        )
        expect(metadataResult.result).toBe('success')

        const afterCrash = importDshSession({
            store,
            engine,
            namespace: 'default',
            machine: selectedMachine,
            sourceUrl: 'http://127.0.0.1:3080',
            transcript: transcript('native-crash', [
                ...initial.messages,
                userMessage('native-crash', 3, 'mid-turn'),
                userMessage('native-crash', 4, 'after-crash')
            ])
        })

        expect(afterCrash).toMatchObject({ action: 'updated', appended: 1 })
        expect(store.messages.getAllMessages(sessionId)).toHaveLength(4)
    })

    it('uses a live cursor when importing a HAPI-created session for the first time', () => {
        const { store, engine } = setup()
        const selectedMachine = machine('machine-1')
        const nativeSessionId = 'native-live'
        const live = store.sessions.getOrCreateSession(
            'dsh-live-session',
            {
                path: '/tmp/project',
                host: 'machine-1.local',
                flavor: 'dsh',
                machineId: selectedMachine.id,
                dshSessionId: nativeSessionId,
                dshHistoryLastEventSeq: 3
            },
            {},
            'default'
        )
        for (let eventSeq = 1; eventSeq <= 3; eventSeq += 1) {
            store.messages.addMessage(live.id, userMessage(nativeSessionId, eventSeq, `live-${eventSeq}`).content)
        }

        const result = importDshSession({
            store,
            engine,
            namespace: 'default',
            machine: selectedMachine,
            sourceUrl: 'http://127.0.0.1:3080',
            transcript: transcript(nativeSessionId, [
                userMessage(nativeSessionId, 1, 'live-1'),
                userMessage(nativeSessionId, 2, 'live-2'),
                userMessage(nativeSessionId, 3, 'live-3'),
                userMessage(nativeSessionId, 4, 'after-crash')
            ])
        })

        expect(result).toMatchObject({ hapiSessionId: live.id, action: 'updated', appended: 1 })
        expect(store.messages.getAllMessages(live.id)).toHaveLength(4)
    })
})
