import { describe, expect, it } from 'vitest'
import {
    localizedCapabilityDescription,
    localizedCapabilityName,
    localizedContributionName,
    localizedPluginDescription,
    localizedPluginName,
    pluginFeatureIntroMarkdown
} from './plugin-metadata'
import type { PluginCapabilityView, PluginDetail } from '@hapi/protocol/plugins/admin'

const plugin = {
    id: 'com.example.plugin',
    name: 'Example Plugin',
    description: 'English fallback',
    display: {
        name: { en: 'Example Plugin', 'zh-CN': '示例插件' },
        description: { en: 'Localized English', 'zh-CN': '本地化中文描述' },
        featureIntro: {
            en: '- English overview',
            'zh-CN': '- 中文功能介绍'
        }
    }
} as unknown as PluginDetail

const capability = {
    pluginId: 'com.example.plugin',
    capabilityId: 'example-capability',
    kind: 'settings.panel',
    displayName: 'Example Capability',
    description: 'English capability fallback',
    display: {
        name: { en: 'Example Capability', 'zh-CN': '示例能力' },
        description: { en: 'Localized capability', 'zh-CN': '本地化能力描述' }
    },
    status: 'ready',
    parts: {},
    diagnostics: []
} as PluginCapabilityView

describe('plugin metadata localization', () => {
    it('localizes plugin and capability metadata from display blocks', () => {
        expect(localizedPluginName(plugin, 'zh-CN')).toBe('示例插件')
        expect(localizedPluginDescription(plugin, 'zh-CN')).toBe('本地化中文描述')
        expect(localizedCapabilityName(capability, 'zh-CN')).toBe('示例能力')
        expect(localizedCapabilityDescription(capability, 'zh-CN')).toBe('本地化能力描述')
    })

    it('localizes contribution fallback objects without rendering [object Object]', () => {
        expect(localizedContributionName({
            pluginId: 'com.example.plugin',
            contributionId: 'settings',
            fallback: { en: 'Settings panel', 'zh-CN': '设置面板' },
            locale: 'zh-CN',
            unknownLabel: '未知'
        })).toBe('设置面板')
    })

    it('returns explicit markdown feature introduction as authored', () => {
        const markdown = pluginFeatureIntroMarkdown(plugin, 'zh-CN')
        expect(markdown).toBe('- 中文功能介绍')
    })

    it('uses plugin description as fallback feature introduction', () => {
        const withoutIntro = { ...plugin, display: { ...plugin.display, featureIntro: undefined } } as PluginDetail
        const markdown = pluginFeatureIntroMarkdown(withoutIntro, 'zh-CN')
        expect(markdown).toBe('本地化中文描述')
        expect(markdown).not.toContain('示例能力')
    })
})
