import { describe, expect, it } from 'bun:test'
import {
    AGENT_FLAVORS,
    PROVIDER_CAPABILITIES,
    PROVIDER_READINESS_FUTURE_SKEW_MS,
    PROVIDER_READINESS_MAX_AGE_MS,
    type AgentFlavor,
    type ProviderReadiness,
    type ProviderReadinessMap
} from '@hapi/protocol'
import { Hono } from 'hono'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createMachinesRoutes } from './machines'

function readyEntry(flavor: AgentFlavor, overrides: Partial<ProviderReadiness> = {}): ProviderReadiness {
    const authCheck = flavor === 'grok'
        ? 'credential-file' as const
        : ['claude', 'codex', 'cursor'].includes(flavor)
            ? 'command' as const
            : 'unavailable' as const
    return {
        status: 'ready',
        installed: true,
        authenticated: authCheck === 'unavailable' ? null : true,
        authCheck,
        version: flavor === 'grok' ? '0.2.101' : '1.2.3',
        ...PROVIDER_CAPABILITIES[flavor],
        checkedAt: Date.now(),
        ...overrides
    }
}

function readyMap(): ProviderReadinessMap {
    return Object.fromEntries(AGENT_FLAVORS.map((flavor) => [flavor, readyEntry(flavor)])) as ProviderReadinessMap
}

function createMachine(overrides?: Partial<Machine>): Machine {
    const base: Machine = {
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
            happyCliVersion: '0.0.0',
            providerReadiness: readyMap()
        },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1
    }

    return {
        ...base,
        ...overrides,
        metadata: overrides?.metadata === undefined
            ? base.metadata
            : overrides.metadata
    }
}

function createApp(machines: Machine[]) {
    const engine = {
        getMachine: (machineId: string) => machines.find((machine) => machine.id === machineId),
        getMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace),
        getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace && machine.active),
        spawnSession: async () => ({ type: 'success' as const, sessionId: 'session-1' })
    } as Partial<SyncEngine>

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

    return app
}

describe('machines routes', () => {
    it('fails closed with structured 409 responses and zero spawn RPC for unavailable readiness', async () => {
        const now = Date.now()
        const cases: Array<{
            name: string
            readiness?: ProviderReadiness
            metadata?: Machine['metadata']
            body?: Record<string, unknown>
            flavor?: AgentFlavor
            omitAgent?: boolean
            code: string
            recoveryCommand?: string
        }> = [
            {
                name: 'missing',
                metadata: { host: 'localhost', platform: 'darwin', happyCliVersion: '0.0.0' },
                code: 'provider-readiness-missing'
            },
            {
                name: 'omitted agent defaults to missing claude readiness',
                metadata: {
                    host: 'localhost',
                    platform: 'darwin',
                    happyCliVersion: '0.0.0',
                    providerReadiness: { grok: readyEntry('grok') }
                },
                omitAgent: true,
                code: 'provider-readiness-missing'
            },
            {
                name: 'malformed cache result',
                metadata: null,
                code: 'provider-readiness-missing'
            },
            {
                name: 'stale',
                readiness: readyEntry('grok', { checkedAt: now - PROVIDER_READINESS_MAX_AGE_MS - 1 }),
                code: 'provider-readiness-stale'
            },
            {
                name: 'future-skewed',
                readiness: readyEntry('grok', { checkedAt: now + PROVIDER_READINESS_FUTURE_SKEW_MS + 60_000 }),
                code: 'provider-readiness-stale'
            },
            {
                name: 'not installed',
                readiness: readyEntry('grok', {
                    status: 'not-installed', installed: false, authenticated: null, version: null
                }),
                code: 'provider-not-installed'
            },
            {
                name: 'not authenticated',
                readiness: readyEntry('grok', { status: 'not-authenticated', authenticated: false }),
                code: 'provider-not-authenticated',
                recoveryCommand: 'grok login --device-code'
            },
            {
                name: 'unsupported version',
                readiness: readyEntry('grok', { status: 'unsupported-version' }),
                code: 'provider-version-unsupported'
            },
            {
                name: 'probe failed',
                readiness: readyEntry('grok', { status: 'probe-failed', authenticated: null }),
                code: 'provider-probe-failed'
            },
            {
                name: 'model mismatch',
                readiness: readyEntry('grok', { models: ['auto'] }),
                body: { model: 'grok-4.5' },
                code: 'provider-model-unavailable'
            },
            {
                name: 'effort mismatch',
                readiness: readyEntry('grok', { efforts: { auto: ['low'], 'grok-4.5': ['low'] } }),
                body: { model: 'grok-4.5', effort: 'high' },
                code: 'provider-effort-unavailable'
            },
            {
                name: 'codex reasoning effort mismatch',
                flavor: 'codex',
                readiness: readyEntry('codex', { efforts: { auto: ['low'], 'gpt-5.4': ['low'] } }),
                body: { model: 'gpt-5.4', modelReasoningEffort: 'high' },
                code: 'provider-effort-unavailable'
            },
            {
                name: 'mode mismatch',
                readiness: readyEntry('grok', { modes: ['default'] }),
                body: { permissionMode: 'safe-yolo' },
                code: 'provider-mode-unavailable'
            },
            {
                name: 'legacy Claude yolo mismatch',
                flavor: 'claude',
                readiness: readyEntry('claude', { modes: ['default'] }),
                body: { yolo: true },
                code: 'provider-mode-unavailable'
            },
            {
                name: 'omitted agy model resolves to an unreported default',
                flavor: 'agy',
                readiness: readyEntry('agy', { models: ['Gemini 3.5 Flash (Low)'] }),
                code: 'provider-model-unavailable'
            },
            {
                name: 'omitted DeepSeek effort resolves to unreported max',
                flavor: 'claude-deepseek',
                readiness: readyEntry('claude-deepseek', {
                    efforts: { auto: ['auto', 'low', 'medium', 'high'] }
                }),
                code: 'provider-effort-unavailable'
            },
            {
                name: 'omitted permission mode resolves to unreported default',
                readiness: readyEntry('grok', { modes: ['safe-yolo'] }),
                code: 'provider-mode-unavailable'
            }
        ]

        for (const testCase of cases) {
            let spawnCalls = 0
            const flavor = testCase.flavor ?? 'grok'
            const metadata = testCase.metadata === undefined
                ? {
                    host: 'localhost',
                    platform: 'darwin',
                    happyCliVersion: '0.0.0',
                    providerReadiness: testCase.readiness ? { [flavor]: testCase.readiness } : undefined
                }
                : testCase.metadata
            const machines = [createMachine({ metadata })]
            const engine = {
                getMachine: (machineId: string) => machines.find((machine) => machine.id === machineId),
                getMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace),
                getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace && machine.active),
                spawnSession: async () => {
                    spawnCalls += 1
                    return { type: 'success' as const, sessionId: 'unexpected' }
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
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    directory: '/tmp/project',
                    ...(testCase.omitAgent ? {} : { agent: flavor }),
                    ...testCase.body
                })
            })

            expect(response.status, testCase.name).toBe(409)
            expect(await response.json(), testCase.name).toMatchObject({
                code: testCase.code,
                ...(testCase.recoveryCommand ? { recoveryCommand: testCase.recoveryCommand } : {})
            })
            expect(spawnCalls, testCase.name).toBe(0)
        }
    })

    it('forwards exactly once when machine readiness and selection are fresh', async () => {
        let spawnCalls = 0
        const machines = [createMachine()]
        const engine = {
            getMachine: (machineId: string) => machines.find((machine) => machine.id === machineId),
            getMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace),
            getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace && machine.active),
            spawnSession: async () => {
                spawnCalls += 1
                return { type: 'success' as const, sessionId: 'session-grok' }
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                directory: '/tmp/project',
                agent: 'grok',
                model: 'grok-4.5',
                effort: 'high',
                permissionMode: 'safe-yolo'
            })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ type: 'success', sessionId: 'session-grok' })
        expect(spawnCalls).toBe(1)
    })

    it('includes known and offline machine counts for the current namespace', async () => {
        const app = createApp([
            createMachine({ id: 'online-machine', active: true }),
            createMachine({ id: 'offline-machine', active: false }),
            createMachine({ id: 'other-namespace-machine', namespace: 'other', active: false }),
        ])

        const beforeRequest = Date.now()
        const response = await app.request('/api/machines')
        const afterRequest = Date.now()

        expect(response.status).toBe(200)
        const body = await response.json() as Record<string, unknown> & { serverTime: number }
        expect(body).toEqual({
            machines: [expect.objectContaining({ id: 'online-machine', active: true })],
            knownMachinesCount: 2,
            offlineMachinesCount: 1,
            serverTime: expect.any(Number)
        })
        expect(body.serverTime).toBeGreaterThanOrEqual(beforeRequest)
        expect(body.serverTime).toBeLessThanOrEqual(afterRequest)
    })

    it('passes service tier when spawning a Codex session', async () => {
        let capturedServiceTier: string | undefined
        let capturedSpawnRequestId: string | undefined
        const machines = [createMachine({ id: 'machine-1', active: true })]
        const engine = {
            getMachine: (machineId: string) => machines.find((machine) => machine.id === machineId),
            getMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace),
            getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace && machine.active),
            querySpawnSession: async (_machineId: string, spawnRequestId: string) => ({
                type: 'not_found' as const,
                spawnRequestId
            }),
            spawnSession: async (...args: unknown[]) => {
                capturedServiceTier = args[11] as string | undefined
                capturedSpawnRequestId = args[12] as string | undefined
                return { type: 'success' as const, sessionId: 'session-codex-fast' }
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                spawnRequestId: '11111111-1111-4111-8111-111111111111',
                directory: '/tmp/project',
                agent: 'codex',
                serviceTier: 'fast'
            })
        })

        expect(response.status).toBe(200)
        expect(capturedServiceTier).toBe('fast')
        expect(capturedSpawnRequestId).toBe('11111111-1111-4111-8111-111111111111')
        expect(await response.json()).toEqual({ type: 'success', sessionId: 'session-codex-fast' })
    })

    it('recovers an existing spawn request before applying a now-stale readiness preflight', async () => {
        let queryCalls = 0
        let spawnCalls = 0
        let queriedOptions: Record<string, unknown> | undefined
        const machines = [createMachine({
            id: 'machine-1',
            active: true,
            metadata: {
                host: 'localhost',
                platform: 'darwin',
                happyCliVersion: '0.0.0',
                providerReadiness: {
                    codex: readyEntry('codex', {
                        checkedAt: Date.now() - PROVIDER_READINESS_MAX_AGE_MS - 1
                    })
                }
            }
        })]
        const engine = {
            getMachine: (machineId: string) => machines.find((machine) => machine.id === machineId),
            getMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace),
            getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace && machine.active),
            querySpawnSession: async (_machineId: string, spawnRequestId: string, expectedOptions?: Record<string, unknown>) => {
                queryCalls += 1
                expect(spawnRequestId).toBe('51515151-5151-4515-8515-515151515151')
                queriedOptions = expectedOptions
                return { type: 'success' as const, sessionId: 'session-already-created' }
            },
            spawnSession: async () => {
                spawnCalls += 1
                return { type: 'success' as const, sessionId: 'session-duplicate' }
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                spawnRequestId: '51515151-5151-4515-8515-515151515151',
                directory: '/tmp/project',
                agent: 'codex'
            })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            type: 'success',
            sessionId: 'session-already-created'
        })
        expect(queryCalls).toBe(1)
        expect(spawnCalls).toBe(0)
        expect(queriedOptions).toMatchObject({
            directory: '/tmp/project',
            agent: 'codex'
        })
    })

    it('queries a pending spawn by the same stable request ID', async () => {
        const machines = [createMachine({ id: 'machine-1', active: true })]
        let captured: { machineId: string; spawnRequestId: string } | null = null
        const engine = {
            getMachine: (machineId: string) => machines.find((machine) => machine.id === machineId),
            getMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace),
            getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace && machine.active),
            querySpawnSession: async (machineId: string, spawnRequestId: string) => {
                captured = { machineId, spawnRequestId }
                return { type: 'pending' as const, spawnRequestId }
            }
        } as Partial<SyncEngine>
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request(
            '/api/machines/machine-1/spawn/11111111-1111-4111-8111-111111111111'
        )

        expect(response.status).toBe(200)
        expect(captured as unknown).toEqual({
            machineId: 'machine-1',
            spawnRequestId: '11111111-1111-4111-8111-111111111111'
        })
        expect(await response.json()).toEqual({
            type: 'pending',
            spawnRequestId: '11111111-1111-4111-8111-111111111111'
        })
    })

    it('accepts CC-deepseek as a spawn agent', async () => {
        let capturedAgent: string | undefined
        const machines = [createMachine({ id: 'machine-1', active: true })]
        const engine = {
            getMachine: (machineId: string) => machines.find((machine) => machine.id === machineId),
            getMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace),
            getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace && machine.active),
            spawnSession: async (
                _machineId: string,
                _directory: string,
                agent?: string
            ) => {
                capturedAgent = agent
                return { type: 'success' as const, sessionId: 'session-cc-deepseek' }
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                directory: '/tmp/project',
                agent: 'claude-deepseek'
            })
        })

        expect(response.status).toBe(200)
        expect(capturedAgent).toBe('claude-deepseek')
        expect(await response.json()).toEqual({ type: 'success', sessionId: 'session-cc-deepseek' })
    })

    it('accepts CC-ark as a spawn agent', async () => {
        let capturedAgent: string | undefined
        const machines = [createMachine({ id: 'machine-1', active: true })]
        const engine = {
            getMachine: (machineId: string) => machines.find((machine) => machine.id === machineId),
            getMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace),
            getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace && machine.active),
            spawnSession: async (
                _machineId: string,
                _directory: string,
                agent?: string
            ) => {
                capturedAgent = agent
                return { type: 'success' as const, sessionId: 'session-cc-ark' }
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                directory: '/tmp/project',
                agent: 'claude-ark'
            })
        })

        expect(response.status).toBe(200)
        expect(capturedAgent).toBe('claude-ark')
        expect(await response.json()).toEqual({ type: 'success', sessionId: 'session-cc-ark' })
    })

    it('accepts Antigravity agy with a live preset model as a spawn agent', async () => {
        let capturedAgent: string | undefined
        let capturedModel: string | undefined
        const machines = [createMachine({ id: 'machine-1', active: true })]
        const engine = {
            getMachine: (machineId: string) => machines.find((machine) => machine.id === machineId),
            getMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace),
            getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace && machine.active),
            spawnSession: async (
                _machineId: string,
                _directory: string,
                agent?: string,
                model?: string
            ) => {
                capturedAgent = agent
                capturedModel = model
                return { type: 'success' as const, sessionId: 'session-agy' }
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                directory: '/tmp/project',
                agent: 'agy',
                model: 'Gemini 3.5 Flash (High)'
            })
        })

        expect(response.status).toBe(200)
        expect(capturedAgent).toBe('agy')
        expect(capturedModel).toBe('Gemini 3.5 Flash (High)')
        expect(await response.json()).toEqual({ type: 'success', sessionId: 'session-agy' })
    })

    it('passes Antigravity agy permission mode through on spawn', async () => {
        let capturedPermissionMode: string | undefined
        const machines = [createMachine({ id: 'machine-1', active: true })]
        const engine = {
            getMachine: (machineId: string) => machines.find((machine) => machine.id === machineId),
            getMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace),
            getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace && machine.active),
            spawnSession: async (...args: unknown[]) => {
                capturedPermissionMode = args[10] as string | undefined
                return { type: 'success' as const, sessionId: 'session-agy-safe-yolo' }
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                directory: '/tmp/project',
                agent: 'agy',
                model: 'Gemini 3.5 Flash (High)',
                permissionMode: 'safe-yolo'
            })
        })

        expect(response.status).toBe(200)
        expect(capturedPermissionMode).toBe('safe-yolo')
        expect(await response.json()).toEqual({ type: 'success', sessionId: 'session-agy-safe-yolo' })
    })

    it('rejects permission modes that are unsupported for the selected agent', async () => {
        let spawnCalls = 0
        const machines = [createMachine({ id: 'machine-1', active: true })]
        const engine = {
            getMachine: (machineId: string) => machines.find((machine) => machine.id === machineId),
            getMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace),
            getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace && machine.active),
            spawnSession: async () => {
                spawnCalls += 1
                return { type: 'success' as const, sessionId: 'session-claude' }
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                directory: '/tmp/project',
                agent: 'claude',
                permissionMode: 'safe-yolo'
            })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Unsupported permission mode for claude: safe-yolo' })
        expect(spawnCalls).toBe(0)
    })

    it('rejects unsupported Antigravity agy model on spawn', async () => {
        let spawnCalls = 0
        const machines = [createMachine({ id: 'machine-1', active: true })]
        const engine = {
            getMachine: (machineId: string) => machines.find((machine) => machine.id === machineId),
            getMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace),
            getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace && machine.active),
            spawnSession: async () => {
                spawnCalls += 1
                return { type: 'success' as const, sessionId: 'session-agy' }
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                directory: '/tmp/project',
                agent: 'agy',
                model: 'not-a-live-agy-model'
            })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Unknown Antigravity agy model: not-a-live-agy-model' })
        expect(spawnCalls).toBe(0)
    })

    it('accepts CC-api as a spawn agent', async () => {
        let capturedAgent: string | undefined
        const machines = [createMachine({ id: 'machine-1', active: true })]
        const engine = {
            getMachine: (machineId: string) => machines.find((machine) => machine.id === machineId),
            getMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace),
            getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace && machine.active),
            spawnSession: async (
                _machineId: string,
                _directory: string,
                agent?: string
            ) => {
                capturedAgent = agent
                return { type: 'success' as const, sessionId: 'session-cc-api' }
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                directory: '/tmp/project',
                agent: 'cc-api'
            })
        })

        expect(response.status).toBe(200)
        expect(capturedAgent).toBe('cc-api')
        expect(await response.json()).toEqual({ type: 'success', sessionId: 'session-cc-api' })
    })

    it('accepts Hermes MoA as a spawn agent with a selected GPT-5.6 Sol preset and permission mode', async () => {
        let capturedAgent: string | undefined
        let capturedModel: string | undefined
        let capturedPermissionMode: string | undefined
        const machines = [createMachine({ id: 'machine-1', active: true })]
        const engine = {
            getMachine: (machineId: string) => machines.find((machine) => machine.id === machineId),
            getMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace),
            getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace && machine.active),
            spawnSession: async (
                _machineId: string,
                _directory: string,
                agent?: string,
                model?: string,
                _modelReasoningEffort?: string,
                _yolo?: boolean,
                _sessionType?: string,
                _worktreeName?: string,
                _resumeSessionId?: string,
                _effort?: string,
                permissionMode?: string
            ) => {
                capturedAgent = agent
                capturedModel = model
                capturedPermissionMode = permissionMode
                return { type: 'success' as const, sessionId: 'session-hermes-moa' }
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                directory: '/tmp/project',
                agent: 'hermes-moa',
                model: 'gpt-5.6-sol-max',
                permissionMode: 'yolo'
            })
        })

        expect(response.status).toBe(200)
        expect(capturedAgent).toBe('hermes-moa')
        expect(capturedModel).toBe('gpt-5.6-sol-max')
        expect(capturedPermissionMode).toBe('yolo')
        expect(await response.json()).toEqual({ type: 'success', sessionId: 'session-hermes-moa' })
    })

    it('rejects unsupported Hermes MoA presets on spawn', async () => {
        let spawnCalls = 0
        const machines = [createMachine({ id: 'machine-1', active: true })]
        const engine = {
            getMachine: (machineId: string) => machines.find((machine) => machine.id === machineId),
            getMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace),
            getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace && machine.active),
            spawnSession: async () => {
                spawnCalls += 1
                return { type: 'success' as const, sessionId: 'session-hermes-moa' }
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                directory: '/tmp/project',
                agent: 'hermes-moa',
                model: 'not-a-moa-preset'
            })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Unknown Hermes MoA preset: not-a-moa-preset' })
        expect(spawnCalls).toBe(0)
    })

    it('rejects unsupported CC-api effort/model combinations on spawn', async () => {
        let spawnCalls = 0
        const machines = [createMachine({ id: 'machine-1', active: true })]
        const engine = {
            getMachine: (machineId: string) => machines.find((machine) => machine.id === machineId),
            getMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace),
            getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace && machine.active),
            spawnSession: async () => {
                spawnCalls += 1
                return { type: 'success' as const, sessionId: 'session-cc-api' }
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                directory: '/tmp/project',
                agent: 'cc-api',
                model: 'kimi-k3',
                effort: 'high'
            })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Effort selection is not supported for the current CC-api model' })
        expect(spawnCalls).toBe(0)
    })

    it('forwards selected CC-deepseek model and official effort on spawn', async () => {
        let capturedModel: string | undefined
        let capturedEffort: string | undefined
        const machines = [createMachine({ id: 'machine-1', active: true })]
        const engine = {
            getMachine: (machineId: string) => machines.find((machine) => machine.id === machineId),
            getMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace),
            getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace && machine.active),
            spawnSession: async (...args: unknown[]) => {
                capturedModel = args[3] as string | undefined
                capturedEffort = args[9] as string | undefined
                return { type: 'success' as const, sessionId: 'session-cc-deepseek' }
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                directory: '/tmp/project',
                agent: 'claude-deepseek',
                model: 'deepseek-v4-flash',
                effort: 'high'
            })
        })

        expect(response.status).toBe(200)
        expect(capturedModel).toBe('deepseek-v4-flash')
        expect(capturedEffort).toBe('high')
    })

    it('rejects unsupported CC-deepseek effort on spawn', async () => {
        let spawnCalls = 0
        const machines = [createMachine({ id: 'machine-1', active: true })]
        const engine = {
            getMachine: (machineId: string) => machines.find((machine) => machine.id === machineId),
            getMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace),
            getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => machine.namespace === namespace && machine.active),
            spawnSession: async () => {
                spawnCalls += 1
                return { type: 'success' as const, sessionId: 'session-cc-deepseek' }
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                directory: '/tmp/project',
                agent: 'claude-deepseek',
                model: 'deepseek-v4-pro[1m]',
                effort: 'medium'
            })
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Effort selection is not supported for the current CC-deepseek model' })
        expect(spawnCalls).toBe(0)
    })
})
