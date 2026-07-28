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
    it('forwards Grok Auto permission mode when spawning', async () => {
        const machine = createMachine()
        let capturedPermissionMode: string | undefined
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            spawnSession: async (
                _machineId: string,
                _directory: string,
                _agent?: string,
                _model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: string,
                _worktreeName?: string,
                _resumeSessionId?: string,
                _effort?: string,
                permissionMode?: string
            ) => {
                capturedPermissionMode = permissionMode
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
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                directory: '/tmp/project',
                agent: 'grok',
                permissionMode: 'auto'
            })
        })

        expect(response.status).toBe(200)
        expect(capturedPermissionMode).toBe('auto')
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

    it('forwards cwd to listGrokModelsForCwd for Create-session discovery', async () => {
        const machine = createMachine()
        const calls: Array<{ machineId: string; cwd: string }> = []
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            listGrokModelsForCwd: async (machineId: string, cwd: string) => {
                calls.push({ machineId, cwd })
                return {
                    success: true,
                    availableModels: [{ modelId: 'grok-4.5' }],
                    currentModelId: 'grok-4.5'
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
            '/api/machines/machine-1/grok-models?cwd=' + encodeURIComponent('/home/user/proj')
        )

        expect(response.status).toBe(200)
        expect(calls).toEqual([{ machineId: 'machine-1', cwd: '/home/user/proj' }])
        expect(await response.json()).toEqual({
            success: true,
            availableModels: [{ modelId: 'grok-4.5' }],
            currentModelId: 'grok-4.5'
        })
    })

    it('returns 503 when cursor-models is requested without a sync engine', async () => {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => null))

        const response = await app.request('/api/machines/machine-1/cursor-models')

        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({
            success: false,
            error: 'Not connected'
        })
    })

    it('returns 500 when listing Cursor models fails', async () => {
        const machine = createMachine()
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            listCursorModelsForMachine: async () => {
                throw new Error('rpc offline')
            }
        } as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/machines/machine-1/cursor-models')

        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({
            success: false,
            error: 'rpc offline'
        })
    })

    it('returns Cursor models for an online machine', async () => {
        const machine = createMachine()
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            listCursorModelsForMachine: async () => ({
                success: true,
                availableModels: [
                    { modelId: 'composer-2.5', name: 'Composer 2.5' },
                    { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' }
                ],
                currentModelId: 'composer-2.5'
            })
        } as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/machines/machine-1/cursor-models')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            availableModels: [
                { modelId: 'composer-2.5', name: 'Composer 2.5' },
                { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' }
            ],
            currentModelId: 'composer-2.5'
        })
    })

    it('returns ACP wire ids from the machine RPC for New Session model pickers', async () => {
        const machine = createMachine()
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            listCursorModelsForMachine: async () => ({
                success: true,
                availableModels: [
                    { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' },
                    { modelId: 'composer-2.5[fast=false]', name: 'composer-2.5' }
                ],
                currentModelId: 'composer-2.5[fast=true]'
            })
        } as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/machines/machine-1/cursor-models')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            availableModels: [
                { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' },
                { modelId: 'composer-2.5[fast=false]', name: 'composer-2.5' }
            ],
            currentModelId: 'composer-2.5[fast=true]'
        })
    })

    describe('PATCH /machines/:id', () => {
        function createApp(engine: Partial<SyncEngine>) {
            const app = new Hono<WebAppEnv>()
            app.use('*', async (c, next) => {
                c.set('namespace', 'default')
                await next()
            })
            app.route('/api', createMachinesRoutes(() => engine as SyncEngine))
            return app
        }

        function patch(app: Hono<WebAppEnv>, body: unknown, machineId = 'machine-1') {
            return app.request(`/api/machines/${machineId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            })
        }

        it('renames a machine', async () => {
            const machine = createMachine()
            let captured: { id: string; displayName: string } | undefined
            const app = createApp({
                getMachine: () => machine,
                renameMachine: async (id: string, displayName: string) => {
                    captured = { id, displayName }
                }
            } as Partial<SyncEngine>)

            const response = await patch(app, { displayName: 'Workstation' })

            expect(response.status).toBe(200)
            expect(captured).toEqual({ id: 'machine-1', displayName: 'Workstation' })
        })

        it('trims the name before storing it', async () => {
            const machine = createMachine()
            let captured: string | undefined
            const app = createApp({
                getMachine: () => machine,
                renameMachine: async (_id: string, displayName: string) => {
                    captured = displayName
                }
            } as Partial<SyncEngine>)

            await patch(app, { displayName: '  Workstation  ' })

            expect(captured).toBe('Workstation')
        })

        it('clears the name when given an empty string', async () => {
            const machine = createMachine()
            let captured: string | undefined
            const app = createApp({
                getMachine: () => machine,
                renameMachine: async (_id: string, displayName: string) => {
                    captured = displayName
                }
            } as Partial<SyncEngine>)

            const response = await patch(app, { displayName: '   ' })

            expect(response.status).toBe(200)
            expect(captured).toBe('')
        })

        it('rejects a name longer than 64 characters', async () => {
            const machine = createMachine()
            let called = false
            const app = createApp({
                getMachine: () => machine,
                renameMachine: async () => {
                    called = true
                }
            } as Partial<SyncEngine>)

            const response = await patch(app, { displayName: 'x'.repeat(65) })

            expect(response.status).toBe(400)
            expect(called).toBe(false)
        })

        it('rejects a body without displayName', async () => {
            const machine = createMachine()
            const app = createApp({
                getMachine: () => machine,
                renameMachine: async () => {}
            } as Partial<SyncEngine>)

            expect((await patch(app, {})).status).toBe(400)
        })

        it('returns 404 for an unknown machine', async () => {
            const app = createApp({
                getMachine: () => undefined,
                renameMachine: async () => {}
            } as Partial<SyncEngine>)

            expect((await patch(app, { displayName: 'Nope' }, 'missing')).status).toBe(404)
        })

        it('returns 403 for a machine in another namespace', async () => {
            const machine = createMachine({ namespace: 'other' })
            const app = createApp({
                getMachine: () => machine,
                renameMachine: async () => {}
            } as Partial<SyncEngine>)

            expect((await patch(app, { displayName: 'Nope' })).status).toBe(403)
        })

        it('maps a concurrency failure to 409', async () => {
            const machine = createMachine()
            const app = createApp({
                getMachine: () => machine,
                renameMachine: async () => {
                    throw new Error('Machine was modified concurrently. Please try again.')
                }
            } as Partial<SyncEngine>)

            expect((await patch(app, { displayName: 'Workstation' })).status).toBe(409)
        })

        it('maps an unexpected failure to 500', async () => {
            const machine = createMachine()
            const app = createApp({
                getMachine: () => machine,
                renameMachine: async () => {
                    throw new Error('disk on fire')
                }
            } as Partial<SyncEngine>)

            expect((await patch(app, { displayName: 'Workstation' })).status).toBe(500)
        })
    })
})
