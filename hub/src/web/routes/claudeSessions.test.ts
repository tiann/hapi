import { afterEach, describe, expect, it } from 'bun:test'
import type { ClaudeLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { Store } from '../../store'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import { importClaudeSession } from './claudeSessions'

function machine(id = 'machine-1'): Machine {
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

function transcript(id: string, prompts: string[]): ClaudeLocalSessionWithMessages {
    return {
        id,
        title: prompts[0] ?? id,
        lastUserMessage: prompts.at(-1) ?? null,
        cwd: '/tmp/project',
        file: `/tmp/${id}.jsonl`,
        modifiedAt: prompts.length * 1_000,
        model: 'claude-sonnet-4-5',
        messageCount: prompts.length,
        messages: prompts.map((text, index) => ({
            localId: `claude:${id}:user-${index + 1}`,
            createdAt: (index + 1) * 1_000,
            content: {
                role: 'user',
                content: { type: 'text', text },
                meta: { sentFrom: 'cli' }
            }
        }))
    }
}

function assistantMessage(sessionId: string, uuid: string, text: string, createdAt: number) {
    return {
        localId: `claude:${sessionId}:${uuid}`,
        createdAt,
        content: {
            role: 'agent' as const,
            content: {
                type: 'output' as const,
                data: {
                    type: 'assistant',
                    uuid,
                    sessionId,
                    timestamp: new Date(createdAt).toISOString(),
                    message: { role: 'assistant', content: [{ type: 'text', text }] }
                }
            },
            meta: { sentFrom: 'cli' as const }
        }
    }
}

describe('Claude session import', () => {
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

    it('imports idempotently and appends new native history', () => {
        const { store, engine } = setup()
        const first = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: transcript('native-1', ['one']),
            launchSettings: {
                model: 'deepseek-v4-flash[1m]',
                effort: 'high',
                permissionMode: 'bypassPermissions'
            }
        })
        expect(first).toMatchObject({ action: 'created', appended: 1 })

        const unchanged = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: transcript('native-1', ['one'])
        })
        expect(unchanged).toMatchObject({
            hapiSessionId: first.hapiSessionId,
            action: 'unchanged',
            appended: 0
        })

        const updated = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: transcript('native-1', ['one', 'two'])
        })
        expect(updated).toMatchObject({
            hapiSessionId: first.hapiSessionId,
            action: 'updated',
            appended: 1
        })
        expect(store.messages.getAllMessages(first.hapiSessionId!)).toHaveLength(2)
        expect(store.sessions.getSession(first.hapiSessionId!)?.metadata).toMatchObject({
            flavor: 'claude',
            claudeSessionId: 'native-1',
            lifecycleState: 'archived',
            preferredPermissionMode: 'bypassPermissions',
            claudeImportState: { state: 'complete' }
        })
        expect(store.sessions.getSession(first.hapiSessionId!)).toMatchObject({
            model: 'deepseek-v4-flash[1m]',
            effort: 'high'
        })
    })

    it('does not duplicate native entries already observed by the live HAPI session', () => {
        const { store, engine } = setup()
        const sessionId = 'native-live'
        const initialTranscript = transcript(sessionId, ['one'])
        initialTranscript.messages.push(assistantMessage(sessionId, 'assistant-1', 'first answer', 1_500))
        initialTranscript.messageCount = initialTranscript.messages.length
        const initial = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: initialTranscript
        })

        const expandedTranscript = transcript(sessionId, ['one', 'two'])
        expandedTranscript.messages.splice(1, 0, assistantMessage(sessionId, 'assistant-1', 'first answer', 1_500))
        expandedTranscript.messages.push(assistantMessage(sessionId, 'assistant-2', 'second answer', 2_500))
        expandedTranscript.messageCount = expandedTranscript.messages.length
        const liveUser = expandedTranscript.messages[2]!
        const liveAssistant = expandedTranscript.messages[3]!
        store.messages.addMessage(initial.hapiSessionId!, liveUser.content, 'web-user-2')
        store.messages.addMessage(initial.hapiSessionId!, liveAssistant.content)

        const repeated = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: expandedTranscript
        })

        expect(repeated).toMatchObject({ action: 'unchanged', appended: 0 })
        expect(store.messages.getAllMessages(initial.hapiSessionId!)).toHaveLength(4)
    })

    it('reuses a normal HAPI session with the same Claude session id', () => {
        const { store, engine } = setup()
        const existing = store.sessions.getOrCreateSession(
            'existing-claude',
            {
                path: '/tmp/project',
                host: 'machine-1.local',
                machineId: 'machine-1',
                flavor: 'claude',
                claudeSessionId: 'native-1'
            },
            {},
            'default'
        )

        const result = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: transcript('native-1', ['already observed'])
        })

        expect(result).toMatchObject({
            hapiSessionId: existing.id,
            action: 'unchanged',
            appended: 0
        })
        expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(1)
    })

    it('marks rewritten imported history as diverged', () => {
        const { store, engine } = setup()
        const initial = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: transcript('native-1', ['one'])
        })
        const rewritten = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: transcript('native-1', ['changed'])
        })

        expect(rewritten.error?.code).toBe('transcript_diverged')
        const metadata = store.sessions.getSession(initial.hapiSessionId!)?.metadata as { claudeImportState?: { state?: string } } | undefined
        expect(metadata?.claudeImportState?.state).toBe('diverged')
    })
})
