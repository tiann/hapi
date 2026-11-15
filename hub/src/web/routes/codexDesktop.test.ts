import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { Store } from '../../store'
import { SyncEngine, type Machine } from '../../sync/syncEngine'
import { RpcRegistry } from '../../socket/rpcRegistry'
import type { WebAppEnv } from '../middleware/auth'
import { createCodexDesktopRoutes, getDarwinCodexOpenArgs, importSelectedCodexSessions, type CodexImportedMessageContent } from './codexDesktop'

const originalCodexHome = process.env.CODEX_HOME

function createMachine(id: string, workspaceRoots: string[], namespace = 'default'): Machine {
    return {
        id,
        namespace,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: {
            host: id,
            platform: 'linux',
            happyCliVersion: '0.0.0-test',
            workspaceRoots
        },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1
    }
}

function createImportSyncEngine(store: Store, machines: Machine[], transcripts?: () => unknown[]): SyncEngine {
    const engine = {
        getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => (
            machine.namespace === namespace && machine.active
        )),
        getSessionsByNamespace: (namespace: string) => (
            store.sessions.getSessionsByNamespace(namespace) as unknown as ReturnType<SyncEngine['getSessionsByNamespace']>
        ),
        getOrCreateSession: (
            tag: string,
            metadata: unknown,
            agentState: unknown,
            namespace: string
        ) => (
            store.sessions.getOrCreateSession(tag, metadata, agentState, namespace) as unknown as ReturnType<SyncEngine['getOrCreateSession']>
        ),
        handleRealtimeEvent: () => {},
        recordSessionActivity: (sessionId: string, updatedAt: number) => {
            store.sessions.touchSessionUpdatedAt(sessionId, updatedAt, 'default')
        }
    } as unknown as SyncEngine
    return transcripts ? withLegacyCodexSessions(engine, transcripts) : engine
}

/**
 * Serve the legacy ListCodexSessions RPC from the given provider: the
 * pre-registry wire shape the hub consumes through the source descriptor's
 * legacy fallback (summaries for list calls, transcripts for id fetches).
 */
function withLegacyCodexSessions(engine: SyncEngine, provider: () => unknown[]): SyncEngine {
    ;(engine as unknown as Record<string, unknown>).listCodexSessionsForMachine = async (_machineId: string, _cwd: unknown, sessionIds?: string[] | null) => {
        const wanted = sessionIds?.length ? new Set(sessionIds) : null
        const sessions = provider()
            .filter((session): session is Record<string, unknown> => session !== null && typeof session === 'object')
            .filter((session) => !wanted || wanted.has(session.id as string))
        return {
            success: true,
            sessions: wanted
                ? sessions
                : sessions.map((session) => ({ ...session, messages: undefined }))
        }
    }
    return engine
}

function codexUserMessage(text: string) {
    return {
        role: 'user',
        content: { type: 'text', text },
        meta: { sentFrom: 'cli' }
    } as const
}

function codexAgentMessage(message: string, id = 'assistant-1') {
    return {
        role: 'agent',
        content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'message', message, id } },
        meta: { sentFrom: 'cli' }
    } as const
}

/** Commit-3 runner fixture: the transcript rows ListLocalSessions delivers. */
function codexThreadFixture(id: string, messages: CodexImportedMessageContent[], overrides: {
    title?: string
    cwd?: string
} = {}) {
    return {
        id,
        title: overrides.title ?? `Codex thread ${id}`,
        cwd: overrides.cwd ?? 'C:\\work\\project',
        file: `rollout-${id}.jsonl`,
        modifiedAt: 1,
        messages
    }
}

function createRoutesApp(namespace: string): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        await next()
    })
    app.route('/api', createCodexDesktopRoutes({
        store: new Store(':memory:'),
        getSyncEngine: () => null
    }))
    return app
}

describe('Codex Desktop import routes', () => {
    afterEach(() => {
        if (originalCodexHome === undefined) {
            delete process.env.CODEX_HOME
        } else {
            process.env.CODEX_HOME = originalCodexHome
        }
    })

    it('imports normal response_item chat messages', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        const codexSessionId = '11111111-1111-4111-8111-111111111111'

        try {
            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => withLegacyCodexSessions(engine, () => [codexThreadFixture(codexSessionId, [ codexUserMessage('normal user message'), codexAgentMessage('normal assistant message', 'assistant-1') ])]),
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session).toBeDefined()
            expect(engine.getSession(session.id)?.hasConversationContent).toBe(true)
            const messages = store.messages.getAllMessages(session.id)
            expect(messages).toHaveLength(2)
            expect(messages[0].content).toEqual({
                role: 'user',
                content: {
                    type: 'text',
                    text: 'normal user message'
                },
                meta: {
                    sentFrom: 'cli'
                }
            })
            expect(messages[1].content).toEqual({
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'message',
                        message: 'normal assistant message',
                        id: expect.any(String)
                    }
                },
                meta: {
                    sentFrom: 'cli'
                }
            })
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('refuses a transcript import for an active Codex thread when stored messages do not match its prefix', async () => {
        const store = new Store(':memory:')
        const codexSessionId = '10101010-1010-4010-8010-101010101010'

        try {
            const liveSession = store.sessions.getOrCreateSession('live-session', {
                path: 'C:\\work\\project',
                flavor: 'codex',
                codexSessionId
            }, {}, 'default')
            store.messages.addMessage(liveSession.id, {
                role: 'user',
                content: { type: 'text', text: 'different from the transcript' }
            }, 'live-1')
            const engine = {
                getSessionsByNamespace: () => [{ ...liveSession, active: true }]
            } as unknown as SyncEngine

            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => withLegacyCodexSessions(engine, () => [codexThreadFixture(codexSessionId, [ codexUserMessage('normal user message'), codexAgentMessage('normal assistant message') ])]),
            })

            expect(result.success).toBe(false)
            if (result.success) throw new Error('Expected active-session transcript import to fail')
            expect(result.error).toContain('matching HAPI session is active')
            expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(1)
            expect(store.messages.getAllMessages(liveSession.id)).toHaveLength(1)
        } finally {
            store.close()
        }
    })

    it('updates an existing forked import when syncing the original Codex session id', async () => {
        const store = new Store(':memory:')
        const codexSessionId = '12121212-1212-4121-8121-121212121212'

        try {
            const first = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => createImportSyncEngine(store, [], () => [codexThreadFixture(codexSessionId, [ codexUserMessage('normal user message'), codexAgentMessage('normal assistant message') ])]),
            })
            expect(first.success).toBe(true)

            const imported = store.sessions.getSessionsByNamespace('default')[0]
            expect(imported).toBeDefined()
            store.sessions.updateSessionMetadata(imported.id, {
                ...(imported.metadata ?? {}),
                codexSessionId: 'fork-session-id',
                codexSourceSessionId: codexSessionId
            }, imported.metadataVersion, 'default')

            const second = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => createImportSyncEngine(store, [], () => [codexThreadFixture(codexSessionId, [ codexUserMessage('normal user message'), codexAgentMessage('normal assistant message') ])]),
            })

            expect(second.success).toBe(true)
            const sessions = store.sessions.getSessionsByNamespace('default')
            expect(sessions).toHaveLength(1)
            expect(sessions[0]?.metadata).toMatchObject({
                codexSessionId: 'fork-session-id',
                codexSourceSessionId: codexSessionId
            })
        } finally {
            store.close()
        }
    })

    it('deduplicates mirrored event_msg and response_item user messages', async () => {
        const store = new Store(':memory:')
        const codexSessionId = '66666666-6666-4666-8666-666666666666'

        try {
            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => createImportSyncEngine(store, [], () => [codexThreadFixture(codexSessionId, [ codexUserMessage('mirrored user message') ])]),
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session).toBeDefined()
            const messages = store.messages.getAllMessages(session.id)
            expect(messages).toHaveLength(1)
            expect(messages[0].content).toEqual({
                role: 'user',
                content: {
                    type: 'text',
                    text: 'mirrored user message'
                },
                meta: {
                    sentFrom: 'cli'
                }
            })
        } finally {
            store.close()
        }
    })

    it('deduplicates adjacent mirrored agent messages with different ids', async () => {
        const store = new Store(':memory:')
        const codexSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

        try {
            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => createImportSyncEngine(store, [], () => [codexThreadFixture(codexSessionId, [ codexAgentMessage('duplicated assistant message', 'event-msg-id') ])]),
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session).toBeDefined()
            const messages = store.messages.getAllMessages(session.id)
            expect(messages).toHaveLength(1)
            expect(messages[0].content).toEqual({
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'message',
                        message: 'duplicated assistant message',
                        id: expect.any(String)
                    }
                },
                meta: {
                    sentFrom: 'cli'
                }
            })
        } finally {
            store.close()
        }
    })

    it('skips injected response_item user context messages', async () => {
        const store = new Store(':memory:')
        const codexSessionId = '88888888-8888-4888-8888-888888888888'

        try {
            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => createImportSyncEngine(store, [], () => [codexThreadFixture(codexSessionId, [ codexUserMessage('real event user message') ])]),
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session).toBeDefined()
            const messages = store.messages.getAllMessages(session.id)
            expect(messages).toHaveLength(1)
            expect(messages[0].content).toEqual({
                role: 'user',
                content: {
                    type: 'text',
                    text: 'real event user message'
                },
                meta: {
                    sentFrom: 'cli'
                }
            })
        } finally {
            store.close()
        }
    })

    it('preserves a real response_item user prompt containing embedded environment_context text', async () => {
        const store = new Store(':memory:')
        const codexSessionId = 'abababab-abab-4bab-8bab-abababababab'

        try {
            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => createImportSyncEngine(store, [], () => [codexThreadFixture(codexSessionId, [ codexUserMessage('Please inspect this transcript block:\n<environment_context>\n<current_date>2026-07-07</current_date>\n</environment_context>\nThis is part of my prompt.') ])]),
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session).toBeDefined()
            const messages = store.messages.getAllMessages(session.id)
            expect(messages).toHaveLength(1)
            expect(messages[0].content).toMatchObject({
                role: 'user',
                content: {
                    type: 'text',
                    text: expect.stringContaining('<environment_context>')
                }
            })
        } finally {
            store.close()
        }
    })

    it('preserves adjacent duplicate messages from the same transcript source', async () => {
        const store = new Store(':memory:')
        const codexSessionId = 'babababa-baba-4aba-8aba-babababababa'

        try {
            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => createImportSyncEngine(store, [], () => [codexThreadFixture(codexSessionId, [ codexUserMessage('same source user message'), codexUserMessage('same source user message'), codexAgentMessage('same source assistant message', 'assistant-1'), codexAgentMessage('same source assistant message', 'assistant-2') ])]),
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session).toBeDefined()
            const messages = store.messages.getAllMessages(session.id)
            expect(messages).toHaveLength(4)
            expect(messages.map((message) => (message.content as { role?: unknown }).role)).toEqual([
                'user',
                'user',
                'agent',
                'agent'
            ])
        } finally {
            store.close()
        }
    })

    it('keeps a later response_item-only user turn with the same text', async () => {
        const store = new Store(':memory:')
        const codexSessionId = '99999999-9999-4999-8999-999999999999'

        try {
            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => createImportSyncEngine(store, [], () => [codexThreadFixture(codexSessionId, [ codexUserMessage('repeat user message'), codexAgentMessage('assistant answer'), codexUserMessage('repeat user message') ])]),
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session).toBeDefined()
            const messages = store.messages.getAllMessages(session.id)
            const roles = messages.map((message) => (message.content as { role?: unknown }).role)
            expect(roles).toEqual(['user', 'agent', 'user'])
            expect(messages[0].content).toMatchObject({
                role: 'user',
                content: {
                    type: 'text',
                    text: 'repeat user message'
                }
            })
            expect(messages[2].content).toMatchObject({
                role: 'user',
                content: {
                    type: 'text',
                    text: 'repeat user message'
                }
            })
        } finally {
            store.close()
        }
    })

    it('keeps distinct user turns while deduplicating mirrored user events', async () => {
        const store = new Store(':memory:')
        const codexSessionId = '77777777-7777-4777-8777-777777777777'

        try {
            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => createImportSyncEngine(store, [], () => [codexThreadFixture(codexSessionId, [ codexUserMessage('first user message'), codexUserMessage('second user message') ])]),
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session).toBeDefined()
            const messages = store.messages.getAllMessages(session.id)
            expect(messages).toHaveLength(2)
            expect(messages.map((message) => message.content)).toEqual([
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: 'first user message'
                    },
                    meta: {
                        sentFrom: 'cli'
                    }
                },
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: 'second user message'
                    },
                    meta: {
                        sentFrom: 'cli'
                    }
                }
            ])
        } finally {
            store.close()
        }
    })

    it('uses the runner-resolved thread title for the imported session name', async () => {
        const store = new Store(':memory:')
        const codexSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

        try {
            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => createImportSyncEngine(store, [], () => [codexThreadFixture(codexSessionId, [ codexUserMessage('normal user message'), codexAgentMessage('normal assistant message') ], { title: 'new thread title' })]),
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session.metadata).toMatchObject({
                name: 'new thread title',
                flavor: 'codex',
                codexSessionId
            })
        } finally {
            store.close()
        }
    })

    it('uses the transcript-derived title when the runner sends no thread name override', async () => {
        const store = new Store(':memory:')
        const codexSessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

        try {
            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => createImportSyncEngine(store, [], () => [codexThreadFixture(codexSessionId, [ codexUserMessage('normal user message'), codexAgentMessage('normal assistant message') ], { title: 'normal user message' })]),
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session.metadata).toMatchObject({
                name: 'normal user message',
                flavor: 'codex',
                codexSessionId
            })
        } finally {
            store.close()
        }
    })

    it('uses the fixture title when the runner index has no entry for the thread', async () => {
        const store = new Store(':memory:')
        const codexSessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

        try {
            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => createImportSyncEngine(store, [], () => [codexThreadFixture(codexSessionId, [ codexUserMessage('normal user message'), codexAgentMessage('normal assistant message') ], { title: 'normal user message' })]),
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session.metadata).toMatchObject({
                name: 'normal user message',
                flavor: 'codex',
                codexSessionId
            })
        } finally {
            store.close()
        }
    })

    it('applies selected Standard and Plan config before an imported session is resumed', async () => {
        const store = new Store(':memory:')
        const codexSessionId = '23232323-2323-4232-8232-232323232323'
        const engine = createImportSyncEngine(store, [
            createMachine('machine-1', ['/home/user/workspace'])
        ])
        const applied: Array<{ sessionId: string; config: unknown }> = []
        ;(engine as unknown as { applySessionConfig: (sessionId: string, config: unknown) => Promise<void> }).applySessionConfig = async (sessionId, config) => {
            applied.push({ sessionId, config })
        }

        try {
            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => withLegacyCodexSessions(engine, () => [codexThreadFixture(codexSessionId, [ codexUserMessage('normal user message'), codexAgentMessage('normal assistant message') ], { cwd: '/home/user/workspace/project' })]),
                serviceTier: 'standard',
                collaborationMode: 'plan',
            })

            expect(result.success).toBe(true)
            const importedSessionId = result.success ? result.hapiSessionIds?.[0] : undefined
            expect(importedSessionId).toBeDefined()
            if (!importedSessionId) {
                throw new Error('Imported session id missing')
            }
            expect(applied).toEqual([{
                sessionId: importedSessionId,
                config: { serviceTier: 'standard', collaborationMode: 'plan' }
            }])
        } finally {
            store.close()
        }
    })

    it('binds the sync to the unique online machine that owns the cwd', async () => {
        const store = new Store(':memory:')
        const codexSessionId = '22222222-2222-4222-8222-222222222222'
        const engine = createImportSyncEngine(store, [
            createMachine('machine-1', ['/home/user/workspace']),
            createMachine('machine-2', ['/other/workspace'])
        ])
        const listCalls: Array<{ machineId: string; cwd: string | null }> = []
        ;(engine as unknown as { listCodexSessionsForMachine: unknown }).listCodexSessionsForMachine = async (machineId: string, cwd: string | null) => {
            listCalls.push({ machineId, cwd })
            return {
                success: true,
                sessions: [codexThreadFixture(codexSessionId, [
                    codexUserMessage('normal user message'),
                    codexAgentMessage('normal assistant message')
                ], { cwd: '/home/user/workspace/project' })]
            }
        }
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createCodexDesktopRoutes({ store, getSyncEngine: () => engine }))

        try {
            const response = await app.request('/api/codex/sync-session', {
                method: 'POST',
                body: JSON.stringify({ sessionIds: [codexSessionId], cwd: '/home/user/workspace/project' })
            })
            const body = await response.json() as { success: boolean }
            expect(body.success).toBe(true)
            expect(listCalls).toEqual([{ machineId: 'machine-1', cwd: '/home/user/workspace/project' }])
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session.metadata).toMatchObject({
                path: '/home/user/workspace/project',
                machineId: 'machine-1'
            })
        } finally {
            store.close()
        }
    })

    it('syncs through the first online machine when several machines own the cwd', async () => {
        const store = new Store(':memory:')
        const codexSessionId = '33333333-3333-4333-8333-333333333333'
        const engine = createImportSyncEngine(store, [
            createMachine('machine-1', ['/home/user/workspace']),
            createMachine('machine-2', ['/home/user/workspace/project'])
        ])
        const listCalls: string[] = []
        ;(engine as unknown as { listCodexSessionsForMachine: unknown }).listCodexSessionsForMachine = async (machineId: string) => {
            listCalls.push(machineId)
            return {
                success: true,
                sessions: [codexThreadFixture(codexSessionId, [
                    codexUserMessage('normal user message'),
                    codexAgentMessage('normal assistant message')
                ], { cwd: '/home/user/workspace/project' })]
            }
        }
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createCodexDesktopRoutes({ store, getSyncEngine: () => engine }))

        try {
            const response = await app.request('/api/codex/sync-session', {
                method: 'POST',
                body: JSON.stringify({ sessionIds: [codexSessionId], cwd: '/home/user/workspace/project' })
            })
            const body = await response.json() as { success: boolean }
            expect(body.success).toBe(true)
            expect(listCalls).toEqual(['machine-1'])
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session.metadata).toMatchObject({ machineId: 'machine-1' })
        } finally {
            store.close()
        }
    })

    it('syncs through the first online machine when none owns the cwd', async () => {
        const store = new Store(':memory:')
        const codexSessionId = '44444444-4444-4444-8444-444444444444'
        const engine = createImportSyncEngine(store, [
            createMachine('machine-1', ['/home/user/other'])
        ])
        const listCalls: string[] = []
        ;(engine as unknown as { listCodexSessionsForMachine: unknown }).listCodexSessionsForMachine = async (machineId: string) => {
            listCalls.push(machineId)
            return {
                success: true,
                sessions: [codexThreadFixture(codexSessionId, [
                    codexUserMessage('normal user message'),
                    codexAgentMessage('normal assistant message')
                ], { cwd: '/home/user/workspace/project' })]
            }
        }
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createCodexDesktopRoutes({ store, getSyncEngine: () => engine }))

        try {
            const response = await app.request('/api/codex/sync-session', {
                method: 'POST',
                body: JSON.stringify({ sessionIds: [codexSessionId], cwd: '/home/user/workspace/project' })
            })
            const body = await response.json() as { success: boolean }
            expect(body.success).toBe(true)
            expect(listCalls).toEqual(['machine-1'])
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session.metadata).toMatchObject({ machineId: 'machine-1' })
        } finally {
            store.close()
        }
    })

    it('does not append a Runner transcript to a session bound to another machine', async () => {
        const store = new Store(':memory:')
        const codexSessionId = '55555555-5555-4555-8555-555555555555'
        store.sessions.getOrCreateSession(randomUUID(), {
            path: '/home/user/workspace/project',
            flavor: 'codex',
            codexSessionId,
            machineId: 'machine-existing'
        }, {}, 'default')
        const engine = createImportSyncEngine(store, [
            createMachine('machine-new', ['/home/user/workspace'])
        ])

        try {
            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => withLegacyCodexSessions(engine, () => [codexThreadFixture(codexSessionId, [ codexUserMessage('normal user message'), codexAgentMessage('normal assistant message') ], { cwd: '/home/user/workspace/project' })]),
                machineId: 'machine-new',
            })

            expect(result.success).toBe(true)
            const sessions = store.sessions.getSessionsByNamespace('default')
            expect(sessions).toHaveLength(2)
            expect(sessions.some((session) => (
                (session.metadata as Record<string, unknown> | null)?.path === '/home/user/workspace/project'
                && (session.metadata as Record<string, unknown> | null)?.machineId === 'machine-new'
            ))).toBe(true)
            expect(sessions.some((session) => (
                (session.metadata as Record<string, unknown> | null)?.path === '/home/user/workspace/project'
                && (session.metadata as Record<string, unknown> | null)?.machineId === 'machine-existing'
            ))).toBe(true)
        } finally {
            store.close()
        }
    })

    it('rejects Codex desktop sidecar routes outside the default namespace', async () => {
        const app = createRoutesApp('team-a')
        const response = await app.request('/api/codex/status')

        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({
            success: false,
            error: 'Codex transcript import is not available outside the default namespace'
        })

        // Transcript list and sync are available in every namespace.
        const listResponse = await app.request('/api/codex/sessions')
        expect(listResponse.status).toBe(503)
        expect(await listResponse.json()).toMatchObject({
            success: false,
            error: 'No online machine available for Codex history import'
        })
    })

    it('allows Codex transcript endpoints in the default namespace', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-route-test-'))
        process.env.CODEX_HOME = codexHome

        try {
            const app = createRoutesApp('default')
            const response = await app.request('/api/codex/sessions')

            expect(response.status).toBe(503)
            expect(await response.json()).toEqual({
                success: false,
                error: 'No online machine available for Codex history import',
                sessions: []
            })
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('does not fall back to another Runner when the requested machine is offline', async () => {
        const store = new Store(':memory:')
        let listCalls = 0
        const engine = {
            getOnlineMachinesByNamespace: () => [createMachine('online-machine', ['/tmp'])],
            listCodexSessionsForMachine: async () => {
                listCalls += 1
                return { success: true, sessions: [] }
            }
        } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createCodexDesktopRoutes({ store, getSyncEngine: () => engine }))

        try {
            const response = await app.request('/api/codex/sessions?machineId=offline-machine')
            expect(response.status).toBe(503)
            expect(listCalls).toBe(0)
        } finally {
            store.close()
        }
    })

    it('does not append imports to an archived Codex session', async () => {
        const store = new Store(':memory:')
        const codexSessionId = '15151515-1515-4515-8515-151515151515'
        const archived = store.sessions.getOrCreateSession('archived-session', {
            path: 'C:\\work\\project',
            flavor: 'codex',
            codexSessionId,
            lifecycleState: 'archived'
        }, {}, 'default')
        store.messages.addMessage(archived.id, { type: 'text', text: 'archived old message' }, 'archived-1')

        try {
            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => createImportSyncEngine(store, [], () => [codexThreadFixture(codexSessionId, [ codexUserMessage('normal user message'), codexAgentMessage('normal assistant message') ])]),
            })

            expect(result.success).toBe(true)
            const sessions = store.sessions.getSessionsByNamespace('default')
            expect(sessions).toHaveLength(2)
            expect(result.hapiSessionIds?.[0]).not.toBe(archived.id)
            expect(store.messages.getAllMessages(archived.id)).toHaveLength(1)
            expect(store.messages.getAllMessages(result.hapiSessionIds![0]!)).toHaveLength(2)
        } finally {
            store.close()
        }
    })

    it('does not treat one session with duplicate Codex import ids as a duplicate group', async () => {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('imported-session', {
            codexSessionId: 'codex-thread-1',
            codexSourceSessionId: 'codex-thread-1',
            lifecycleState: 'imported'
        }, {}, 'default')
        store.messages.addMessage(session.id, { type: 'text', text: 'imported message' }, 'message-1')
        app.route('/api', createCodexDesktopRoutes({
            store,
            getSyncEngine: () => null
        }))

        try {
            const duplicateResponse = await app.request('/api/codex/duplicate-sessions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionIds: ['codex-thread-1'] })
            })

            expect(duplicateResponse.status).toBe(200)
            const duplicateBody = await duplicateResponse.json() as { success: true; duplicates: unknown[] }
            expect(duplicateBody.success).toBe(true)
            expect(duplicateBody.duplicates).toEqual([])

            const mergeResponse = await app.request('/api/codex/merge-duplicate-sessions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionIds: ['codex-thread-1'] })
            })

            expect(mergeResponse.status).toBe(200)
            const mergeBody = await mergeResponse.json() as { success: true; merged: unknown[]; mergedCount: number }
            expect(mergeBody.success).toBe(true)
            expect(mergeBody.merged).toEqual([])
            expect(mergeBody.mergedCount).toBe(0)
            expect(store.sessions.getSessionByNamespace(session.id, 'default')).toBeDefined()
            expect(store.messages.getAllMessages(session.id)).toHaveLength(1)
        } finally {
            store.close()
        }
    })

    it('does not treat archived Codex sessions as mergeable duplicates', async () => {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        const store = new Store(':memory:')
        const archived = store.sessions.getOrCreateSession('archived-session', {
            codexSessionId: 'codex-thread-1',
            lifecycleState: 'archived'
        }, {}, 'default')
        const imported = store.sessions.getOrCreateSession('imported-session', { codexSessionId: 'codex-thread-1' }, {}, 'default')
        app.route('/api', createCodexDesktopRoutes({
            store,
            getSyncEngine: () => null
        }))

        try {
            const duplicateResponse = await app.request('/api/codex/duplicate-sessions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionIds: ['codex-thread-1'] })
            })

            expect(duplicateResponse.status).toBe(200)
            const duplicateBody = await duplicateResponse.json() as { success: true; duplicates: unknown[] }
            expect(duplicateBody.success).toBe(true)
            expect(duplicateBody.duplicates).toEqual([])

            const mergeResponse = await app.request('/api/codex/merge-duplicate-sessions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionIds: ['codex-thread-1'] })
            })

            expect(mergeResponse.status).toBe(200)
            const mergeBody = await mergeResponse.json() as { success: true; merged: unknown[]; mergedCount: number }
            expect(mergeBody.success).toBe(true)
            expect(mergeBody.merged).toEqual([])
            expect(mergeBody.mergedCount).toBe(0)
            expect(store.sessions.getSessionsByNamespace('default').map((session) => session.id).sort()).toEqual([archived.id, imported.id].sort())
        } finally {
            store.close()
        }
    })

    it('does not treat engine-only sessions as mergeable Codex duplicates', async () => {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        const store = new Store(':memory:')
        const storedSession = store.sessions.getOrCreateSession('stored-session', { codexSessionId: 'codex-thread-1' }, {}, 'default')
        const engineOnlySession = {
            id: 'engine-only-session',
            active: false,
            updatedAt: storedSession.updatedAt + 1,
            metadata: { codexSessionId: 'codex-thread-1' }
        }
        const engine = {
            getSessionsByNamespace: () => [engineOnlySession]
        } as unknown as SyncEngine
        app.route('/api', createCodexDesktopRoutes({
            store,
            getSyncEngine: () => engine
        }))

        try {
            const duplicateResponse = await app.request('/api/codex/duplicate-sessions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionIds: ['codex-thread-1'] })
            })

            expect(duplicateResponse.status).toBe(200)
            const duplicateBody = await duplicateResponse.json() as { success: true; duplicates: unknown[] }
            expect(duplicateBody.success).toBe(true)
            expect(duplicateBody.duplicates).toEqual([])

            const mergeResponse = await app.request('/api/codex/merge-duplicate-sessions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionIds: ['codex-thread-1'] })
            })

            expect(mergeResponse.status).toBe(200)
            const mergeBody = await mergeResponse.json() as { success: true; merged: unknown[]; mergedCount: number }
            expect(mergeBody.success).toBe(true)
            expect(mergeBody.merged).toEqual([])
            expect(mergeBody.mergedCount).toBe(0)
            expect(store.sessions.getSessionsByNamespace('default').map((session) => session.id)).toEqual([storedSession.id])
        } finally {
            store.close()
        }
    })

    it('detects duplicate sessions from both SyncEngine cache and persistent store', async () => {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        const store = new Store(':memory:')
        const storedSession = store.sessions.getOrCreateSession('stored-session', { codexSessionId: 'codex-thread-1' }, {}, 'default')
        const engineSession = store.sessions.getOrCreateSession('engine-session', { codexSessionId: 'codex-thread-1' }, {}, 'default')
        const engine = {
            getSessionsByNamespace: () => [engineSession]
        } as unknown as SyncEngine
        app.route('/api', createCodexDesktopRoutes({
            store,
            getSyncEngine: () => engine
        }))

        try {
            const response = await app.request('/api/codex/duplicate-sessions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionIds: ['codex-thread-1'] })
            })

            expect(response.status).toBe(200)
            const body = await response.json() as { success: true; duplicates: Array<{ codexSessionId: string; hapiSessionIds: string[] }> }
            expect(body.success).toBe(true)
            expect(body.duplicates).toHaveLength(1)
            expect(body.duplicates[0]?.hapiSessionIds.sort()).toEqual([storedSession.id, engineSession.id].sort())
        } finally {
            store.close()
        }
    })

    it('merges duplicate sessions discovered across SyncEngine cache and persistent store', async () => {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        const store = new Store(':memory:')
        const storedSession = store.sessions.getOrCreateSession('stored-session', { codexSessionId: 'codex-thread-1' }, {}, 'default')
        const engineSession = store.sessions.getOrCreateSession('engine-session', { codexSessionId: 'codex-thread-1' }, {}, 'default')
        store.messages.addMessage(storedSession.id, { type: 'text', text: 'first stored message' }, 'stored-1')
        store.messages.addMessage(storedSession.id, { type: 'text', text: 'second stored message' }, 'stored-2')
        store.messages.addMessage(engineSession.id, { type: 'text', text: 'engine-only message' }, 'engine-1')
        const engine = {
            getSessionsByNamespace: () => [engineSession],
            transferAttachedJobs: (fromSessionId: string, toSessionId: string) => {
                store.sessionJobs.transfer(fromSessionId, toSessionId)
            },
            deleteSession: async (sessionId: string) => {
                store.sessions.deleteSession(sessionId, 'default')
            },
            handleRealtimeEvent: () => {},
            recordSessionActivity: (sessionId: string, updatedAt: number) => {
                store.sessions.touchSessionUpdatedAt(sessionId, updatedAt, 'default')
            }
        } as unknown as SyncEngine
        app.route('/api', createCodexDesktopRoutes({
            store,
            getSyncEngine: () => engine
        }))

        try {
            const response = await app.request('/api/codex/merge-duplicate-sessions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionIds: ['codex-thread-1'] })
            })

            expect(response.status).toBe(200)
            const body = await response.json() as { success: true; merged: Array<{ canonicalSessionId?: string; removedSessionIds?: string[] }> }
            expect(body.success).toBe(true)
            expect(body.merged[0]?.canonicalSessionId).toBe(storedSession.id)
            expect(body.merged[0]?.removedSessionIds).toEqual([engineSession.id])
            const sessions = store.sessions.getSessionsByNamespace('default')
            expect(sessions.map((session) => session.id)).toEqual([storedSession.id])
            expect(store.messages.getAllMessages(storedSession.id)).toHaveLength(3)
        } finally {
            store.close()
        }
    })

    it('defers no-engine merge when the source still has attached jobs', async () => {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        const store = new Store(':memory:')
        const canonical = store.sessions.getOrCreateSession(
            'canonical-with-history',
            { codexSessionId: 'codex-thread-jobs' },
            {},
            'default'
        )
        const source = store.sessions.getOrCreateSession(
            'source-with-job',
            { codexSessionId: 'codex-thread-jobs' },
            {},
            'default'
        )
        store.messages.addMessage(canonical.id, { type: 'text', text: 'keep me canonical' }, 'canon-1')
        const upserted = store.sessionJobs.upsert(source.id, 'beets', {
            label: 'beets import',
            status: 'running',
            remaining: 5
        })
        expect(upserted.outcome).toBe('upserted')

        app.route('/api', createCodexDesktopRoutes({
            store,
            getSyncEngine: () => null
        }))

        try {
            const response = await app.request('/api/codex/merge-duplicate-sessions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionIds: ['codex-thread-jobs'] })
            })
            expect(response.status).toBe(200)
            const body = await response.json() as { success: false; error: string }
            expect(body.success).toBe(false)
            expect(body.error).toMatch(/attached-job redirects/i)
            expect(store.sessions.getSessionByNamespace(source.id, 'default')).not.toBeNull()
            expect(store.sessions.getSessionByNamespace(canonical.id, 'default')).not.toBeNull()
            expect(store.sessionJobs.getPrimaryRunning(source.id)?.key).toBe('beets')
        } finally {
            store.close()
        }
    })

    it('treats source and fork ids as the same duplicate-sessions group', async () => {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        const store = new Store(':memory:')
        const forkSession = store.sessions.getOrCreateSession('fork-session-id', { codexSessionId: 'fork-session-id', codexSourceSessionId: 'original-session-id' }, {}, 'default')
        const dupSession = store.sessions.getOrCreateSession('dup-session-id', { codexSessionId: 'original-session-id' }, {}, 'default')
        app.route('/api', createCodexDesktopRoutes({
            store,
            getSyncEngine: () => null
        }))

        const response = await app.request('/api/codex/duplicate-sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionIds: ['original-session-id'] })
        })

        expect(response.status).toBe(200)
        const body = await response.json() as { success: true; duplicates: Array<{ codexSessionId: string; hapiSessionIds: string[] }> }
        expect(body.success).toBe(true)
        expect(body.duplicates).toHaveLength(1)
        expect(body.duplicates[0]?.codexSessionId).toBe('original-session-id')
        expect(body.duplicates[0]?.hapiSessionIds.sort()).toEqual([dupSession.id, forkSession.id].sort())
    })
})

describe('Codex Desktop restart helpers', () => {
    it('opens a concrete macOS app bundle path directly', () => {
        expect(getDarwinCodexOpenArgs('/Applications/Codex.app')).toEqual(['/Applications/Codex.app'])
    })

    it('uses open -a for a macOS application name', () => {
        expect(getDarwinCodexOpenArgs('Codex')).toEqual(['-a', 'Codex'])
    })
})
