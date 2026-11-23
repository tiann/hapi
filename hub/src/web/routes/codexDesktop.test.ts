import { afterEach, describe, expect, it } from 'bun:test'
import type { Database } from 'bun:sqlite'
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
        reconcileNotifySignalAfterImport: () => {},
        reconcileNotifyAcrossDuplicateSessions: () => {},
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
            expect(engine.getSession(session.id)?.metadata?.codexImportedAt).toEqual(expect.any(Number))
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

    it('does not duplicate a prompt that the live projection and the importer both hold', async () => {
        // The live Codex projection and the Desktop importer mirror the same
        // prompt under two different local ids. Keying on the native
        // transcript id treated those as distinct occurrences and appended the
        // imported copy a second time — and that copy's later timestamp let
        // reconciliation read an initiating prompt as an answer and clear an
        // unanswered blocker. One event, one row: occurrences are aligned by
        // position among rows that share a key, so a mirror is not surplus.
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        const store = new Store(':memory:')
        const canonical = store.sessions.getOrCreateSession(
            'canon-mirror', { codexSessionId: 'codex-thread-12' }, {}, 'default'
        )
        const duplicate = store.sessions.getOrCreateSession(
            'dup-mirror', { codexSessionId: 'codex-thread-12' }, {}, 'default'
        )
        const base = Date.now() - 600_000

        // Canonical holds filler plus the live projection's copy of the prompt.
        for (let i = 0; i < 4; i++) {
            store.messages.addImportedMessage(canonical.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: { type: 'assistant', message: { content: [{ type: 'text', text: `filler ${i}` }] } }
                }
            }, `mirror-filler-${i}`, base)
        }
        store.messages.addMessage(canonical.id, {
            role: 'user', content: { type: 'text', text: 'Continue' }, meta: { sentFrom: 'webapp' }
        }, 'live-projection-id', null, base + 1_000, base + 1_000)
        store.messages.markMessagesInvoked(canonical.id, ['live-projection-id'], base + 2_000)

        // The duplicate holds the SAME event under the importer's id, with the
        // same delivery time — one prompt, mirrored.
        store.messages.addMessage(duplicate.id, {
            role: 'user', content: { type: 'text', text: 'Continue' }, meta: { sentFrom: 'webapp' }
        }, 'importer-id', null, base + 1_000, base + 1_000)
        store.messages.markMessagesInvoked(duplicate.id, ['importer-id'], base + 2_000)

        const engine = {
            getSessionsByNamespace: () => [],
            transferBlockedAck: () => {},
            transferAttachedJobs: () => {},
            deleteSession: async (sessionId: string) => {
                store.sessions.deleteSession(sessionId, 'default')
            },
            handleRealtimeEvent: () => {},
            reconcileNotifySignalAfterImport: () => {},
            reconcileNotifyAcrossDuplicateSessions: () => {},
            recordSessionActivity: () => {}
        } as unknown as SyncEngine
        app.route('/api', createCodexDesktopRoutes({ store, getSyncEngine: () => engine }))

        try {
            const response = await app.request('/api/codex/merge-duplicate-sessions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionIds: ['codex-thread-12'] })
            })
            expect(response.status).toBe(200)
            const body = await response.json() as { merged: Array<{ canonicalSessionId?: string }> }
            const survivorId = body.merged[0]?.canonicalSessionId
            expect(survivorId).toBe(canonical.id)

            const prompts = store.messages.getAllMessages(survivorId!)
                .filter((row) => JSON.stringify(row.content).includes('Continue'))
            expect(prompts).toHaveLength(1)
        } finally {
            store.close()
        }
    })


    it('remaps a dismissed source footer\'s key to the surviving occurrence\'s own timestamp (cold-review round 25)', async () => {
        // An untimestamped Codex footer can carry a DIFFERENT `createdAt` in
        // two projections of the same thread. When the merge deduplicates
        // that footer — the survivor already has a matching occurrence, so
        // the duplicate's copy is dropped, not appended — the survivor KEEPS
        // its own `createdAt`. `transferBlockedAck` used to copy the
        // source's `notify:<its own createdAt>` key unchanged, which no
        // longer matches the surviving row at all: the operator's dismissal
        // silently stopped applying and the acknowledged blocker reappeared.
        const { SyncEngine } = await import('../../sync/syncEngine')
        const { RpcRegistry } = await import('../../socket/rpcRegistry')
        const { notifyBlockerKey } = await import('@hapi/protocol')
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const canonical = store.sessions.getOrCreateSession(
            'canon-footer-remap', { codexSessionId: 'codex-thread-25b', path: '/tmp', host: 'h' }, {}, 'default'
        )
        const duplicate = store.sessions.getOrCreateSession(
            'dup-footer-remap', { codexSessionId: 'codex-thread-25b', path: '/tmp', host: 'h' }, {}, 'default'
        )
        const base = Date.now() - 600_000
        const footerText = 'Stuck.\n\nAGENT_NOTIFY_SUMMARY '
            + JSON.stringify({ version: 1, status: 'blocked', summary: 'needs creds' })

        // Survivor: padding so it wins canonical selection, then its OWN
        // projection of the footer — a different `createdAt` than the
        // duplicate's copy of the same event.
        for (let i = 0; i < 6; i++) {
            store.messages.addImportedMessage(canonical.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: { type: 'assistant', message: { content: [{ type: 'text', text: `pad ${i}` }] } }
                }
            }, `remap-pad-${i}`, base)
        }
        store.messages.addImportedMessage(canonical.id, {
            role: 'agent',
            content: { type: 'output', data: { type: 'assistant', message: { content: [{ type: 'text', text: footerText }] } } }
        }, 'remap-canonical-footer', base + 5_000)

        // Duplicate: its OWN projection of the SAME footer, a different
        // `createdAt` — and the operator already dismissed THIS occurrence.
        store.messages.addImportedMessage(duplicate.id, {
            role: 'agent',
            content: { type: 'output', data: { type: 'assistant', message: { content: [{ type: 'text', text: footerText }] } } }
        }, 'remap-duplicate-footer', base + 1_000)
        store.sessions.setSessionBlockedAck(duplicate.id, {
            at: base + 1_000,
            reason: 'handled',
            keys: [notifyBlockerKey(base + 1_000)]
        }, 'default')

        app.route('/api', createCodexDesktopRoutes({ store, getSyncEngine: () => engine }))
        try {
            const response = await app.request('/api/codex/merge-duplicate-sessions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionIds: ['codex-thread-25b'] })
            })
            expect(response.status).toBe(200)

            const footers = store.messages.getAllMessages(canonical.id)
                .filter((row) => JSON.stringify(row.content).includes('AGENT_NOTIFY_SUMMARY'))
            // One footer — the duplicate's copy was deduplicated, not
            // appended — and it kept the SURVIVOR's own createdAt.
            expect(footers).toHaveLength(1)
            expect(footers[0]!.createdAt).toBe(base + 5_000)

            const merged = store.sessions.getSessionByNamespace(canonical.id, 'default')
            // The transferred dismissal is keyed to the row that actually
            // survives, not the raw key the duplicate carried.
            expect(merged?.blockedAckKeys).toContain(notifyBlockerKey(base + 5_000))
            expect(merged?.blockedAckKeys).not.toContain(notifyBlockerKey(base + 1_000))
        } finally {
            store.close()
        }
    })

    it('does not let an untimestamped Desktop import outrank a live session that already answered the exact same footer (#1717)', async () => {
        // Every row of a genuinely untimestamped Codex Desktop import batch
        // is stamped with THAT import's own wall-clock moment
        // (`importLocalTranscript.ts`'s `message.createdAt ?? importedAt`
        // fallback) — which necessarily lands after whatever a live session
        // did in the past, regardless of which one is conversationally more
        // current. Picking "whichever footer's raw timestamp is latest"
        // across sessions would always let a stale, already-answered
        // import's footer win over a live session that resolved the exact
        // same blocker, purely because importing happens later in
        // wall-clock terms than the original conversation did.
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const live = store.sessions.getOrCreateSession(
            'live-answered', { codexSessionId: 'codex-thread-untimestamped', path: '/tmp', host: 'h' }, {}, 'default'
        )
        const stale = store.sessions.getOrCreateSession(
            'stale-import', { codexSessionId: 'codex-thread-untimestamped', path: '/tmp', host: 'h' }, {}, 'default'
        )
        const base = Date.now() - 600_000
        const footerText = 'Stuck.\n\nAGENT_NOTIFY_SUMMARY '
            + JSON.stringify({ version: 1, status: 'blocked', summary: 'needs creds' })

        // Live session: padding (wins canonical selection), the footer, then
        // a REAL reply that answers it — all genuinely timestamped, in the
        // past.
        for (let i = 0; i < 6; i++) {
            store.messages.addImportedMessage(live.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: { type: 'assistant', message: { content: [{ type: 'text', text: `pad ${i}` }] } }
                }
            }, `untimestamped-pad-${i}`, base)
        }
        store.messages.addMessage(live.id, {
            role: 'agent',
            content: { type: 'output', data: { type: 'assistant', message: { content: [{ type: 'text', text: footerText }] } } }
        }, undefined, null, base + 1_000, base + 1_000)
        store.messages.addMessage(live.id, {
            role: 'user', content: { type: 'text', text: 'Continue' }, meta: { sentFrom: 'webapp' }
        }, 'untimestamped-live-reply', null, base + 1_500, base + 1_500)
        store.messages.markMessagesInvoked(live.id, ['untimestamped-live-reply'], base + 2_000)

        // Stale import: its OWN projection of the SAME footer, with no
        // explicit timestamp of its own — exactly like a real Codex
        // transcript, which carries none — so it is stamped with the
        // import's own `Date.now()`, necessarily after `base`.
        store.messages.addImportedMessage(stale.id, {
            role: 'agent',
            content: { type: 'output', data: { type: 'assistant', message: { content: [{ type: 'text', text: footerText }] } } }
        }, 'untimestamped-import-footer', Date.now())

        app.route('/api', createCodexDesktopRoutes({ store, getSyncEngine: () => engine }))

        try {
            const response = await app.request('/api/codex/merge-duplicate-sessions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionIds: ['codex-thread-untimestamped'] })
            })
            expect(response.status).toBe(200)
            const body = await response.json() as { merged: Array<{ canonicalSessionId?: string }> }
            const survivorId = body.merged[0]?.canonicalSessionId
            expect(survivorId).toBe(live.id)

            const merged = store.sessions.getSessionByNamespace(survivorId!, 'default')
            // The live session's own already-answered state wins — the
            // import's later wall-clock stamp never gets to compare against
            // it at all.
            expect(merged?.lastNotifyStatus).toBeNull()
        } finally {
            store.close()
        }
    })

    it('remaps a LATER dismissal onto the representative the deterministic session order picks, across a THREE-session merge (#1717)', async () => {
        // Neither duplicate's footer is answered anywhere, so the overall
        // status is unambiguously blocked either way — what's under test is
        // which occurrence becomes the session-level REPRESENTATIVE (and so
        // which key a dismissal needs to end up matching). Picking "whichever
        // footer's raw timestamp is latest" is unsound here: a Codex Desktop
        // import carries no per-row timestamp at all, so `base + 1_000` and
        // `base + 2_000` reflect nothing but each duplicate's own import
        // batch stamp, not which one is conversationally more current. The
        // representative is instead the first survivor in the SAME
        // deterministic order the merge sorts sessions into for canonical
        // selection — which also means the second duplicate's dismissal,
        // keyed to its own (losing) occurrence, needs the remap to keep
        // applying.
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const canonical = store.sessions.getOrCreateSession(
            'tri-copy-canon', { codexSessionId: 'codex-thread-26b', path: '/tmp', host: 'h' }, {}, 'default'
        )
        const firstDup = store.sessions.getOrCreateSession(
            'tri-copy-first', { codexSessionId: 'codex-thread-26b', path: '/tmp', host: 'h' }, {}, 'default'
        )
        const secondDup = store.sessions.getOrCreateSession(
            'tri-copy-second', { codexSessionId: 'codex-thread-26b', path: '/tmp', host: 'h' }, {}, 'default'
        )
        const base = Date.now() - 600_000
        const footerText = 'Stuck.\n\nAGENT_NOTIFY_SUMMARY '
            + JSON.stringify({ version: 1, status: 'blocked', summary: 'needs creds' })

        // Duplicates with an equal message count (one footer each) process
        // in DESCENDING `updatedAt` order — pinned explicitly, to values
        // AHEAD of real `Date.now()` since `touchSessionUpdatedAt` is
        // monotonic and both sessions' creation-time `updatedAt` already sit
        // at real "now". Pinning so which duplicate supplies the copy and
        // which supplies the dismissal does not depend on wall-clock timing
        // between the two `getOrCreateSession` calls above.
        store.sessions.touchSessionUpdatedAt(firstDup.id, Date.now() + 10_000, 'default')
        store.sessions.touchSessionUpdatedAt(secondDup.id, Date.now() + 5_000, 'default')

        // Survivor: padding only, no footer of its own — the footer must be
        // COPIED from a duplicate, not matched against an existing row.
        for (let i = 0; i < 6; i++) {
            store.messages.addImportedMessage(canonical.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: { type: 'assistant', message: { content: [{ type: 'text', text: `pad ${i}` }] } }
                }
            }, `tri-copy-pad-${i}`, base)
        }

        // First duplicate: processed first (newer `updatedAt`), supplies the
        // footer genuinely new to canonical — goes through the COPY path.
        store.messages.addImportedMessage(firstDup.id, {
            role: 'agent',
            content: { type: 'output', data: { type: 'assistant', message: { content: [{ type: 'text', text: footerText }] } } }
        }, 'tri-copy-first-footer', base + 1_000)

        // Second duplicate: its OWN projection of the SAME footer, a
        // different `createdAt` — and the operator already dismissed THIS
        // occurrence. Processed after the first, so it lands in the
        // deduplicate branch once the copy above makes room for it.
        store.messages.addImportedMessage(secondDup.id, {
            role: 'agent',
            content: { type: 'output', data: { type: 'assistant', message: { content: [{ type: 'text', text: footerText }] } } }
        }, 'tri-copy-second-footer', base + 2_000)
        const { notifyBlockerKey } = await import('@hapi/protocol')
        store.sessions.setSessionBlockedAck(secondDup.id, {
            at: base + 2_000,
            reason: 'handled',
            keys: [notifyBlockerKey(base + 2_000)]
        }, 'default')

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createCodexDesktopRoutes({ store, getSyncEngine: () => engine }))

        try {
            const response = await app.request('/api/codex/merge-duplicate-sessions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionIds: ['codex-thread-26b'] })
            })
            expect(response.status).toBe(200)

            const footers = store.messages.getAllMessages(canonical.id)
                .filter((row) => JSON.stringify(row.content).includes('AGENT_NOTIFY_SUMMARY'))
            // One footer in the merged TRANSCRIPT — the second duplicate's
            // copy deduplicated against the first duplicate's COPIED row,
            // not appended again. This is still the unchanged base merge
            // rule: whichever content occurrence is seen first wins.
            expect(footers).toHaveLength(1)
            expect(footers[0]!.createdAt).toBe(base + 1_000)

            const merged = store.sessions.getSessionByNamespace(canonical.id, 'default')
            // The representative is the FIRST duplicate's occurrence — same
            // deterministic order the merge itself used to decide which row
            // the content-dedup keeps — so the second duplicate's dismissal,
            // keyed to its own (losing) occurrence, needed the remap to
            // still apply.
            expect(merged?.lastNotifyAt).toBe(base + 1_000)
            expect(merged?.blockedAckKeys).toContain(notifyBlockerKey(base + 1_000))
            expect(merged?.blockedAckKeys).not.toContain(notifyBlockerKey(base + 2_000))
        } finally {
            store.close()
        }
    })

    it('does not duplicate an initiating prompt across a THREE-session merge', async () => {
        // Survivor holds a blocked footer. One duplicate supplies the live
        // prompt that preceded it; another supplies the Desktop import of that
        // SAME prompt. Bumping only the tally a row was measured against left
        // the other stale, so the second duplicate saw a count that did not
        // include the row just copied and appended the prompt again — with a
        // synthetic stamp after the footer, which reconciliation then read as
        // an answer and hid an unanswered blocker.
        const { SyncEngine } = await import('../../sync/syncEngine')
        const { RpcRegistry } = await import('../../socket/rpcRegistry')
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        // Created through the STORE, not the engine: `engine.getOrCreateSession`
        // with a shared `codexSessionId` engages the engine's own duplicate
        // handling, which raced the route-level merge under test and made this
        // flaky (2 of 3 runs) before I caught it.
        const canonical = store.sessions.getOrCreateSession(
            'tri-canon', { codexSessionId: 'codex-thread-14', path: '/tmp', host: 'h' }, {}, 'default'
        )
        const liveDup = store.sessions.getOrCreateSession(
            'tri-live', { codexSessionId: 'codex-thread-14', path: '/tmp', host: 'h' }, {}, 'default'
        )
        const importDup = store.sessions.getOrCreateSession(
            'tri-import', { codexSessionId: 'codex-thread-14', path: '/tmp', host: 'h' }, {}, 'default'
        )
        const base = Date.now() - 600_000
        const footer = 'Prose.\n\nAGENT_NOTIFY_SUMMARY '
            + JSON.stringify({ version: 1, status: 'blocked', summary: 'needs a key' })

        // Survivor: padding so it wins canonical selection, then the footer.
        for (let i = 0; i < 6; i++) {
            store.messages.addImportedMessage(canonical.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: { type: 'assistant', message: { content: [{ type: 'text', text: `pad ${i}` }] } }
                }
            }, `tri-pad-${i}`, base)
        }
        store.messages.addMessage(canonical.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'assistant', message: { content: [{ type: 'text', text: footer }] } }
            }
        }, undefined, null, base + 3_000, base + 3_000)
        // The footer is set directly rather than derived first: deriving it
        // pre-merge depended on engine cache priming and made this flaky. What
        // is under test is whether the MERGE's reconciliation keeps it, so the
        // starting state only has to be unambiguous.
        engine.handleRealtimeEvent({ type: 'session-updated', sessionId: canonical.id })
        store.sessions.setSessionLastNotify(
            canonical.id,
            { status: 'blocked', at: base + 3_000, note: 'needs a key', receivedAt: base + 3_000 },
            'default'
        )
        const blockedStatus = () => store.sessions
            .getSessionByNamespace(canonical.id, 'default')?.lastNotifyStatus
        expect(blockedStatus()).toBe('blocked')

        // Duplicate A: the live prompt, real hub acknowledgement.
        store.messages.addMessage(liveDup.id, {
            role: 'user', content: { type: 'text', text: 'Continue' }, meta: { sentFrom: 'webapp' }
        }, 'tri-live-id', null, base + 1_000, base + 1_000)
        store.messages.markMessagesInvoked(liveDup.id, ['tri-live-id'], base + 2_000)
        // Duplicate B: the Desktop import of the same prompt, synthetic stamp
        // AFTER the footer.
        store.messages.addImportedMessage(importDup.id, {
            role: 'user', content: { type: 'text', text: 'Continue' }, meta: { sentFrom: 'webapp' }
        }, 'tri-import-id', base + 9_000)

        app.route('/api', createCodexDesktopRoutes({ store, getSyncEngine: () => engine }))
        try {
            const response = await app.request('/api/codex/merge-duplicate-sessions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionIds: ['codex-thread-14'] })
            })
            expect(response.status).toBe(200)

            const prompts = store.messages.getAllMessages(canonical.id)
                .filter((row) => JSON.stringify(row.content).includes('Continue'))
            expect(prompts).toHaveLength(1)
            expect(blockedStatus()).toBe('blocked')
        } finally {
            store.close()
        }
    })

    it('aligns a live prompt with its LATER Desktop import, under real reconciliation', async () => {
        // My previous test gave both copies the same delivery timestamp and
        // stubbed reconciliation, which is the easy version of this. In
        // reality the live projection carries a real hub acknowledgement time
        // while the untimestamped Desktop import synthesizes its own, so the
        // two never matched: the prompt was appended again and its later
        // timestamp let reconciliation read an initiating prompt as a reply
        // and hide the blocker. Real engine, real reconciliation here.
        const { SyncEngine } = await import('../../sync/syncEngine')
        const { RpcRegistry } = await import('../../socket/rpcRegistry')
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        const store = new Store(':memory:')
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const canonical = store.sessions.getOrCreateSession(
            'canon-real', { codexSessionId: 'codex-thread-13', path: '/tmp', host: 'h' }, {}, 'default'
        )
        const duplicate = store.sessions.getOrCreateSession(
            'dup-real', { codexSessionId: 'codex-thread-13', path: '/tmp', host: 'h' }, {}, 'default'
        )
        const base = Date.now() - 600_000
        const footer = 'Prose.\n\nAGENT_NOTIFY_SUMMARY '
            + JSON.stringify({ version: 1, status: 'blocked', summary: 'needs a key' })

        // Survivor: the live projection's prompt (real hub ack time), then an
        // unanswered blocked footer AFTER it.
        for (let i = 0; i < 4; i++) {
            store.messages.addImportedMessage(canonical.id, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: { type: 'assistant', message: { content: [{ type: 'text', text: `pad ${i}` }] } }
                }
            }, `pad-${i}`, base)
        }
        store.messages.addMessage(canonical.id, {
            role: 'user', content: { type: 'text', text: 'Continue' }, meta: { sentFrom: 'webapp' }
        }, 'live-id', null, base + 1_000, base + 1_000)
        store.messages.markMessagesInvoked(canonical.id, ['live-id'], base + 2_000)
        store.messages.addMessage(canonical.id, {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'assistant', message: { content: [{ type: 'text', text: footer }] } }
            }
        }, undefined, null, base + 3_000, base + 3_000)
        // The footer is set directly rather than derived first: deriving it
        // pre-merge depended on engine cache priming and made this flaky. What
        // is under test is whether the MERGE's reconciliation keeps it, so the
        // starting state only has to be unambiguous.
        engine.handleRealtimeEvent({ type: 'session-updated', sessionId: canonical.id })
        store.sessions.setSessionLastNotify(
            canonical.id,
            { status: 'blocked', at: base + 3_000, note: 'needs a key', receivedAt: base + 3_000 },
            'default'
        )
        const blockedStatus = () => store.sessions
            .getSessionByNamespace(canonical.id, 'default')?.lastNotifyStatus
        expect(blockedStatus()).toBe('blocked')

        // The duplicate holds the SAME prompt as an untimestamped import, so
        // its delivery stamp is synthetic and LATER than the footer.
        store.messages.addImportedMessage(duplicate.id, {
            role: 'user', content: { type: 'text', text: 'Continue' }, meta: { sentFrom: 'webapp' }
        }, 'import-id', base + 9_000)

        app.route('/api', createCodexDesktopRoutes({ store, getSyncEngine: () => engine }))
        try {
            const response = await app.request('/api/codex/merge-duplicate-sessions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionIds: ['codex-thread-13'] })
            })
            expect(response.status).toBe(200)

            const prompts = store.messages.getAllMessages(canonical.id)
                .filter((row) => JSON.stringify(row.content).includes('Continue'))
            expect(prompts).toHaveLength(1)
            // And the blocker is still there, because nothing answered it.
            expect(blockedStatus()).toBe('blocked')
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
            transferBlockedAck: () => {},
            transferAttachedJobs: (fromSessionId: string, toSessionId: string) => {
                store.sessionJobs.transfer(fromSessionId, toSessionId)
            },
            deleteSession: async (sessionId: string) => {
                store.sessions.deleteSession(sessionId, 'default')
            },
            handleRealtimeEvent: () => {},
            reconcileNotifySignalAfterImport: () => {},
            reconcileNotifyAcrossDuplicateSessions: () => {},
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
