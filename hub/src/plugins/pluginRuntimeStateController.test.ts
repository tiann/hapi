import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginRuntimeStateController } from '@hapi/protocol/plugins/runtime/stateController'
import type { DiscoveredPluginRecord } from '@hapi/protocol/plugins/foundation'

function record(overrides: Partial<DiscoveredPluginRecord> = {}): DiscoveredPluginRecord {
    return {
        rootPath: '/plugins/com.example.plugin',
        manifestPath: '/plugins/com.example.plugin/hapi.plugin.json',
        source: 'user-home',
        status: 'validated',
        manifest: {
            id: 'com.example.plugin',
            name: 'Example',
            version: '0.1.0',
            pluginApiVersion: '0.1'
        },
        diagnostics: [],
        runtimeEntryPaths: [],
        ...overrides
    }
}

describe('PluginRuntimeStateController', () => {
    let testDir: string

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'hapi-plugin-state-controller-'))
    })

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true })
    })

    it('applies runtime-scoped config without mutating the discovered record', () => {
        const controller = new PluginRuntimeStateController({
            hapiHome: testDir,
            configScope: (pluginId) => `runner:runner-1:${pluginId}`,
            displayId: (entry) => entry.manifest?.id ?? entry.rootPath
        })
        const discovered = record({
            config: { stale: true },
            configUpdatedAt: 1,
            configSource: 'legacy-default'
        })

        const [resolved] = controller.applyScopedRuntimeConfig([discovered], {
            enabled: {
                'com.example.plugin': {
                    enabled: true,
                    config: { legacy: true },
                    scopedConfig: {
                        'runner:runner-1:com.example.plugin': {
                            config: { scoped: true },
                            updatedAt: 2
                        }
                    }
                }
            }
        })

        expect(discovered.config).toEqual({ stale: true })
        expect(resolved?.config).toEqual({ scoped: true })
        expect(resolved?.configUpdatedAt).toBe(2)
        expect(resolved?.configSource).toBe('scoped')
    })

    it('preserves default-enabled plugins when updating scoped config if requested', async () => {
        const controller = new PluginRuntimeStateController({
            hapiHome: testDir,
            configScope: (pluginId) => `hub:${pluginId}`,
            defaultEnabledPluginIds: () => ['com.example.plugin'],
            enableDefaultOnConfigUpdate: true,
            displayId: (entry) => entry.manifest?.id ?? entry.rootPath
        })

        const pluginId = await controller.updatePluginConfigState(
            'com.example.plugin',
            { label: 'hub' },
            async () => record()
        )

        const state = JSON.parse(readFileSync(join(testDir, 'plugins.json'), 'utf8')) as {
            enabled: Record<string, { enabled: boolean; scopedConfig?: Record<string, { config: Record<string, unknown> }> }>
        }
        expect(pluginId).toBe('com.example.plugin')
        expect(state.enabled['com.example.plugin']?.enabled).toBe(true)
        expect(state.enabled['com.example.plugin']?.scopedConfig?.['hub:com.example.plugin']?.config).toEqual({ label: 'hub' })
    })

    it('does not implicitly enable config-only updates unless configured', async () => {
        const controller = new PluginRuntimeStateController({
            hapiHome: testDir,
            configScope: (pluginId) => `runner:runner-1:${pluginId}`,
            defaultEnabledPluginIds: () => ['com.example.plugin'],
            displayId: (entry) => entry.manifest?.id ?? entry.rootPath
        })

        await controller.updatePluginConfigState(
            'com.example.plugin',
            { label: 'runner' },
            async () => record()
        )

        const state = JSON.parse(readFileSync(join(testDir, 'plugins.json'), 'utf8')) as {
            enabled: Record<string, { enabled: boolean }>
        }
        expect(state.enabled['com.example.plugin']?.enabled).toBe(false)
    })

    it('rejects writes while plugins.json is invalid', async () => {
        writeFileSync(join(testDir, 'plugins.json'), '{ invalid')
        const controller = new PluginRuntimeStateController({
            hapiHome: testDir,
            configScope: (pluginId) => `hub:${pluginId}`,
            displayId: (entry) => entry.manifest?.id ?? entry.rootPath
        })

        await expect(controller.enablePluginState('com.example.plugin', undefined, async () => record()))
            .rejects.toThrow('Cannot update plugins.json while it is invalid')
    })
})
