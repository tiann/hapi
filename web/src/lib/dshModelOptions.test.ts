import { describe, expect, it } from 'vitest'
import { buildDshModelOptions, getDshReasoningOptions } from './dshModelOptions'

const models = [
    {
        provider: 'deepseek-official',
        providerName: 'DeepSeek',
        modelId: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        reasoningEfforts: [
            { id: 'high', name: 'High', isDefault: false },
            { id: 'max', name: 'Max', isDefault: true }
        ]
    },
    {
        provider: 'proxy',
        providerName: 'Proxy',
        modelId: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        reasoningEfforts: [{ id: 'medium', name: 'Medium', isDefault: true }]
    }
]

describe('DeepSeek Harness model options', () => {
    it('keeps the current duplicate model bare and qualifies the other provider', () => {
        const current = { provider: 'deepseek-official', modelId: 'deepseek-v4-pro', reasoningEffort: 'max' }
        expect(buildDshModelOptions(models, current)).toEqual([
            { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro (DeepSeek)' },
            { value: 'proxy/deepseek-v4-pro', label: 'DeepSeek V4 Pro (Proxy)' }
        ])
    })

    it('qualifies every duplicate when no native session owns the selection yet', () => {
        expect(buildDshModelOptions(models, null)).toEqual([
            { value: 'deepseek-official/deepseek-v4-pro', label: 'DeepSeek V4 Pro (DeepSeek)' },
            { value: 'proxy/deepseek-v4-pro', label: 'DeepSeek V4 Pro (Proxy)' }
        ])
    })

    it('returns reasoning efforts for the selected provider-qualified model', () => {
        expect(getDshReasoningOptions(
            models,
            { provider: 'deepseek-official', modelId: 'deepseek-v4-pro' },
            'proxy/deepseek-v4-pro'
        )).toEqual([{ value: 'medium', name: 'Medium' }])
    })

    it('does not infer fresh-session reasoning options from another session current provider', () => {
        expect(getDshReasoningOptions(models, null, 'auto')).toEqual([])
    })
})
