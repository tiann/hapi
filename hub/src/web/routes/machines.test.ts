import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createMachinesRoutes } from './machines'

function createMachine(overrides?: Partial<Machine>): Machine {
    return {
        id: 'machine-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            host: 'localhost',
            platform: 'darwin',
            happyCliVersion: '1.0.0'
        },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1,
        ...overrides
    }
}

describe('machines routes', () => {
    it('accepts plugin agent ids when spawning a session', async () => {
        const machine = createMachine()
        const calls: Array<{
            machineId: string
            directory: string
            agent: string | undefined
        }> = []
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            spawnSession: async (machineId: string, directory: string, agent?: string) => {
                calls.push({ machineId, directory, agent })
                return { type: 'success' as const, sessionId: 'session-1' }
            }
        } as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/machines/machine-1/spawn', {
            method: 'POST',
            body: JSON.stringify({
                directory: '/repo',
                agent: 'vendor:example-agent'
            }),
            headers: { 'content-type': 'application/json' }
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ type: 'success', sessionId: 'session-1' })
        expect(calls).toEqual([{ machineId: 'machine-1', directory: '/repo', agent: 'vendor:example-agent' }])
    })

    it('previews Runner spawn options through the selected machine', async () => {
        const machine = createMachine()
        const calls: unknown[] = []
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            previewRunnerSpawnOptions: async (_machineId: string, payload: unknown) => {
                calls.push(payload)
                return {
                    options: { permissionMode: 'yolo', modelReasoningEffort: 'xhigh' },
                    applied: [{ pluginId: 'test.runner-defaults', contributionId: 'defaults', label: 'Codex repo' }],
                    diagnostics: []
                }
            }
        } as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/machines/machine-1/spawn-options/preview', {
            method: 'POST',
            body: JSON.stringify({
                directory: '/repo',
                agent: 'codex',
                manualFields: ['model']
            }),
            headers: { 'content-type': 'application/json' }
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            options: { permissionMode: 'yolo', modelReasoningEffort: 'xhigh' },
            applied: [{ pluginId: 'test.runner-defaults', contributionId: 'defaults', label: 'Codex repo' }],
            diagnostics: []
        })
        expect(calls).toEqual([expect.objectContaining({ directory: '/repo', agent: 'codex', manualFields: ['model'] })])
    })

    it('returns Codex models for an online machine', async () => {
        const machine = createMachine()
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            listCodexModelsForMachine: async () => ({
                success: true,
                models: [
                    { id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true }
                ]
            })
        } as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/machines/machine-1/codex-models')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            models: [
                { id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true }
            ]
        })
    })

    it('imports plugin agent native history through the machine namespace guard', async () => {
        const machine = createMachine()
        const calls: Array<{ machineId: string; agentId: string; nativeSessionId: string }> = []
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            importRunnerAgentHistory: async (machineId: string, payload: { agentId: string; nativeSessionId: string }) => {
                calls.push({ machineId, agentId: payload.agentId, nativeSessionId: payload.nativeSessionId })
                return { messages: [{ role: 'user' as const, content: 'hello' }] }
            }
        } as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/machines/machine-1/agents/vendor%3Aexample-agent/history/import', {
            method: 'POST',
            body: JSON.stringify({ nativeSessionId: 'native-session-1' }),
            headers: { 'content-type': 'application/json' }
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ messages: [{ role: 'user', content: 'hello' }] })
        expect(calls).toEqual([{ machineId: 'machine-1', agentId: 'vendor:example-agent', nativeSessionId: 'native-session-1' }])
    })

    it('returns 400 when /opencode-models is called without cwd', async () => {
        const machine = createMachine()
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            listOpencodeModelsForCwd: async () => ({ success: true, availableModels: [] })
        } as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/machines/machine-1/opencode-models')

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            success: false,
            error: 'cwd query parameter is required'
        })
    })

    it('forwards cwd to listOpencodeModelsForCwd and returns availableModels', async () => {
        const machine = createMachine()
        const calls: Array<{ machineId: string; cwd: string }> = []
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            listOpencodeModelsForCwd: async (machineId: string, cwd: string) => {
                calls.push({ machineId, cwd })
                return {
                    success: true,
                    availableModels: [
                        { modelId: 'ollama/exaone:4.5-33b-q8', name: 'Ollama/EXAONE 4.5 33B Q8' }
                    ],
                    currentModelId: 'ollama/exaone:4.5-33b-q8'
                }
            }
        } as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request(
            '/api/machines/machine-1/opencode-models?cwd=' + encodeURIComponent('/home/user/proj')
        )

        expect(response.status).toBe(200)
        expect(calls).toEqual([{ machineId: 'machine-1', cwd: '/home/user/proj' }])
        expect(await response.json()).toEqual({
            success: true,
            availableModels: [
                { modelId: 'ollama/exaone:4.5-33b-q8', name: 'Ollama/EXAONE 4.5 33B Q8' }
            ],
            currentModelId: 'ollama/exaone:4.5-33b-q8'
        })
    })
})
