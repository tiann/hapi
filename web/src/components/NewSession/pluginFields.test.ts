import { describe, expect, it } from 'vitest'
import {
    buildNewSessionPluginFieldPayload,
    collectNewSessionPluginFields,
    newSessionPluginFieldStorageKey,
    validateNewSessionPluginFieldValues
} from './pluginFields'
import type { PluginWebContributionView } from '@hapi/protocol/plugins'

const contributions: PluginWebContributionView[] = [{
    pluginId: 'com.example.plugin',
    pluginName: 'Example Plugin',
    target: 'runner:machine-1',
    contributions: {
        newSessionFields: [
            { id: 'profile', key: 'profile', label: 'Profile', type: 'select', required: true, agentIds: ['vendor:example-agent'], options: [{ value: 'fast', label: 'Fast' }] },
            { id: 'ignored', key: 'ignored', label: 'Ignored', type: 'text', agentIds: ['claude'] }
        ]
    }
}]

describe('new session plugin fields', () => {
    it('filters descriptor fields by agent and validates required values', () => {
        const fields = collectNewSessionPluginFields(contributions, 'vendor:example-agent')
        expect(fields).toHaveLength(1)
        expect(fields[0].key).toBe('profile')

        const errors = validateNewSessionPluginFieldValues(fields, {})
        expect(errors).toEqual([{ key: 'com.example.plugin.profile', message: 'Profile is required.' }])
    })

    it('localizes descriptor labels and validation messages', () => {
        const fields: typeof contributions[0]['contributions']['newSessionFields'] = [
            {
                id: 'profile',
                key: 'profile',
                label: { en: 'Profile', 'zh-CN': '配置' },
                type: 'select',
                required: true,
                options: [{ value: 'fast', label: { en: 'Fast', 'zh-CN': '快速' } }]
            }
        ]
        const collected = collectNewSessionPluginFields([{ ...contributions[0], contributions: { newSessionFields: fields } }], 'vendor:example-agent')

        expect(validateNewSessionPluginFieldValues(collected, {}, 'zh-CN')).toEqual([
            { key: 'com.example.plugin.profile', message: '请填写配置。' }
        ])
        expect(validateNewSessionPluginFieldValues(collected, { 'com.example.plugin.profile': 'slow' }, 'zh-CN')).toEqual([
            { key: 'com.example.plugin.profile', message: '配置必须是列表中的选项。' }
        ])
    })

    it('builds a plugin-scoped payload after validation succeeds', () => {
        const fields = collectNewSessionPluginFields(contributions, 'vendor:example-agent')
        const key = newSessionPluginFieldStorageKey(fields[0])
        expect(validateNewSessionPluginFieldValues(fields, { [key]: 'fast' })).toHaveLength(0)
        expect(buildNewSessionPluginFieldPayload(fields, { [key]: 'fast' })).toEqual({
            'com.example.plugin': { profile: 'fast' }
        })
    })

    it('rejects invalid select and number values', () => {
        const fields: typeof contributions[0]['contributions']['newSessionFields'] = [
            { id: 'profile', key: 'profile', label: 'Profile', type: 'select', options: [{ value: 'fast' }] },
            { id: 'budget', key: 'budget', label: 'Budget', type: 'number' }
        ]
        const collected = collectNewSessionPluginFields([{ ...contributions[0], contributions: { newSessionFields: fields } }], 'vendor:example-agent')
        expect(validateNewSessionPluginFieldValues(collected, {
            'com.example.plugin.profile': 'slow',
            'com.example.plugin.budget': 'abc'
        })).toEqual([
            { key: 'com.example.plugin.profile', message: 'Profile must be one of the listed options.' },
            { key: 'com.example.plugin.budget', message: 'Budget must be a finite number.' }
        ])
        expect(buildNewSessionPluginFieldPayload(collected, {
            'com.example.plugin.profile': 'slow',
            'com.example.plugin.budget': 'abc'
        })).toBeUndefined()
    })
})
