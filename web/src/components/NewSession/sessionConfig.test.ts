import { describe, expect, it } from 'vitest'
import { getDefaultModelForAgent, resolveSpawnModelConfig, resolveSpawnPermissionConfig } from './sessionConfig'

describe('getDefaultModelForAgent', () => {
    it('uses the first Ark Coding Plan model for CC-ark sessions', () => {
        expect(getDefaultModelForAgent('claude-ark')).toBe('doubao-seed-2.0-code')
    })

    it('uses the first CC-api model for CC-api sessions', () => {
        expect(getDefaultModelForAgent('cc-api')).toBe('doubao-seed-2.1-pro')
    })

    it('uses DeepSeek V4 Pro 1M by default for CC-deepseek sessions', () => {
        expect(getDefaultModelForAgent('claude-deepseek')).toBe('deepseek-v4-pro[1m]')
    })

    it('uses Auto for Auto/default agents and explicit default for agy', () => {
        expect(getDefaultModelForAgent('claude')).toBe('auto')
        expect(getDefaultModelForAgent('codex')).toBe('auto')
        expect(getDefaultModelForAgent('agy')).toBe('Gemini 3.5 Flash (High)')
    })

    it('uses the explicit default preset for Hermes MoA sessions', () => {
        expect(getDefaultModelForAgent('hermes-moa')).toBe('default')
    })
})

describe('resolveSpawnModelConfig', () => {
    it('passes selected Ark model and selected effort', () => {
        expect(resolveSpawnModelConfig({
            agent: 'claude-ark',
            model: 'doubao-seed-2.0-code',
            effort: 'high'
        })).toEqual({
            model: 'doubao-seed-2.0-code',
            effort: 'high'
        })
    })

    it('omits Ark effort when effort is Auto', () => {
        expect(resolveSpawnModelConfig({
            agent: 'claude-ark',
            model: 'deepseek-v4-pro',
            effort: 'auto'
        })).toEqual({
            model: 'deepseek-v4-pro',
            effort: undefined
        })
    })


    it('passes selected CC-api model and allowed model-aware effort', () => {
        expect(resolveSpawnModelConfig({
            agent: 'cc-api',
            model: 'glm-5.2',
            effort: 'max'
        })).toEqual({
            model: 'glm-5.2',
            effort: 'max'
        })
    })

    it('passes the only supported Kimi K3 effort and rejects lower levels', () => {
        expect(resolveSpawnModelConfig({
            agent: 'cc-api',
            model: 'kimi-k3',
            effort: 'max'
        })).toEqual({
            model: 'kimi-k3',
            effort: 'max'
        })
        expect(resolveSpawnModelConfig({
            agent: 'cc-api',
            model: 'kimi-k3',
            effort: 'high'
        })).toEqual({
            model: 'kimi-k3',
            effort: undefined
        })
    })

    it('passes Antigravity agy default model explicitly', () => {
        expect(resolveSpawnModelConfig({
            agent: 'agy',
            model: 'Gemini 3.5 Flash (High)',
            effort: 'auto'
        })).toEqual({
            model: 'Gemini 3.5 Flash (High)',
            effort: undefined
        })
    })

    it('maps legacy agy auto to the current default model', () => {
        expect(resolveSpawnModelConfig({
            agent: 'agy',
            model: 'auto',
            effort: 'auto'
        })).toEqual({
            model: 'Gemini 3.5 Flash (High)',
            effort: undefined
        })
    })

    it('passes the Hermes MoA preset while omitting Claude effort', () => {
        expect(resolveSpawnModelConfig({
            agent: 'hermes-moa',
            model: 'gpt-5.6-sol-max',
            effort: 'max'
        })).toEqual({
            model: 'gpt-5.6-sol-max',
            effort: undefined
        })
    })

    it('passes the selected CC-deepseek model and official effort', () => {
        expect(resolveSpawnModelConfig({
            agent: 'claude-deepseek',
            model: 'deepseek-v4-flash',
            effort: 'high'
        })).toEqual({
            model: 'deepseek-v4-flash',
            effort: 'high'
        })
    })

    it('rejects unsupported CC-deepseek effort levels', () => {
        expect(resolveSpawnModelConfig({
            agent: 'claude-deepseek',
            model: 'deepseek-v4-flash',
            effort: 'medium'
        })).toEqual({
            model: 'deepseek-v4-flash',
            effort: undefined
        })
    })
})

describe('resolveSpawnPermissionConfig', () => {
    it('forwards Grok permission mode without the legacy yolo flag', () => {
        expect(resolveSpawnPermissionConfig('grok', 'safe-yolo', true)).toEqual({
            permissionMode: 'safe-yolo', yolo: undefined
        })
    })
})
