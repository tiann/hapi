import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { ClaudeLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { normalizeClaudeImportedUserText } from '@hapi/protocol/messages'
import { Store } from '../../store'
import { RpcTargetMissingError } from '../../sync/rpcGateway'
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

type AssistantRuntimeFields = {
    cwd?: string
    version?: string
    gitBranch?: string
    requestId?: string
    usage?: Record<string, number>
}

function assistantMessage(
    sessionId: string,
    uuid: string,
    text: string,
    createdAt: number,
    runtime: AssistantRuntimeFields = {}
) {
    const { usage, ...runtimeFields } = runtime
    return {
        localId: `claude:${sessionId}:${uuid}`,
        createdAt,
        content: {
            role: 'agent' as const,
            content: {
                type: 'output' as const,
                data: {
                    ...runtimeFields,
                    type: 'assistant',
                    uuid,
                    sessionId,
                    timestamp: new Date(createdAt).toISOString(),
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text }],
                        ...(usage ? { usage } : {})
                    }
                }
            },
            meta: { sentFrom: 'cli' as const }
        }
    }
}

function nativeObservedContent(message: ClaudeLocalSessionWithMessages['messages'][number]) {
    return {
        ...message.content,
        meta: {
            ...message.content.meta,
            claudeTranscriptLocalId: message.localId
        }
    }
}

function visibleMessageText(message: { content: unknown }): string | null {
    const envelope = message.content as {
        role?: string
        content?: {
            text?: string
            data?: { message?: { content?: Array<{ type?: string; text?: string }> } }
        }
    }
    if (envelope.role === 'user') return envelope.content?.text ?? null
    return envelope.content?.data?.message?.content?.find((block) => block.type === 'text')?.text ?? null
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
            applySessionConfig: async (
                sessionId: string,
                config: { model?: string | null; effort?: string | null }
            ) => {
                if (config.model !== undefined) {
                    store.sessions.setSessionModel(sessionId, config.model, 'default', { touchUpdatedAt: false })
                }
                if (config.effort !== undefined) {
                    store.sessions.setSessionEffort(sessionId, config.effort, 'default', { touchUpdatedAt: false })
                }
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
        const persistedCounts: number[] = []
        const engine = {
            getOnlineMachinesByNamespace: () => [selectedMachine],
            listClaudeSessionPageForMachine: async (_machineId: string, options: { sessionId: string; cursor: number }) => {
                requests.push({ sessionId: options.sessionId, cursor: options.cursor })
                const imported = store.sessions.getSessionsByNamespace('default').find((session) =>
                    (session.metadata as { claudeSessionId?: string } | null)?.claudeSessionId === options.sessionId
                )
                persistedCounts.push(imported ? store.messages.getAllMessages(imported.id).length : 0)
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
            { sessionId: 'native-batch-1', cursor: 0 },
            { sessionId: 'native-batch-1', cursor: 1 },
            { sessionId: 'native-batch-1', cursor: 2 },
            { sessionId: 'native-batch-2', cursor: 0 },
            { sessionId: 'native-batch-2', cursor: 1 },
            { sessionId: 'native-batch-2', cursor: 0 },
            { sessionId: 'native-batch-2', cursor: 1 }
        ])
        expect(persistedCounts).toEqual([
            0, 0, 0,
            0, 1, 2,
            0, 0,
            0, 1
        ])
    })

    it('queues concurrent imports and applies each request launch settings in order', async () => {
        const { store } = setup()
        const selectedMachine = machine()
        const source = transcript('native-concurrent', ['one'])
        let pageCalls = 0
        let signalFirstPageStarted!: () => void
        let releaseFirstPage!: () => void
        const firstPageStarted = new Promise<void>((resolve) => {
            signalFirstPageStarted = resolve
        })
        const firstPageBlocked = new Promise<void>((resolve) => {
            releaseFirstPage = resolve
        })
        const engine = {
            getOnlineMachinesByNamespace: () => [selectedMachine],
            listClaudeSessionPageForMachine: async (_machineId: string, options: { cursor: number }) => {
                pageCalls += 1
                if (pageCalls === 1) {
                    signalFirstPageStarted()
                    await firstPageBlocked
                }
                const messages = source.messages.slice(options.cursor, options.cursor + 1)
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
                        nextCursor: null
                    }
                }
            },
            recordSessionActivity: (sessionId: string, updatedAt: number) => {
                store.sessions.touchSessionUpdatedAt(sessionId, updatedAt, 'default')
            },
            applySessionConfig: async (
                sessionId: string,
                config: { model?: string | null; effort?: string | null }
            ) => {
                if (config.model !== undefined) {
                    store.sessions.setSessionModel(sessionId, config.model, 'default', { touchUpdatedAt: false })
                }
                if (config.effort !== undefined) {
                    store.sessions.setSessionEffort(sessionId, config.effort, 'default', { touchUpdatedAt: false })
                }
            },
            handleRealtimeEvent: () => {}
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createClaudeSessionRoutes({ store, getSyncEngine: () => engine }))

        const request = (settings: { model: string; effort: string; permissionMode: string }) =>
            app.request('/api/claude/import-sessions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    machineId: selectedMachine.id,
                    sessionIds: [source.id],
                    ...settings
                })
            })
        const firstResponse = request({
            model: 'first-model',
            effort: 'high',
            permissionMode: 'bypassPermissions'
        })
        await firstPageStarted
        const secondResponse = request({
            model: 'second-model',
            effort: 'low',
            permissionMode: 'default'
        })
        await Promise.resolve()
        expect(pageCalls).toBe(1)

        releaseFirstPage()
        expect(await (await firstResponse).json()).toMatchObject({
            success: true,
            results: [{ action: 'created', appended: 1 }]
        })
        expect(await (await secondResponse).json()).toMatchObject({
            success: true,
            results: [{ action: 'unchanged', appended: 0 }]
        })

        expect(pageCalls).toBe(3)
        expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(1)
        expect(store.sessions.getSessionsByNamespace('default')[0]).toMatchObject({
            model: 'second-model',
            effort: 'low',
            metadata: expect.objectContaining({ preferredPermissionMode: 'default' })
        })
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

    it('returns an upgrade hint when the selected Runner lacks Claude history RPC', async () => {
        const { store } = setup()
        const selectedMachine = machine()
        const engine = {
            getOnlineMachinesByNamespace: () => [selectedMachine],
            listClaudeSessionSummariesForMachine: async () => {
                throw new RpcTargetMissingError(`${selectedMachine.id}:listClaudeSessions`, 'handler-not-registered')
            }
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createClaudeSessionRoutes({ store, getSyncEngine: () => engine }))

        const response = await app.request(`/api/claude/sessions?machineId=${selectedMachine.id}`)

        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({
            success: false,
            error: 'This machine uses a HAPI Runner version that does not support Claude history import; update and restart the Runner',
            sessions: [],
            machineId: selectedMachine.id
        })
    })

    it('rejects a non-advancing transcript page', async () => {
        const { store, engine } = setup()
        const source = transcript('native-stalled', ['one'])
        source.messages = []

        const result = await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: source
        })

        expect(result).toMatchObject({
            claudeSessionId: source.id,
            error: { code: 'import_failed', message: 'Invalid Claude transcript page cursor' }
        })
        expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(0)
    })

    it('imports idempotently and appends new native history', async () => {
        const { store, engine } = setup()
        const first = await importClaudeSession({
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

        const unchanged = await importClaudeSession({
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

        const updated = await importClaudeSession({
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

    it('does not duplicate native entries already observed by the live HAPI session', async () => {
        const { store, engine } = setup()
        const sessionId = 'native-live'
        const initialTranscript = transcript(sessionId, ['one'])
        initialTranscript.messages.push(assistantMessage(sessionId, 'assistant-1', 'first answer', 1_500))
        initialTranscript.messageCount = initialTranscript.messages.length
        const initial = await importClaudeSession({
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
        store.messages.addMessage(
            initial.hapiSessionId!,
            nativeObservedContent(liveAssistant as ReturnType<typeof assistantMessage>)
        )

        const repeated = await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: expandedTranscript
        })

        expect(repeated).toMatchObject({ action: 'unchanged', appended: 0 })
        expect(store.messages.getAllMessages(initial.hapiSessionId!)).toHaveLength(4)
    })

    it('ignores an SDK-generated UUID when re-importing an unchanged transcript', async () => {
        const { store, engine } = setup()
        const sessionId = 'native-sdk-unchanged'
        const source = transcript(sessionId, ['one'])
        source.messages.push(assistantMessage(sessionId, 'assistant-1', 'first answer', 1_500))
        source.messageCount = source.messages.length
        const initial = await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: source
        })
        const sdkAgent = assistantMessage(sessionId, 'synthetic-sdk-uuid', 'remote-only answer', 2_500)
        store.messages.addMessage(initial.hapiSessionId!, sdkAgent.content)

        const repeated = await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: source
        })

        expect(repeated).toMatchObject({ action: 'unchanged', appended: 0 })
        expect(store.sessions.getSession(initial.hapiSessionId!)?.metadata).toMatchObject({
            claudeImportState: { state: 'complete' }
        })
    })

    it('matches an SDK agent tail when the corresponding native turn reaches disk', async () => {
        const { store, engine } = setup()
        const sessionId = 'native-sdk-tail'
        const initialTranscript = transcript(sessionId, ['one'])
        initialTranscript.messages.push(assistantMessage(sessionId, 'assistant-1', 'first answer', 1_500))
        initialTranscript.messageCount = initialTranscript.messages.length
        const initial = await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: initialTranscript
        })

        const expandedTranscript = transcript(sessionId, ['one', 'two'])
        expandedTranscript.messages.splice(1, 0, assistantMessage(sessionId, 'assistant-1', 'first answer', 1_500))
        expandedTranscript.messages.push(assistantMessage(
            sessionId,
            'assistant-native-2',
            'second answer',
            2_500,
            {
                cwd: '/native/project',
                version: '2.1.0',
                gitBranch: 'native-branch',
                requestId: 'native-request-2',
                usage: { input_tokens: 20, output_tokens: 8 }
            }
        ))
        expandedTranscript.messageCount = expandedTranscript.messages.length
        store.messages.addMessage(initial.hapiSessionId!, expandedTranscript.messages[2]!.content, 'web-user-2')
        const sdkAgent = assistantMessage(
            sessionId,
            'synthetic-sdk-2',
            'second answer',
            9_000,
            {
                cwd: '/sdk/project',
                version: '2.2.0',
                gitBranch: 'sdk-branch',
                requestId: 'sdk-request-2',
                usage: { input_tokens: 20, output_tokens: 8, context_window: 1_000_000 }
            }
        )
        const sdkEvent = sdkAgent.content.content.data
        sdkAgent.content.content.data = {
            message: sdkEvent.message,
            sessionId: sdkEvent.sessionId,
            type: sdkEvent.type,
            uuid: sdkEvent.uuid,
            timestamp: sdkEvent.timestamp,
            requestId: sdkEvent.requestId,
            gitBranch: sdkEvent.gitBranch,
            version: sdkEvent.version,
            cwd: sdkEvent.cwd
        }
        store.messages.addMessage(initial.hapiSessionId!, sdkAgent.content)

        const repeated = await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: expandedTranscript
        })

        expect(repeated).toMatchObject({ action: 'unchanged', appended: 0 })
        expect(store.messages.getAllMessages(initial.hapiSessionId!)).toHaveLength(4)
    })

    it('does not duplicate a trailing live user message without an assistant response', async () => {
        const { store, engine } = setup()
        const sessionId = 'native-live-user-tail'
        const initialTranscript = transcript(sessionId, ['one'])
        initialTranscript.messages.push(assistantMessage(sessionId, 'assistant-1', 'first answer', 1_500))
        initialTranscript.messageCount = initialTranscript.messages.length
        const initial = await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: initialTranscript
        })

        const expandedTranscript = transcript(sessionId, ['one', '  trailing user\n'])
        expandedTranscript.messages.splice(1, 0, assistantMessage(sessionId, 'assistant-1', 'first answer', 1_500))
        expandedTranscript.messageCount = expandedTranscript.messages.length
        const liveUser = expandedTranscript.messages.at(-1)!
        store.messages.addMessage(initial.hapiSessionId!, liveUser.content, 'web-user-tail')

        const repeated = await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: expandedTranscript
        })

        expect(repeated).toMatchObject({ action: 'unchanged', appended: 0 })
        expect(store.messages.getAllMessages(initial.hapiSessionId!)).toHaveLength(3)
    })

    it('does not duplicate or truncate an oversized trailing live user message', async () => {
        const { store, engine } = setup()
        const sessionId = 'native-live-user-oversized'
        const initialTranscript = transcript(sessionId, ['one'])
        initialTranscript.messages.push(assistantMessage(sessionId, 'assistant-1', 'first answer', 1_500))
        initialTranscript.messageCount = initialTranscript.messages.length
        const initial = await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: initialTranscript
        })

        const prompt = 'x'.repeat(70 * 1024)
        const expandedTranscript = transcript(sessionId, ['one', normalizeClaudeImportedUserText(prompt)])
        expandedTranscript.messages.splice(1, 0, assistantMessage(sessionId, 'assistant-1', 'first answer', 1_500))
        expandedTranscript.messageCount = expandedTranscript.messages.length
        const sourceTail = expandedTranscript.messages.at(-1)!
        if (sourceTail.content.role !== 'user') throw new Error('expected user tail')
        const liveContent = {
            ...sourceTail.content,
            content: { ...sourceTail.content.content, text: prompt }
        }
        store.messages.addMessage(initial.hapiSessionId!, liveContent, 'web-user-oversized')

        const repeated = await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: expandedTranscript
        })

        const stored = store.messages.getAllMessages(initial.hapiSessionId!)
        expect(repeated).toMatchObject({ action: 'unchanged', appended: 0 })
        expect(stored).toHaveLength(3)
        expect((stored.at(-1)?.content as typeof liveContent).content.text).toBe(prompt)
    })

    it('matches separately stored user rows to one newline-batched native prompt', async () => {
        const { store, engine } = setup()
        const sessionId = 'native-live-user-batch'
        const initialTranscript = transcript(sessionId, ['one'])
        initialTranscript.messages.push(assistantMessage(sessionId, 'assistant-1', 'first answer', 1_500))
        initialTranscript.messageCount = initialTranscript.messages.length
        const initial = await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: initialTranscript
        })

        const first = transcript(sessionId, ['first queued']).messages[0]!.content
        const second = transcript(sessionId, ['second queued']).messages[0]!.content
        store.messages.addMessage(initial.hapiSessionId!, first, 'web-user-first')
        store.messages.addMessage(initial.hapiSessionId!, second, 'web-user-second')

        const expandedTranscript = transcript(sessionId, ['one', 'first queued\nsecond queued'])
        expandedTranscript.messages.splice(1, 0, assistantMessage(sessionId, 'assistant-1', 'first answer', 1_500))
        expandedTranscript.messageCount = expandedTranscript.messages.length
        const repeated = await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: expandedTranscript
        })

        expect(repeated).toMatchObject({ action: 'unchanged', appended: 0 })
        expect(store.messages.getAllMessages(initial.hapiSessionId!)).toHaveLength(4)
    })

    async function expectSuffixOnlyHistoryToBeCompleted(markNativeIds: boolean): Promise<void> {
        const { store, engine } = setup()
        const sessionId = markNativeIds ? 'native-exact-suffix' : 'native-content-suffix'
        const nativeTranscript = transcript(sessionId, ['old prompt', 'new prompt'])
        nativeTranscript.messages.splice(1, 0, assistantMessage(sessionId, 'assistant-old', 'old answer', 1_500))
        nativeTranscript.messages.push(assistantMessage(sessionId, 'assistant-new', 'new answer', 2_500))
        nativeTranscript.messageCount = nativeTranscript.messages.length
        const existing = store.sessions.getOrCreateSession(
            `existing-${sessionId}`,
            {
                path: '/tmp/project',
                machineId: 'machine-1',
                flavor: 'claude',
                claudeSessionId: sessionId
            },
            {},
            'default'
        )
        for (const message of nativeTranscript.messages.slice(2)) {
            store.messages.addMessage(
                existing.id,
                markNativeIds ? nativeObservedContent(message) : message.content,
                message.content.role === 'user' ? `web-${message.localId}` : undefined,
                undefined,
                message.createdAt
            )
        }

        const result = await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: nativeTranscript
        })

        expect(result).toMatchObject({ hapiSessionId: existing.id, action: 'updated', appended: 2 })
        const stored = store.messages.getMessagesByPosition(existing.id, 200)
        expect(stored).toHaveLength(4)
        expect(stored.map(visibleMessageText)).toEqual([
            'old prompt',
            'old answer',
            'new prompt',
            'new answer'
        ])

        const repeated = await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: nativeTranscript
        })
        expect(repeated).toMatchObject({ action: 'unchanged', appended: 0 })
        expect(store.messages.getAllMessages(existing.id)).toHaveLength(4)

        const liveTail = transcript(sessionId, ['latest prompt']).messages[0]!
        liveTail.localId = `claude:${sessionId}:user-latest`
        liveTail.createdAt = 3_000
        store.messages.addMessage(existing.id, liveTail.content, 'web-user-latest', undefined, liveTail.createdAt)
        const expandedTranscript = {
            ...nativeTranscript,
            modifiedAt: 3_000,
            messageCount: 5,
            lastUserMessage: 'latest prompt',
            messages: [...nativeTranscript.messages, liveTail]
        }
        const afterLiveTail = await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: expandedTranscript
        })
        expect(afterLiveTail).toMatchObject({ action: 'unchanged', appended: 0 })
        expect(store.messages.getMessagesByPosition(existing.id, 200).map(visibleMessageText)).toEqual([
            'old prompt',
            'old answer',
            'new prompt',
            'new answer',
            'latest prompt'
        ])
    }

    it('completes a suffix-only HAPI history without duplicating content-matched entries', async () => {
        await expectSuffixOnlyHistoryToBeCompleted(false)
    })

    it('completes a suffix-only HAPI history without treating native IDs as a prefix', async () => {
        await expectSuffixOnlyHistoryToBeCompleted(true)
    })

    it('recovers a suffix import after finalization fails before the cursor is saved', async () => {
        const { store, engine } = setup()
        const sessionId = 'native-suffix-retry'
        const nativeTranscript = transcript(sessionId, ['old prompt', 'new prompt'])
        nativeTranscript.messages.splice(1, 0, assistantMessage(sessionId, 'assistant-old', 'old answer', 1_500))
        nativeTranscript.messages.push(assistantMessage(sessionId, 'assistant-new', 'new answer', 2_500))
        nativeTranscript.messageCount = nativeTranscript.messages.length
        const existing = store.sessions.getOrCreateSession(
            'existing-suffix-retry',
            {
                path: '/tmp/project',
                machineId: 'machine-1',
                flavor: 'claude',
                claudeSessionId: sessionId
            },
            {},
            'default'
        )
        for (const message of nativeTranscript.messages.slice(2)) {
            store.messages.addMessage(existing.id, message.content, undefined, undefined, message.createdAt)
        }

        const applySessionConfig = engine.applySessionConfig.bind(engine)
        let configAttempts = 0
        const flakyEngine = {
            ...engine,
            applySessionConfig: async (session: string, config: Parameters<SyncEngine['applySessionConfig']>[1]) => {
                configAttempts += 1
                if (configAttempts === 1) throw new Error('temporary config failure')
                await applySessionConfig(session, config)
            }
        } as unknown as SyncEngine

        const failed = await importClaudeSession({
            store,
            engine: flakyEngine,
            namespace: 'default',
            machine: machine(),
            transcript: nativeTranscript,
            launchSettings: { model: 'claude-opus-4-1' }
        })
        expect(failed.error).toMatchObject({ code: 'import_failed', message: 'temporary config failure' })
        expect(store.messages.getAllMessages(existing.id)).toHaveLength(4)

        const retried = await importClaudeSession({
            store,
            engine: flakyEngine,
            namespace: 'default',
            machine: machine(),
            transcript: nativeTranscript,
            launchSettings: { model: 'claude-opus-4-1' }
        })
        expect(retried).toMatchObject({ action: 'unchanged', appended: 0 })
        expect(store.messages.getMessagesByPosition(existing.id, 200).map(visibleMessageText)).toEqual([
            'old prompt',
            'old answer',
            'new prompt',
            'new answer'
        ])
    })

    it('fails closed when existing HAPI history cannot be aligned with the native transcript', async () => {
        const { store, engine } = setup()
        const sessionId = 'native-unaligned'
        const existing = store.sessions.getOrCreateSession(
            'existing-unaligned',
            {
                path: '/tmp/project',
                machineId: 'machine-1',
                flavor: 'claude',
                claudeSessionId: sessionId
            },
            {},
            'default'
        )
        store.messages.addMessage(existing.id, transcript(sessionId, ['not in native']).messages[0]!.content, 'web-unmatched')

        const result = await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: transcript(sessionId, ['native prompt'])
        })

        expect(result.error).toMatchObject({ code: 'transcript_diverged' })
        expect(store.messages.getAllMessages(existing.id)).toHaveLength(1)
    })

    it('aligns separately stored user rows with one batched native prompt without a prior cursor', async () => {
        const { store, engine } = setup()
        const sessionId = 'native-unanchored-user-batch'
        const existing = store.sessions.getOrCreateSession(
            'existing-unanchored-user-batch',
            {
                path: '/tmp/project',
                machineId: 'machine-1',
                flavor: 'claude',
                claudeSessionId: sessionId
            },
            {},
            'default'
        )
        store.messages.addMessage(existing.id, transcript(sessionId, ['first queued']).messages[0]!.content, 'web-first')
        store.messages.addMessage(existing.id, transcript(sessionId, ['second queued']).messages[0]!.content, 'web-second')

        const result = await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: transcript(sessionId, ['first queued\nsecond queued'])
        })

        expect(result).toMatchObject({ action: 'unchanged', appended: 0 })
        expect(store.messages.getAllMessages(existing.id)).toHaveLength(2)
    })

    it('fails closed when content-only history has multiple valid native alignments', async () => {
        const { store, engine } = setup()
        const sessionId = 'native-ambiguous'
        const existing = store.sessions.getOrCreateSession(
            'existing-ambiguous',
            {
                path: '/tmp/project',
                machineId: 'machine-1',
                flavor: 'claude',
                claudeSessionId: sessionId
            },
            {},
            'default'
        )
        store.messages.addMessage(existing.id, transcript(sessionId, ['same prompt']).messages[0]!.content, 'web-same')

        const result = await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: transcript(sessionId, ['same prompt', 'same prompt'])
        })

        expect(result.error).toMatchObject({ code: 'transcript_diverged' })
        expect(store.messages.getAllMessages(existing.id)).toHaveLength(1)
    })

    it('reuses a normal HAPI session and imports only its newer native tail', async () => {
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

        const result = await importClaudeSession({
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

        await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: nativeTranscript,
            launchSettings: { model: null, effort: null }
        })
        expect(store.sessions.getSession(existing.id)).toMatchObject({ model: null, effort: null })
    })

    it('does not import a native tail while the matching HAPI session is active', async () => {
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

        const result = await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: transcript('native-active', ['native tail'])
        })

        expect(result.error?.code).toBe('session_active')
        expect(store.messages.getAllMessages(existing.id)).toHaveLength(0)
    })

    it('applies requested launch settings through the active session runtime', async () => {
        const { store, engine } = setup()
        const sessionId = 'native-active-settings'
        const nativeTranscript = transcript(sessionId, ['already observed'])
        const existing = store.sessions.getOrCreateSession(
            'active-claude-settings',
            {
                path: '/tmp/project',
                machineId: 'machine-1',
                flavor: 'claude',
                claudeSessionId: sessionId
            },
            {},
            'default',
            'old-model',
            'low'
        )
        store.messages.addMessage(existing.id, nativeTranscript.messages[0]!.content, 'web-observed')
        store.sessions.setSessionActive(existing.id, true, Date.now(), 'default')
        const appliedConfigs: unknown[] = []
        const runtimeEngine = {
            ...engine,
            applySessionConfig: async (_sessionId: string, config: unknown) => {
                appliedConfigs.push(config)
            }
        } as unknown as SyncEngine

        const result = await importClaudeSession({
            store,
            engine: runtimeEngine,
            namespace: 'default',
            machine: machine(),
            transcript: nativeTranscript,
            launchSettings: {
                model: 'new-model',
                effort: 'high',
                permissionMode: 'bypassPermissions'
            }
        })

        expect(result).toMatchObject({ action: 'unchanged', appended: 0 })
        expect(appliedConfigs).toEqual([{
            model: 'new-model',
            effort: 'high',
            permissionMode: 'bypassPermissions'
        }])
    })

    it('does not persist requested settings when the active runtime rejects them', async () => {
        const { store, engine } = setup()
        const sessionId = 'native-active-settings-rejected'
        const nativeTranscript = transcript(sessionId, ['already observed'])
        const existing = store.sessions.getOrCreateSession(
            'active-claude-settings-rejected',
            {
                path: '/tmp/project',
                machineId: 'machine-1',
                flavor: 'claude',
                claudeSessionId: sessionId
            },
            {},
            'default',
            'old-model',
            'low'
        )
        store.messages.addMessage(existing.id, nativeTranscript.messages[0]!.content, 'web-observed')
        store.sessions.setSessionActive(existing.id, true, Date.now(), 'default')
        const rejectingEngine = {
            ...engine,
            applySessionConfig: async () => {
                throw new Error('runtime rejected config')
            }
        } as unknown as SyncEngine

        const result = await importClaudeSession({
            store,
            engine: rejectingEngine,
            namespace: 'default',
            machine: machine(),
            transcript: nativeTranscript,
            launchSettings: { model: 'new-model', effort: 'high', permissionMode: 'bypassPermissions' }
        })

        expect(result.error).toEqual({ code: 'session_config_failed', message: 'runtime rejected config' })
        expect(store.sessions.getSession(existing.id)).toMatchObject({ model: 'old-model', effort: 'low' })
        expect(store.sessions.getSession(existing.id)?.metadata).not.toMatchObject({
            preferredPermissionMode: 'bypassPermissions'
        })
    })

    it('marks rewritten imported history as diverged', async () => {
        const { store, engine } = setup()
        const initial = await importClaudeSession({
            store,
            engine,
            namespace: 'default',
            machine: machine(),
            transcript: transcript('native-1', ['one'])
        })
        const rewritten = await importClaudeSession({
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
