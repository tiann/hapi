import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createImportableSessionsRoutes } from './importableSessions'

function createApp(engine: Partial<SyncEngine>) {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createImportableSessionsRoutes(() => engine as SyncEngine))
    return app
}

describe('importable sessions routes', () => {
    it('lists codex importable sessions with imported status', async () => {
        const engine = {
            listImportableCodexSessions: async () => ({
                type: 'success' as const,
                machineId: 'machine-1',
                sessions: [
                    {
                        agent: 'codex' as const,
                        externalSessionId: 'external-1',
                        cwd: '/tmp/project',
                        timestamp: 123,
                        transcriptPath: '/tmp/project/.codex/sessions/external-1.jsonl',
                        previewTitle: 'Imported title',
                        previewPrompt: 'Imported prompt',
                        model: 'gpt-5.4',
                        effort: 'xhigh',
                        modelReasoningEffort: 'xhigh',
                        serviceTier: 'fast',
                        collaborationMode: 'default' as const,
                        approvalPolicy: 'never',
                        sandboxPolicy: { type: 'danger-full-access' },
                        permissionMode: 'yolo' as const
                    },
                    {
                        agent: 'codex' as const,
                        externalSessionId: 'external-2',
                        cwd: '/tmp/project-2',
                        timestamp: 456,
                        transcriptPath: '/tmp/project-2/.codex/sessions/external-2.jsonl',
                        previewTitle: null,
                        previewPrompt: null
                    }
                ]
            }),
            findSessionByExternalCodexSessionId: (_namespace: string, externalSessionId: string) => {
                if (externalSessionId === 'external-1') {
                    return { sessionId: 'hapi-123' }
                }
                return null
            }
        }

        const app = createApp(engine)

        const response = await app.request('/api/importable-sessions?agent=codex')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            sessions: [
                {
                    agent: 'codex',
                    externalSessionId: 'external-1',
                    cwd: '/tmp/project',
                    timestamp: 123,
                    transcriptPath: '/tmp/project/.codex/sessions/external-1.jsonl',
                    previewTitle: 'Imported title',
                    previewPrompt: 'Imported prompt',
                    model: 'gpt-5.4',
                    effort: 'xhigh',
                    modelReasoningEffort: 'xhigh',
                    serviceTier: 'fast',
                    collaborationMode: 'default',
                    approvalPolicy: 'never',
                    sandboxPolicy: { type: 'danger-full-access' },
                    permissionMode: 'yolo',
                    alreadyImported: true,
                    importedHapiSessionId: 'hapi-123'
                },
                {
                    agent: 'codex',
                    externalSessionId: 'external-2',
                    cwd: '/tmp/project-2',
                    timestamp: 456,
                    transcriptPath: '/tmp/project-2/.codex/sessions/external-2.jsonl',
                    previewTitle: null,
                    previewPrompt: null,
                    alreadyImported: false,
                    importedHapiSessionId: null
                }
            ]
        })
    })

    it('returns a sensible error when no machine is online', async () => {
        const engine = {
            listImportableCodexSessions: async () => ({
                type: 'error' as const,
                code: 'no_machine_online' as const,
                message: 'No machine online'
            })
        }

        const app = createApp(engine)

        const response = await app.request('/api/importable-sessions?agent=codex')

        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({
            error: 'No machine online',
            code: 'no_machine_online'
        })
    })

    it('lists claude importable sessions with imported status', async () => {
        const engine = {
            listImportableClaudeSessions: async () => ({
                type: 'success' as const,
                machineId: 'machine-1',
                sessions: [
                    {
                        agent: 'claude' as const,
                        externalSessionId: 'external-1',
                        cwd: '/tmp/project',
                        timestamp: 123,
                        transcriptPath: '/tmp/project/.claude/projects/project/external-1.jsonl',
                        previewTitle: 'Imported Claude title',
                        previewPrompt: 'Imported Claude prompt'
                    }
                ]
            }),
            findSessionByExternalClaudeSessionId: () => ({ sessionId: 'hapi-claude-123' })
        }

        const app = createApp(engine)

        const response = await app.request('/api/importable-sessions?agent=claude')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            sessions: [
                {
                    agent: 'claude',
                    externalSessionId: 'external-1',
                    cwd: '/tmp/project',
                    timestamp: 123,
                    transcriptPath: '/tmp/project/.claude/projects/project/external-1.jsonl',
                    previewTitle: 'Imported Claude title',
                    previewPrompt: 'Imported Claude prompt',
                    alreadyImported: true,
                    importedHapiSessionId: 'hapi-claude-123'
                }
            ]
        })
    })

    it('imports an external codex session', async () => {
        const captured: Array<{ externalSessionId: string; namespace: string }> = []
        const engine = {
            importExternalCodexSession: async (externalSessionId: string, namespace: string) => {
                captured.push({ externalSessionId, namespace })
                return {
                    type: 'success' as const,
                    sessionId: 'hapi-123'
                }
            }
        }

        const app = createApp(engine)

        const response = await app.request('/api/importable-sessions/codex/external-1/import', {
            method: 'POST'
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            type: 'success',
            sessionId: 'hapi-123'
        })
        expect(captured).toEqual([
            {
                externalSessionId: 'external-1',
                namespace: 'default'
            }
        ])
    })

    it('re-imports an external codex session', async () => {
        const captured: Array<{ externalSessionId: string; namespace: string }> = []
        const engine = {
            refreshExternalCodexSession: async (externalSessionId: string, namespace: string) => {
                captured.push({ externalSessionId, namespace })
                return {
                    type: 'success' as const,
                    sessionId: 'hapi-123'
                }
            }
        }

        const app = createApp(engine)

        const response = await app.request('/api/importable-sessions/codex/external-1/refresh', {
            method: 'POST'
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            type: 'success',
            sessionId: 'hapi-123'
        })
        expect(captured).toEqual([
            {
                externalSessionId: 'external-1',
                namespace: 'default'
            }
        ])
    })

    it('imports an external claude session', async () => {
        const captured: Array<{ externalSessionId: string; namespace: string }> = []
        const engine = {
            importExternalClaudeSession: async (externalSessionId: string, namespace: string) => {
                captured.push({ externalSessionId, namespace })
                return {
                    type: 'success' as const,
                    sessionId: 'hapi-claude-123'
                }
            }
        }

        const app = createApp(engine)

        const response = await app.request('/api/importable-sessions/claude/external-1/import', {
            method: 'POST'
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            type: 'success',
            sessionId: 'hapi-claude-123'
        })
        expect(captured).toEqual([
            {
                externalSessionId: 'external-1',
                namespace: 'default'
            }
        ])
    })

    it('re-imports an external claude session', async () => {
        const captured: Array<{ externalSessionId: string; namespace: string }> = []
        const engine = {
            refreshExternalClaudeSession: async (externalSessionId: string, namespace: string) => {
                captured.push({ externalSessionId, namespace })
                return {
                    type: 'success' as const,
                    sessionId: 'hapi-claude-123'
                }
            }
        }

        const app = createApp(engine)

        const response = await app.request('/api/importable-sessions/claude/external-1/refresh', {
            method: 'POST'
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            type: 'success',
            sessionId: 'hapi-claude-123'
        })
        expect(captured).toEqual([
            {
                externalSessionId: 'external-1',
                namespace: 'default'
            }
        ])
    })
})
