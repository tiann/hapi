import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { ClaudeLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { Store } from '../../store'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createClaudeSessionRoutes, importClaudeSession } from './claudeSessions'

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

    it('imports a deduplicated batch through bounded per-session pages', async () => {
        const { store } = setup()
        const selectedMachine = machine()
        const transcripts = new Map([
            ['native-batch-1', transcript('native-batch-1', ['one', 'two', 'three'])],
            ['native-batch-2', transcript('native-batch-2', ['four', 'five'])]
        ])
        const requests: Array<{ sessionId: string; cursor: number }> = []
        const engine = {
            getOnlineMachinesByNamespace: () => [selectedMachine],
            listClaudeSessionPageForMachine: async (_machineId: string, options: { sessionId: string; cursor: number }) => {
                requests.push({ sessionId: options.sessionId, cursor: options.cursor })
                const source = transcripts.get(options.sessionId)
                if (!source) return { success: false as const, error: 'Claude session transcript not found' }
                const messages = source.messages.slice(options.cursor, options.cursor + 1)
                const next = options.cursor + messages.length
                return {
                    success: true as const,
                    mode: 'messages' as const,
                    page: {
                        session: {
                            id: source.id,
                            title: source.title,
                            lastUserMessage: source.lastUserMessage,
                            cwd: source.cwd,
                            file: source.file,
                            modifiedAt: source.modifiedAt,
                            model: source.model,
                            messageCount: source.messageCount
                        },
                        messages,
                        nextCursor: next < source.messages.length ? next : null
                    }
                }
            },
            recordSessionActivity: (sessionId: string, updatedAt: number) => {
                store.sessions.touchSessionUpdatedAt(sessionId, updatedAt, 'default')
            },
            handleRealtimeEvent: () => {}
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createClaudeSessionRoutes({ store, getSyncEngine: () => engine }))

        const response = await app.request('/api/claude/import-sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                machineId: selectedMachine.id,
                sessionIds: ['native-batch-1', 'native-batch-2', 'native-batch-1']
            })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
            success: true,
            results: [
                { claudeSessionId: 'native-batch-1', action: 'created', appended: 3 },
                { claudeSessionId: 'native-batch-2', action: 'created', appended: 2 }
            ]
        })
        expect(requests).toEqual([
            { sessionId: 'native-batch-1', cursor: 0 },
            { sessionId: 'native-batch-1', cursor: 1 },
            { sessionId: 'native-batch-1', cursor: 2 },
            { sessionId: 'native-batch-2', cursor: 0 },
            { sessionId: 'native-batch-2', cursor: 1 }
        ])
    })

    it('rejects pages from different transcript snapshots before persisting', async () => {
        const { store } = setup()
        const selectedMachine = machine()
        const source = transcript('native-changing', ['one', 'two'])
        const engine = {
            getOnlineMachinesByNamespace: () => [selectedMachine],
            listClaudeSessionPageForMachine: async (_machineId: string, options: { cursor: number }) => ({
                success: true as const,
                mode: 'messages' as const,
                page: {
                    session: {
                        id: source.id,
                        title: source.title,
                        cwd: source.cwd,
                        file: source.file,
                        modifiedAt: source.modifiedAt + options.cursor,
                        messageCount: source.messageCount
                    },
                    messages: source.messages.slice(options.cursor, options.cursor + 1),
                    nextCursor: options.cursor === 0 ? 1 : null
                }
            }),
            recordSessionActivity: () => {},
            handleRealtimeEvent: () => {}
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createClaudeSessionRoutes({ store, getSyncEngine: () => engine }))

        const response = await app.request('/api/claude/import-sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ machineId: selectedMachine.id, sessionIds: [source.id] })
        })

        expect(await response.json()).toMatchObject({
            success: false,
            results: [{ claudeSessionId: source.id, error: { code: 'transcript_changed' } }]
        })
        expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(0)
    })

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

    it('reuses a normal HAPI session and imports only its newer native tail', () => {
        const { store, engine } = setup()
        const nativeTranscript = transcript('native-1', ['already observed', 'native tail'])
        nativeTranscript.messages.splice(1, 0, assistantMessage('native-1', 'assistant-1', 'first answer', 1_500))
        nativeTranscript.messages.push(assistantMessage('native-1', 'assistant-2', 'second answer', 2_500))
        nativeTranscript.messageCount = nativeTranscript.messages.length
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
            'default',
            'claude-haiku-4-5',
            'low'
        )
        store.messages.addMessage(existing.id, nativeTranscript.messages[0]!.content, 'web-user-1')
        store.messages.addMessage(existing.id, nativeTranscript.messages[1]!.content)

        const result = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: nativeTranscript,
            launchSettings: {
                model: 'claude-opus-4-1',
                effort: 'high',
                permissionMode: 'bypassPermissions'
            }
        })

        expect(result).toMatchObject({
            hapiSessionId: existing.id,
            action: 'updated',
            appended: 2
        })
        expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(1)
        expect(store.messages.getAllMessages(existing.id).map((message) => message.content)).toEqual(
            nativeTranscript.messages.map((message) => message.content)
        )
        expect(store.sessions.getSession(existing.id)).toMatchObject({
            model: 'claude-opus-4-1',
            effort: 'high',
            metadata: expect.objectContaining({ preferredPermissionMode: 'bypassPermissions' })
        })

        importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: nativeTranscript,
            launchSettings: { model: null, effort: null }
        })
        expect(store.sessions.getSession(existing.id)).toMatchObject({ model: null, effort: null })
    })

    it('does not import a native tail while the matching HAPI session is active', () => {
        const { store, engine } = setup()
        const existing = store.sessions.getOrCreateSession(
            'active-claude',
            {
                path: '/tmp/project',
                machineId: 'machine-1',
                flavor: 'claude',
                claudeSessionId: 'native-active'
            },
            {},
            'default'
        )
        store.sessions.setSessionActive(existing.id, true, Date.now(), 'default')

        const result = importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: transcript('native-active', ['native tail'])
        })

        expect(result.error?.code).toBe('session_active')
        expect(store.messages.getAllMessages(existing.id)).toHaveLength(0)
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
