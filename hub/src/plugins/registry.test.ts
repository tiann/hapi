import { describe, expect, it, mock } from 'bun:test'
import { HubPluginRegistry } from './registry'
import type { HubMessageActionContribution } from './types'

function messageAction(id: string, dispose?: () => void): HubMessageActionContribution {
    return {
        id,
        kind: 'chat.composer.messageAction',
        plan: () => ({ ok: true, plan: { type: 'immediate' } }),
        ...(dispose ? { dispose } : {})
    }
}

describe('HubPluginRegistry', () => {
    it('rejects registrations after activation is closed', () => {
        const registry = new HubPluginRegistry()
        const activation = registry.createContext({ pluginId: 'com.example.plugin' })
        activation.close()

        expect(() => activation.ctx.notifications.registerChannel({ async send() {} }))
            .toThrow('Plugin notification channels can only be registered during activate(ctx).')
        expect(() => activation.ctx.messages.registerAction(messageAction('send-later')))
            .toThrow('Plugin message actions can only be registered during activate(ctx).')
    })

    it('reports missing and undeclared secrets without exposing values', () => {
        const registry = new HubPluginRegistry()
        const activation = registry.createContext({
            pluginId: 'com.example.plugin',
            declaredSecrets: ['PLUGIN_TOKEN'],
            env: {}
        })

        expect(activation.ctx.secrets.get('OTHER_TOKEN')).toBeUndefined()
        expect(registry.diagnostics.map((entry) => entry.code)).toEqual(['missing-secret', 'undeclared-secret'])
        expect(JSON.stringify(registry.diagnostics)).not.toContain('secret-value')
    })

    it('exposes network fetch with declared permission checks', async () => {
        const registry = new HubPluginRegistry()
        const activation = registry.createContext({
            pluginId: 'com.example.plugin',
            declaredNetwork: ['https://api.example.com']
        })

        await expect(activation.ctx.network.fetch('https://other.example.com/secret-path')).rejects.toThrow('not declared')

        expect(registry.diagnostics.map((entry) => entry.code)).toEqual(['plugin-network-blocked'])
        expect(JSON.stringify(registry.diagnostics)).not.toContain('secret-path')
    })

    it('redacts declared secrets from logger messages and circular object arguments', () => {
        const registry = new HubPluginRegistry()
        const activation = registry.createContext({
            pluginId: 'com.example.plugin',
            declaredSecrets: ['PLUGIN_TOKEN'],
            env: { PLUGIN_TOKEN: 'secret-value' }
        })
        const circular: Record<string, unknown> = { nested: 'secret-value' }
        circular.self = circular
        const consoleInfo = mock(() => undefined)
        const originalInfo = console.info
        console.info = consoleInfo
        try {
            activation.ctx.logger.info('logger saw secret-value', circular)
        } finally {
            console.info = originalInfo
        }

        const calls = JSON.stringify(consoleInfo.mock.calls)
        expect(calls).not.toContain('secret-value')
        expect(calls).toContain('[REDACTED]')
        expect(calls).toContain('[Circular]')
    })

    it('disposes rollback registrations in reverse order and keeps earlier registrations', async () => {
        const registry = new HubPluginRegistry()
        const activation = registry.createContext({ pluginId: 'com.example.plugin' })
        const disposed: string[] = []

        activation.ctx.messages.registerAction(messageAction('first', () => disposed.push('first')))
        const startIndex = registry.getDisposableCount()
        activation.ctx.messages.registerAction(messageAction('second', () => disposed.push('second')))
        activation.ctx.messages.registerAction(messageAction('third', () => disposed.push('third')))

        await registry.disposeFrom(startIndex)

        expect(disposed).toEqual(['third', 'second'])
        expect(registry.getMessageActions().map((entry) => entry.id)).toEqual(['first'])

        await registry.dispose()

        expect(disposed).toEqual(['third', 'second', 'first'])
    })
})
