import { describe, expect, it } from 'vitest'
import { PluginWebContributionsSchema, type PluginCapabilityView } from '@hapi/protocol/plugins'
import { collectPluginMessageComposerActions } from './composerActions'

describe('composer action contributions', () => {
    it('accepts plugin message composer actions in the plugin web schema', () => {
        const parsed = PluginWebContributionsSchema.safeParse({
            composerActions: [{
                id: 'schedule',
                kind: 'pluginMessageAction',
                capabilityId: 'schedule',
                label: { en: 'Schedule', 'zh-CN': '定时' },
                icon: 'clock',
                handler: { position: 'hub', actionId: 'schedule' },
                ui: {
                    kind: 'delayPicker',
                    maxDelayMs: 60_000,
                    presets: [{ id: 'one-minute', label: '+1m', delayMs: 60_000 }]
                }
            }]
        })

        expect(parsed.success).toBe(true)
    })

    it('collects ready plugin message actions from capability inventories', () => {
        const capability: PluginCapabilityView = {
            pluginId: 'com.example.scheduler',
            pluginName: 'Example Scheduler',
            pluginVersion: '0.1.0',
            capabilityId: 'schedule',
            kind: 'chat.composer.messageAction',
            status: 'ready',
            parts: {
                web: { status: 'ready', required: true, declared: true, registered: true, active: true, diagnostics: [] },
                hub: { status: 'ready', required: true, declared: true, registered: true, active: true, diagnostics: [] }
            },
            diagnostics: [],
            web: {
                composerActions: [{
                    id: 'custom-schedule',
                    kind: 'pluginMessageAction',
                    capabilityId: 'schedule',
                    label: 'Custom schedule',
                    icon: 'clock',
                    handler: { position: 'hub', actionId: 'custom-schedule' },
                    ui: {
                        kind: 'delayPicker',
                        maxDelayMs: 120_000,
                        presets: [{ id: 'two-minutes', label: '+2m', delayMs: 120_000 }]
                    }
                }]
            }
        }

        const actions = collectPluginMessageComposerActions([capability])

        expect(actions[0]).toMatchObject({
            id: 'custom-schedule',
            pluginId: 'com.example.scheduler',
            capabilityId: 'schedule',
            ui: {
                kind: 'delayPicker',
                presets: [{ id: 'two-minutes', label: '+2m', delayMs: 120_000 }]
            }
        })
        expect(collectPluginMessageComposerActions([])).toEqual([])
    })
})
