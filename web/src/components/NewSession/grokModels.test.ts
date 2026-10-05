import { describe, expect, it } from 'vitest'
import {
    buildGrokEffortOptions,
    buildGrokModelOptions,
    shouldEnableGrokModelDiscovery,
    buildKimiModelOptions,
    buildKimiSessionModelOptions,
    shouldEnableKimiModelDiscovery
} from './grokModels'

describe('Grok Create-session options', () => {
    it('enables model discovery only for an existing cwd on the target machine', () => {
        const args = {
            agent: 'grok' as const,
            machineId: 'machine-1',
            cwd: '/home/user/project',
            cwdExists: true,
        }

        expect(shouldEnableGrokModelDiscovery(args)).toBe(true)
        expect(shouldEnableGrokModelDiscovery({ ...args, cwdExists: undefined })).toBe(false)
        expect(shouldEnableGrokModelDiscovery({ ...args, agent: 'claude' })).toBe(false)
    })

    it('shows Default plus every discovered Grok model', () => {
        expect(buildGrokModelOptions([
            { modelId: 'grok-4.5' },
            { modelId: 'custom-fast', name: 'Custom Fast' }
        ])).toEqual([
            { value: 'auto', label: 'Default' },
            { value: 'grok-4.5', label: 'grok-4.5' },
            { value: 'custom-fast', label: 'Custom Fast' }
        ])
    })

    it('uses the selected model ACP effort catalog', () => {
        expect(buildGrokEffortOptions([{
            modelId: 'grok-4.5',
            reasoningEfforts: [
                { value: 'high', name: 'High Effort', isDefault: true },
                { value: 'low', name: 'Low Effort' }
            ]
        }], 'auto', 'grok-4.5')).toEqual([
            { value: 'auto', label: 'Default' },
            { value: 'high', label: 'High Effort' },
            { value: 'low', label: 'Low Effort' }
        ])
    })
})

describe('Kimi Create-session options', () => {
    it('enables model discovery only for an existing cwd on the target machine', () => {
        const args = {
            agent: 'kimi' as const,
            machineId: 'machine-1',
            cwd: '/home/user/project',
            cwdExists: true,
        }

        expect(shouldEnableKimiModelDiscovery(args)).toBe(true)
        expect(shouldEnableKimiModelDiscovery({ ...args, cwdExists: undefined })).toBe(false)
        expect(shouldEnableKimiModelDiscovery({ ...args, agent: 'claude' })).toBe(false)
    })

    it('keeps Default and appends every discovered Kimi model with the real alias as value', () => {
        const options = buildKimiModelOptions([
            { modelId: 'GLM-5.3-flash', name: 'thehive / GLM-5.3-flash', provider: 'thehive' },
            { modelId: 'deepseek-v4.1-flash', name: 'thehive / hive-deepseek', provider: 'thehive' },
            { modelId: 'hyper-glm-5.3-flash', name: 'charm-hyper / Hyper · GLM-5.3-Flash', provider: 'charm-hyper' },
            { modelId: 'openrouter-union-alpha', provider: 'openrouter' }
        ])

        expect(options[0]).toEqual({ value: 'auto', label: 'Default' })
        expect(options.map((option) => option.value)).toEqual([
            'auto',
            'GLM-5.3-flash',
            'deepseek-v4.1-flash',
            'hyper-glm-5.3-flash',
            'openrouter-union-alpha'
        ])
    })

    it('makes providers recognizable in labels', () => {
        const options = buildKimiModelOptions([
            { modelId: 'GLM-5.3-flash', name: 'thehive / GLM-5.3-flash', provider: 'thehive' },
            { modelId: 'openrouter-union-alpha', provider: 'openrouter' }
        ])

        expect(options[1]).toEqual({ value: 'GLM-5.3-flash', label: 'thehive — thehive / GLM-5.3-flash' })
        expect(options[2]).toEqual({ value: 'openrouter-union-alpha', label: 'openrouter — openrouter-union-alpha' })
    })

    it('falls back to the alias when a model has no display name or provider', () => {
        expect(buildKimiModelOptions([{ modelId: 'alias-only' }])).toEqual([
            { value: 'auto', label: 'Default' },
            { value: 'alias-only', label: 'alias-only' }
        ])
    })

    it('running-session options keep Default as null and aliases as values', () => {
        const options = buildKimiSessionModelOptions([
            { modelId: 'GLM-5.3-flash', provider: 'thehive' },
            { modelId: 'deepseek-v4.1-flash', provider: 'thehive' }
        ])

        expect(options[0]).toEqual({ value: null, label: 'Default' })
        expect(options.map((option) => option.value)).toEqual([null, 'GLM-5.3-flash', 'deepseek-v4.1-flash'])
    })
})
