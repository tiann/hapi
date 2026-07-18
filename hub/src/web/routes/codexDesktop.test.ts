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

function createMirroredTranscript(codexHome: string, sessionId: string): void {
    const sessionDir = join(codexHome, 'sessions', '2026', '06', '04')
    mkdirSync(sessionDir, { recursive: true })
    const transcriptPath = join(sessionDir, 'rollout-' + sessionId + '.jsonl')
    const transcriptLines = [
        {
            type: 'session_meta',
            payload: {
                id: sessionId,
                cwd: 'C:/work/project',
                originator: 'codex_cli_rs',
                cli_version: '0.0.0-test'
            }
        },
        {
            type: 'event_msg',
            payload: { type: 'user_message', message: 'mirrored user message' }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'mirrored user message\n' }]
            }
        }
    ]
    writeFileSync(transcriptPath, transcriptLines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8')
}

function createMirroredAgentMessageTranscript(codexHome: string, sessionId: string): void {
    const sessionDir = join(codexHome, 'sessions', '2026', '06', '04')
    mkdirSync(sessionDir, { recursive: true })
    const transcriptPath = join(sessionDir, 'rollout-' + sessionId + '.jsonl')
    const transcriptLines = [
        {
            type: 'session_meta',
            payload: {
                id: sessionId,
                cwd: 'C:/work/project',
                originator: 'codex_cli_rs',
                cli_version: '0.0.0-test'
            }
        },
        {
            type: 'event_msg',
            payload: { type: 'agent_message', message: 'duplicated assistant message' }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'duplicated assistant message' }]
            }
        }
    ]
    writeFileSync(transcriptPath, transcriptLines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8')
}

function createInjectedResponseUserTranscript(codexHome: string, sessionId: string): void {
    const sessionDir = join(codexHome, 'sessions', '2026', '06', '04')
    mkdirSync(sessionDir, { recursive: true })
    const transcriptPath = join(sessionDir, 'rollout-' + sessionId + '.jsonl')
    const transcriptLines = [
        {
            type: 'session_meta',
            payload: {
                id: sessionId,
                cwd: 'C:/work/project',
                originator: 'codex_cli_rs',
                cli_version: '0.0.0-test'
            }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: `# AGENTS.md instructions for /repo
<INSTRUCTIONS>ignore</INSTRUCTIONS>` }]
            }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: `<environment_context>
<current_date>2026-07-07</current_date>
<filesystem>workspace</filesystem>
</environment_context>` }]
            }
        },
        {
            type: 'event_msg',
            payload: { type: 'user_message', message: 'real event user message' }
        }
    ]
    writeFileSync(transcriptPath, transcriptLines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8')
}

function createEmbeddedEnvironmentPromptTranscript(codexHome: string, sessionId: string): void {
    const sessionDir = join(codexHome, 'sessions', '2026', '06', '04')
    mkdirSync(sessionDir, { recursive: true })
    const transcriptPath = join(sessionDir, 'rollout-' + sessionId + '.jsonl')
    const transcriptLines = [
        {
            type: 'session_meta',
            payload: {
                id: sessionId,
                cwd: 'C:/work/project',
                originator: 'codex_cli_rs',
                cli_version: '0.0.0-test'
            }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: `Please inspect this transcript block:
<environment_context>
<current_date>2026-07-07</current_date>
</environment_context>
This is part of my prompt.` }]
            }
        }
    ]
    writeFileSync(transcriptPath, transcriptLines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8')
}

function createSameSourceDuplicateTranscript(codexHome: string, sessionId: string): void {
    const sessionDir = join(codexHome, 'sessions', '2026', '06', '04')
    mkdirSync(sessionDir, { recursive: true })
    const transcriptPath = join(sessionDir, 'rollout-' + sessionId + '.jsonl')
    const transcriptLines = [
        {
            type: 'session_meta',
            payload: {
                id: sessionId,
                cwd: 'C:/work/project',
                originator: 'codex_cli_rs',
                cli_version: '0.0.0-test'
            }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'same source user message' }]
            }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'same source user message' }]
            }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'same source assistant message' }]
            }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'same source assistant message' }]
            }
        }
    ]
    writeFileSync(transcriptPath, transcriptLines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8')
}

function createRepeatedSameTextDistinctTurnTranscript(codexHome: string, sessionId: string): void {
    const sessionDir = join(codexHome, 'sessions', '2026', '06', '04')
    mkdirSync(sessionDir, { recursive: true })
    const transcriptPath = join(sessionDir, 'rollout-' + sessionId + '.jsonl')
    const transcriptLines = [
        {
            type: 'session_meta',
            payload: {
                id: sessionId,
                cwd: 'C:/work/project',
                originator: 'codex_cli_rs',
                cli_version: '0.0.0-test'
            }
        },
        {
            type: 'event_msg',
            payload: { type: 'user_message', message: 'repeat user message' }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'repeat user message' }]
            }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'assistant answer' }]
            }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'repeat user message' }]
            }
        }
    ]
    writeFileSync(transcriptPath, transcriptLines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8')
}

function createMirroredAndDistinctUserTranscript(codexHome: string, sessionId: string): void {
    const sessionDir = join(codexHome, 'sessions', '2026', '06', '04')
    mkdirSync(sessionDir, { recursive: true })
    const transcriptPath = join(sessionDir, 'rollout-' + sessionId + '.jsonl')
    const transcriptLines = [
        {
            type: 'session_meta',
            payload: {
                id: sessionId,
                cwd: 'C:/work/project',
                originator: 'codex_cli_rs',
                cli_version: '0.0.0-test'
            }
        },
        {
            type: 'event_msg',
            payload: { type: 'user_message', message: 'first user message' }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'first user message' }]
            }
        },
        {
            type: 'event_msg',
            payload: { type: 'user_message', message: 'second user message' }
        }
    ]
    writeFileSync(transcriptPath, transcriptLines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8')
}

function writeSessionIndex(codexHome: string, records: Array<{ id: string; thread_name: string; updated_at: string }>): void {
    writeFileSync(
        join(codexHome, 'session_index.jsonl'),
        records.map((record) => JSON.stringify(record)).join('\n') + '\n',
        'utf-8'
    )
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
            const sessions = store.sessions.getSessionsByNamespace('default')
            expect(sessions).toHaveLength(1)
            expect(sessions[0]?.metadata).toMatchObject({
                codexSessionId: 'fork-session-id',
                codexSourceSessionId: codexSessionId
            })
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('deduplicates mirrored event_msg and response_item user messages', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-mirror-test-'))
        const store = new Store(':memory:')
        const codexSessionId = '66666666-6666-4666-8666-666666666666'
        process.env.CODEX_HOME = codexHome

        try {
            createMirroredTranscript(codexHome, codexSessionId)

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
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('deduplicates adjacent mirrored agent messages with different ids', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-agent-mirror-test-'))
        const store = new Store(':memory:')
        const codexSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        process.env.CODEX_HOME = codexHome

        try {
            createMirroredAgentMessageTranscript(codexHome, codexSessionId)

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
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('skips injected response_item user context messages', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-injected-user-test-'))
        const store = new Store(':memory:')
        const codexSessionId = '88888888-8888-4888-8888-888888888888'
        process.env.CODEX_HOME = codexHome

        try {
            createInjectedResponseUserTranscript(codexHome, codexSessionId)

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
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('preserves a real response_item user prompt containing embedded environment_context text', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-embedded-env-test-'))
        const store = new Store(':memory:')
        const codexSessionId = 'abababab-abab-4bab-8bab-abababababab'
        process.env.CODEX_HOME = codexHome

        try {
            createEmbeddedEnvironmentPromptTranscript(codexHome, codexSessionId)

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
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('preserves adjacent duplicate messages from the same transcript source', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-same-source-duplicate-test-'))
        const store = new Store(':memory:')
        const codexSessionId = 'babababa-baba-4aba-8aba-babababababa'
        process.env.CODEX_HOME = codexHome

        try {
            createSameSourceDuplicateTranscript(codexHome, codexSessionId)

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
            expect(messages).toHaveLength(4)
            expect(messages.map((message) => (message.content as { role?: unknown }).role)).toEqual([
                'user',
                'user',
                'agent',
                'agent'
            ])
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('keeps a later response_item-only user turn with the same text', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-repeat-user-test-'))
        const store = new Store(':memory:')
        const codexSessionId = '99999999-9999-4999-8999-999999999999'
        process.env.CODEX_HOME = codexHome

        try {
            createRepeatedSameTextDistinctTurnTranscript(codexHome, codexSessionId)

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
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('keeps distinct user turns while deduplicating mirrored user events', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-distinct-user-test-'))
        const store = new Store(':memory:')
        const codexSessionId = '77777777-7777-4777-8777-777777777777'
        process.env.CODEX_HOME = codexHome

        try {
            createMirroredAndDistinctUserTranscript(codexHome, codexSessionId)

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
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('uses the latest session_index thread_name for list and imported session title', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-index-title-test-'))
        const store = new Store(':memory:')
        const codexSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId)
            writeSessionIndex(codexHome, [
                {
                    id: codexSessionId,
                    thread_name: 'old thread title',
                    updated_at: '2026-07-07T01:00:00.000000000Z'
                },
                {
                    id: codexSessionId,
                    thread_name: 'new thread title',
                    updated_at: '2026-07-07T02:00:00.000000000Z'
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
            expect(session.metadata).toMatchObject({
                name: 'new thread title',
                flavor: 'codex',
                codexSessionId
            })
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('falls back to transcript title when session_index is missing', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-no-index-title-test-'))
        const store = new Store(':memory:')
        const codexSessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
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
            expect(session.metadata).toMatchObject({
                name: 'normal user message',
                flavor: 'codex',
                codexSessionId
            })
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('falls back to transcript title when session_index has no matching id', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-index-miss-title-test-'))
        const store = new Store(':memory:')
        const codexSessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId)
            writeSessionIndex(codexHome, [
                {
                    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                    thread_name: 'unrelated title',
                    updated_at: '2026-07-07T03:00:00.000000000Z'
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
            expect(session.metadata).toMatchObject({
                name: 'normal user message',
                flavor: 'codex',
                codexSessionId
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

    it('does not append a Runner transcript to a session bound to another machine', async () => {
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
                getSyncEngine: () => engine,
                machineId: 'machine-new'
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
