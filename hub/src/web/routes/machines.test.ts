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
    it('validates and forwards machine-scoped host operations', async () => {
        const machine = createMachine()
        const calls: unknown[] = []
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            startHostOperation: async (_machineId: string, request: unknown) => {
                calls.push(request)
                return {
                    success: true,
                    operation: {
                        id: '11111111-1111-4111-8111-111111111111',
                        domain: 'file',
                        kind: 'create-directory',
                        status: 'queued',
                        progress: 0,
                        createdAt: 1
                    }
                }
            }
        } as Partial<SyncEngine>
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', 'default'); await next() })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/machines/machine-1/host/operations', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ domain: 'file', operation: { kind: 'create-directory', path: '/workspace/new' } })
        })

        expect(response.status).toBe(200)
        expect(calls).toEqual([{ domain: 'file', operation: { kind: 'create-directory', path: '/workspace/new' } }])
    })

    it('forwards scoped file previews and editor writes', async () => {
        const machine = createMachine()
        const calls: unknown[] = []
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            readHostFilePreview: async (_machineId: string, path: string) => {
                calls.push(['read', { path }])
                return { success: true, kind: 'text', text: 'hello', size: 5, modified: 1 }
            },
            writeHostFile: async (_machineId: string, request: unknown) => {
                calls.push(['write', request])
                return { success: true, kind: 'text', text: 'updated', size: 7, modified: 2 }
            }
        } as Partial<SyncEngine>
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', 'default'); await next() })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const preview = await app.request('/api/machines/machine-1/host/files/read', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: '/workspace/notes.md' })
        })
        const write = await app.request('/api/machines/machine-1/host/files/write', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: '/workspace/notes.md', content: 'updated', expectedModified: 1, expectedSize: 5 })
        })

        expect(preview.status).toBe(200)
        expect(write.status).toBe(200)
        expect(calls).toEqual([
            ['read', { path: '/workspace/notes.md' }],
            ['write', { path: '/workspace/notes.md', content: 'updated', expectedModified: 1, expectedSize: 5 }]
        ])
    })

    it('forwards a bounded workspace file upload to the selected machine', async () => {
        const machine = createMachine()
        const calls: unknown[] = []
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            uploadHostFile: async (_machineId: string, request: unknown) => {
                calls.push(request)
                return { success: true, path: '/workspace/notes.txt', size: 5 }
            }
        } as Partial<SyncEngine>
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', 'default'); await next() })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/machines/machine-1/host/files/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                directory: '/workspace',
                name: 'notes.txt',
                contentBase64: 'aGVsbG8=',
                conflict: 'new-copy'
            })
        })

        expect(response.status).toBe(200)
        expect(calls).toEqual([{
            directory: '/workspace',
            name: 'notes.txt',
            contentBase64: 'aGVsbG8=',
            conflict: 'new-copy'
        }])
    })

    it('rejects oversized host request bodies before parsing or RPC', async () => {
        const machine = createMachine()
        let called = false
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            uploadHostFile: async () => {
                called = true
                return { success: true }
            }
        } as Partial<SyncEngine>
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', 'default'); await next() })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/machines/machine-1/host/files/upload', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': String(32 * 1024 * 1024)
            },
            body: '{}'
        })

        expect(response.status).toBe(413)
        expect(await response.json()).toEqual({ error: 'Payload too large' })
        expect(called).toBe(false)
    })

    it('stops oversized streamed host bodies without a content-length header', async () => {
        const machine = createMachine()
        let called = false
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            uploadHostFile: async () => {
                called = true
                return { success: true }
            }
        } as Partial<SyncEngine>
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', 'default'); await next() })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))
        let remaining = 32 * 1024 * 1024
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (remaining === 0) {
                    controller.close()
                    return
                }
                const bytes = Math.min(1024 * 1024, remaining)
                remaining -= bytes
                controller.enqueue(new Uint8Array(bytes))
            }
        })
        const request = new Request('http://localhost/api/machines/machine-1/host/files/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            duplex: 'half'
        } as RequestInit & { duplex: 'half' })

        const response = await app.request(request)

        expect(response.status).toBe(413)
        expect(await response.json()).toEqual({ error: 'Payload too large' })
        expect(called).toBe(false)
    })

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
})
