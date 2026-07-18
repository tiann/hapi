import { beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createConfiguration } from '../../configuration'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import { resolveAccessTokenNamespace } from '../../utils/accessToken'
import { createCliRoutes } from './cli'

function createSession(overrides?: Partial<Session>): Session {
    const base: Session = {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 1,
        todos: [],
        model: null,
        modelReasoningEffort: null,
        effort: null,
        permissionMode: undefined,
        collaborationMode: undefined
    }

    return {
        ...base,
        ...overrides
    }
}

beforeAll(async () => {
    process.env.HAPI_HOME = mkdtempSync(join(tmpdir(), 'hapi-cli-route-test-'))
    process.env.CLI_API_TOKEN = 'test-cli-token'
    await createConfiguration()
})

function createApp(messages: Array<{ id: string; seq: number; createdAt: number; localId?: string | null; content: unknown }>) {
    const session = createSession()
    const engine = {
        resolveSessionAccess: () => ({ ok: true, sessionId: session.id, session }),
        getMessagesAfter: () => messages
    } as Partial<SyncEngine>

    const app = new Hono()
    app.route('/cli', createCliRoutes(() => engine as SyncEngine))
    return app
}

describe('cli routes', () => {
    it('rejects malformed machine metadata at REST registration ingress', async () => {
        let calls = 0
        const engine = {
            getMachine: () => undefined,
            getOrCreateMachine: () => {
                calls += 1
                throw new Error('must not persist malformed metadata')
            }
        } as Partial<SyncEngine>
        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as SyncEngine))

        const response = await app.request('/cli/machines', {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-cli-token',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                id: 'machine-1',
                metadata: { host: 'runner.example' }
            })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Invalid body' })
        expect(calls).toBe(0)
    })

    it('derives the CLI namespace from an independent server-side credential mapping', async () => {
        let capturedNamespace: string | undefined
        const engine = {
            getOrCreateSession: (...args: unknown[]) => {
                capturedNamespace = args[3] as string
                return createSession({ namespace: capturedNamespace })
            }
        } as Partial<SyncEngine>
        const resolveToken = (token: string) => resolveAccessTokenNamespace(token, {
            defaultToken: 'default-token-credential',
            namespaceTokens: { alice: 'alice-token-credential', bob: 'bob-token-credential' },
        })
        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as SyncEngine, resolveToken))

        const aliceResponse = await app.request('/cli/sessions', {
            method: 'POST',
            headers: {
                authorization: 'Bearer alice-token-credential',
                'content-type': 'application/json'
            },
            body: JSON.stringify({ tag: 'alice-session', metadata: null })
        })
        const forgedBobResponse = await app.request('/cli/sessions', {
            method: 'POST',
            headers: {
                authorization: 'Bearer alice-token-credential:bob',
                'content-type': 'application/json'
            },
            body: JSON.stringify({ tag: 'forged-session', metadata: null })
        })

        expect(aliceResponse.status).toBe(200)
        expect(capturedNamespace).toBe('alice')
        expect(forgedBobResponse.status).toBe(401)
    })

    it('passes service tier through CLI session registration', async () => {
        let capturedServiceTier: 'standard' | 'fast' | undefined
        const engine = {
            getOrCreateSession: (...args: unknown[]) => {
                capturedServiceTier = args[7] as 'standard' | 'fast' | undefined
                return createSession({ serviceTier: capturedServiceTier ?? null })
            }
        } as Partial<SyncEngine>
        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as SyncEngine))

        const response = await app.request('/cli/sessions', {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-cli-token',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                tag: 'session-1',
                metadata: { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                serviceTier: 'fast'
            })
        })

        expect(response.status).toBe(200)
        expect(capturedServiceTier).toBe('fast')
    })

    it('rejects invalid CLI service tier values', async () => {
        const engine = {
            getOrCreateSession: () => createSession()
        } as Partial<SyncEngine>
        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as SyncEngine))

        const response = await app.request('/cli/sessions', {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-cli-token',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                tag: 'session-1',
                metadata: { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
                serviceTier: 'default'
            })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Invalid body' })
    })

    it('filters passive codex sync messages from CLI backfill by localId prefix', async () => {
        const app = createApp([
            {
                id: 'message-1',
                seq: 1,
                createdAt: 1,
                localId: 'codex:thread-1:12:abc123',
                content: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: 'desktop sync replay without meta'
                    }
                }
            },
            {
                id: 'message-2',
                seq: 2,
                createdAt: 2,
                localId: 'web-1',
                content: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: 'phone message'
                    },
                    meta: {
                        sentFrom: 'webapp'
                    }
                }
            }
        ])

        const response = await app.request('/cli/sessions/session-1/messages?afterSeq=0', {
            headers: {
                authorization: 'Bearer test-cli-token'
            }
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            messages: [
                {
                    id: 'message-2',
                    seq: 2,
                    createdAt: 2,
                    localId: 'web-1',
                    content: {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: 'phone message'
                        },
                        meta: {
                            sentFrom: 'webapp'
                        }
                    }
                }
            ]
        })
    })

    it('filters passive sync messages from CLI backfill by sentFrom metadata', async () => {
        const app = createApp([
            {
                id: 'message-1',
                seq: 1,
                createdAt: 1,
                localId: 'web-1',
                content: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: 'desktop sync replay with meta'
                    },
                    meta: {
                        sentFrom: 'codex-desktop-sync'
                    }
                }
            }
        ])

        const response = await app.request('/cli/sessions/session-1/messages?afterSeq=0', {
            headers: {
                authorization: 'Bearer test-cli-token'
            }
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            messages: []
        })
    })

    it('filters passive synced agent/tool messages from CLI backfill', async () => {
        const app = createApp([
            {
                id: 'message-1',
                seq: 1,
                createdAt: 1,
                localId: 'codex:thread-1:99:toolabc',
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'tool-call',
                            name: 'exec_command',
                            callId: 'call_1',
                            input: { cmd: 'pwd' }
                        }
                    },
                    meta: {
                        sentFrom: 'codex-desktop-sync'
                    }
                }
            },
            {
                id: 'message-2',
                seq: 2,
                createdAt: 2,
                localId: null,
                content: {
                    role: 'agent',
                    content: {
                        type: 'event',
                        event: 'kept-visible'
                    }
                }
            }
        ])

        const response = await app.request('/cli/sessions/session-1/messages?afterSeq=0', {
            headers: {
                authorization: 'Bearer test-cli-token'
            }
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            messages: [
                {
                    id: 'message-2',
                    seq: 2,
                    createdAt: 2,
                    localId: null,
                    content: {
                        role: 'agent',
                        content: {
                            type: 'event',
                            event: 'kept-visible'
                        }
                    }
                }
            ]
        })
    })
})
