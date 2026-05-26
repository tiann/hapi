import { describe, expect, it, vi } from 'vitest'
import { RunnerPluginRegistry } from './runnerPluginRegistry'
import { logger as runnerLogger } from '@/ui/logger'
import type { RunnerEnvironmentProviderContribution } from '@hapi/protocol/plugins'

function environmentProvider(id: string, dispose?: () => void): RunnerEnvironmentProviderContribution {
    return {
        id,
        ...(dispose ? { dispose } : {})
    }
}

function backendStub() {
    return {
        async initialize() {},
        async newSession() { return 'session' },
        async prompt() {},
        async cancelPrompt() {},
        async respondToPermission() {},
        onPermissionRequest() {},
        async disconnect() {}
    }
}

describe('RunnerPluginRegistry', () => {
    it('rejects registrations after activation is closed', () => {
        const registry = new RunnerPluginRegistry('runner-1')
        const activation = registry.createContext({ pluginId: 'com.example.runner' })
        activation.close()

        expect(() => activation.ctx.runtime.registerEnvironmentProvider(environmentProvider('env')))
            .toThrow('Runner plugin runtime contributions can only be registered during activate(ctx).')
    })

    it('keeps stable contribution order and filters disposed entries', async () => {
        const registry = new RunnerPluginRegistry('runner-1')
        const activation = registry.createContext({ pluginId: 'com.example.runner' })

        const first = activation.ctx.runtime.registerEnvironmentProvider({ id: 'env-a', priority: 10 })
        activation.ctx.runtime.registerEnvironmentProvider({ id: 'env-b', priority: -1 })

        expect(registry.getEnvironmentProviders().map((entry) => ({
            id: entry.id,
            priority: entry.priority,
            order: entry.order
        }))).toEqual([
            { id: 'env-a', priority: 10, order: 0 },
            { id: 'env-b', priority: -1, order: 1 }
        ])

        await first.dispose()

        expect(registry.getEnvironmentProviders().map((entry) => entry.id)).toEqual(['env-b'])
    })

    it('disposes rollback registrations in reverse order and keeps earlier registrations', async () => {
        const registry = new RunnerPluginRegistry('runner-1')
        const activation = registry.createContext({ pluginId: 'com.example.runner' })
        const disposed: string[] = []

        activation.ctx.runtime.registerEnvironmentProvider(environmentProvider('first', () => disposed.push('first')))
        const startIndex = registry.getDisposableCount()
        activation.ctx.runtime.registerEnvironmentProvider(environmentProvider('second', () => disposed.push('second')))
        activation.ctx.runtime.registerEnvironmentProvider(environmentProvider('third', () => disposed.push('third')))

        await registry.disposeFrom(startIndex)

        expect(disposed).toEqual(['third', 'second'])
        expect(registry.getEnvironmentProviders().map((entry) => entry.id)).toEqual(['first'])

        await registry.dispose()

        expect(disposed).toEqual(['third', 'second', 'first'])
    })

    it('reports missing and undeclared secrets with runner diagnostic prefix', () => {
        const registry = new RunnerPluginRegistry('runner-1')
        const activation = registry.createContext({
            pluginId: 'com.example.runner',
            declaredSecrets: ['RUNNER_TOKEN'],
            env: {}
        })

        expect(activation.ctx.secrets.get('OTHER_TOKEN')).toBeUndefined()
        expect(registry.diagnostics.map((entry) => entry.code)).toEqual(['missing-secret', 'undeclared-secret'])
        expect(registry.diagnostics.every((entry) => entry.message.startsWith('[runner-plugin:runner-1:com.example.runner]'))).toBe(true)
    })

    it('exposes network fetch with runner diagnostic prefix', async () => {
        const registry = new RunnerPluginRegistry('runner-1')
        const activation = registry.createContext({
            pluginId: 'com.example.runner',
            declaredNetwork: ['https://api.example.com']
        })

        await expect(activation.ctx.network.fetch('https://other.example.com/secret-path')).rejects.toThrow('not declared')

        expect(registry.diagnostics.map((entry) => entry.code)).toEqual(['plugin-network-blocked'])
        expect(registry.diagnostics[0]?.message.startsWith('[runner-plugin:runner-1:com.example.runner]')).toBe(true)
        expect(JSON.stringify(registry.diagnostics)).not.toContain('secret-path')
    })

    it('allows agent ids with namespaces while contribution ids stay manifest-local', () => {
        const registry = new RunnerPluginRegistry('runner-1')
        const activation = registry.createContext({ pluginId: 'com.example.runner' })

        activation.ctx.runtime.registerAgentAdapter({
            id: 'example-adapter',
            descriptor: {
                id: 'vendor:example-agent',
                displayName: 'Example Agent',
                source: 'plugin',
                available: true,
                adapter: {
                    runtime: 'runner',
                    kind: 'custom-runner-plugin',
                    contributionId: 'example-adapter'
                },
                capabilities: { permissionModes: ['default'] }
            },
            createBackend: () => backendStub()
        })

        expect(registry.getAgentAdapters()[0]).toMatchObject({
            id: 'example-adapter',
            contribution: {
                descriptor: {
                    id: 'vendor:example-agent',
                    adapter: { contributionId: 'example-adapter' }
                }
            }
        })
    })

    it('rejects agent adapter contribution ids that do not match descriptor metadata', () => {
        const registry = new RunnerPluginRegistry('runner-1')
        const activation = registry.createContext({ pluginId: 'com.example.runner' })

        expect(() => activation.ctx.runtime.registerAgentAdapter({
            id: 'example-adapter',
            descriptor: {
                id: 'vendor:example-agent',
                displayName: 'Example Agent',
                source: 'plugin',
                available: true,
                adapter: {
                    runtime: 'runner',
                    kind: 'custom-runner-plugin',
                    contributionId: 'other-adapter'
                },
                capabilities: { permissionModes: ['default'] }
            },
            createBackend: () => backendStub()
        })).toThrow('agentAdapter id must match descriptor.adapter.contributionId')
    })

    it('redacts declared secrets from dispose failure logs', async () => {
        const debug = vi.spyOn(runnerLogger, 'debug').mockImplementation(() => undefined)
        try {
            const registry = new RunnerPluginRegistry('runner-1')
            const activation = registry.createContext({
                pluginId: 'com.example.runner',
                declaredSecrets: ['RUNNER_TOKEN'],
                env: { RUNNER_TOKEN: 'super-secret-value' }
            })
            activation.ctx.runtime.registerEnvironmentProvider(environmentProvider('env', () => {
                throw new Error('dispose failed super-secret-value')
            }))

            await registry.dispose()

            expect(debug).toHaveBeenCalled()
            expect(JSON.stringify(debug.mock.calls)).toContain('[REDACTED]')
            expect(JSON.stringify(debug.mock.calls)).not.toContain('super-secret-value')
        } finally {
            debug.mockRestore()
        }
    })
})
