import { describe, expect, it } from 'vitest'
import { buildKimiProviderListArgs, parseKimiProviderListOutput } from './kimiModels'

const PROVIDER_LIST_OUTPUT = JSON.stringify({
    providers: {
        thehive: {
            baseUrl: 'https://api.thehive.example/v1',
            type: 'openai',
            apiKey: 'sk-secret-thehive-key'
        },
        'charm-hyper': {
            baseUrl: 'https://api.charm-hyper.example',
            type: 'openai',
            apiKey: 'sk-secret-charm-key'
        },
        openrouter: {
            baseUrl: 'https://openrouter.example/api',
            type: 'openai',
            apiKey: 'sk-secret-openrouter-key'
        }
    },
    models: {
        'GLM-5.3-flash': {
            provider: 'thehive',
            model: 'zai-org/glm-5.3-flash',
            displayName: 'thehive / GLM-5.3-flash',
            capabilities: ['tool_use', 'image_in']
        },
        'deepseek-v4.1-flash': {
            provider: 'thehive',
            model: 'deepseek-ai/deepseek-v4.1-flash',
            displayName: 'thehive / hive-deepseek'
        },
        'hyper-glm-5.3-flash': {
            provider: 'charm-hyper',
            model: 'glm-5.3-flash',
            displayName: 'charm-hyper / Hyper · GLM-5.3-Flash'
        },
        'openrouter-union-alpha': {
            provider: 'openrouter',
            model: 'stealth/union-alpha',
            displayName: 'openrouter / Union Alpha'
        }
    }
})

describe('buildKimiProviderListArgs', () => {
    it('uses the provider list command in json mode', () => {
        expect(buildKimiProviderListArgs()).toEqual(['provider', 'list', '--json'])
    })
})

describe('parseKimiProviderListOutput', () => {
    it('parses the real provider list format with multiple providers', () => {
        const parsed = parseKimiProviderListOutput(PROVIDER_LIST_OUTPUT)
        expect(parsed.availableModels.map((model) => model.modelId)).toEqual([
            'hyper-glm-5.3-flash',
            'openrouter-union-alpha',
            'deepseek-v4.1-flash',
            'GLM-5.3-flash'
        ])
        expect(parsed.currentModelId).toBeNull()
    })

    it('keeps several models of the same provider distinct', () => {
        const parsed = parseKimiProviderListOutput(PROVIDER_LIST_OUTPUT)
        const thehiveModels = parsed.availableModels.filter((model) => model.provider === 'thehive')
        expect(thehiveModels.map((model) => model.modelId).sort()).toEqual([
            'GLM-5.3-flash',
            'deepseek-v4.1-flash'
        ])
    })

    it('carries provider and display name for UI labels', () => {
        const parsed = parseKimiProviderListOutput(PROVIDER_LIST_OUTPUT)
        const hyper = parsed.availableModels.find((model) => model.modelId === 'hyper-glm-5.3-flash')
        expect(hyper).toEqual({
            modelId: 'hyper-glm-5.3-flash',
            name: 'charm-hyper / Hyper · GLM-5.3-Flash',
            provider: 'charm-hyper'
        })
    })

    it('never transmits secrets from the provider payload', () => {
        const parsed = parseKimiProviderListOutput(PROVIDER_LIST_OUTPUT)
        const serialized = JSON.stringify(parsed)
        expect(serialized).not.toContain('sk-secret-thehive-key')
        expect(serialized).not.toContain('sk-secret-charm-key')
        expect(serialized).not.toContain('sk-secret-openrouter-key')
        expect(serialized).not.toContain('api.thehive.example')
        expect(serialized).not.toContain('openrouter.example')
        for (const model of parsed.availableModels) {
            expect(Object.keys(model).sort()).toEqual(['modelId', 'name', 'provider'].sort())
        }
    })

    it('reports the local default model as current', () => {
        const parsed = parseKimiProviderListOutput(PROVIDER_LIST_OUTPUT, 'GLM-5.3-flash')
        expect(parsed.currentModelId).toBe('GLM-5.3-flash')
    })

    it('parses a bare models map', () => {
        const output = JSON.stringify({
            models: {
                'alias-a': { provider: 'p1', displayName: 'Model A' },
                'alias-b': { provider: 'p2' }
            }
        })
        const parsed = parseKimiProviderListOutput(output)
        expect(parsed.availableModels.map((model) => model.modelId).sort()).toEqual(['alias-a', 'alias-b'])
    })

    it('parses an array of model entries', () => {
        const output = JSON.stringify([
            { alias: 'alias-a', displayName: 'Model A', provider: 'p1', apiKey: 'should-not-leak' },
            { modelId: 'alias-b', name: 'Model B' }
        ])
        const parsed = parseKimiProviderListOutput(output)
        expect(parsed.availableModels).toEqual([
            { modelId: 'alias-b', name: 'Model B' },
            { modelId: 'alias-a', name: 'Model A', provider: 'p1' }
        ])
        expect(JSON.stringify(parsed)).not.toContain('should-not-leak')
    })

    it('parses providers with nested models', () => {
        const output = JSON.stringify({
            providers: {
                p1: { apiKey: 'secret', models: { 'alias-a': { displayName: 'Model A' } } }
            }
        })
        const parsed = parseKimiProviderListOutput(output)
        expect(parsed.availableModels).toEqual([
            { modelId: 'alias-a', name: 'Model A', provider: undefined }
        ])
        expect(JSON.stringify(parsed)).not.toContain('secret')
    })

    it('tolerates leading non-JSON output', () => {
        const parsed = parseKimiProviderListOutput(`some banner\n${PROVIDER_LIST_OUTPUT}`)
        expect(parsed.availableModels).toHaveLength(4)
    })

    it('falls back to the object key when no alias field exists', () => {
        const output = JSON.stringify({ models: { 'key-alias': { model: 'upstream/id' } } })
        const parsed = parseKimiProviderListOutput(output)
        expect(parsed.availableModels[0]?.modelId).toBe('key-alias')
        // The upstream provider model id is not the alias and must not be used as value.
        expect(parsed.availableModels[0]).not.toHaveProperty('modelId', 'upstream/id')
    })

    it('throws on output without JSON', () => {
        expect(() => parseKimiProviderListOutput('no json here')).toThrow('no JSON output')
    })

    it('throws on invalid JSON', () => {
        expect(() => parseKimiProviderListOutput('{"models":')).toThrow('invalid JSON output')
    })

    it('deduplicates models across shapes', () => {
        const output = JSON.stringify({
            models: { 'alias-a': { provider: 'p1' } },
            providers: { p1: { models: { 'alias-a': { displayName: 'dup' } } } }
        })
        const parsed = parseKimiProviderListOutput(output)
        expect(parsed.availableModels).toHaveLength(1)
    })
})
