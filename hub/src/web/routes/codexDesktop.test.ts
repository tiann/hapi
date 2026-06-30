import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { Store } from '../../store'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createCodexDesktopRoutes, importSelectedCodexSessions } from './codexDesktop'

const originalCodexHome = process.env.CODEX_HOME


function createTranscriptFromLines(codexHome: string, sessionId: string, lines: unknown[]): void {
    const sessionDir = join(codexHome, 'sessions', '2026', '06', '04')
    mkdirSync(sessionDir, { recursive: true })
    const transcriptPath = join(sessionDir, `rollout-${sessionId}.jsonl`)
    writeFileSync(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf-8')
}

function createTranscript(codexHome: string, sessionId: string, cwd = 'C:\\work\\project'): void {
    const sessionDir = join(codexHome, 'sessions', '2026', '06', '04')
    mkdirSync(sessionDir, { recursive: true })
    const transcriptPath = join(sessionDir, `rollout-${sessionId}.jsonl`)
    const lines = [
        {
            type: 'session_meta',
            payload: {
                id: sessionId,
                cwd,
                originator: 'codex_cli_rs',
                cli_version: '0.0.0-test'
            }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'normal user message' }]
            }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'normal assistant message' }]
            }
        }
    ]
    writeFileSync(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf-8')
}

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

function createImportSyncEngine(store: Store, machines: Machine[]): SyncEngine {
    return {
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


    it('archives a Codex transcript via machine RPC route', async () => {
        const archiveCodexSessionForMachine = async (machineId: string, sessionId: string) => ({
            success: true as const,
            archivedPath: `/tmp/${machineId}/${sessionId}.jsonl`
        })
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createCodexDesktopRoutes({
            store: new Store(':memory:'),
            getSyncEngine: () => ({
                getOnlineMachinesByNamespace: () => [createMachine('machine-1', ['/tmp/project'])],
                archiveCodexSessionForMachine
            } as unknown as SyncEngine)
        }))

        const response = await app.request('/api/codex/archive-session', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: 'codex-session-1', machineId: 'machine-1' })
        })

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
            success: true,
            archivedPath: '/tmp/machine-1/codex-session-1.jsonl',
            machineId: 'machine-1'
        })
    })

    it('imports normal response_item chat messages', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-test-'))
        const store = new Store(':memory:')
        const codexSessionId = '11111111-1111-4111-8111-111111111111'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId)

            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => null
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session).toBeDefined()
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
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('updates an existing forked import when syncing the original Codex session id', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-source-test-'))
        const store = new Store(':memory:')
        const codexSessionId = '12121212-1212-4121-8121-121212121212'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId)

            const first = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => null
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
                getSyncEngine: () => null
            })

            expect(second.success).toBe(true)
            expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(1)
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })


    it('deduplicates adjacent event_msg and response_item transcript records', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-dedup-test-'))
        const store = new Store(':memory:')
        const codexSessionId = '66666666-6666-4666-8666-666666666666'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscriptFromLines(codexHome, codexSessionId, [
                {
                    type: 'session_meta',
                    payload: {
                        id: codexSessionId,
                        cwd: '/home/user/workspace/project',
                        originator: 'codex_cli_rs',
                        cli_version: '0.0.0-test'
                    }
                },
                {
                    type: 'event_msg',
                    payload: {
                        type: 'user_message',
                        message: 'hi'
                    }
                },
                {
                    type: 'response_item',
                    payload: {
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text: 'hi\n' }]
                    }
                },
                {
                    type: 'event_msg',
                    payload: {
                        type: 'agent_message',
                        message: 'hi，我在。'
                    }
                },
                {
                    type: 'response_item',
                    payload: {
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: 'hi，我在。' }]
                    }
                }
            ])

            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => null
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            const messages = store.messages.getAllMessages(session.id)
            expect(messages).toHaveLength(2)
            expect(messages[0].content).toMatchObject({
                role: 'user',
                content: {
                    type: 'text',
                    text: 'hi'
                }
            })
            expect(messages[1].content).toMatchObject({
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'message',
                        message: 'hi，我在。'
                    }
                }
            })
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('binds imported transcripts to the unique online machine that owns the cwd', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-machine-test-'))
        const store = new Store(':memory:')
        const codexSessionId = '22222222-2222-4222-8222-222222222222'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId, '/home/user/workspace/project')
            const engine = createImportSyncEngine(store, [
                createMachine('machine-1', ['/home/user/workspace']),
                createMachine('machine-2', ['/other/workspace'])
            ])

            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => engine
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session.metadata).toMatchObject({
                path: '/home/user/workspace/project',
                machineId: 'machine-1'
            })
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('does not bind imported transcripts when multiple online machines own the cwd', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-machine-ambiguous-test-'))
        const store = new Store(':memory:')
        const codexSessionId = '33333333-3333-4333-8333-333333333333'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId, '/home/user/workspace/project')
            const engine = createImportSyncEngine(store, [
                createMachine('machine-1', ['/home/user/workspace']),
                createMachine('machine-2', ['/home/user/workspace/project'])
            ])

            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => engine
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session.metadata).toMatchObject({
                path: '/home/user/workspace/project'
            })
            expect(session.metadata).not.toHaveProperty('machineId')
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('does not bind imported transcripts when no online machine owns the cwd', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-machine-miss-test-'))
        const store = new Store(':memory:')
        const codexSessionId = '44444444-4444-4444-8444-444444444444'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId, '/home/user/workspace/project')
            const engine = createImportSyncEngine(store, [
                createMachine('machine-1', ['/home/user/other'])
            ])

            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => engine
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session.metadata).toMatchObject({
                path: '/home/user/workspace/project'
            })
            expect(session.metadata).not.toHaveProperty('machineId')
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('keeps an existing machineId when updating an imported transcript', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-machine-existing-test-'))
        const store = new Store(':memory:')
        const codexSessionId = '55555555-5555-4555-8555-555555555555'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId, '/home/user/workspace/project')
            store.sessions.getOrCreateSession(randomUUID(), {
                path: '/home/user/workspace/project',
                flavor: 'codex',
                codexSessionId,
                machineId: 'machine-existing'
            }, {}, 'default')
            const engine = createImportSyncEngine(store, [
                createMachine('machine-new', ['/home/user/workspace'])
            ])

            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => engine
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session.metadata).toMatchObject({
                path: '/home/user/workspace/project',
                machineId: 'machine-existing'
            })
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('rejects Codex transcript endpoints outside the default namespace', async () => {
        const app = createRoutesApp('team-a')
        const response = await app.request('/api/codex/sessions')

        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({
            success: false,
            error: 'Codex transcript import is not available outside the default namespace'
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
})
