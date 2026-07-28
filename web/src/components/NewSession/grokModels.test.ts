import { describe, expect, it } from 'vitest'
import { buildGrokEffortOptions, buildGrokModelOptions, shouldEnableGrokModelDiscovery } from './grokModels'

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
